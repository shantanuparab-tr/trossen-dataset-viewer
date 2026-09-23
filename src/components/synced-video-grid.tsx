"use client";

/**
 * Several camera clips played as one: a single play/pause and scrub bar drives
 * every tile, and drifting tiles are pulled back onto the leader's clock.
 *
 * The clips come from different cameras in the same recording, which free-run
 * on their own clocks (28.29 Hz next to 31.12 Hz in a real episode), so their
 * frame counts and durations differ. Position in seconds is the only thing
 * they share, so that is what is synchronized.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

/** How far a tile may drift from the leader before it is snapped back. */
const DRIFT_TOLERANCE_S = 0.15;

export interface SyncedSource {
  topic: string;
  url: string;
}

export default function SyncedVideoGrid({
  sources,
  onTimeChange,
  seekTo,
}: {
  sources: SyncedSource[];
  /** Called with the playhead in seconds, for anything drawn alongside. */
  onTimeChange?: (seconds: number) => void;
  /** A seek requested from outside; `nonce` makes a repeat of the same second
   *  still count as a new request. */
  seekTo?: { seconds: number; nonce: number };
}) {
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Keep the ref array the same length as the tile list, so an index always
  // refers to the same topic.
  videos.current.length = sources.length;

  const forEachVideo = useCallback(
    (fn: (video: HTMLVideoElement, index: number) => void) => {
      videos.current.forEach((video, index) => {
        if (video) fn(video, index);
      });
    },
    [],
  );

  const seekAll = useCallback(
    (seconds: number) => {
      forEachVideo((video) => {
        video.currentTime = Math.min(seconds, video.duration || seconds);
      });
      setTime(seconds);
      onTimeChange?.(seconds);
    },
    [forEachVideo, onTimeChange],
  );

  useEffect(() => {
    if (seekTo) seekAll(seekTo.seconds);
    // Only a new request seeks; seekAll changing identity must not re-seek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTo?.nonce]);

  useEffect(() => {
    if (playing) {
      forEachVideo((video) => void video.play().catch(() => {}));
    } else {
      forEachVideo((video) => video.pause());
    }
  }, [playing, forEachVideo, sources]);

  // Reset when the recording (and so the tile list) changes.
  useEffect(() => {
    setTime(0);
    setDuration(0);
    setPlaying(true);
  }, [sources]);

  const onLeaderTime = useCallback(() => {
    const leader = videos.current[0];
    if (!leader) return;
    setTime(leader.currentTime);
    onTimeChange?.(leader.currentTime);
    forEachVideo((video, index) => {
      if (index === 0) return;
      const target = Math.min(leader.currentTime, video.duration || Infinity);
      if (Math.abs(video.currentTime - target) > DRIFT_TOLERANCE_S) {
        video.currentTime = target;
      }
    });
  }, [forEachVideo, onTimeChange]);

  // The leader drives the loop: every tile restarts together rather than each
  // wrapping at its own duration.
  const onLeaderEnded = useCallback(() => {
    forEachVideo((video) => {
      video.currentTime = 0;
      void video.play().catch(() => {});
    });
    setTime(0);
    onTimeChange?.(0);
  }, [forEachVideo, onTimeChange]);

  if (sources.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="panel flex items-center gap-3 p-3">
        <button
          onClick={() => setPlaying((prev) => !prev)}
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-white/5"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          onClick={() => seekAll(0)}
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/5"
          title="Back to start"
        >
          ⟲
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={time}
          onChange={(e) => seekAll(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400"
        />
        <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-500">
          {time.toFixed(2)} / {duration.toFixed(2)} s
        </span>
      </div>

      <div className="flex flex-wrap gap-4">
        {sources.map((source, index) => (
          <div key={source.topic} className="w-96 max-w-full">
            <p className="truncate rounded-t-md border border-b-0 border-white/5 bg-[var(--surface-1)] px-2.5 py-1 text-[11px] text-slate-400">
              {source.topic}
            </p>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={(el) => {
                videos.current[index] = el;
              }}
              className="w-full rounded-b-md bg-black object-contain"
              src={source.url}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => {
                const video = e.currentTarget;
                setDuration((prev) => Math.max(prev, video.duration || 0));
                if (playing) void video.play().catch(() => {});
              }}
              onTimeUpdate={index === 0 ? onLeaderTime : undefined}
              onEnded={index === 0 ? onLeaderEnded : undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
