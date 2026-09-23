"use client";

/**
 * Good / bad verdict for the episode on screen, its labels, and the keyboard
 * shortcuts a review pass runs on: `g` good, `b` reject, `x` clear, `n` next
 * unreviewed, and `1`-`9` to toggle the first nine labels. Marking a verdict
 * jumps to the next episode so a pass is one keystroke per episode.
 *
 * Labels are independent of the verdict, so `1` on a good episode is how an
 * action item ("change task prompt") gets recorded without rejecting it.
 *
 * A leaf component on purpose: it subscribes to the review store, which the
 * 800-line viewer above it does not have to.
 */

import React, { useCallback, useEffect } from "react";
import { useReview, type Verdict } from "@/context/review-context";

interface ReviewBarProps {
  episodeId: number;
  episodes: number[];
  onNavigate: (episodeId: number) => void;
}

/** Skip the shortcuts while the user is typing into a field. */
function inTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

const ReviewBar: React.FC<ReviewBarProps> = ({
  episodeId,
  episodes,
  onNavigate,
}) => {
  const {
    verdictOf,
    setVerdict,
    labelsOf,
    toggleLabel,
    addLabel,
    palette,
    reviewedCount,
    goodCount,
    count,
  } = useReview();
  const current = verdictOf(episodeId);
  const applied = labelsOf(episodeId);
  const [newLabel, setNewLabel] = React.useState("");

  const mark = useCallback(
    (verdict: Verdict | null) => {
      setVerdict(episodeId, verdict);
      if (verdict === null) return;
      const next = episodes[episodes.indexOf(episodeId) + 1];
      if (next !== undefined) onNavigate(next);
    },
    [episodeId, episodes, onNavigate, setVerdict],
  );

  // Wraps around, so `n` keeps finding work until the pass is complete.
  const goToNextUnreviewed = useCallback(() => {
    const start = episodes.indexOf(episodeId);
    for (let i = 1; i <= episodes.length; i++) {
      const candidate = episodes[(start + i) % episodes.length];
      if (verdictOf(candidate) === undefined) {
        onNavigate(candidate);
        return;
      }
    }
  }, [episodeId, episodes, onNavigate, verdictOf]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inTextEntry(e.target)) return;
      if (e.key === "g") mark("good");
      else if (e.key === "b") mark("bad");
      else if (e.key === "x") mark(null);
      else if (e.key === "n") goToNextUnreviewed();
      else if (e.key >= "1" && e.key <= "9") {
        const label = palette[Number(e.key) - 1];
        if (!label) return;
        toggleLabel(episodeId, label);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mark, goToNextUnreviewed, palette, toggleLabel, episodeId]);

  const btn = (
    verdict: Verdict | null,
    label: string,
    key: string,
    tone: string,
  ) => {
    const active = current === verdict && verdict !== null;
    return (
      <button
        onClick={() => mark(verdict)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors ${
          active ? tone : "text-slate-400 border-white/10 hover:bg-white/5"
        }`}
      >
        {label}
        <kbd className="text-[10px] font-mono bg-white/10 rounded px-1 leading-tight">
          {key}
        </kbd>
      </button>
    );
  };

  return (
    <div className="panel p-3 flex flex-wrap items-center gap-3">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">
        Review
      </span>
      {btn(
        "good",
        "Good",
        "g",
        "bg-green-500/15 text-green-300 border-green-500/40",
      )}
      {btn(
        "bad",
        "Reject",
        "b",
        "bg-red-500/15 text-red-300 border-red-500/40",
      )}
      {current && btn(null, "Clear", "x", "")}

      <span className="flex flex-wrap items-center gap-1.5">
        {palette.map((label, index) => {
          const on = applied.includes(label);
          return (
            <button
              key={label}
              onClick={() => toggleLabel(episodeId, label)}
              title={index < 9 ? `Toggle with ${index + 1}` : undefined}
              className={`rounded-full border px-2 py-1 text-[11px] transition-colors ${
                on
                  ? "border-cyan-400/50 bg-cyan-400/20 text-cyan-200"
                  : "border-white/10 text-slate-500 hover:text-slate-300"
              }`}
            >
              {label}
            </button>
          );
        })}
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !newLabel.trim()) return;
            addLabel(newLabel);
            toggleLabel(episodeId, newLabel.trim());
            setNewLabel("");
          }}
          placeholder="+ label"
          className="w-24 rounded-full border border-dashed border-white/15 bg-transparent px-2 py-1 text-[11px] text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400/40"
        />
      </span>

      <button
        onClick={goToNextUnreviewed}
        className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-slate-400 border border-white/10 hover:bg-white/5 transition-colors"
      >
        Next unreviewed
        <kbd className="text-[10px] font-mono bg-white/10 rounded px-1 leading-tight">
          n
        </kbd>
      </button>
      <span className="text-xs text-slate-500 tabular-nums">
        {reviewedCount} / {episodes.length} reviewed · {goodCount} good ·{" "}
        {count} rejected
      </span>
    </div>
  );
};

export default ReviewBar;
