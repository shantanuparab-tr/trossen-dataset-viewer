#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcap>=1.2"]
# ///
"""Summarize the stream layout and timing of Trossen MCAP recordings.

Reports, per episode file: the file header, the recording metadata record, and
one row per channel giving the message count, the wall-clock span, the mean
rate, and the jitter of the inter-message interval. Run it against a directory
to get the same per-episode detail plus a dataset-level roll-up of the episode
count and the per-stream rate spread.

Rates come from message log times, which are the times the recorder stamped on
each message. A camera stream free-runs on its own clock, so its rate is not
expected to match the joint-state rate exactly; the spread reported here is what
a timestamp synchronization step has to absorb.

Requires only the base `mcap` package: messages are counted, never decoded.

Usage:
    ./mcap_analyze.py <file.mcap | dataset_dir> [...] [--json] [--publish-time]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

from mcap.reader import make_reader

NS_PER_S = 1_000_000_000


@dataclass
class ChannelStats:
    """Timing of one channel within a single episode."""

    topic: str
    schema: str
    message_encoding: str
    metadata: dict[str, str]
    count: int = 0
    first_ns: int | None = None
    last_ns: int | None = None
    deltas_ns: list[int] = field(default_factory=list)

    def observe(self, timestamp_ns: int) -> None:
        """Fold one message time into the running statistics."""
        if self.last_ns is not None:
            self.deltas_ns.append(timestamp_ns - self.last_ns)
        if self.first_ns is None:
            self.first_ns = timestamp_ns
        self.last_ns = timestamp_ns
        self.count += 1

    @property
    def span_s(self) -> float:
        """Seconds between the first and last message, 0.0 for fewer than two."""
        if self.first_ns is None or self.last_ns is None:
            return 0.0
        return (self.last_ns - self.first_ns) / NS_PER_S

    @property
    def fps(self) -> float:
        """Mean rate in Hz over the span, 0.0 when the span is empty."""
        span = self.span_s
        return (self.count - 1) / span if span > 0 else 0.0

    @property
    def median_dt_ms(self) -> float:
        """Median inter-message interval in milliseconds."""
        return statistics.median(self.deltas_ns) / 1e6 if self.deltas_ns else 0.0

    @property
    def jitter_ms(self) -> float:
        """Standard deviation of the inter-message interval, in milliseconds."""
        if len(self.deltas_ns) < 2:
            return 0.0
        return statistics.stdev(self.deltas_ns) / 1e6

    @property
    def max_gap_ms(self) -> float:
        """Largest inter-message interval in milliseconds, the worst dropout."""
        return max(self.deltas_ns) / 1e6 if self.deltas_ns else 0.0

    def as_dict(self) -> dict:
        return {
            "topic": self.topic,
            "schema": self.schema,
            "message_encoding": self.message_encoding,
            "channel_metadata": self.metadata,
            "count": self.count,
            "span_s": round(self.span_s, 3),
            "fps": round(self.fps, 2),
            "median_dt_ms": round(self.median_dt_ms, 3),
            "jitter_ms": round(self.jitter_ms, 3),
            "max_gap_ms": round(self.max_gap_ms, 3),
        }


@dataclass
class EpisodeReport:
    """Everything read out of one .mcap file."""

    path: Path
    profile: str
    library: str
    size_bytes: int
    message_count: int
    start_ns: int
    end_ns: int
    metadata: dict[str, dict[str, str]]
    channels: list[ChannelStats]

    @property
    def duration_s(self) -> float:
        return (self.end_ns - self.start_ns) / NS_PER_S if self.end_ns else 0.0

    @property
    def episode_id(self) -> str:
        """Recorded episode id, falling back to the file stem."""
        for record in self.metadata.values():
            if "episode_id" in record:
                return record["episode_id"]
        return self.path.stem

    def as_dict(self) -> dict:
        return {
            "file": str(self.path),
            "profile": self.profile,
            "library": self.library,
            "size_bytes": self.size_bytes,
            "episode_id": self.episode_id,
            "duration_s": round(self.duration_s, 3),
            "message_count": self.message_count,
            "metadata": self.metadata,
            "channels": [c.as_dict() for c in self.channels],
        }


def analyze_file(path: Path, use_publish_time: bool) -> EpisodeReport:
    """Read one MCAP file and return its header, metadata and per-channel timing."""
    with path.open("rb") as handle:
        reader = make_reader(handle)
        header = reader.get_header()
        summary = reader.get_summary()

        metadata = {record.name: dict(record.metadata) for record in reader.iter_metadata()}

        stats: dict[int, ChannelStats] = {}
        if summary is not None:
            for channel_id, channel in summary.channels.items():
                schema = summary.schemas.get(channel.schema_id) if channel.schema_id else None
                stats[channel_id] = ChannelStats(
                    topic=channel.topic,
                    schema=schema.name if schema else "",
                    message_encoding=channel.message_encoding,
                    metadata=dict(channel.metadata),
                )

        for _, channel, message in reader.iter_messages():
            entry = stats.get(channel.id)
            if entry is None:
                entry = ChannelStats(
                    topic=channel.topic,
                    schema="",
                    message_encoding=channel.message_encoding,
                    metadata=dict(channel.metadata),
                )
                stats[channel.id] = entry
            entry.observe(message.publish_time if use_publish_time else message.log_time)

        channels = sorted(stats.values(), key=lambda c: c.topic)
        totals = summary.statistics if summary else None
        return EpisodeReport(
            path=path,
            profile=header.profile,
            library=header.library,
            size_bytes=path.stat().st_size,
            message_count=totals.message_count if totals else sum(c.count for c in channels),
            start_ns=totals.message_start_time if totals else 0,
            end_ns=totals.message_end_time if totals else 0,
            metadata=metadata,
            channels=channels,
        )


def collect_paths(targets: list[str]) -> list[Path]:
    """Expand each argument into the .mcap files it names, sorted and deduplicated."""
    found: list[Path] = []
    for target in targets:
        path = Path(target).expanduser()
        if path.is_dir():
            found.extend(sorted(path.rglob("*.mcap")))
        elif path.is_file():
            found.append(path)
        else:
            print(f"skipping {path}: not a file or directory", file=sys.stderr)
    return list(dict.fromkeys(found))


def print_episode(report: EpisodeReport) -> None:
    """Print one episode's header, metadata and channel table."""
    print(f"\n{report.path}")
    print(
        f"  profile={report.profile}  library={report.library}  "
        f"size={report.size_bytes / 1e6:.1f} MB"
    )
    print(
        f"  episode={report.episode_id}  duration={report.duration_s:.2f} s  "
        f"messages={report.message_count}  channels={len(report.channels)}"
    )

    for name, record in report.metadata.items():
        print(f"  metadata [{name}]")
        for key, value in sorted(record.items()):
            if len(value) > 100:
                value = value[:97] + "..."
            print(f"    {key}: {value}")

    header = f"  {'topic':<44} {'count':>7} {'span_s':>8} {'fps':>8} {'dt_ms':>8} {'jit_ms':>8} {'gap_ms':>8}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for channel in report.channels:
        print(
            f"  {channel.topic:<44} {channel.count:>7} {channel.span_s:>8.2f} "
            f"{channel.fps:>8.2f} {channel.median_dt_ms:>8.2f} "
            f"{channel.jitter_ms:>8.2f} {channel.max_gap_ms:>8.2f}"
        )


def print_dataset(reports: list[EpisodeReport]) -> None:
    """Print the dataset roll-up: episode count and the per-topic rate spread."""
    print(f"\n{'=' * 100}")
    print(f"dataset: {len(reports)} episode(s)")
    total_duration = sum(r.duration_s for r in reports)
    total_messages = sum(r.message_count for r in reports)
    total_bytes = sum(r.size_bytes for r in reports)
    print(
        f"  total duration={total_duration:.1f} s  messages={total_messages}  "
        f"size={total_bytes / 1e9:.2f} GB"
    )

    rates: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    for report in reports:
        for channel in report.channels:
            if channel.fps > 0:
                rates.setdefault(channel.topic, []).append(channel.fps)
            counts[channel.topic] = counts.get(channel.topic, 0) + channel.count

    header = f"  {'topic':<44} {'episodes':>9} {'messages':>9} {'fps_min':>8} {'fps_mean':>9} {'fps_max':>8}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for topic in sorted(counts):
        seen = rates.get(topic, [])
        if seen:
            print(
                f"  {topic:<44} {len(seen):>9} {counts[topic]:>9} "
                f"{min(seen):>8.2f} {statistics.fmean(seen):>9.2f} {max(seen):>8.2f}"
            )
        else:
            print(f"  {topic:<44} {0:>9} {counts[topic]:>9} {'-':>8} {'-':>9} {'-':>8}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("targets", nargs="+", help="MCAP files, or directories searched recursively")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of the tables")
    parser.add_argument(
        "--publish-time",
        action="store_true",
        help="time messages by publish_time instead of log_time",
    )
    args = parser.parse_args()

    paths = collect_paths(args.targets)
    if not paths:
        print("no .mcap files found", file=sys.stderr)
        return 1

    reports = [analyze_file(path, args.publish_time) for path in paths]

    if args.json:
        print(json.dumps({"episodes": [r.as_dict() for r in reports]}, indent=2))
        return 0

    for report in reports:
        print_episode(report)
    if len(reports) > 1:
        print_dataset(reports)
    return 0


if __name__ == "__main__":
    sys.exit(main())
