"use client";

import React from "react";

/**
 * Metadata values are strings, but the recorder packs whole JSON documents into
 * some of them (`dataset_info` carries every stream and camera). Rendering that
 * as one wrapped line is unreadable, so a value that parses as JSON is shown
 * structured: an object whose values are themselves objects becomes a table,
 * anything else a key/value list.
 */
export function MetadataValue({ value }: { value: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return <span className="break-all text-slate-300">{value}</span>;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return <span className="break-all text-slate-300">{value}</span>;
  }
  return <JsonBlock value={parsed as Record<string, unknown>} />;
}

export function scalarText(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** True when every item is a plain object, i.e. the array is a table. */
function isRowArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
  );
}

function RowTable({
  rows,
  nameKey,
}: {
  rows: Record<string, unknown>[];
  nameKey?: string;
}) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  // Nested tables and objects do not fit in a cell, so a row's scalar fields
  // stay on the row and its structured fields are stacked underneath it.
  const isComplex = (value: unknown) =>
    isRowArray(value) ||
    (typeof value === "object" && value !== null && !Array.isArray(value));
  const scalarColumns = columns.filter(
    (column) => !rows.some((row) => isComplex(row[column])),
  );
  const complexColumns = columns.filter(
    (column) => !scalarColumns.includes(column),
  );

  return (
    <div className="overflow-x-auto rounded-md border border-white/10">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-[var(--surface-0)]/60 text-[10px] uppercase tracking-wide text-slate-500">
          <tr>
            {nameKey && <th className="px-3 py-1.5 font-medium">{nameKey}</th>}
            {scalarColumns.map((column) => (
              <th key={column} className="px-3 py-1.5 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <React.Fragment key={index}>
              <tr className="border-t border-white/5 align-top">
                {scalarColumns.map((column) => (
                  <td
                    key={column}
                    className="px-3 py-1.5 tabular-nums text-slate-400"
                  >
                    <MetadataValue value={scalarText(row[column])} />
                  </td>
                ))}
              </tr>
              {complexColumns.some((column) => row[column] !== undefined) && (
                <tr className="border-t border-white/5">
                  <td
                    colSpan={Math.max(1, scalarColumns.length)}
                    className="space-y-3 px-3 pb-3"
                  >
                    {complexColumns.map((column) =>
                      row[column] === undefined ? null : (
                        <div key={column}>
                          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                            {column}
                          </p>
                          {isRowArray(row[column]) ? (
                            <RowTable
                              rows={row[column] as Record<string, unknown>[]}
                            />
                          ) : (
                            <JsonBlock
                              value={row[column] as Record<string, unknown>}
                            />
                          )}
                        </div>
                      ),
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JsonBlock({
  value,
}: {
  value: Record<string, unknown> | unknown[];
}) {
  // A bare array of objects is a table on its own (a tool that prints a list
  // of episodes, say).
  if (isRowArray(value)) return <RowTable rows={value} />;
  if (Array.isArray(value)) {
    return <span className="text-slate-300">{scalarText(value)}</span>;
  }

  const entries = Object.entries(value);
  const rowsOfObjects = entries.filter(
    ([, v]) => typeof v === "object" && v !== null && !Array.isArray(v),
  );

  // Uniform object-of-objects (cameras, streams) reads as a table: one row per
  // entry, one column per field across the union of their keys.
  if (rowsOfObjects.length === entries.length && entries.length > 0) {
    const columns = [
      ...new Set(
        rowsOfObjects.flatMap(([, v]) =>
          Object.keys(v as Record<string, unknown>),
        ),
      ),
    ];
    return (
      <div className="overflow-x-auto rounded-md border border-white/10">
        <table className="w-full text-left text-[11px]">
          <thead className="bg-[var(--surface-0)]/60 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-1.5 font-medium">name</th>
              {columns.map((column) => (
                <th key={column} className="px-3 py-1.5 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsOfObjects.map(([name, row]) => (
              <tr key={name} className="border-t border-white/5">
                <td className="px-3 py-1.5 font-medium text-slate-300">
                  {name}
                </td>
                {columns.map((column) => (
                  <td
                    key={column}
                    className="px-3 py-1.5 tabular-nums text-slate-400"
                  >
                    {scalarText((row as Record<string, unknown>)[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map(([key, child]) =>
        isRowArray(child) ? (
          <div key={key}>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
              {key}
            </p>
            <RowTable rows={child} />
          </div>
        ) : typeof child === "object" &&
          child !== null &&
          !Array.isArray(child) ? (
          <div key={key}>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
              {key}
            </p>
            <JsonBlock value={child as Record<string, unknown>} />
          </div>
        ) : (
          <div key={key} className="flex gap-3">
            <span className="shrink-0 text-slate-500">{key}</span>
            <span className="break-all text-slate-300">
              {scalarText(child)}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
