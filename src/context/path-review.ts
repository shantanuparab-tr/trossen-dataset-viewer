"use client";

/**
 * Review verdicts keyed by file path, for things that are not LeRobot episodes
 * (raw MCAP recordings). Same verdicts, same reasons and same export shape as
 * `review-context`, which is keyed by episode index and carries the whole
 * episode viewer's state; this is a plain hook because the MCAP page is one
 * component and needs no provider.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_LABELS, type Verdict } from "@/context/review-context";

export { DEFAULT_LABELS };
export type { Verdict };

type Stored = {
  verdicts: Record<string, Verdict>;
  labels: Record<string, string[]>;
  palette: string[];
};

const EMPTY: Stored = { verdicts: {}, labels: {}, palette: [] };

function load(scope: string): Stored {
  try {
    const raw = localStorage.getItem(`review:${scope}`);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    const labels: Record<string, string[]> = { ...(parsed.labels ?? {}) };
    // A pass recorded before labels existed stored one reason per recording.
    for (const [path, reason] of Object.entries(
      (parsed.reasons ?? {}) as Record<string, string>,
    )) {
      if (!labels[path]?.length) labels[path] = [reason];
    }
    return {
      verdicts: parsed.verdicts ?? {},
      labels,
      palette: parsed.palette ?? [],
    };
  } catch {
    return EMPTY;
  }
}

export function usePathReview(scope: string) {
  const [state, setState] = useState<Stored>(EMPTY);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(false);
    setState(load(scope));
    setHydrated(true);
  }, [scope]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(`review:${scope}`, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [scope, state, hydrated]);

  const setVerdict = useCallback((path: string, verdict: Verdict | null) => {
    setState((prev) => {
      const next = { ...prev, verdicts: { ...prev.verdicts } };
      if (verdict === null) delete next.verdicts[path];
      else next.verdicts[path] = verdict;
      return next;
    });
  }, []);

  // Labels stand on their own: a recording can be worth keeping and still be
  // marked "change task prompt".
  const toggleLabel = useCallback((path: string, label: string) => {
    setState((prev) => {
      const current = prev.labels[path] ?? [];
      const next = { ...prev, labels: { ...prev.labels } };
      if (current.includes(label)) {
        const remaining = current.filter((entry) => entry !== label);
        if (remaining.length) next.labels[path] = remaining;
        else delete next.labels[path];
      } else {
        next.labels[path] = [...current, label];
      }
      return next;
    });
  }, []);

  const addLabel = useCallback((label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setState((prev) =>
      DEFAULT_LABELS.includes(trimmed as (typeof DEFAULT_LABELS)[number]) ||
      prev.palette.includes(trimmed)
        ? prev
        : { ...prev, palette: [...prev.palette, trimmed] },
    );
  }, []);

  const clear = useCallback(
    () => setState({ verdicts: {}, labels: {}, palette: [] }),
    [],
  );

  const counts = useMemo(() => {
    const values = Object.values(state.verdicts);
    return {
      reviewed: values.length,
      good: values.filter((v) => v === "good").length,
      rejected: values.filter((v) => v === "bad").length,
    };
  }, [state.verdicts]);

  return {
    verdicts: state.verdicts,
    labels: state.labels,
    palette: [...DEFAULT_LABELS, ...state.palette],
    verdictOf: (path: string) => state.verdicts[path],
    labelsOf: (path: string) => state.labels[path] ?? [],
    setVerdict,
    toggleLabel,
    addLabel,
    clear,
    counts,
  };
}
