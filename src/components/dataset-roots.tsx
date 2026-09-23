"use client";

/**
 * The directories this server looks in for datasets, and a way to change them
 * without restarting it.
 *
 * Datasets live wherever they were put: a NAS mount, a USB stick, a local
 * cache. Retargeting used to mean editing the compose file and restarting, so
 * this panel adds and drops roots live. Roots passed on the command line are
 * shown but not removable, so a shared deployment cannot be emptied from a
 * browser tab.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  addDatasetRoot,
  listDatasetRoots,
  removeDatasetRoot,
  type DatasetRoot,
} from "@/utils/versionUtils";

export default function DatasetRoots({
  onChange,
}: {
  /** Called after a root is added or dropped, so the dataset list reloads. */
  onChange?: () => void;
}) {
  const [roots, setRoots] = useState<DatasetRoot[]>([]);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    listDatasetRoots().then(setRoots);
  }, []);

  const apply = useCallback(
    async (
      action: () => Promise<{
        ok: boolean;
        error: string | null;
        roots: DatasetRoot[];
      }>,
    ) => {
      setBusy(true);
      const result = await action();
      setBusy(false);
      setRoots(result.roots);
      setError(result.error);
      if (result.ok) {
        setPath("");
        onChange?.();
      }
    },
    [onChange],
  );

  const total = roots.reduce((sum, root) => sum + root.datasets, 0);

  return (
    <div className="mt-8 w-full max-w-2xl text-left">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="text-xs uppercase tracking-wide text-white/40 transition-colors hover:text-white/70"
      >
        {open ? "▾" : "▸"} Dataset folders · {roots.length} · {total} dataset
        {total === 1 ? "" : "s"}
      </button>

      {open && (
        <div className="mt-3 space-y-2 rounded-lg border border-white/10 bg-[var(--surface-1)]/60 p-4">
          {roots.map((root) => (
            <div
              key={root.path}
              className="flex items-center gap-3 text-xs text-white/70"
            >
              <span
                className={`font-mono ${root.exists ? "" : "text-amber-300"}`}
              >
                {root.path}
              </span>
              <span className="tabular-nums text-white/35">
                {root.exists ? `${root.datasets}` : "unreachable"}
              </span>
              {root.fixed ? (
                <span className="ml-auto text-[10px] uppercase tracking-wide text-white/25">
                  from startup
                </span>
              ) : (
                <button
                  onClick={() => apply(() => removeDatasetRoot(root.path))}
                  disabled={busy}
                  className="ml-auto rounded border border-white/10 px-2 py-0.5 text-[10px] text-white/50 hover:bg-white/5"
                >
                  remove
                </button>
              )}
            </div>
          ))}

          <form
            className="flex gap-2 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              apply(() => addDatasetRoot(path));
            }}
          >
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/media/usb/datasets"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-xs text-white/80 outline-none focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5"
            >
              Add
            </button>
          </form>

          {error && <p className="text-xs text-amber-300">{error}</p>}
          <p className="text-[10px] leading-relaxed text-white/30">
            Absolute paths, as this server sees them. In Docker that means a
            path mounted into the container, so a USB stick needs a bind mount
            (for example <code>-v /media:/media:ro</code>).
          </p>
        </div>
      )}
    </div>
  );
}
