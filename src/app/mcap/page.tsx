"use client";

/**
 * Inspector for the raw MCAP recordings, before anything is converted: which
 * topics a recording actually carries, how many messages each holds and at
 * what rate, and whether the file was indexed (a recorder that was killed
 * leaves an unindexed file, which is itself the finding).
 *
 * Recordings group by the directory they live in, which is how the datasets
 * are laid out on the rigs, so the left nav walks datasets and episodes the
 * same way the LeRobot viewer does.
 *
 * Image topics can be previewed: the server decodes the recording's raw frames
 * and returns an H.264 clip, so only the clip crosses the wire. The frames
 * themselves are uncompressed BGR8/16-bit at gigabytes a minute, which no
 * browser can decode and nobody wants to download.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathReview } from "@/context/path-review";
import SyncedVideoGrid from "@/components/synced-video-grid";
import JointPlots from "@/components/joint-plots";
import DatasetRoots from "@/components/dataset-roots";
import { episodeName } from "@/utils/episodeNames";
import { MetadataValue } from "@/components/json-view";
import type { Verdict } from "@/context/review-context";
import {
  listMcapFiles,
  fetchMcapSummary,
  fetchMcapJoints,
  mcapPreviewUrl,
  type McapChannel,
  type McapJointStream,
  type McapFileEntry,
  type McapSummary,
} from "@/utils/versionUtils";

/**
 * Topics the server can turn into a clip: the camera ones, in either storage
 * format. A recording made before video storage existed holds `RawImage`; one
 * recorded, or transcoded, since holds `CompressedVideo`.
 */
function isImageTopic(channel: McapChannel): boolean {
  return (
    channel.schema.endsWith("RawImage") ||
    channel.schema.endsWith("Image") ||
    channel.schema.endsWith("CompressedVideo")
  );
}

/**
 * What the recorder wrote on the channel. Today that is `stream_type` and, on
 * video recordings, `video_format`; anything the recorder starts attaching
 * (camera model, serial, arm model) shows up here without a change to this
 * page. Keys are printed as written so nothing is silently dropped.
 */
function ChannelHardware({ metadata }: { metadata?: Record<string, string> }) {
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) {
    return <span className="text-slate-600">not recorded</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <span
          key={key}
          className="rounded-full border border-white/10 bg-[var(--surface-0)]/60 px-2 py-0.5 text-[10px] text-slate-400"
        >
          <span className="text-slate-500">{key}</span> {value}
        </span>
      ))}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} kB`;
}

/** The dataset a recording belongs to: everything above its filename. */
function datasetOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "." : path.slice(0, cut);
}

function episodeOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.mcap$/, "");
}

export default function McapInspector() {
  const [files, setFiles] = useState<McapFileEntry[]>([]);
  const [dataset, setDataset] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState<McapSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each preview costs a decode + encode of the topic's frames, so tiles are
  // opened on request rather than all at once.
  const [previews, setPreviews] = useState<string[]>([]);
  const [joints, setJoints] = useState<McapJointStream[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [seekTo, setSeekTo] = useState<{ seconds: number; nonce: number }>();
  const [rejectedOnly, setRejectedOnly] = useState(false);
  const [newLabel, setNewLabel] = useState("");

  const review = usePathReview("mcap");

  useEffect(() => {
    listMcapFiles().then((found) => {
      setFiles(found);
      if (found.length > 0) setDataset(datasetOf(found[0].path));
    });
  }, []);

  const datasets = useMemo(
    () => [...new Set(files.map((f) => datasetOf(f.path)))].sort(),
    [files],
  );

  const episodes = useMemo(() => {
    const inDataset = files.filter((f) => datasetOf(f.path) === dataset);
    if (!rejectedOnly) return inDataset;
    return inDataset.filter((f) => review.verdictOf(f.path) === "bad");
  }, [files, dataset, rejectedOnly, review]);

  const open = useCallback((path: string) => {
    setSelected(path);
    setSummary(null);
    setError(null);
    setPreviews([]);
    setJoints([]);
    setPlayhead(0);
    setLoading(true);
    // The plots are a second, slower read of the same file (every joint message
    // is decoded), so they fill in after the summary rather than holding it up.
    fetchMcapJoints(path)
      .then(setJoints)
      .catch(() => setJoints([]));
    fetchMcapSummary(path)
      .then((result) => {
        if (result.error) {
          setError(result.error);
          return;
        }
        setSummary(result);
        // Cameras are what someone opens a recording to look at, so the tiles
        // come up without being asked for. Each one is a cached transcode
        // after the first visit.
        setPreviews(
          result.channels.filter(isImageTopic).map((channel) => channel.topic),
        );
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  // Marking a verdict moves to the next recording, so a pass through a dataset
  // is one click per episode, as on the LeRobot side.
  const mark = useCallback(
    (verdict: Verdict | null) => {
      if (!selected) return;
      review.setVerdict(selected, verdict);
      if (verdict === null) return;
      const index = episodes.findIndex((f) => f.path === selected);
      const next = episodes[index + 1];
      if (next) open(next.path);
    },
    [selected, episodes, review, open],
  );

  const download = useCallback(() => {
    const rejected = Object.entries(review.verdicts)
      .filter(([, v]) => v === "bad")
      .map(([path]) => path)
      .sort();
    const good = Object.entries(review.verdicts)
      .filter(([, v]) => v === "good")
      .map(([path]) => path)
      .sort();
    const payload = {
      source: "mcap",
      reviewedAt: new Date().toISOString(),
      reviewed: review.counts.reviewed,
      good,
      rejected,
      labels: review.labels,
      palette: review.palette,
      verdicts: review.verdicts,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "mcap-review.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [review]);

  // Rates that disagree across cameras, or a channel that stopped early, are
  // what someone opens this page to notice.
  const maxHz = Math.max(1, ...(summary?.channels ?? []).map((c) => c.hz ?? 0));
  const verdict = selected ? review.verdictOf(selected) : undefined;
  const applied = selected ? review.labelsOf(selected) : [];

  const verdictDot = (path: string) => {
    const v = review.verdictOf(path);
    return (
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          v === "good"
            ? "bg-green-400"
            : v === "bad"
              ? "bg-red-400"
              : "bg-white/10"
        }`}
        title={v ?? "not reviewed"}
      />
    );
  };

  return (
    <div className="flex h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      <nav className="w-80 shrink-0 overflow-y-auto border-r border-white/5 bg-[var(--surface-0)] p-4">
        <Link
          href="/"
          className="block opacity-90 transition-opacity hover:opacity-100"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/trossen-logo.png"
            alt="Trossen Robotics"
            className="h-5 w-auto object-contain"
          />
        </Link>
        <Link
          href="/"
          className="mt-2 block text-[10px] uppercase tracking-widest text-slate-500 hover:text-slate-300"
        >
          ← Datasets
        </Link>
        <Link
          href="/tools"
          className="block text-[10px] uppercase tracking-widest text-slate-500 hover:text-slate-300"
        >
          Tools →
        </Link>

        <DatasetRoots
          kind="mcap"
          onChange={() =>
            listMcapFiles().then((found) => {
              setFiles(found);
              if (found.length > 0 && !dataset) {
                setDataset(datasetOf(found[0].path));
              }
            })
          }
        />

        <p className="mt-4 text-[10px] uppercase tracking-wide text-slate-500">
          Dataset
        </p>
        <select
          value={dataset ?? ""}
          onChange={(e) => {
            setDataset(e.target.value);
            setSelected(null);
            setSummary(null);
          }}
          className="mt-1 w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs text-slate-200"
        >
          {datasets.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            Episodes · {episodes.length}
          </p>
          {review.counts.reviewed > 0 && (
            <span className="text-[10px] tabular-nums text-slate-500">
              {review.counts.reviewed} reviewed
            </span>
          )}
        </div>

        {review.counts.rejected > 0 && (
          <button
            onClick={() => setRejectedOnly((prev) => !prev)}
            className={`mt-2 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors ${
              rejectedOnly
                ? "border-red-500/30 bg-red-500/15 text-red-300"
                : "border-white/10 text-slate-500 hover:text-slate-300"
            }`}
          >
            Rejected · {review.counts.rejected}
          </button>
        )}

        <ul className="mt-2 space-y-px">
          {episodes.map((file) => (
            <li key={file.path}>
              <button
                onClick={() => open(file.path)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  file.path === selected
                    ? "bg-cyan-400/10 text-cyan-300"
                    : "text-slate-300 hover:bg-white/5"
                }`}
              >
                {verdictDot(file.path)}
                <span className="flex-1 truncate">
                  {episodeName(episodeOf(file.path)).label}
                </span>
                {episodeName(episodeOf(file.path)).detail && (
                  <span
                    className="shrink-0 font-mono text-[10px] text-slate-600"
                    title={episodeOf(file.path)}
                  >
                    {episodeName(episodeOf(file.path)).detail}
                  </span>
                )}
                <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                  {formatBytes(file.size)}
                </span>
              </button>
            </li>
          ))}
          {files.length === 0 && (
            <li className="px-2 py-3 text-xs text-slate-500">
              No recordings. Start the server with{" "}
              <code>--mcap-root &lt;dir&gt;</code>.
            </li>
          )}
        </ul>
      </nav>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-xl font-bold text-slate-100">MCAP Inspector</h1>
            <p className="mt-1 text-sm text-slate-400">
              Topics, message counts and rates straight from the recording.
              Messages are counted, never decoded, so this stays fast on
              multi-gigabyte files.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs">
            <span className="tabular-nums text-slate-500">
              {review.counts.reviewed} reviewed · {review.counts.good} good ·{" "}
              {review.counts.rejected} rejected
            </span>
            <button
              onClick={download}
              disabled={review.counts.reviewed === 0}
              className="text-slate-400 transition-colors hover:text-cyan-300 disabled:opacity-40"
            >
              Download verdicts
            </button>
            <button
              onClick={review.clear}
              disabled={review.counts.reviewed === 0}
              className="text-slate-500 transition-colors hover:text-red-400 disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </div>

        {loading && (
          <p className="mt-8 text-sm text-slate-400">Reading recording…</p>
        )}
        {error && (
          <p className="mt-8 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </p>
        )}

        {summary && (
          <div className="mt-6 space-y-6">
            <div className="panel flex flex-wrap items-center gap-3 p-3">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                Review
              </span>
              <button
                onClick={() => mark("good")}
                className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                  verdict === "good"
                    ? "border-green-500/40 bg-green-500/15 text-green-300"
                    : "border-white/10 text-slate-400 hover:bg-white/5"
                }`}
              >
                Good
              </button>
              <button
                onClick={() => mark("bad")}
                className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                  verdict === "bad"
                    ? "border-red-500/40 bg-red-500/15 text-red-300"
                    : "border-white/10 text-slate-400 hover:bg-white/5"
                }`}
              >
                Reject
              </button>
              {verdict && (
                <button
                  onClick={() => mark(null)}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/5"
                >
                  Clear
                </button>
              )}
              {review.palette.map((label, index) => (
                <button
                  key={label}
                  onClick={() =>
                    selected && review.toggleLabel(selected, label)
                  }
                  title={index < 9 ? `Toggle with ${index + 1}` : undefined}
                  className={`rounded-full border px-2 py-1 text-[11px] transition-colors ${
                    applied.includes(label)
                      ? "border-cyan-400/50 bg-cyan-400/20 text-cyan-200"
                      : "border-white/10 text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {label}
                </button>
              ))}
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !newLabel.trim() || !selected)
                    return;
                  review.addLabel(newLabel);
                  review.toggleLabel(selected, newLabel.trim());
                  setNewLabel("");
                }}
                placeholder="+ label"
                className="w-24 rounded-full border border-dashed border-white/15 bg-transparent px-2 py-1 text-[11px] text-slate-300 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
              />
              <span className="ml-auto truncate text-xs text-slate-500">
                {summary.path}
              </span>
            </div>

            <SyncedVideoGrid
              sources={previews.map((topic) => ({
                topic,
                url: mcapPreviewUrl(summary.path, topic),
              }))}
              onTimeChange={setPlayhead}
              seekTo={seekTo}
            />

            <JointPlots
              streams={joints}
              time={playhead}
              onSeek={(seconds) => setSeekTo({ seconds, nonce: Date.now() })}
            />

            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 rounded-lg border border-white/10 bg-[var(--surface-1)]/60 p-5 text-sm sm:grid-cols-4">
              {[
                ["Duration", `${summary.durationSeconds.toFixed(2)} s`],
                ["Messages", summary.messageCount.toLocaleString()],
                ["Size", formatBytes(summary.size)],
                ["Channels", String(summary.channels.length)],
                ["Profile", summary.profile || "—"],
                ["Writer", summary.library || "—"],
                [
                  "Index",
                  summary.indexed
                    ? "present"
                    : "missing (recording cut short?)",
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[10px] uppercase tracking-wide text-slate-500">
                    {label}
                  </dt>
                  <dd
                    className={`tabular-nums ${
                      label === "Index" && !summary.indexed
                        ? "text-amber-300"
                        : "text-slate-200"
                    }`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>

            {Object.keys(summary.metadata).length > 0 && (
              <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/60 p-5">
                <h2 className="text-sm font-semibold text-slate-200">
                  Recording metadata
                </h2>
                {Object.entries(summary.metadata).map(([name, fields]) => (
                  <div key={name} className="mt-3">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">
                      {name}
                    </p>
                    <dl className="mt-1 grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 text-xs">
                      {Object.entries(fields).map(([key, value]) => (
                        <React.Fragment key={key}>
                          <dt className="pt-0.5 text-slate-500">{key}</dt>
                          <dd className="min-w-0">
                            <MetadataValue value={value} />
                          </dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            )}

            <div className="overflow-hidden rounded-lg border border-white/10">
              <table className="w-full text-left text-xs">
                <thead className="bg-[var(--surface-1)]/60 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Topic</th>
                    <th className="px-4 py-2 font-medium">Schema</th>
                    <th className="px-4 py-2 text-right font-medium">
                      Messages
                    </th>
                    <th className="px-4 py-2 font-medium">Rate</th>
                    <th className="px-4 py-2 font-medium">Hardware</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {summary.channels.map((channel) => (
                    <tr
                      key={channel.topic}
                      className="border-t border-white/5 text-slate-300"
                    >
                      <td className="px-4 py-2 font-medium">{channel.topic}</td>
                      <td className="px-4 py-2 text-slate-500">
                        {channel.schema}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {channel.count.toLocaleString()}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/5">
                            <div
                              className="h-full rounded-full bg-cyan-500"
                              style={{
                                width: `${((channel.hz ?? 0) / maxHz) * 100}%`,
                              }}
                            />
                          </div>
                          <span className="tabular-nums text-slate-400">
                            {channel.hz === null
                              ? "—"
                              : `${channel.hz.toFixed(2)} Hz`}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <ChannelHardware metadata={channel.channelMetadata} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        {isImageTopic(channel) && (
                          <button
                            onClick={() =>
                              setPreviews((prev) =>
                                prev.includes(channel.topic)
                                  ? prev.filter((t) => t !== channel.topic)
                                  : [...prev, channel.topic],
                              )
                            }
                            className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                              previews.includes(channel.topic)
                                ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-300"
                                : "border-white/10 text-slate-400 hover:bg-white/5"
                            }`}
                          >
                            Preview
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!summary && !loading && !error && (
          <p className="mt-8 text-sm text-slate-500">
            Pick a recording on the left.
          </p>
        )}
      </main>
    </div>
  );
}
