"use client";

/**
 * Joint positions over an episode, one plot per robot stream, drawn against the
 * same clock as the camera tiles.
 *
 * Cameras show what happened; the joint traces show what the arms were doing
 * while it happened, which is what separates "the gripper missed" from "the
 * gripper never closed". A cursor marks the instant on screen in the tiles, and
 * clicking a plot seeks there.
 */

import React, { useMemo } from "react";

import type { McapJointStream } from "@/utils/versionUtils";

/** Plot box in user units; the SVG scales to whatever width it is given. */
const VIEW_W = 1000;
const VIEW_H = 160;

/** Line colors, cycled per joint. Distinct at a glance on a dark background. */
const LINE_COLORS = [
  "#55bde3",
  "#f0a35e",
  "#8ad36b",
  "#e36d8f",
  "#b79ae0",
  "#e3d45f",
  "#6fd9c2",
];

function pathFor(
  values: number[],
  times: number[],
  min: number,
  span: number,
  duration: number,
): string {
  return values
    .map((value, index) => {
      const x = (times[index] / duration) * VIEW_W;
      const y = VIEW_H - ((value - min) / span) * VIEW_H;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function StreamPlot({
  stream,
  time,
  onSeek,
}: {
  stream: McapJointStream;
  time: number;
  onSeek: (seconds: number) => void;
}) {
  const plot = useMemo(() => {
    const duration = stream.t[stream.t.length - 1] || 1;
    const jointCount = stream.positions[0]?.length ?? 0;
    // One shared vertical scale per stream: the joints of one arm are the same
    // kind of quantity, and a per-joint scale would make a still joint look as
    // busy as a moving one.
    let min = Infinity;
    let max = -Infinity;
    for (const row of stream.positions) {
      for (const value of row) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (!Number.isFinite(min)) {
      min = 0;
      max = 1;
    }
    const span = max - min || 1;
    const lines = Array.from({ length: jointCount }, (_, joint) =>
      pathFor(
        stream.positions.map((row) => row[joint] ?? min),
        stream.t,
        min,
        span,
        duration,
      ),
    );
    return { duration, lines, min, max };
  }, [stream]);

  const cursorX = Math.min(
    VIEW_W,
    Math.max(0, (time / plot.duration) * VIEW_W),
  );

  return (
    <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/60 p-4">
      <div className="flex items-baseline gap-3">
        <h3 className="font-mono text-xs text-slate-200">{stream.stream}</h3>
        <span className="text-[10px] tabular-nums text-slate-500">
          {plot.min.toFixed(2)} … {plot.max.toFixed(2)} rad
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {plot.lines.map((_, joint) => (
            <span
              key={joint}
              className="flex items-center gap-1 text-[10px] text-slate-400"
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: LINE_COLORS[joint % LINE_COLORS.length] }}
              />
              {stream.names[joint] ?? `joint_${joint}`}
            </span>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="mt-3 h-32 w-full cursor-crosshair"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - box.left) / box.width;
          onSeek(Math.max(0, Math.min(1, fraction)) * plot.duration);
        }}
      >
        {plot.lines.map((d, joint) => (
          <path
            key={joint}
            d={d}
            fill="none"
            stroke={LINE_COLORS[joint % LINE_COLORS.length]}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line
          x1={cursorX}
          x2={cursorX}
          y1={0}
          y2={VIEW_H}
          stroke="#ffffff"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          opacity={0.6}
        />
      </svg>
    </div>
  );
}

export default function JointPlots({
  streams,
  time,
  onSeek,
}: {
  streams: McapJointStream[];
  time: number;
  onSeek: (seconds: number) => void;
}) {
  if (streams.length === 0) return null;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {streams.map((stream) => (
        <StreamPlot
          key={stream.topic}
          stream={stream}
          time={time}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}
