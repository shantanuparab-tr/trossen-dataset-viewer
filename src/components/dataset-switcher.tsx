"use client";

/**
 * Jumps between the datasets served from the local root without going back to
 * the landing page. Renders nothing when the server has no listing (the Hub
 * has no `/api/datasets`), so a Hub-backed instance is unchanged.
 */

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  listLocalDatasets,
  type LocalDatasetEntry,
} from "@/utils/versionUtils";

const DatasetSwitcher: React.FC<{ repoId: string }> = ({ repoId }) => {
  const router = useRouter();
  const [datasets, setDatasets] = useState<LocalDatasetEntry[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    listLocalDatasets().then((found) => {
      if (!cancelled) setDatasets(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  if (datasets.length < 2) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="px-3 py-1.5 rounded-md text-xs text-slate-400 border border-white/10 hover:text-slate-100 hover:bg-white/5 transition-colors"
      >
        Dataset ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-max max-w-[32rem] max-h-80 overflow-y-auto panel-raised bg-[var(--surface-1)] shadow-xl p-1.5 z-50">
          {datasets.map((ds) => (
            <button
              key={ds.repoId}
              onClick={() => {
                setOpen(false);
                router.push(`/${ds.repoId}/episode_0`);
              }}
              className={`flex w-full items-baseline justify-between gap-6 px-2 py-1.5 rounded-md text-xs transition-colors ${
                ds.repoId === repoId
                  ? "text-cyan-300 bg-cyan-400/10"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              <span className="truncate">{ds.repoId}</span>
              <span className="shrink-0 text-[10px] text-slate-500 tabular-nums">
                {(ds.total_episodes ?? 0).toLocaleString()} ep
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default DatasetSwitcher;
