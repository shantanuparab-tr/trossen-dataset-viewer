"use client";

/**
 * The folders this server reads from, and a way to change them without
 * restarting it.
 *
 * Data lives wherever it was put: a NAS share, a USB stick, a local cache.
 * Retargeting used to mean editing the compose file and restarting, so this
 * panel adds and drops folders live, for LeRobot datasets and for raw MCAP
 * recordings alike. Folders passed on the command line are shown but not
 * removable, so a shared deployment cannot be emptied from a browser tab.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  changeRoot,
  listRoots,
  type DatasetRoot,
  type RootKind,
} from "@/utils/versionUtils";

const LABELS: Record<RootKind, { title: string; unit: string; hint: string }> =
  {
    datasets: {
      title: "Dataset folders",
      unit: "dataset",
      hint: "/media/usb/converted",
    },
    mcap: {
      title: "MCAP folders",
      unit: "recording",
      hint: "/mnt/nas/mcap",
    },
  };

export default function DatasetRoots({
  kind = "datasets",
  onChange,
}: {
  /** Which set of folders to manage. */
  kind?: RootKind;
  /** Called after a folder is added or dropped, so listings reload. */
  onChange?: () => void;
}) {
  const [roots, setRoots] = useState<DatasetRoot[]>([]);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const labels = LABELS[kind];

  useEffect(() => {
    listRoots(kind).then(setRoots);
  }, [kind]);

  const apply = useCallback(
    async (action: "add" | "remove", target: string) => {
      setBusy(true);
      const result = await changeRoot(kind, action, target);
      setBusy(false);
      setRoots(result.roots);
      setError(result.error);
      if (result.ok) {
        setPath("");
        onChange?.();
      }
    },
    [kind, onChange],
  );

  const total = roots.reduce((sum, root) => sum + root.datasets, 0);

  return (
    <div className="mt-4 w-full max-w-2xl text-left">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="text-xs uppercase tracking-wide text-white/40 transition-colors hover:text-white/70"
      >
        {open ? "▾" : "▸"} {labels.title} · {roots.length} · {total}{" "}
        {labels.unit}
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
                  onClick={() => apply("remove", root.path)}
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
              apply("add", path);
            }}
          >
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={labels.hint}
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
            path mounted into the container: <code>/mnt</code> and{" "}
            <code>/media</code> are mounted for you, so a NAS share or USB stick
            already mounted on the host works at the same path.
          </p>
        </div>
      )}
    </div>
  );
}
