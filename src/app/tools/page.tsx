"use client";

/**
 * Runs the checks in tools/ against a dataset or a recording and shows what
 * they printed.
 *
 * The page knows nothing about any individual tool: the list, the targets it
 * accepts and the options it takes all come from its manifest, so a tool
 * dropped into tools/ appears here without a change to this file.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { JsonBlock } from "@/components/json-view";
import {
  listTools,
  listLocalDatasets,
  listMcapFiles,
  runTool,
  type LocalDatasetEntry,
  type McapFileEntry,
  type ToolManifest,
  type ToolRun,
} from "@/utils/versionUtils";

function defaultOptions(tool: ToolManifest): Record<string, string> {
  const values: Record<string, string> = {};
  for (const option of tool.options ?? []) {
    if (option.default === undefined) continue;
    values[option.flag] = String(option.default);
  }
  return values;
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolManifest[]>([]);
  const [datasets, setDatasets] = useState<LocalDatasetEntry[]>([]);
  const [recordings, setRecordings] = useState<McapFileEntry[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [options, setOptions] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ToolRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTools().then((found) => {
      setTools(found);
      if (found.length > 0) setSelectedId(found[0].id);
    });
    listLocalDatasets().then(setDatasets);
    listMcapFiles().then(setRecordings);
  }, []);

  const tool = useMemo(
    () => tools.find((t) => t.id === selectedId) ?? null,
    [tools, selectedId],
  );

  // Targets follow the tool: a dataset check lists datasets, an MCAP check
  // lists recordings.
  const targets = useMemo(() => {
    if (!tool) return [];
    return tool.target === "mcap"
      ? recordings.map((file) => file.path)
      : datasets.map((dataset) => dataset.repoId);
  }, [tool, datasets, recordings]);

  useEffect(() => {
    if (!tool) return;
    setOptions(defaultOptions(tool));
    setResult(null);
    setError(null);
  }, [tool]);

  useEffect(() => {
    if (targets.length > 0 && !targets.includes(target)) setTarget(targets[0]);
  }, [targets, target]);

  const run = useCallback(() => {
    if (!tool || !target) return;
    setRunning(true);
    setResult(null);
    setError(null);
    runTool(tool.id, target, options)
      .then(setResult)
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setRunning(false));
  }, [tool, target, options]);

  return (
    <div className="flex h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      <nav className="w-72 shrink-0 overflow-y-auto border-r border-white/5 bg-[var(--surface-0)] p-4">
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
          href="/mcap"
          className="block text-[10px] uppercase tracking-widest text-slate-500 hover:text-slate-300"
        >
          MCAP →
        </Link>

        <p className="mt-4 text-[10px] uppercase tracking-wide text-slate-500">
          Checks · {tools.length}
        </p>
        <ul className="mt-2 space-y-px">
          {tools.map((entry) => (
            <li key={entry.id}>
              <button
                onClick={() => setSelectedId(entry.id)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  entry.id === selectedId
                    ? "bg-cyan-400/10 text-cyan-300"
                    : "text-slate-300 hover:bg-white/5"
                }`}
              >
                <span className="block truncate">{entry.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {entry.target}
                </span>
              </button>
            </li>
          ))}
          {tools.length === 0 && (
            <li className="px-2 py-3 text-xs text-slate-500">
              No tools found in <code>tools/</code>.
            </li>
          )}
        </ul>
      </nav>

      <main className="flex-1 overflow-y-auto p-6">
        <h1 className="text-xl font-bold text-slate-100">Tools</h1>
        <p className="mt-1 text-sm text-slate-400">
          Checks that read the data directly. They run on this machine, against
          the same roots the viewer serves.
        </p>

        {tool && (
          <div className="mt-6 space-y-6">
            <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/60 p-5">
              <h2 className="text-sm font-semibold text-slate-200">
                {tool.name}
              </h2>
              {tool.description && (
                <p className="mt-1 text-xs text-slate-400">
                  {tool.description}
                </p>
              )}

              <div className="mt-4 flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {tool.target === "mcap" ? "Recording" : "Dataset"}
                  </span>
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="min-w-[22rem] max-w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-2 py-1.5 text-xs text-slate-200"
                  >
                    {targets.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>

                {(tool.options ?? []).map((option) => (
                  <label key={option.flag} className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      {option.label}
                    </span>
                    {option.type === "boolean" ? (
                      <input
                        type="checkbox"
                        checked={options[option.flag] === "true"}
                        onChange={(e) =>
                          setOptions((prev) => ({
                            ...prev,
                            [option.flag]: String(e.target.checked),
                          }))
                        }
                        className="h-4 w-4 accent-cyan-400"
                      />
                    ) : (
                      <input
                        type={option.type === "number" ? "number" : "text"}
                        value={options[option.flag] ?? ""}
                        onChange={(e) =>
                          setOptions((prev) => ({
                            ...prev,
                            [option.flag]: e.target.value,
                          }))
                        }
                        className="w-28 rounded-md border border-white/10 bg-[var(--surface-0)] px-2 py-1.5 text-xs text-slate-200"
                      />
                    )}
                  </label>
                ))}

                <button
                  onClick={run}
                  disabled={running || !target}
                  className="rounded-md border border-cyan-400/40 bg-cyan-400/15 px-4 py-1.5 text-xs text-cyan-300 transition-colors hover:bg-cyan-400/20 disabled:opacity-40"
                >
                  {running ? "Running…" : "Run"}
                </button>
              </div>
            </div>

            {error && (
              <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
                {error}
              </p>
            )}

            {result && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <span
                    className={`rounded-full border px-2 py-0.5 ${
                      result.ok
                        ? "border-green-500/40 bg-green-500/15 text-green-300"
                        : "border-red-500/40 bg-red-500/15 text-red-300"
                    }`}
                  >
                    {result.ok ? "passed" : "failed"}
                  </span>
                  <span className="tabular-nums text-slate-500">
                    exit {result.exitCode ?? "—"} ·{" "}
                    {((result.durationMs ?? 0) / 1000).toFixed(1)}s
                  </span>
                  {result.command && (
                    <code className="truncate text-[11px] text-slate-600">
                      {result.command}
                    </code>
                  )}
                </div>

                {result.json !== undefined &&
                result.json !== null &&
                typeof result.json === "object" ? (
                  <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/60 p-5 text-xs">
                    <JsonBlock value={result.json as Record<string, unknown>} />
                  </div>
                ) : (
                  result.stdout && (
                    <pre className="overflow-x-auto rounded-lg border border-white/10 bg-[var(--surface-1)]/60 p-5 text-xs text-slate-300">
                      {result.stdout}
                    </pre>
                  )
                )}

                {result.stderr && (
                  <pre className="overflow-x-auto rounded-lg border border-red-500/30 bg-red-500/5 p-5 text-xs text-red-200">
                    {result.stderr}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
