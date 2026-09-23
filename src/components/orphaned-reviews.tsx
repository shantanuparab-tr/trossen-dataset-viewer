"use client";

/**
 * Review passes whose dataset is no longer served.
 *
 * Verdicts are keyed by repo id, so a dataset that is renamed or removed leaves
 * its pass behind in this browser with nothing to open it from. This finds
 * those keys and offers to drop them.
 */

import React, { useCallback, useEffect, useState } from "react";

const PREFIX = "review:";
/** Not a dataset pass: the MCAP inspector keys everything under one scope. */
const KEEP = new Set(["review:mcap"]);

type Orphan = { key: string; repoId: string; reviewed: number };

function countVerdicts(raw: string): number {
  try {
    const parsed = JSON.parse(raw);
    const verdicts = parsed?.verdicts ?? parsed ?? {};
    return Object.keys(verdicts).length;
  } catch {
    return 0;
  }
}

export default function OrphanedReviews({ repoIds }: { repoIds: string[] }) {
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [cleared, setCleared] = useState(0);

  const scan = useCallback(() => {
    if (repoIds.length === 0) return;
    const served = new Set(repoIds);
    const found: Orphan[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(PREFIX) || KEEP.has(key)) continue;
        const repoId = key.slice(PREFIX.length);
        if (served.has(repoId)) continue;
        found.push({
          key,
          repoId,
          reviewed: countVerdicts(localStorage.getItem(key) ?? ""),
        });
      }
    } catch {
      /* storage unavailable; nothing to offer */
    }
    setOrphans(found.filter((entry) => entry.reviewed > 0));
  }, [repoIds]);

  useEffect(scan, [scan]);

  const clear = useCallback(() => {
    for (const orphan of orphans) {
      try {
        localStorage.removeItem(orphan.key);
      } catch {
        /* ignore */
      }
    }
    setCleared(orphans.length);
    setOrphans([]);
  }, [orphans]);

  if (orphans.length === 0) {
    return cleared > 0 ? (
      <p className="mt-4 text-xs text-white/40">
        Cleared {cleared} orphaned review pass{cleared === 1 ? "" : "es"}.
      </p>
    ) : null;
  }

  return (
    <div className="mt-4 flex flex-col items-center gap-1 text-xs text-white/40">
      <p>
        {orphans.length} review pass{orphans.length === 1 ? "" : "es"} for
        datasets no longer served:{" "}
        {orphans.map((orphan) => orphan.repoId.split("/").pop()).join(", ")}
      </p>
      <button
        onClick={clear}
        className="text-cyan-200/80 underline underline-offset-4 hover:text-white"
      >
        Clear them
      </button>
    </div>
  );
}
