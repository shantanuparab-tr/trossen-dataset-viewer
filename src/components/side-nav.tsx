"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";
import { useReview } from "@/context/review-context";

import type { DatasetDisplayInfo } from "@/app/[org]/[dataset]/[episode]/fetch-data";

/** Which episodes the list shows. "rejected" and "unreviewed" span the whole
 * dataset rather than the current page — a review pass wants the next one to
 * look at, not the next one on this page. */
export type EpisodeFilter = "all" | "rejected" | "unreviewed";

export interface TaskGroup {
  task: string;
  episodes: number[];
}

interface SidebarProps {
  datasetInfo: DatasetDisplayInfo;
  paginatedEpisodes: number[];
  allEpisodes: number[];
  episodeId: number;
  totalPages: number;
  currentPage: number;
  prevPage: () => void;
  nextPage: () => void;
  filter: EpisodeFilter;
  onFilterChange: (filter: EpisodeFilter) => void;
  /** Distinct task prompts in this dataset, most frequent first. */
  taskGroups?: TaskGroup[];
  /** The prompt the list is narrowed to, or null for all of them. */
  taskFilter?: string | null;
  onTaskFilterChange?: (task: string | null) => void;
  onEpisodeSelect?: (ep: number) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  datasetInfo,
  paginatedEpisodes,
  allEpisodes,
  episodeId,
  totalPages,
  currentPage,
  prevPage,
  nextPage,
  filter,
  onFilterChange,
  taskGroups = [],
  taskFilter = null,
  onTaskFilterChange,
  onEpisodeSelect,
}) => {
  const [mobileVisible, setMobileVisible] = useState(false);
  const { flagged, count, toggle, verdictOf, labelsOf, reviewedCount } =
    useReview();

  // A task filter spans the dataset, so it replaces the page window the same
  // way the verdict filters do, and the two compose.
  const taskEpisodes = useMemo(() => {
    if (!taskFilter) return null;
    return new Set(
      taskGroups.find((group) => group.task === taskFilter)?.episodes ?? [],
    );
  }, [taskFilter, taskGroups]);

  const displayEpisodes = useMemo(() => {
    let episodes: number[];
    if (filter === "rejected") episodes = [...flagged].sort((a, b) => a - b);
    else if (filter === "unreviewed")
      episodes = allEpisodes.filter((ep) => verdictOf(ep) === undefined);
    else episodes = taskEpisodes ? allEpisodes : paginatedEpisodes;
    return taskEpisodes
      ? episodes.filter((ep) => taskEpisodes.has(ep))
      : episodes;
  }, [
    filter,
    paginatedEpisodes,
    allEpisodes,
    flagged,
    verdictOf,
    taskEpisodes,
  ]);

  const unreviewedCount = allEpisodes.length - reviewedCount;

  const filterBtn = (value: EpisodeFilter, label: string, tone: string) => (
    <button
      onClick={() => onFilterChange(filter === value ? "all" : value)}
      className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md transition-colors border ${
        filter === value
          ? tone
          : "text-slate-500 hover:text-slate-300 border-white/10"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex z-10 shrink-0">
      <nav
        className={`shrink-0 overflow-y-auto bg-[var(--surface-0)] border-r border-white/5 p-4 break-words w-60 ${
          mobileVisible ? "block" : "hidden"
        } md:block`}
        aria-label="Sidebar navigation"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-400 tabular">
          <dt className="uppercase tracking-wide text-[10px] text-slate-500">
            Frames
          </dt>
          <dd className="text-slate-200">
            {datasetInfo.total_frames.toLocaleString()}
          </dd>
          <dt className="uppercase tracking-wide text-[10px] text-slate-500">
            Episodes
          </dt>
          <dd className="text-slate-200">
            {datasetInfo.total_episodes.toLocaleString()}
          </dd>
          <dt className="uppercase tracking-wide text-[10px] text-slate-500">
            FPS
          </dt>
          <dd className="text-slate-200">{datasetInfo.fps}</dd>
        </dl>

        {taskGroups.length > 1 && (
          <div className="mt-5">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              Task prompt
            </p>
            <select
              value={taskFilter ?? ""}
              onChange={(e) => onTaskFilterChange?.(e.target.value || null)}
              className="mt-1 w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs text-slate-200"
            >
              <option value="">All tasks · {allEpisodes.length}</option>
              {taskGroups.map((group) => (
                <option key={group.task} value={group.task}>
                  {group.task} · {group.episodes.length}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            Episodes
          </p>
          {reviewedCount > 0 && (
            <span className="text-[10px] text-slate-500 tabular">
              {reviewedCount} reviewed
            </span>
          )}
        </div>

        {(count > 0 || reviewedCount > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {count > 0 &&
              filterBtn(
                "rejected",
                `Rejected · ${count}`,
                "bg-red-500/15 text-red-300 border-red-500/30",
              )}
            {unreviewedCount > 0 &&
              filterBtn(
                "unreviewed",
                `Unreviewed · ${unreviewedCount}`,
                "bg-cyan-400/15 text-cyan-300 border-cyan-400/30",
              )}
          </div>
        )}

        <ul className="mt-2 space-y-px">
          {displayEpisodes.map((episode) => {
            const active = episode === episodeId;
            const verdict = verdictOf(episode);
            const labelCount = labelsOf(episode).length;
            // A verdict dot in front of the label, so a review pass can see at
            // a glance which episodes are still unseen.
            const dot = (
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  verdict === "good"
                    ? "bg-green-400"
                    : verdict === "bad"
                      ? "bg-red-400"
                      : "bg-white/10"
                }`}
                title={verdict ?? "not reviewed"}
              />
            );
            const itemClass = `group flex items-center justify-between gap-2 px-2 py-1 rounded-md text-xs tabular transition-colors ${
              active
                ? "bg-cyan-400/10 text-cyan-300"
                : "text-slate-300 hover:bg-white/5"
            }`;
            return (
              <li key={episode}>
                {onEpisodeSelect ? (
                  <div className={itemClass}>
                    {dot}
                    <button
                      onClick={() => onEpisodeSelect(episode)}
                      className="flex-1 text-left"
                    >
                      Episode {episode}
                    </button>
                    {labelCount > 0 && (
                      <span
                        className="shrink-0 text-[10px] text-cyan-300/70"
                        title={labelsOf(episode).join(", ")}
                      >
                        {labelCount}
                      </span>
                    )}
                    <button
                      onClick={() => toggle(episode)}
                      className={`text-xs leading-none transition-colors ${
                        flagged.has(episode)
                          ? "text-orange-400 hover:text-orange-300"
                          : "text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100"
                      }`}
                      title={flagged.has(episode) ? "Unflag" : "Flag"}
                    >
                      ⚑
                    </button>
                  </div>
                ) : (
                  <div className={itemClass}>
                    {dot}
                    <Link
                      href={`./episode_${episode}`}
                      className="flex-1 text-left"
                    >
                      Episode {episode}
                    </Link>
                    {labelCount > 0 && (
                      <span
                        className="shrink-0 text-[10px] text-cyan-300/70"
                        title={labelsOf(episode).join(", ")}
                      >
                        {labelCount}
                      </span>
                    )}
                    <button
                      onClick={() => toggle(episode)}
                      className={`text-xs leading-none transition-colors ${
                        flagged.has(episode)
                          ? "text-orange-400 hover:text-orange-300"
                          : "text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100"
                      }`}
                      title={flagged.has(episode) ? "Unflag" : "Flag"}
                    >
                      ⚑
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {filter === "all" && !taskFilter && totalPages > 1 && (
          <div className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-400">
            <button
              onClick={prevPage}
              className={`px-2 py-1 rounded-md border border-white/10 transition-colors hover:bg-white/5 hover:text-slate-200 ${
                currentPage === 1 ? "cursor-not-allowed opacity-40" : ""
              }`}
              disabled={currentPage === 1}
            >
              ‹ Prev
            </button>
            <span className="tabular text-slate-500">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={nextPage}
              className={`ml-auto px-2 py-1 rounded-md border border-white/10 transition-colors hover:bg-white/5 hover:text-slate-200 ${
                currentPage === totalPages
                  ? "cursor-not-allowed opacity-40"
                  : ""
              }`}
              disabled={currentPage === totalPages}
            >
              Next ›
            </button>
          </div>
        )}
      </nav>

      <button
        className="mx-1 flex items-center opacity-50 hover:opacity-100 focus:outline-none focus:ring-0 md:hidden"
        onClick={() => setMobileVisible((prev) => !prev)}
        title="Toggle sidebar"
      >
        <div className="h-10 w-1 rounded-full bg-white/20" />
      </button>
    </div>
  );
};

export default Sidebar;
