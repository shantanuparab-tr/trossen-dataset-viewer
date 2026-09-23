"use client";

/**
 * Per-episode review verdicts for one dataset.
 *
 * A review pass is someone watching every episode and saying whether it is
 * good or bad; the rejects come out as a list to hand to `lerobot-edit-dataset`.
 * Verdicts are kept in localStorage under the dataset's repo id, so a pass
 * over a few hundred episodes survives reloads and restarts.
 *
 * `flagged` is the set of episodes marked bad. The heuristics in the Filtering
 * tab (low movement, jerky, outlier length) flag episodes through the same
 * store, so a flag and a "bad" verdict are one and the same thing.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
} from "react";

export type Verdict = "good" | "bad";

export type VerdictMap = Record<number, Verdict>;
/** Several labels per episode, independent of its verdict. */
export type LabelMap = Record<number, string[]>;

/**
 * The labels a pass starts with. They are not rejection reasons: "change task
 * prompt" is an action item for an episode worth keeping. A pass can add its
 * own, which are remembered alongside the verdicts.
 */
export const DEFAULT_LABELS = [
  "change task prompt",
  "too short",
  "incomplete task",
  "blurry",
  "collision",
  "wrong task",
  "truncated",
] as const;

type StoredReview = {
  verdicts: VerdictMap;
  labels: LabelMap;
  /** Labels this pass added on top of DEFAULT_LABELS. */
  palette: string[];
};

function storageKey(repoId: string) {
  return `review:${repoId}`;
}

function load(repoId: string): StoredReview {
  const empty: StoredReview = { verdicts: {}, labels: {}, palette: [] };
  try {
    const raw = localStorage.getItem(storageKey(repoId));
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    // Oldest passes stored the verdict map alone; the next ones added a single
    // `reasons` string per episode, which is now that episode's first label.
    if (parsed && typeof parsed === "object" && "verdicts" in parsed) {
      const labels: LabelMap = { ...((parsed.labels ?? {}) as LabelMap) };
      for (const [id, reason] of Object.entries(
        (parsed.reasons ?? {}) as Record<string, string>,
      )) {
        const key = Number(id);
        if (!labels[key]?.length) labels[key] = [reason];
      }
      return {
        verdicts: (parsed.verdicts ?? {}) as VerdictMap,
        labels,
        palette: (parsed.palette ?? []) as string[],
      };
    }
    return { verdicts: (parsed ?? {}) as VerdictMap, labels: {}, palette: [] };
  } catch {
    return empty;
  }
}

function save(repoId: string, review: StoredReview) {
  try {
    localStorage.setItem(storageKey(repoId), JSON.stringify(review));
  } catch {
    /* ignore */
  }
}

type ReviewContextType = {
  verdicts: VerdictMap;
  labels: LabelMap;
  /** Every label offered by the chips: the built-in set plus this pass's own. */
  palette: string[];
  verdictOf: (id: number) => Verdict | undefined;
  labelsOf: (id: number) => string[];
  setVerdict: (id: number, verdict: Verdict | null) => void;
  toggleLabel: (id: number, label: string) => void;
  /** Adds a label to the palette without applying it to anything. */
  addLabel: (label: string) => void;
  /** Merges an exported pass back in; imported values win on a conflict. */
  importReview: (incoming: Partial<StoredReview>) => void;
  reviewedCount: number;
  goodCount: number;
  /** Episodes marked bad. */
  flagged: Set<number>;
  /** Size of `flagged`, i.e. the reject count. */
  count: number;
  has: (id: number) => boolean;
  toggle: (id: number) => void;
  addMany: (ids: number[]) => void;
  clear: () => void;
};

const ReviewContext = createContext<ReviewContextType | undefined>(undefined);

export function useReview() {
  const ctx = useContext(ReviewContext);
  if (!ctx) throw new Error("useReview must be used within ReviewProvider");
  return ctx;
}

/** Back-compat alias: most call sites only care about the rejects. */
export const useFlaggedEpisodes = useReview;

export const ReviewProvider: React.FC<{
  repoId: string;
  children: React.ReactNode;
}> = ({ repoId, children }) => {
  const [review, setReview] = useState<StoredReview>({
    verdicts: {},
    labels: {},
    palette: [],
  });
  const [hydrated, setHydrated] = useState(false);
  const { verdicts, labels } = review;

  // Hydrate after mount (localStorage does not exist during SSR), and re-read
  // whenever the dataset changes so verdicts never leak between datasets.
  useEffect(() => {
    setHydrated(false);
    setReview(load(repoId));
    setHydrated(true);
  }, [repoId]);

  // Only persist after hydration, so the initial empty map cannot overwrite a
  // stored pass when the provider remounts.
  useEffect(() => {
    if (!hydrated) return;
    save(repoId, review);
  }, [repoId, review, hydrated]);

  const setVerdict = useCallback((id: number, verdict: Verdict | null) => {
    setReview((prev) => {
      const next = { ...prev, verdicts: { ...prev.verdicts } };
      if (verdict === null) delete next.verdicts[id];
      else next.verdicts[id] = verdict;
      return next;
    });
  }, []);

  // Labels are independent of the verdict, so clearing a verdict leaves them
  // in place: an episode can be worth keeping and still need its task prompt
  // rewritten.
  const toggleLabel = useCallback((id: number, label: string) => {
    setReview((prev) => {
      const current = prev.labels[id] ?? [];
      const next = { ...prev, labels: { ...prev.labels } };
      if (current.includes(label)) {
        const remaining = current.filter((entry) => entry !== label);
        if (remaining.length) next.labels[id] = remaining;
        else delete next.labels[id];
      } else {
        next.labels[id] = [...current, label];
      }
      return next;
    });
  }, []);

  const addLabel = useCallback((label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setReview((prev) =>
      DEFAULT_LABELS.includes(trimmed as (typeof DEFAULT_LABELS)[number]) ||
      prev.palette.includes(trimmed)
        ? prev
        : { ...prev, palette: [...prev.palette, trimmed] },
    );
  }, []);

  const importReview = useCallback((incoming: Partial<StoredReview>) => {
    setReview((prev) => ({
      verdicts: { ...prev.verdicts, ...(incoming.verdicts ?? {}) },
      labels: { ...prev.labels, ...(incoming.labels ?? {}) },
      palette: [...new Set([...prev.palette, ...(incoming.palette ?? [])])],
    }));
  }, []);

  const toggle = useCallback((id: number) => {
    setReview((prev) => {
      const next = { ...prev, verdicts: { ...prev.verdicts } };
      if (next.verdicts[id] === "bad") delete next.verdicts[id];
      else next.verdicts[id] = "bad";
      return next;
    });
  }, []);

  const addMany = useCallback((ids: number[]) => {
    setReview((prev) => {
      const next = { ...prev, verdicts: { ...prev.verdicts } };
      for (const id of ids) next.verdicts[id] = "bad";
      return next;
    });
  }, []);

  const clear = useCallback(
    () => setReview({ verdicts: {}, labels: {}, palette: [] }),
    [],
  );

  const flagged = useMemo(
    () =>
      new Set(
        Object.entries(verdicts)
          .filter(([, v]) => v === "bad")
          .map(([id]) => Number(id)),
      ),
    [verdicts],
  );

  const goodCount = useMemo(
    () => Object.values(verdicts).filter((v) => v === "good").length,
    [verdicts],
  );

  const palette = useMemo(
    () => [...DEFAULT_LABELS, ...review.palette],
    [review.palette],
  );

  const has = useCallback((id: number) => flagged.has(id), [flagged]);
  const verdictOf = useCallback((id: number) => verdicts[id], [verdicts]);
  const labelsOf = useCallback((id: number) => labels[id] ?? [], [labels]);

  const value = useMemo(
    () => ({
      verdicts,
      labels,
      palette,
      verdictOf,
      labelsOf,
      setVerdict,
      toggleLabel,
      addLabel,
      importReview,
      reviewedCount: Object.keys(verdicts).length,
      goodCount,
      flagged,
      count: flagged.size,
      has,
      toggle,
      addMany,
      clear,
    }),
    [
      verdicts,
      labels,
      palette,
      verdictOf,
      labelsOf,
      setVerdict,
      toggleLabel,
      addLabel,
      importReview,
      goodCount,
      flagged,
      has,
      toggle,
      addMany,
      clear,
    ],
  );

  return (
    <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
  );
};
