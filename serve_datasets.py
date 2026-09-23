#!/usr/bin/env python3
"""Serve local LeRobot datasets the way the HuggingFace Hub serves them.

The visualizer builds every request as `${DATASET_URL}/${repoId}/resolve/main/${path}`,
so this strips the `resolve/<rev>` segments and maps what is left onto a local
directory laid out as `<root>/<org>/<dataset>/...`.

Byte-range requests are answered properly: without them the browser cannot seek
within the concatenated per-chunk mp4 files, which is how v3.0 stores video.

Two extras on top of plain file serving:

* `GET /api/datasets` lists the datasets found under --root, so the app can
  offer them instead of making the user type a repo id.
* `GET /api/mcap` and `GET /api/mcap/summary?path=<rel>` inspect the raw MCAP
  recordings under --mcap-root: topics, schemas, message counts and rates,
  before anything is converted. Messages are counted, never decoded.
* `GET /api/tools` lists the checks in tools/, and `GET /api/tools/run` runs one
  against a dataset or recording and returns what it printed.
Preview clips are written to the depth cache, capped at `VIZ_CACHE_MAX_GB`
(5 GB by default, least recently read dropped first) and encoded for a review
tile rather than for archive: `VIZ_PREVIEW_HEIGHT`, `VIZ_PREVIEW_FPS` and
`VIZ_PREVIEW_CRF` change that.

* `GET /api/roots`, `GET /api/roots/add?path=<abs>` and
  `GET /api/roots/remove?path=<abs>` list and change the directories datasets
  are served from, without a restart. `/api/mcap/roots{,/add,/remove}` does the
  same for the folders raw recordings are read from.
* `GET /api/mcap/joints?path=<rel>` returns each joint stream's decoded
  positions over the episode, strided down for plotting.
* `GET /api/mcap/preview?path=<rel>&topic=<topic>` returns an H.264 clip of one
  image topic, decoded from the recording's raw frames and cached. The frames
  are uncompressed BGR8/16-bit, which a browser cannot decode, so the mp4 is
  built here and only the mp4 crosses the wire.
* `?depth8=1&start=<s>&end=<s>` on a video path returns an 8-bit H.264 clip of
  that span, transcoded on demand and cached. Depth streams are HEVC Main 12
  (`gray12le`), which no browser decodes, so the raw file renders as an empty
  tile. Adding `&warm=1` answers 202 at once and transcodes in the background,
  which is how the viewer pre-warms the episodes it is about to show.

    ./serve_datasets.py --root ~/NVIDIA_DATASETS/converted --port 8080
"""

import argparse
import hashlib
import json
import os
import re
import socket
import socketserver
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler
from pathlib import Path

CONTENT_TYPES = {
    ".json": "application/json",
    ".parquet": "application/octet-stream",
    ".mp4": "video/mp4",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".jsonl": "application/x-ndjson",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
}

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
ROOTS = [Path(".")]
FIXED_ROOTS = []            # the roots given on the command line; never removable
DEPTH_CACHE = None          # directory for transcoded depth previews, or None
MCAP_ROOTS = []             # directories holding raw .mcap recordings
FIXED_MCAP_ROOTS = []       # the ones given on the command line; never removable
TOOLS_DIR = Path(__file__).resolve().parent / "tools"
TOOL_TIMEOUT_S = 1800       # a sync check over a large dataset is minutes, not seconds
DEPTH_LOCKS_GUARD = threading.Lock()
DEPTH_LOCKS = {}            # cache key -> lock, so one transcode runs per clip

# Depth renders through a colormap rather than as gray: near and far are metres
# apart but only a few grey levels apart, and the eye reads a hue ramp far more
# finely than a brightness ramp. `turbo` is the perceptually even rainbow, so
# close reads red and far reads blue. Part of every depth cache key, so changing
# it re-renders instead of serving the previous colors.
# Previews are watched in a tile a few hundred pixels wide, so they are encoded
# for that and not for archival: a smaller frame, a lower rate and a looser
# quantizer cut a clip to roughly a tenth, which is disk on this machine and
# read time off the NAS. VIZ_PREVIEW_* override any of it.
PREVIEW_MAX_HEIGHT = int(os.environ.get("VIZ_PREVIEW_HEIGHT", "360"))
PREVIEW_MAX_FPS = float(os.environ.get("VIZ_PREVIEW_FPS", "15"))
PREVIEW_CRF = os.environ.get("VIZ_PREVIEW_CRF", "28")

# Total size the transcoded previews may occupy. The least recently read clips
# are dropped once a new one takes the directory over it, so a review pass over
# a large dataset cannot fill the disk; a dropped clip is rebuilt on demand.
CACHE_MAX_BYTES = int(float(os.environ.get("VIZ_CACHE_MAX_GB", "5")) * 1e9)

# Part of every cache key, so changing the encode settings rebuilds the clips
# instead of serving the ones the previous settings produced.
PREVIEW_PROFILE = "h%sf%sq%s" % (
    PREVIEW_MAX_HEIGHT, PREVIEW_MAX_FPS, PREVIEW_CRF,
)

# Scale to PREVIEW_MAX_HEIGHT, leaving anything already smaller alone, and keep
# the width even because H.264 in yuv420p cannot encode an odd one.
PREVIEW_SCALE_FILTER = (
    "scale=-2:'min(%d,ih)':flags=bilinear" % PREVIEW_MAX_HEIGHT
)

DEPTH_COLORMAP = "turbo"

# pseudocolor writes color into the frame it is given, so the gray frame has to
# be widened to a color format first or the filter passes it through unchanged.
DEPTH_COLORMAP_FILTERS = ["format=gbrp", "pseudocolor=preset=%s" % DEPTH_COLORMAP]

# Raw depth is in millimetres and uses a small part of its range, so a plain
# truncation renders almost flat; `normalize` stretches each clip to its own
# extremes before the colormap is applied.
DEPTH_FILTERS = ["format=gray", "normalize"] + DEPTH_COLORMAP_FILTERS


def preview_encode_args(filters, fps=None):
    """The ffmpeg output arguments every preview clip is written with.

    @param filters Filters the caller needs applied before the common scaling.
    @param fps Source rate, when it is known; the clip is capped at
        PREVIEW_MAX_FPS and left alone when it is already slower.
    """
    chain = list(filters) + [PREVIEW_SCALE_FILTER]
    if fps is None or fps > PREVIEW_MAX_FPS:
        chain.append("fps=%g" % PREVIEW_MAX_FPS)
    return [
        "-vf", ",".join(chain),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", PREVIEW_CRF,
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    ]


def evict_preview_cache():
    """Drop the least recently read clips until the cache is under its budget.

    Read time, not write time: a clip someone keeps coming back to survives,
    while one built for an episode reviewed once goes first.
    """
    if DEPTH_CACHE is None or CACHE_MAX_BYTES <= 0:
        return
    try:
        clips = [(p.stat(), p) for p in DEPTH_CACHE.glob("*.mp4")]
    except OSError:
        return
    total = sum(stat.st_size for stat, _ in clips)
    if total <= CACHE_MAX_BYTES:
        return
    clips.sort(key=lambda entry: entry[0].st_atime)
    for stat, path in clips:
        if total <= CACHE_MAX_BYTES:
            break
        try:
            path.unlink()
        except OSError:
            continue
        total -= stat.st_size
        print("preview cache: dropped %s" % path.name)


def depth_preview(source, start, end):
    """Return an 8-bit H.264 clip of source[start:end], transcoding if needed.

    Depth is stored as HEVC Main 12 / gray12le, which browsers cannot decode.
    ffmpeg's `format=gray` rescales the 12-bit luma into 8 bits linearly, so a
    normalized colormap band computed from the 12-bit stats still applies.
    """
    key = hashlib.sha1(
        ("%s|%.3f|%.3f|%s|%s"
         % (source, start, end, DEPTH_COLORMAP, PREVIEW_PROFILE)).encode()
    ).hexdigest()
    out = DEPTH_CACHE / ("%s.mp4" % key)

    with DEPTH_LOCKS_GUARD:
        lock = DEPTH_LOCKS.setdefault(key, threading.Lock())
    with lock:
        if out.is_file() and out.stat().st_size > 0:
            return out
        tmp = out.with_suffix(".part.mp4")
        cmd = [
            "ffmpeg", "-nostdin", "-y", "-loglevel", "error",
            "-ss", "%.3f" % start, "-t", "%.3f" % max(end - start, 0.04),
            "-i", str(source),
            "-an",
        ] + preview_encode_args(["format=gray"] + DEPTH_COLORMAP_FILTERS) + [
            str(tmp),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except (OSError, subprocess.CalledProcessError) as exc:
            tmp.unlink(missing_ok=True)
            detail = getattr(exc, "stderr", b"") or b""
            print("depth preview failed for %s: %s" % (source, detail.decode()[:400]))
            return None
        tmp.replace(out)
        evict_preview_cache()
        return out


def list_mcap_files():
    """Every .mcap under the MCAP roots, with its size.

    A recording is named by its path relative to the root it was found under,
    which is also how it is resolved again, so the first root holding that
    relative path wins. Give two roots the same internal layout and the second
    one's copies are shadowed.
    """
    files = []
    seen = set()
    for root in MCAP_ROOTS:
        for path in root.rglob("*.mcap"):
            # macOS resource forks ride along on NAS copies and are not recordings.
            if path.name.startswith("._") or not path.is_file():
                continue
            rel = str(path.relative_to(root))
            if rel in seen:
                continue
            seen.add(rel)
            stat = path.stat()
            files.append({
                "path": rel,
                "size": stat.st_size,
                "modified": int(stat.st_mtime),
            })
    files.sort(key=lambda f: f["path"])
    return files


def resolve_mcap(rel):
    """Map a recording's relative path back onto a file under one of the roots."""
    if not rel:
        return None
    for root in MCAP_ROOTS:
        target = (root / rel).resolve()
        if str(target).startswith(str(root)) and target.is_file():
            return target
    return None


def mcap_root_of(path):
    """The MCAP root a resolved recording sits under, or None."""
    for root in MCAP_ROOTS:
        if str(path).startswith(str(root)):
            return root
    return None


def mcap_summary(path):
    """Per-channel counts, spans and rates for one recording.

    Reads the file's summary section when it has one and falls back to a scan
    otherwise: a recording written without an index carries no channel
    statistics, which is the case for anything the recorder was killed out of.
    """
    from mcap.reader import make_reader

    with open(path, "rb") as fh:
        reader = make_reader(fh)
        header = reader.get_header()
        summary = reader.get_summary()

        channels = {}
        indexed = bool(summary and summary.statistics and summary.chunk_indexes)
        if indexed:
            for channel_id, channel in summary.channels.items():
                schema = summary.schemas.get(channel.schema_id)
                channels[channel_id] = {
                    "topic": channel.topic,
                    "schema": schema.name if schema else "",
                    "encoding": channel.message_encoding,
                    # Whatever the recorder attached to the channel. Today that
                    # is `stream_type` on cameras and nothing on joints.
                    "channelMetadata": dict(channel.metadata),
                    "count": summary.statistics.channel_message_counts.get(
                        channel_id, 0
                    ),
                    "start": None,
                    "end": None,
                }
            start_ns = summary.statistics.message_start_time
            end_ns = summary.statistics.message_end_time
            total = summary.statistics.message_count
        else:
            start_ns, end_ns, total = None, None, 0
            for schema, channel, message in reader.iter_messages():
                entry = channels.setdefault(channel.id, {
                    "topic": channel.topic,
                    "schema": schema.name if schema else "",
                    "encoding": channel.message_encoding,
                    "channelMetadata": dict(channel.metadata),
                    "count": 0,
                    "start": message.log_time,
                    "end": message.log_time,
                })
                entry["count"] += 1
                entry["start"] = min(entry["start"], message.log_time)
                entry["end"] = max(entry["end"], message.log_time)
                total += 1
                start_ns = message.log_time if start_ns is None else min(
                    start_ns, message.log_time)
                end_ns = message.log_time if end_ns is None else max(
                    end_ns, message.log_time)

        span_s = ((end_ns - start_ns) / 1e9) if start_ns and end_ns else 0.0
        rows = []
        for entry in channels.values():
            # A channel's own span is the honest denominator for its rate: a
            # camera free-runs on its own clock and starts late.
            if entry["start"] and entry["end"] and entry["end"] > entry["start"]:
                own_span = (entry["end"] - entry["start"]) / 1e9
            else:
                own_span = span_s
            rows.append({
                "topic": entry["topic"],
                "schema": entry["schema"],
                "encoding": entry["encoding"],
                "channelMetadata": entry.get("channelMetadata", {}),
                "count": entry["count"],
                "hz": round((entry["count"] - 1) / own_span, 2)
                if own_span > 0 and entry["count"] > 1 else None,
            })
        rows.sort(key=lambda r: r["topic"])

        return {
            "path": str(path.relative_to(mcap_root_of(path) or path.parent)),
            "size": path.stat().st_size,
            "profile": header.profile,
            "library": header.library,
            "indexed": indexed,
            "messageCount": total,
            "durationSeconds": round(span_s, 3),
            "startNs": start_ns,
            "endNs": end_ns,
            "channels": rows,
            "metadata": {
                record.name: record.metadata
                for record in reader.iter_metadata()
            },
        }


# RawImage.encoding -> the ffmpeg input pixel format holding the same bytes.
# Anything not listed is refused rather than guessed at.
IMAGE_PIX_FMTS = {
    "bgr8": "bgr24",
    "rgb8": "rgb24",
    "bgra8": "bgra",
    "rgba8": "rgba",
    "mono8": "gray",
    "8UC1": "gray",
    "mono16": "gray16le",
    "16UC1": "gray16le",
}


# CompressedVideo.format -> the ffmpeg demuxer for that elementary stream.
VIDEO_INPUT_FORMATS = {
    "h264": "h264",
    "h265": "hevc",
    "hevc": "hevc",
}


def mcap_preview(path, topic):
    """Build (or reuse) an H.264 clip of one image topic in a recording.

    Two storage formats reach here. `foxglove.RawImage` frames are uncompressed,
    so they stream straight into ffmpeg as raw video. `foxglove.CompressedVideo`
    frames are already an Annex B bitstream, so the packets are concatenated and
    ffmpeg demuxes them; depth (12-bit HEVC) still has to be re-encoded to 8-bit
    because no browser decodes it. Either way nothing is held in memory and
    nothing is written next to the recording.
    """
    from mcap.reader import make_reader
    from mcap_protobuf.decoder import DecoderFactory

    stat = path.stat()
    key = hashlib.sha1(
        ("%s|%d|%s|%s|%s"
         % (path, stat.st_mtime_ns, topic, DEPTH_COLORMAP,
            PREVIEW_PROFILE)).encode()
    ).hexdigest()
    out = DEPTH_CACHE / ("mcap-%s.mp4" % key)

    with DEPTH_LOCKS_GUARD:
        lock = DEPTH_LOCKS.setdefault(key, threading.Lock())
    with lock:
        if out.is_file() and out.stat().st_size > 0:
            return out

        # The playback rate is the topic's own rate: cameras free-run on their
        # own clocks and do not share the joint stream's timing.
        summary = mcap_summary(path)
        channel = next(
            (c for c in summary["channels"] if c["topic"] == topic), None
        )
        if channel is None:
            return None
        fps = channel["hz"] or 30.0
        compressed = channel["schema"] == "foxglove.CompressedVideo"
        depth = channel.get("channelMetadata", {}).get("stream_type") == "depth"

        tmp = out.with_suffix(".part.mp4")
        proc = None
        frames = 0
        try:
            with open(path, "rb") as fh:
                reader = make_reader(fh, decoder_factories=[DecoderFactory()])
                for _schema, _channel, _message, msg in (
                    reader.iter_decoded_messages(topics=[topic])
                ):
                    if proc is None and compressed:
                        demuxer = VIDEO_INPUT_FORMATS.get(
                            getattr(msg, "format", "").lower()
                        )
                        if demuxer is None:
                            print("unsupported video format on %s: %r"
                                  % (topic, getattr(msg, "format", None)))
                            return None
                        # 12-bit depth goes through DEPTH_FILTERS for the same
                        # reason the raw path sends 16-bit through it: no browser
                        # decodes those streams.
                        filters = DEPTH_FILTERS if depth else []
                        proc = subprocess.Popen(
                            ["ffmpeg", "-nostdin", "-y", "-loglevel", "error",
                             "-f", demuxer, "-r", "%.4f" % fps, "-i", "-", "-an"]
                            + preview_encode_args(filters, fps)
                            + [str(tmp)],
                            stdin=subprocess.PIPE,
                        )
                    elif proc is None:
                        pix_fmt = IMAGE_PIX_FMTS.get(getattr(msg, "encoding", ""))
                        if pix_fmt is None:
                            print("unsupported image encoding on %s: %r"
                                  % (topic, getattr(msg, "encoding", None)))
                            return None
                        # 16-bit depth is rescaled and colored here for the same
                        # reason the LeRobot depth previews are: no browser
                        # decodes a 16-bit stream.
                        filters = DEPTH_FILTERS if "16" in pix_fmt else []
                        proc = subprocess.Popen(
                            ["ffmpeg", "-nostdin", "-y", "-loglevel", "error",
                             "-f", "rawvideo", "-pix_fmt", pix_fmt,
                             "-s", "%dx%d" % (msg.width, msg.height),
                             "-r", "%.4f" % fps, "-i", "-", "-an"]
                            + preview_encode_args(filters, fps)
                            + [str(tmp)],
                            stdin=subprocess.PIPE,
                        )
                    proc.stdin.write(msg.data)
                    frames += 1
        except (OSError, ValueError, BrokenPipeError) as exc:
            print("mcap preview failed for %s %s: %s" % (path, topic, exc))
            if proc:
                proc.stdin.close()
                proc.wait()
            tmp.unlink(missing_ok=True)
            return None

        if proc is None or frames == 0:
            tmp.unlink(missing_ok=True)
            return None
        proc.stdin.close()
        if proc.wait() != 0 or not tmp.is_file():
            tmp.unlink(missing_ok=True)
            return None
        tmp.replace(out)
        evict_preview_cache()
        return out


# Most points a joint series keeps. An episode is a few thousand samples and a
# plot is a few hundred pixels wide, so anything denser is drawn on top of
# itself; the series is strided down to this before it leaves the server.
JOINT_SERIES_MAX_POINTS = 1500

# Suffix marking a topic as a robot's joint-state stream.
JOINT_TOPIC_SUFFIX = "/joints/state"


def mcap_joint_series(path):
    """Decoded joint positions per stream, for the episode's plots.

    Timestamps are seconds from the first message in the file, which is what
    the camera clips are also positioned on, so a cursor in a plot and a frame
    in a tile refer to the same instant.
    """
    from mcap.reader import make_reader
    from mcap_protobuf.decoder import DecoderFactory

    summary = mcap_summary(path)
    topics = [
        channel["topic"] for channel in summary["channels"]
        if channel["topic"].endswith(JOINT_TOPIC_SUFFIX)
    ]
    if not topics:
        return {"streams": []}

    # The recorder writes each stream's joint names into dataset_info, so the
    # plot can label the lines instead of numbering them.
    names_by_stream = {}
    for fields in summary["metadata"].values():
        info = fields.get("dataset_info")
        if not info:
            continue
        try:
            streams = json.loads(info).get("streams", {})
        except ValueError:
            continue
        for stream, entry in streams.items():
            joint_names = (entry or {}).get("joint_names")
            if joint_names:
                names_by_stream[stream] = joint_names

    series = {topic: {"t": [], "positions": []} for topic in topics}
    origin = None
    with open(path, "rb") as fh:
        reader = make_reader(fh, decoder_factories=[DecoderFactory()])
        for _schema, channel, message, decoded in (
            reader.iter_decoded_messages(topics=topics)
        ):
            if origin is None:
                origin = message.log_time
            entry = series[channel.topic]
            entry["t"].append((message.log_time - origin) / 1e9)
            entry["positions"].append([round(v, 5) for v in decoded.positions])

    streams = []
    for topic in topics:
        entry = series[topic]
        count = len(entry["t"])
        if count == 0:
            continue
        stride = max(1, -(-count // JOINT_SERIES_MAX_POINTS))
        stream_id = topic[: -len(JOINT_TOPIC_SUFFIX)]
        streams.append({
            "topic": topic,
            "stream": stream_id,
            "names": names_by_stream.get(stream_id, []),
            "t": entry["t"][::stride],
            "positions": entry["positions"][::stride],
        })
    return {"streams": streams}


def list_tools():
    """Every `<name>.tool.json` in tools/, as written.

    Read per request rather than cached, so a tool dropped in beside the others
    is available on the next page load.
    """
    tools = []
    if not TOOLS_DIR.is_dir():
        return tools
    for manifest in sorted(TOOLS_DIR.glob("*.tool.json")):
        try:
            tool = json.loads(manifest.read_text())
        except (OSError, ValueError) as exc:
            print("ignoring %s: %s" % (manifest.name, exc))
            continue
        script = TOOLS_DIR / tool.get("script", "")
        if not script.is_file():
            print("ignoring %s: script not found: %s" % (manifest.name, script))
            continue
        tools.append(tool)
    return tools


def resolve_target(kind, rel):
    """Map a browser-supplied target onto a real path inside a configured root.

    The browser names a dataset or a recording; it never supplies a filesystem
    path, and nothing outside the roots can be reached.
    """
    if kind == "mcap":
        return resolve_mcap(rel)

    for root in ROOTS:
        target = (root / rel).resolve()
        if str(target).startswith(str(root)) and target.is_dir():
            return target
    return None


def run_tool(tool, target, options):
    """Run one tool against one target and collect what it printed."""
    cmd = ["python3", str(TOOLS_DIR / tool["script"]), str(target)]
    for option in tool.get("options", []):
        flag = option.get("flag")
        if flag not in options:
            continue
        value = options[flag]
        if option.get("type") == "boolean":
            if value in ("1", "true", "True"):
                cmd.append(flag)
        elif value not in ("", None):
            cmd.extend([flag, str(value)])
    if tool.get("jsonFlag"):
        cmd.append(tool["jsonFlag"])

    started = time.monotonic()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=TOOL_TIMEOUT_S, cwd=str(TOOLS_DIR))
    except subprocess.TimeoutExpired:
        return {"id": tool["id"], "ok": False, "timedOut": True,
                "durationMs": int((time.monotonic() - started) * 1000),
                "stdout": "", "stderr": "timed out after %ds" % TOOL_TIMEOUT_S}
    except OSError as exc:
        return {"id": tool["id"], "ok": False, "stdout": "", "stderr": str(exc),
                "durationMs": 0}

    result = {
        "id": tool["id"],
        "target": str(target),
        "command": " ".join(cmd),
        "exitCode": proc.returncode,
        "ok": proc.returncode == 0,
        "durationMs": int((time.monotonic() - started) * 1000),
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
    # A tool that prints JSON gets rendered as a table; anything else is text.
    try:
        result["json"] = json.loads(proc.stdout)
    except ValueError:
        pass
    return result


# Roots added from the UI, kept apart from the ones the process was started
# with so a restart cannot lose the command line and cannot silently drop what
# someone browsed to. Persisted next to the preview cache, which is the one
# writable directory the container is given.
EXTRA_ROOTS_FILE = None


def load_extra_roots():
    """Re-attach the roots added from the UI in an earlier run."""
    if EXTRA_ROOTS_FILE is None or not EXTRA_ROOTS_FILE.is_file():
        return
    try:
        saved = json.loads(EXTRA_ROOTS_FILE.read_text())
    except (OSError, ValueError):
        return
    # A bare list is the older format, which only held dataset roots.
    if isinstance(saved, list):
        saved = {"datasets": saved, "mcap": []}
    for entry in saved.get("datasets", []):
        path = Path(entry).expanduser()
        if path.is_dir() and path not in ROOTS:
            ROOTS.append(path)
    for entry in saved.get("mcap", []):
        path = Path(entry).expanduser()
        if path.is_dir() and path not in MCAP_ROOTS:
            MCAP_ROOTS.append(path)


def save_extra_roots():
    """Record the UI-added roots, ignoring a read-only or missing cache dir."""
    if EXTRA_ROOTS_FILE is None:
        return
    payload = {
        "datasets": [str(r) for r in ROOTS if r not in FIXED_ROOTS],
        "mcap": [str(r) for r in MCAP_ROOTS if r not in FIXED_MCAP_ROOTS],
    }
    try:
        EXTRA_ROOTS_FILE.write_text(json.dumps(payload))
    except OSError as exc:
        print("could not save roots: %s" % exc)


def check_root(raw):
    """Validate a path typed into the roots panel.

    Returns (path, None) when it can be served, or (None, message). A path the
    process cannot see is the common case in a container, where only mounted
    directories exist, so it is reported as such rather than as "not found".
    """
    if not raw.strip():
        return None, "no path given"
    path = Path(raw).expanduser()
    if not path.is_absolute():
        return None, "path must be absolute: %s" % path
    path = path.resolve()
    if not path.is_dir():
        return None, ("not a directory inside this server: %s "
                      "(in Docker, only mounted paths exist)" % path)
    return path, None


def mcap_root_entries():
    """Every MCAP root, with how many recordings it holds, for the panel."""
    return [
        {
            "path": str(root),
            "exists": root.is_dir(),
            "datasets": sum(1 for p in root.rglob("*.mcap")
                            if not p.name.startswith("._")),
            "fixed": root in FIXED_MCAP_ROOTS,
        }
        for root in MCAP_ROOTS
    ]


def add_mcap_root(raw):
    """Inspect recordings under another directory as well."""
    path, error = check_root(raw)
    if error:
        return error
    if path not in MCAP_ROOTS:
        MCAP_ROOTS.append(path)
        save_extra_roots()
    return None


def remove_mcap_root(raw):
    """Stop inspecting a UI-added MCAP root."""
    try:
        path = Path(raw).expanduser().resolve()
    except OSError:
        return "not a path: %s" % raw
    if path in FIXED_MCAP_ROOTS:
        return "%s was passed on the command line; it cannot be removed here" % path
    if path not in MCAP_ROOTS:
        return "not a root: %s" % path
    MCAP_ROOTS.remove(path)
    save_extra_roots()
    return None


def root_entries():
    """Every root, with what it currently holds, for the roots panel."""
    return [
        {
            "path": str(root),
            "exists": root.is_dir(),
            "datasets": sum(1 for _ in root.glob("*/*/meta/info.json")),
            "fixed": root in FIXED_ROOTS,
        }
        for root in ROOTS
    ]


def add_root(raw):
    """Serve datasets from another directory as well."""
    path, error = check_root(raw)
    if error:
        return error
    if path not in ROOTS:
        ROOTS.append(path)
        save_extra_roots()
    return None


def remove_root(raw):
    """Stop serving a UI-added root. The ones from the command line stay."""
    path = Path(raw).expanduser()
    try:
        path = path.resolve()
    except OSError:
        return "not a path: %s" % raw
    if path in FIXED_ROOTS:
        return "%s was passed on the command line; it cannot be removed here" % path
    if path not in ROOTS:
        return "not a root: %s" % path
    ROOTS.remove(path)
    save_extra_roots()
    return None


def list_datasets():
    """Every `<org>/<dataset>` under the roots that has a meta/info.json, with
    the headline numbers the landing page shows."""
    out = []
    seen = set()
    for root in ROOTS:
        for org in sorted(p for p in root.iterdir() if p.is_dir()):
            for ds in sorted(p for p in org.iterdir() if p.is_dir()):
                repo_id = "%s/%s" % (org.name, ds.name)
                if repo_id in seen:
                    continue
                entry = dataset_entry(ds, repo_id)
                if entry:
                    seen.add(repo_id)
                    out.append(entry)
    out.sort(key=lambda d: d["repoId"])
    return out


def dataset_entry(ds, repo_id):
    """Headline numbers for one dataset directory, or None if it is not one."""
    meta = ds / "meta" / "info.json"
    if not meta.is_file():
        return None
    entry = {"repoId": repo_id}
    try:
        info = json.loads(meta.read_text())
    except (OSError, ValueError):
        info = {}
    for key in ("total_episodes", "total_frames", "fps",
                "robot_type", "codebase_version"):
        if key in info:
            entry[key] = info[key]
    entry["cameras"] = sorted(
        name for name, f in (info.get("features") or {}).items()
        if f.get("dtype") == "video"
    )
    return entry


# A <video> that seeks away stops reading its current response. The server is
# then left blocking in write() on a socket whose window never opens, holding
# one of the browser's six per-host connections for good. Six camera tiles seek
# constantly, so without a timeout the pool drains and every later fetch (the
# next episode's metadata included) hangs forever.
SOCKET_TIMEOUT_S = 20

# A media element asks for `bytes=N-` and then reads lazily, so the rest of the
# file sits in the socket's send buffer with a zero receive window and the
# connection is pinned for as long as the tile is on screen. Six tiles is
# exactly the browser's per-host connection budget, and the next episode's
# metadata fetch then never gets a slot. Answering an open-ended range with a
# bounded slice keeps every connection short-lived; the player asks for the
# next slice when it needs one.
MAX_OPEN_RANGE_BYTES = 4 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LocalDatasetHub/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(SOCKET_TIMEOUT_S)

    def log_message(self, fmt, *args):
        if "--verbose" in os.environ.get("SERVE_FLAGS", ""):
            super().log_message(fmt, *args)

    def resolve(self):
        """Map a Hub-style request path onto a file under one of ROOTS, or None."""
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        parts = [p for p in path.split("/") if p not in ("", ".")]
        if not parts or ".." in parts:
            return None
        # `<org>/<dataset>/resolve/<rev>/<rest>` -> `<org>/<dataset>/<rest>`
        if "resolve" in parts:
            i = parts.index("resolve")
            parts = parts[:i] + parts[i + 2:]
        for root in ROOTS:
            target = (root / Path(*parts)).resolve()
            if not str(target).startswith(str(root)):
                continue
            if target.is_file():
                return target
        return None

    def send_common(self, target, length):
        ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "range")
        self.send_header("Access-Control-Expose-Headers", "content-length, content-range")
        self.send_header("Content-Length", str(length))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "range")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.serve(body=False)

    def do_GET(self):
        self.serve(body=True)

    def send_json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve(self, body):
        route = self.path.split("?", 1)[0].rstrip("/")
        if route == "/api/datasets":
            self.send_json(list_datasets())
            return

        if route == "/api/roots":
            self.send_json({"roots": root_entries()})
            return

        if route in ("/api/roots/add", "/api/roots/remove"):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw = (query.get("path") or [""])[0]
            error = (add_root if route.endswith("/add") else remove_root)(raw)
            self.send_json({"ok": error is None, "error": error,
                            "roots": root_entries()})
            return

        if route == "/api/tools":
            self.send_json(list_tools())
            return

        if route == "/api/tools/run":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            tool_id = (query.get("id") or [""])[0]
            tool = next((t for t in list_tools() if t["id"] == tool_id), None)
            if tool is None:
                self.send_json({"ok": False, "stderr": "no such tool: %s" % tool_id})
                return
            target = resolve_target(
                tool.get("target", "dataset"), (query.get("target") or [""])[0]
            )
            if target is None:
                self.send_json({"ok": False, "stderr": "target not found under any root"})
                return
            options = {
                key: values[0] for key, values in query.items()
                if key.startswith("--")
            }
            self.send_json(run_tool(tool, target, options))
            return

        if route.startswith("/api/mcap"):
            # The roots routes answer before the "any roots at all" check, so a
            # server started without one can still be pointed at recordings.
            if route == "/api/mcap/roots":
                self.send_json({"roots": mcap_root_entries()})
                return

            if route in ("/api/mcap/roots/add", "/api/mcap/roots/remove"):
                query = urllib.parse.parse_qs(
                    urllib.parse.urlparse(self.path).query
                )
                raw = (query.get("path") or [""])[0]
                error = (add_mcap_root if route.endswith("/add")
                         else remove_mcap_root)(raw)
                self.send_json({"ok": error is None, "error": error,
                                "roots": mcap_root_entries()})
                return

            if not MCAP_ROOTS:
                self.send_json({"error": "no MCAP folder configured"})
                return
            if route == "/api/mcap":
                self.send_json(list_mcap_files())
                return
            if route == "/api/mcap/preview":
                query = urllib.parse.parse_qs(
                    urllib.parse.urlparse(self.path).query
                )
                rel = (query.get("path") or [""])[0]
                topic = (query.get("topic") or [""])[0]
                source = resolve_mcap(rel)
                if source is None or not topic or DEPTH_CACHE is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
                if query.get("warm"):
                    threading.Thread(
                        target=mcap_preview, args=(source, topic), daemon=True,
                    ).start()
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
                clip = mcap_preview(source, topic)
                if clip is None:
                    self.send_response(415)
                    self.send_header("Content-Length", "0")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
                self.serve_file(clip, body)
                return

            if route == "/api/mcap/joints":
                query = urllib.parse.parse_qs(
                    urllib.parse.urlparse(self.path).query
                )
                rel = (query.get("path") or [""])[0]
                target = resolve_mcap(rel)
                if target is None:
                    self.send_json({"error": "no such recording: %s" % rel})
                    return
                try:
                    self.send_json(mcap_joint_series(target))
                except Exception as exc:  # a truncated file is a finding
                    self.send_json({"error": "%s: %s" % (type(exc).__name__, exc)})
                return

            if route == "/api/mcap/summary":
                query = urllib.parse.parse_qs(
                    urllib.parse.urlparse(self.path).query
                )
                rel = (query.get("path") or [""])[0]
                target = resolve_mcap(rel)
                if target is None:
                    self.send_json({"error": "no such recording: %s" % rel})
                    return
                try:
                    self.send_json(mcap_summary(target))
                except Exception as exc:  # a truncated file is a finding
                    self.send_json({"error": "%s: %s" % (type(exc).__name__, exc)})
                return

        target = self.resolve()
        if target is not None and DEPTH_CACHE is not None:
            query = urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query
            )
            if query.get("depth8"):
                try:
                    start = float(query.get("start", ["0"])[0])
                    end = float(query.get("end", ["0"])[0])
                except ValueError:
                    start = end = 0.0
                if query.get("warm"):
                    # Answer before transcoding: a pre-warm must not hold one
                    # of the browser's six per-host connections open on ffmpeg.
                    source = target
                    threading.Thread(
                        target=depth_preview, args=(source, start, end),
                        daemon=True,
                    ).start()
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
                target = depth_preview(target, start, end) or target
        if target is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return

        self.serve_file(target, body)

    def serve_file(self, target, body):
        """Send one file, honouring a Range header."""
        size = target.stat().st_size
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        partial = False

        if rng:
            m = RANGE_RE.match(rng.strip())
            if m:
                lo, hi = m.group(1), m.group(2)
                open_ended = False
                if lo:
                    start = int(lo)
                    if hi:
                        end = int(hi)
                    else:
                        end = size - 1
                        open_ended = True
                elif hi:  # suffix range: last N bytes
                    start = max(0, size - int(hi))
                if start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
                end = min(end, size - 1)
                if open_ended:
                    end = min(end, start + MAX_OPEN_RANGE_BYTES - 1)
                partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_common(target, length)
        self.end_headers()

        if not body:
            return
        with open(target, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                block = fh.read(min(256 * 1024, remaining))
                if not block:
                    break
                try:
                    self.wfile.write(block)
                except (BrokenPipeError, ConnectionResetError, socket.timeout,
                        TimeoutError, OSError):
                    # The player seeked away. Drop the connection rather than
                    # leaving a half-sent body on it: the browser would keep
                    # waiting for the rest of Content-Length and never reuse
                    # the slot.
                    self.close_connection = True
                    return
                remaining -= len(block)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def env_paths(name):
    """Parse a colon-separated path list from the environment."""
    raw = os.environ.get(name, "")
    return [Path(part) for part in raw.split(os.pathsep) if part]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    # Every option also reads an environment variable, so a container or a
    # service file can configure the server without a command line.
    ap.add_argument("--root", type=Path, action="append",
                    default=env_paths("VIZ_DATASET_ROOTS") or None,
                    help="directory holding <org>/<dataset> trees; repeatable "
                         "(env VIZ_DATASET_ROOTS, %s-separated)" % os.pathsep)
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("VIZ_PORT", "8080")))
    ap.add_argument("--host", default=os.environ.get("VIZ_HOST", "127.0.0.1"))
    ap.add_argument("--verbose", action="store_true",
                    default=bool(os.environ.get("VIZ_VERBOSE")))
    ap.add_argument("--depth-cache", type=Path,
                    default=Path(os.environ.get(
                        "VIZ_DEPTH_CACHE",
                        Path.home() / ".cache" / "lerobot_depth_preview")),
                    help="where transcoded 8-bit previews are kept "
                         "(env VIZ_DEPTH_CACHE)")
    ap.add_argument("--mcap-root", type=Path, action="append",
                    default=(env_paths("VIZ_MCAP_ROOTS")
                             or env_paths("VIZ_MCAP_ROOT") or None),
                    help="directory of raw .mcap recordings to inspect; repeat "
                         "for several (env VIZ_MCAP_ROOTS, %s-separated)"
                         % os.pathsep)
    ap.add_argument("--no-depth-preview", action="store_true",
                    default=bool(os.environ.get("VIZ_NO_DEPTH_PREVIEW")),
                    help="serve depth streams as stored (browsers show them empty)")
    args = ap.parse_args()
    if not args.root:
        ap.error("no dataset root: pass --root or set VIZ_DATASET_ROOTS")

    global ROOTS
    # An empty mount is normal in a container (someone maps only MCAP, say),
    # so a missing root is reported and skipped rather than fatal.
    ROOTS = []
    for root in args.root:
        resolved = root.expanduser().resolve()
        if resolved.is_dir():
            ROOTS.append(resolved)
        else:
            print("skipping dataset root (not a directory): %s" % resolved)
    if not ROOTS:
        raise SystemExit("no usable dataset root")
    global FIXED_ROOTS
    FIXED_ROOTS = list(ROOTS)
    if args.verbose:
        os.environ["SERVE_FLAGS"] = "--verbose"

    global MCAP_ROOTS, FIXED_MCAP_ROOTS
    for root in args.mcap_root or []:
        candidate = root.expanduser().resolve()
        if candidate.is_dir():
            MCAP_ROOTS.append(candidate)
        else:
            print("skipping mcap root (not a directory): %s" % candidate)
    FIXED_MCAP_ROOTS = list(MCAP_ROOTS)

    global DEPTH_CACHE
    if not args.no_depth_preview:
        DEPTH_CACHE = args.depth_cache.expanduser().resolve()
        DEPTH_CACHE.mkdir(parents=True, exist_ok=True)

    global EXTRA_ROOTS_FILE
    EXTRA_ROOTS_FILE = (DEPTH_CACHE or Path(__file__).resolve().parent) / "roots.json"
    load_extra_roots()

    datasets = [d["repoId"] for d in list_datasets()]
    print("serving %s on http://%s:%d"
          % (", ".join(str(r) for r in ROOTS), args.host, args.port))
    print("depth previews: %s" % (DEPTH_CACHE or "disabled"))
    print("mcap roots: %s"
          % (", ".join(str(r) for r in MCAP_ROOTS) or "disabled"))
    print("%d dataset(s):" % len(datasets))
    for d in datasets:
        print("  %s" % d)

    with Server((args.host, args.port), Handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
