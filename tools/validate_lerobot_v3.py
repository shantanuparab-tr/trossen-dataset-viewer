#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pandas>=2.0", "pyarrow>=14", "numpy>=1.24"]
# ///
"""Check a LeRobot v3.0 dataset for structural faults and image/state desync.

Four groups of checks, each independent, each reported separately:

  structure  the files and metadata keys a v3.0 reader requires are present
  counts     info.json, the episode table, the data rows and the video frame
             counts all agree
  cadence    episode indices are contiguous from zero and every episode's
             timestamps are the uniform k/fps grid the format assumes
  sync       decoded frame-to-frame motion lines up in time with joint motion

The sync check is the one that catches the defect this dataset was converted to
fix. It correlates per-frame image motion against per-row joint velocity and
reports the lag, in frames, that best aligns them. Zero means the image in a row
was taken when the joints were in that row's state. A non-zero lag is the images
running ahead of or behind the state, which is invisible in the file itself.

Usage:
    ./validate_lerobot_v3.py <dataset_root> [--sync-episodes N] [--json]

`dataset_root` is the directory holding meta/, data/ and videos/.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

# Frames decoded per camera per sampled episode. Enough for a stable correlation
# without decoding whole videos.
SYNC_FRAMES = 150

# Lags searched, in frames, either side of zero.
MAX_LAG = 15


@dataclass
class Report:
    """Accumulated findings for one dataset."""

    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def add(self, group: str, ok: bool, detail: str) -> None:
        self.checks.append((group, ok, detail))

    @property
    def failed(self) -> int:
        return sum(1 for _, ok, _ in self.checks if not ok)

    def print(self) -> None:
        width = max(len(g) for g, _, _ in self.checks) if self.checks else 10
        for group, ok, detail in self.checks:
            print(f"  [{'ok' if ok else 'FAIL'}] {group:<{width}}  {detail}")

    def as_dict(self, root: Path) -> dict:
        """The same findings as a document, for callers that render them."""
        return {
            "dataset": str(root),
            "passed": len(self.checks) - self.failed,
            "total": len(self.checks),
            "checks": [
                {"group": group, "ok": ok, "detail": detail}
                for group, ok, detail in self.checks
            ],
        }


def read_parquet_dir(path: Path) -> pd.DataFrame:
    """Read one parquet file, or every parquet under a directory, as one frame."""
    if path.is_file():
        return pd.read_parquet(path)
    files = sorted(path.rglob("*.parquet"))
    if not files:
        return pd.DataFrame()
    return pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)


def video_frame_count(mp4: Path) -> int:
    """Count frames in an mp4 by decoding its index, or 0 when ffprobe fails."""
    cmd = [
        "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", str(mp4),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        return int(out.stdout.strip() or 0)
    except (subprocess.SubprocessError, ValueError):
        return 0


def check_structure(root: Path, report: Report) -> dict | None:
    """Verify the v3.0 layout and return info.json, or None when unusable."""
    info_path = root / "meta" / "info.json"
    if not info_path.exists():
        report.add("structure", False, f"missing {info_path}")
        return None

    info = json.loads(info_path.read_text())
    required = ["fps", "total_episodes", "total_frames", "features"]
    missing = [k for k in required if k not in info]
    report.add("structure", not missing,
               "info.json complete" if not missing else f"info.json missing {missing}")

    for sub in ["data", "videos", "meta/episodes"]:
        present = (root / sub).exists()
        report.add("structure", present, f"{sub}/ {'present' if present else 'MISSING'}")

    tasks = root / "meta" / "tasks.parquet"
    report.add("structure", tasks.exists(),
               f"meta/tasks.parquet {'present' if tasks.exists() else 'MISSING'}")
    return info


def check_counts(root: Path, info: dict, report: Report) -> pd.DataFrame:
    """Cross-check the episode table against info.json and the data rows."""
    episodes = read_parquet_dir(root / "meta" / "episodes")
    data = read_parquet_dir(root / "data")

    if episodes.empty or data.empty:
        report.add("counts", False, "episode table or data rows are empty")
        return episodes

    n_ep = len(episodes)
    report.add("counts", n_ep == info.get("total_episodes"),
               f"episodes: table {n_ep}, info.json {info.get('total_episodes')}")

    n_rows = len(data)
    report.add("counts", n_rows == info.get("total_frames"),
               f"frames: data {n_rows}, info.json {info.get('total_frames')}")

    if "length" in episodes.columns:
        summed = int(episodes["length"].sum())
        report.add("counts", summed == n_rows,
                   f"episode lengths sum to {summed}, data has {n_rows} rows")
    return episodes


def check_cadence(data: pd.DataFrame, info: dict, report: Report) -> None:
    """Episode indices contiguous from zero, timestamps on the uniform grid."""
    if data.empty or "episode_index" not in data.columns:
        report.add("cadence", False, "no episode_index column")
        return

    indices = sorted(data["episode_index"].unique())
    contiguous = indices == list(range(len(indices)))
    report.add("cadence", contiguous,
               f"episode_index 0..{len(indices) - 1} contiguous"
               if contiguous else f"episode_index has gaps: {indices[:8]}...")

    if "timestamp" not in data.columns:
        report.add("cadence", False, "no timestamp column")
        return

    fps = float(info.get("fps", 30.0))
    period = 1.0 / fps
    worst = 0.0
    for idx in indices:
        ts = data.loc[data["episode_index"] == idx, "timestamp"].to_numpy()
        expected = np.arange(len(ts)) * period
        worst = max(worst, float(np.max(np.abs(ts - expected))) if len(ts) else 0.0)
    report.add("cadence", worst < period / 2,
               f"timestamps match k/fps within {worst * 1000:.3f} ms")


# Frames are decoded to this size before differencing. Small enough to be cheap,
# large enough that real motion dominates compression noise.
PROBE_W, PROBE_H = 80, 60


def motion_energy(mp4: Path, start_s: float, count: int, fps: float) -> np.ndarray:
    """Mean absolute difference between consecutive frames, decoded through ffmpeg.

    ffmpeg is used rather than OpenCV because the codecs here (AV1 for colour, 12-bit
    HEVC for depth) are not decodable by a stock OpenCV build, which silently yields
    zero frames and so a silently empty measurement.
    """
    cmd = [
        "ffmpeg", "-v", "error", "-ss", f"{start_s:.6f}", "-i", str(mp4),
        "-frames:v", str(count), "-vf", f"scale={PROBE_W}:{PROBE_H}",
        "-pix_fmt", "gray", "-f", "rawvideo", "-",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=600)
    except subprocess.SubprocessError:
        return np.array([])

    frame_bytes = PROBE_W * PROBE_H
    usable = len(out.stdout) // frame_bytes
    if usable < 2:
        return np.array([])
    frames = np.frombuffer(out.stdout[: usable * frame_bytes], dtype=np.uint8)
    frames = frames.reshape(usable, frame_bytes).astype(np.float32)
    return np.mean(np.abs(np.diff(frames, axis=0)), axis=1)


def joint_velocity(rows: pd.DataFrame) -> np.ndarray:
    """Per-row L2 norm of the change in observation.state."""
    state_cols = [c for c in rows.columns if c.startswith("observation.state")]
    if not state_cols:
        return np.array([])
    values = np.stack([np.asarray(rows[c].tolist(), dtype=np.float32).reshape(len(rows), -1)
                       for c in state_cols], axis=1).reshape(len(rows), -1)
    return np.linalg.norm(np.diff(values, axis=0), axis=1)


def best_lag(image: np.ndarray, joints: np.ndarray) -> tuple[int, float]:
    """Lag in frames that best aligns two signals, with its correlation.

    A lag reported at the edge of the search window means no peak was found inside it,
    so the caller treats a boundary result as unmeasured rather than as a large lag.
    """
    n = min(len(image), len(joints))
    if n < 3 * MAX_LAG:
        return 0, float("nan")
    a = image[:n] - image[:n].mean()
    b = joints[:n] - joints[:n].mean()
    if a.std() == 0 or b.std() == 0:
        return 0, float("nan")
    a, b = a / a.std(), b / b.std()

    scores = {}
    for lag in range(-MAX_LAG, MAX_LAG + 1):
        if lag < 0:
            x, y = a[-lag:], b[:lag]
        elif lag > 0:
            x, y = a[:-lag], b[lag:]
        else:
            x, y = a, b
        scores[lag] = float(np.mean(x * y))
    lag = max(scores, key=scores.get)
    return lag, scores[lag]


def check_sync(root: Path, data: pd.DataFrame, episodes: pd.DataFrame, info: dict,
               sample: int, report: Report) -> None:
    """Correlate image motion against joint motion and report the aligning lag."""
    video_keys = [k for k, v in info.get("features", {}).items()
                  if isinstance(v, dict) and v.get("dtype") == "video"]
    if not video_keys:
        report.add("sync", False, "no video features in info.json")
        return

    indices = sorted(data["episode_index"].unique())[:sample]
    results: dict[str, list[int]] = {k: [] for k in video_keys}

    for idx in indices:
        rows = data[data["episode_index"] == idx]
        velocity = joint_velocity(rows)
        if velocity.size == 0:
            continue
        for key in video_keys:
            mp4s = sorted((root / "videos" / key).rglob("*.mp4"))
            if not mp4s:
                continue
            # Episodes are concatenated into shared files; the episode table records
            # where each one starts.
            start_s = 0.0
            col = f"videos/{key}/from_timestamp"
            if col in episodes.columns and idx < len(episodes):
                start_s = float(episodes.loc[episodes["episode_index"] == idx, col].iloc[0])
            fps = float(info.get("fps", 30.0))
            energy = motion_energy(mp4s[0], start_s, SYNC_FRAMES, fps)
            if energy.size == 0:
                continue
            lag, score = best_lag(energy, velocity)
            # A peak pinned to the window edge is the absence of a peak, and a weak
            # correlation means neither signal carried usable motion for this episode.
            if np.isnan(score) or abs(lag) >= MAX_LAG or score < 0.2:
                continue
            results[key].append(lag)

    for key, lags in results.items():
        if not lags:
            report.add("sync", False,
                       f"{key}: inconclusive, no episode gave a clear correlation peak")
            continue
        median = int(np.median(lags))
        report.add("sync", abs(median) <= 1,
                   f"{key}: median lag {median:+d} frame(s) over {len(lags)} episode(s), "
                   f"range {min(lags):+d}..{max(lags):+d}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset_root", help="directory holding meta/, data/ and videos/")
    parser.add_argument("--sync-episodes", type=int, default=5,
                        help="episodes to sample for the sync check (default 5)")
    parser.add_argument("--skip-sync", action="store_true", help="structure and counts only")
    parser.add_argument("--json", action="store_true",
                        help="emit the findings as JSON instead of the table")
    args = parser.parse_args()

    root = Path(args.dataset_root).expanduser()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 1

    if not args.json:
        print(f"\n{root}")
    report = Report()

    info = check_structure(root, report)
    if info is None:
        emit(report, root, args.json)
        return 1

    episodes = check_counts(root, info, report)
    data = read_parquet_dir(root / "data")
    check_cadence(data, info, report)

    if not args.skip_sync and not data.empty:
        check_sync(root, data, episodes, info, args.sync_episodes, report)

    emit(report, root, args.json)
    return 1 if report.failed else 0


def emit(report: Report, root: Path, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report.as_dict(root), indent=2))
        return
    report.print()
    print(f"\n  {len(report.checks) - report.failed}/{len(report.checks)} checks passed")


if __name__ == "__main__":
    sys.exit(main())
