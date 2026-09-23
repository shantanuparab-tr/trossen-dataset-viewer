"use client";

import { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { postParentMessageWithParams } from "@/utils/postParentMessage";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import PlaybackBar from "@/components/playback-bar";
import { TimeProvider, useTime } from "@/context/time-context";
import { ReviewProvider } from "@/context/review-context";
import {
  AnnotationsProvider,
  useAnnotations,
} from "@/context/annotations-context";
import { AnnotationsPanel } from "@/components/annotations-panel";
import { AnnotationsTimeline } from "@/components/annotations-timeline";
import Sidebar, { type EpisodeFilter } from "@/components/side-nav";
import ReviewBar from "@/components/review-bar";
import DatasetSwitcher from "@/components/dataset-switcher";
import StatsPanel from "@/components/stats-panel";
import OverviewPanel from "@/components/overview-panel";
import Loading from "@/components/loading-component";
import HfAuthButton from "@/components/hf-auth-button";
import { hasURDFSupport } from "@/lib/so101-robot";
import {
  getAdjacentEpisodesVideoInfo,
  computeColumnMinMax,
  getEpisodeDataSafe,
  loadAllEpisodeLengthsV3,
  loadEpisodeTasksV3,
  loadAllEpisodeFrameInfo,
  loadCrossEpisodeActionVariance,
  type EpisodeData,
  type ColumnMinMax,
  type EpisodeLengthStats,
  type EpisodeTasks,
  type EpisodeFramesData,
  type CrossEpisodeVarianceData,
} from "./fetch-data";
import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import type { DatasetMetadata } from "@/utils/parquetUtils";

const URDFViewer = lazy(() => import("@/components/urdf-viewer"));
const ActionInsightsPanel = lazy(
  () => import("@/components/action-insights-panel"),
);
const FilteringPanel = lazy(() => import("@/components/filtering-panel"));
// Recharts is ~150KB gz and not above-the-fold (videos render first on the
// Episodes tab). Lazy-load it so the initial chunk can ship faster and
// videos start downloading in parallel with the chart bundle.
const DataRecharts = lazy(() => import("@/components/data-recharts"));

/** Skip global playback / navigation shortcuts while typing in a field. */
function isKeyboardFocusInsideTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }
  const tag = target.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "INPUT" ||
    tag === "BUTTON" ||
    (tag === "A" && target.hasAttribute("href"))
  );
}

type ActiveTab =
  | "episodes"
  | "annotations"
  | "statistics"
  | "frames"
  | "insights"
  | "filtering"
  | "doctor"
  | "urdf";

// Subscribes to `currentTime` so its parent doesn't have to. Keeping this
// in a leaf component means the throttled time ticks (~12.5/s during
// playback) only re-render this no-op sub-tree, not the entire 700-line
// EpisodeViewerInner. Vercel rule: rerender-defer-reads.
function UrlTimeSync() {
  const { currentTime, isPlaying } = useTime();
  const searchParams = useSearchParams();
  const lastUrlSecondRef = useRef<number>(-1);

  // Only update the URL ?t= param when the integer second changes, and
  // only while paused — replacing state every frame during playback would
  // spam the browser's history.
  useEffect(() => {
    if (isPlaying) return;
    const currentSec = Math.floor(currentTime);
    if (currentTime > 0 && lastUrlSecondRef.current !== currentSec) {
      lastUrlSecondRef.current = currentSec;
      const newParams = new URLSearchParams(searchParams.toString());
      newParams.set("t", currentSec.toString());
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}?${newParams.toString()}`,
      );
      postParentMessageWithParams((params: URLSearchParams) => {
        params.set("path", window.location.pathname + window.location.search);
      });
    }
  }, [isPlaying, currentTime, searchParams]);

  return null;
}

// Hoisted to module scope. Defining inside EpisodeViewerInner created a new
// component type on every parent render — and the parent re-renders ~12.5×/s
// during playback because it consumes `currentTime` from useTime. React
// would unmount and remount every tab on every tick.
function TabButton({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`relative px-5 py-3 text-xs font-medium tracking-wide uppercase transition-colors ${
        active ? "text-cyan-300" : "text-slate-400 hover:text-slate-100"
      }`}
    >
      {label}
      <span
        className={`pointer-events-none absolute bottom-0 left-3 right-3 h-px transition-all ${
          active
            ? "bg-cyan-400 shadow-[0_0_8px_rgba(56,189,248,0.55)]"
            : "bg-transparent"
        }`}
      />
    </button>
  );
}

export default function EpisodeViewer({
  org,
  dataset,
  episodeId,
}: {
  org: string;
  dataset: string;
  episodeId: number;
}) {
  const [data, setData] = useState<EpisodeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (Number.isNaN(episodeId)) {
      setError("Invalid episode id.");
      setData(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    setError(null);
    setData(null);
    getEpisodeDataSafe(org, dataset, episodeId)
      .then(({ data: loaded, error: loadError }) => {
        if (requestIdRef.current !== requestId) return;
        if (loadError) {
          setError(loadError);
          setData(null);
          return;
        }
        setData(loaded ?? null);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || "Unknown error");
        setData(null);
      });
  }, [org, dataset, episodeId]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-red-300">
        <div className="panel-raised max-w-xl p-6 border-red-500/40">
          <h2 className="text-xl font-medium mb-3">Something went wrong</h2>
          <p className="text-sm font-mono whitespace-pre-wrap text-red-200/90">
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="relative h-screen bg-[var(--bg)]">
        <Loading />
      </div>
    );
  }

  return (
    <TimeProvider duration={data!.duration}>
      <ReviewProvider repoId={data!.datasetInfo.repoId}>
        <AnnotationsProvider>
          <EpisodeBootstrap data={data!} />
          <EpisodeViewerInner data={data!} org={org} dataset={dataset} />
        </AnnotationsProvider>
      </ReviewProvider>
    </TimeProvider>
  );
}

/** Wires the loaded episode into the AnnotationsProvider. */
function EpisodeBootstrap({ data }: { data: EpisodeData }) {
  const { setEpisode } = useAnnotations();
  useEffect(() => {
    setEpisode(
      data.episodeId,
      { repoId: data.datasetInfo.repoId },
      data.languageAtoms,
      data.frameTimestamps,
    );
  }, [
    data.episodeId,
    data.datasetInfo.repoId,
    data.languageAtoms,
    data.frameTimestamps,
    setEpisode,
  ]);
  return null;
}

function EpisodeViewerInner({
  data,
  org,
  dataset,
}: {
  data: EpisodeData;
  org?: string;
  dataset?: string;
}) {
  const {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    episodes,
    task,
  } = data;

  // Depth feeds are transcoded on demand (see fetch-data), so they stay out of
  // the grid until asked for. Most review passes only look at the colour
  // cameras, and each depth tile costs a server-side transcode.
  const [showDepth, setShowDepth] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("showDepth") === "true"
      : false,
  );
  const depthCount = useMemo(
    () => videosInfo.filter((v) => v.isDepth).length,
    [videosInfo],
  );
  const shownVideos = useMemo(
    () => (showDepth ? videosInfo : videosInfo.filter((v) => !v.isDepth)),
    [videosInfo, showDepth],
  );

  const [videosReady, setVideosReady] = useState(!shownVideos.length);

  // Nothing to wait for when the grid is empty (every feed is depth and depth
  // is toggled off), so don't hold the loading gate open.
  useEffect(() => {
    if (!shownVideos.length) setVideosReady(true);
  }, [shownVideos.length]);
  const [chartsReady, setChartsReady] = useState(false);

  const loadStartRef = useRef(performance.now());

  const router = useRouter();
  const searchParams = useSearchParams();

  // Tab state & lazy stats — read sessionStorage in the initializer so the
  // correct tab renders on the very first frame (no post-mount flash).
  // Safe because EpisodeViewerInner only mounts client-side (behind a loading gate).
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem("activeTab");
      if (
        stored &&
        [
          "episodes",
          "annotations",
          "statistics",
          "frames",
          "insights",
          "filtering",
          "urdf",
        ].includes(stored)
      ) {
        return stored as ActiveTab;
      }
    }
    return "episodes";
  });
  const isLoading = activeTab === "episodes" && (!videosReady || !chartsReady);

  useEffect(() => {
    if (!isLoading) {
      console.log(
        `[perf] Loading complete in ${(performance.now() - loadStartRef.current).toFixed(0)}ms (videos: ${videosReady ? "✓" : "…"}, charts: ${chartsReady ? "✓" : "…"})`,
      );
    }
  }, [isLoading, videosReady, chartsReady]);
  const [, setColumnMinMax] = useState<ColumnMinMax[] | null>(null);
  const [episodeLengthStats, setEpisodeLengthStats] =
    useState<EpisodeLengthStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const statsLoadedRef = useRef(false);
  const [episodeFramesData, setEpisodeFramesData] =
    useState<EpisodeFramesData | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const framesLoadedRef = useRef(false);
  const [framesFlaggedOnly, setFramesFlaggedOnly] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("framesFlaggedOnly") === "true"
      : false,
  );
  const [sidebarFilter, setSidebarFilter] = useState<EpisodeFilter>(() => {
    const stored =
      typeof window !== "undefined"
        ? sessionStorage.getItem("sidebarFilter")
        : null;
    return stored === "rejected" || stored === "unreviewed" ? stored : "all";
  });
  // Task prompts are per episode in a multi-task dataset, so the sidebar's task
  // filter needs the whole meta/episodes table, not just this episode's row.
  const [episodeTasks, setEpisodeTasks] = useState<EpisodeTasks | null>(null);
  // Held in sessionStorage per dataset: opening an episode from the filtered
  // list is a client-side route change, which remounts this component, and a
  // filter that reset on every step would make a multi-task pass unusable.
  const taskFilterKey = `taskFilter:${datasetInfo.repoId}`;
  const [taskFilter, setTaskFilter] = useState<string | null>(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem(taskFilterKey)
      : null,
  );

  const [crossEpData, setCrossEpData] =
    useState<CrossEpisodeVarianceData | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const insightsLoadedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One small parquet read per dataset; the filter is useless without it and
  // the Episodes tab is where it is used, so it loads with the page.
  useEffect(() => {
    let cancelled = false;
    setEpisodeTasks(null);
    if (!org || !dataset) return;
    const repoId = `${org}/${dataset}`;
    getDatasetVersionAndInfo(repoId)
      .then(({ version }) =>
        version === "v3.0" ? loadEpisodeTasksV3(repoId, version) : null,
      )
      .then((result) => {
        if (cancelled) return;
        setEpisodeTasks(result);
        // Drop a stored filter only when this dataset has no such prompt.
        setTaskFilter((current) =>
          current && !result?.tasks.some((group) => group.task === current)
            ? null
            : current,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [org, dataset]);

  useEffect(() => {
    if (taskFilter) sessionStorage.setItem(taskFilterKey, taskFilter);
    else sessionStorage.removeItem(taskFilterKey);
  }, [taskFilter, taskFilterKey]);

  useEffect(() => {
    statsLoadedRef.current = false;
    framesLoadedRef.current = false;
    insightsLoadedRef.current = false;
    setEpisodeLengthStats(null);
    setEpisodeFramesData(null);
    setCrossEpData(null);
  }, [datasetInfo.repoId]);

  // Eagerly load the URDFViewer bundle + warm the STL geometry cache while
  // the user is on the Episodes tab, so the 3D Replay tab opens faster.
  useEffect(() => {
    if (
      hasURDFSupport(datasetInfo.robot_type) &&
      datasetInfo.codebase_version >= "v3.0"
    ) {
      void import("@/components/urdf-viewer");
    }
  }, [datasetInfo.robot_type, datasetInfo.codebase_version]);

  // Persist UI state across episode navigations. One effect instead of
  // three near-identical writes — fewer commit hooks per render and the
  // intent (mirror three primitives to sessionStorage) reads as one unit.
  useEffect(() => {
    sessionStorage.setItem("activeTab", activeTab);
    sessionStorage.setItem("sidebarFilter", sidebarFilter);
    sessionStorage.setItem("framesFlaggedOnly", String(framesFlaggedOnly));
    sessionStorage.setItem("showDepth", String(showDepth));
  }, [activeTab, sidebarFilter, framesFlaggedOnly, showDepth]);

  const loadStats = () => {
    if (statsLoadedRef.current) return;
    statsLoadedRef.current = true;
    setStatsLoading(true);
    setColumnMinMax(computeColumnMinMax(data.chartDataGroups));
    if (org && dataset) {
      const repoId = `${org}/${dataset}`;
      getDatasetVersionAndInfo(repoId)
        .then(({ version, info }) => {
          if (version !== "v3.0") return null;
          return loadAllEpisodeLengthsV3(repoId, version, info.fps);
        })
        .then((result) => {
          if (!mountedRef.current) return;
          setEpisodeLengthStats(result);
        })
        .catch(() => {})
        .finally(() => {
          if (mountedRef.current) setStatsLoading(false);
        });
    } else {
      setStatsLoading(false);
    }
  };

  const loadFrames = () => {
    if (framesLoadedRef.current || !org || !dataset) return;
    framesLoadedRef.current = true;
    setFramesLoading(true);
    const repoId = `${org}/${dataset}`;
    getDatasetVersionAndInfo(repoId)
      .then(({ version, info }) =>
        loadAllEpisodeFrameInfo(
          repoId,
          version,
          info as unknown as DatasetMetadata,
        ),
      )
      .then((result) => {
        if (!mountedRef.current) return;
        setEpisodeFramesData(result);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setEpisodeFramesData({ cameras: [], framesByCamera: {} });
      })
      .finally(() => {
        if (mountedRef.current) setFramesLoading(false);
      });
  };

  const loadInsights = () => {
    if (insightsLoadedRef.current || !org || !dataset) return;
    insightsLoadedRef.current = true;
    setInsightsLoading(true);
    const repoId = `${org}/${dataset}`;
    getDatasetVersionAndInfo(repoId)
      .then(({ version, info }) =>
        loadCrossEpisodeActionVariance(
          repoId,
          version,
          info as unknown as DatasetMetadata,
          info.fps,
        ),
      )
      .then((result) => {
        if (!mountedRef.current) return;
        setCrossEpData(result);
      })
      .catch((err) => console.error("[cross-ep] Failed:", err))
      .finally(() => {
        if (mountedRef.current) setInsightsLoading(false);
      });
  };

  // Re-trigger data loading for the restored tab on mount
  useEffect(() => {
    if (activeTab === "statistics") loadStats();
    if (activeTab === "frames") loadFrames();
    if (activeTab === "insights") loadInsights();
    if (activeTab === "filtering") {
      loadStats();
      loadInsights();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTabChange = (tab: ActiveTab) => {
    setActiveTab(tab);
    if (tab === "statistics") loadStats();
    if (tab === "frames") loadFrames();
    if (tab === "insights") loadInsights();
    if (tab === "filtering") {
      loadStats();
      loadInsights();
    }
  };

  // `currentTime` is intentionally NOT read here. Subscribing to it would
  // re-render this 700-line component every ~80ms during playback. The
  // <UrlTimeSync /> child handles its only consumer (the ?t= URL writer).
  // `seek` and `setIsPlaying` are stable references from useCallback /
  // useState — they don't drive renders.
  const { seek, setIsPlaying } = useTime();

  // URDFViewer episode changer and play toggle — populated by URDFViewer on mount
  const urdfChangerRef = useRef<((ep: number) => void) | undefined>(undefined);
  const urdfPlayToggleRef = useRef<(() => void) | undefined>(undefined);
  const [urdfEpisode, setUrdfEpisode] = useState(episodeId);
  useEffect(() => setUrdfEpisode(episodeId), [episodeId]);

  // Pagination state
  const pageSize = 100;
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.ceil(episodes.length / pageSize);
  const paginatedEpisodes = episodes.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  // Read inside the preload effect without making it a dependency: toggling
  // depth should not tear down and rebuild the preload links.
  const showDepthRef = useRef(showDepth);
  showDepthRef.current = showDepth;

  // Preload adjacent episodes' videos via <link rel="preload"> tags
  useEffect(() => {
    if (!org || !dataset) return;
    const links: HTMLLinkElement[] = [];

    getAdjacentEpisodesVideoInfo(org, dataset, episodeId, 2)
      .then((adjacentVideos) => {
        for (const ep of adjacentVideos) {
          for (const v of ep.videosInfo) {
            // Never <link rel=preload> depth: the URL is a transcode request,
            // so the browser would hold several of its six per-host
            // connections open on ffmpeg runs, starving the metadata fetches
            // the next episode needs. Ask the server to build the preview in
            // the background instead — it answers 202 straight away.
            if (v.isDepth) {
              if (showDepthRef.current) void fetch(`${v.url}&warm=1`);
              continue;
            }
            const link = document.createElement("link");
            link.rel = "preload";
            link.as = "video";
            link.href = v.url;
            document.head.appendChild(link);
            links.push(link);
          }
        }
      })
      .catch(() => {});

    return () => {
      links.forEach((l) => l.remove());
    };
  }, [org, dataset, episodeId]);

  // Initialize based on URL time parameter
  useEffect(() => {
    const timeParam = searchParams.get("t");
    if (timeParam) {
      const timeValue = parseFloat(timeParam);
      if (!isNaN(timeValue)) {
        seek(timeValue);
      }
    }
  }, [searchParams, seek]);

  // sync with parent window hf.co/spaces
  useEffect(() => {
    postParentMessageWithParams((params: URLSearchParams) => {
      params.set("path", window.location.pathname + window.location.search);
    });
  }, []);

  // Initialize page based on the current episode. Splitting this out from
  // the keyboard listener effect lets the listener attach exactly once.
  useEffect(() => {
    const episodeIndex = episodes.indexOf(episodeId);
    if (episodeIndex !== -1) {
      setCurrentPage(Math.floor(episodeIndex / pageSize) + 1);
    }
  }, [episodes, episodeId, pageSize]);

  // Mirror the values the keydown handler needs into a ref. Without this,
  // `useCallback` would produce a new handler whenever `activeTab` /
  // `episodeId` / `urdfEpisode` changed, and the keydown effect would
  // detach + reattach the listener each time. Now the listener attaches
  // once and reads the latest state via the ref.
  // Vercel rule: advanced-event-handler-refs.
  // Arrow keys step through what the sidebar is showing: with a task filter on,
  // the next episode is the next one under that prompt, not episodeId + 1.
  const navigableEpisodes = useMemo(() => {
    if (!taskFilter) return episodes;
    const group = episodeTasks?.tasks.find((t) => t.task === taskFilter);
    return group?.episodes.length ? group.episodes : episodes;
  }, [taskFilter, episodeTasks, episodes]);

  const keyStateRef = useRef({
    activeTab,
    episodeId,
    episodes: navigableEpisodes,
    urdfEpisode,
  });
  keyStateRef.current = {
    activeTab,
    episodeId,
    episodes: navigableEpisodes,
    urdfEpisode,
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { key } = e;
      const s = keyStateRef.current;
      const inTextEntry = isKeyboardFocusInsideTextEntry(e.target);

      if (key === " ") {
        if (inTextEntry) return;
        e.preventDefault();
        if (s.activeTab === "urdf") {
          urdfPlayToggleRef.current?.();
        } else {
          setIsPlaying((prev: boolean) => !prev);
        }
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        if (inTextEntry) return;
        e.preventDefault();
        if (s.activeTab === "urdf") {
          const nextEp =
            key === "ArrowDown" ? s.urdfEpisode + 1 : s.urdfEpisode - 1;
          const lowest = s.episodes[0];
          const highest = s.episodes[s.episodes.length - 1];
          if (nextEp >= lowest && nextEp <= highest) {
            setUrdfEpisode(nextEp);
            urdfChangerRef.current?.(nextEp);
          }
        } else {
          const position = s.episodes.indexOf(s.episodeId);
          const nextEpisodeId =
            position === -1
              ? key === "ArrowDown"
                ? s.episodeId + 1
                : s.episodeId - 1
              : s.episodes[position + (key === "ArrowDown" ? 1 : -1)];
          if (nextEpisodeId !== undefined) {
            router.push(`./episode_${nextEpisodeId}`);
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // router / setIsPlaying are stable; the rest is read via keyStateRef.
  }, [router, setIsPlaying]);

  // Pagination functions
  const nextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  const prevPage = () => {
    if (currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  const renderTab = (tab: ActiveTab, label: string, title?: string) => (
    <TabButton
      active={activeTab === tab}
      onClick={() => handleTabChange(tab)}
      label={label}
      title={title}
    />
  );

  return (
    <div className="flex flex-col h-screen max-h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      <UrlTimeSync />
      {/* Top tab bar */}
      <div className="flex items-center border-b border-white/5 bg-[var(--surface-0)] shrink-0">
        {renderTab("episodes", "Episodes")}
        {renderTab(
          "annotations",
          "Annotations",
          "Edit subtask / plan / memory / interjection / VQA atoms (lerobot v3.1 schema)",
        )}
        {hasURDFSupport(datasetInfo.robot_type) &&
          datasetInfo.codebase_version >= "v3.0" &&
          renderTab("urdf", "3D Replay")}
        {renderTab("statistics", "Statistics")}
        {renderTab("filtering", "Filtering")}
        {renderTab("frames", "Frames")}
        {renderTab("insights", "Action Insights")}
        {renderTab(
          "doctor",
          "Doctor",
          "Dataset quality diagnostics (powered by lerobot-doctor)",
        )}
        <div className="ml-auto flex items-center gap-2 pr-3">
          <Link
            href="/mcap"
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
          >
            MCAP
          </Link>
          <Link
            href="/tools"
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
          >
            Tools
          </Link>
          <DatasetSwitcher repoId={datasetInfo.repoId} />
          <HfAuthButton variant="tab" />
        </div>
      </div>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar — on Episodes and 3D Replay tabs */}
        {(activeTab === "episodes" ||
          activeTab === "annotations" ||
          activeTab === "urdf") && (
          <Sidebar
            datasetInfo={datasetInfo}
            paginatedEpisodes={paginatedEpisodes}
            episodeId={activeTab === "urdf" ? urdfEpisode : episodeId}
            totalPages={totalPages}
            currentPage={currentPage}
            prevPage={prevPage}
            nextPage={nextPage}
            allEpisodes={episodes}
            filter={sidebarFilter}
            onFilterChange={setSidebarFilter}
            taskGroups={episodeTasks?.tasks}
            taskFilter={taskFilter}
            onTaskFilterChange={setTaskFilter}
            onEpisodeSelect={
              activeTab === "urdf"
                ? (ep) => {
                    setUrdfEpisode(ep);
                    urdfChangerRef.current?.(ep);
                  }
                : activeTab === "annotations"
                  ? (ep) => router.push(`./episode_${ep}`)
                  : undefined
            }
          />
        )}

        {/* Main content */}
        <div
          className={`flex flex-col gap-4 p-4 flex-1 relative ${isLoading ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {isLoading && <Loading />}

          {activeTab === "episodes" && (
            <>
              <div className="flex items-center gap-4 mb-2">
                <Link
                  href="/"
                  className="block shrink-0 opacity-90 transition-opacity hover:opacity-100"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/trossen-logo.png"
                    alt="Trossen Robotics"
                    className="h-6 w-auto object-contain"
                  />
                </Link>

                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-slate-200">
                    {datasetInfo.repoId}
                  </p>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-0.5 tabular">
                    Episode · {episodeId}
                  </p>
                </div>
              </div>

              {/* Videos */}
              {depthCount > 0 && (
                <button
                  onClick={() => setShowDepth((prev) => !prev)}
                  title="Depth is stored as 12-bit HEVC; showing it transcodes an 8-bit preview per episode"
                  className={`self-start text-[10px] uppercase tracking-wide px-2 py-1 rounded-md border transition-colors ${
                    showDepth
                      ? "bg-cyan-400/15 text-cyan-300 border-cyan-400/40"
                      : "text-slate-500 border-white/10 hover:text-slate-300"
                  }`}
                >
                  Depth · {depthCount}
                </button>
              )}
              {shownVideos.length > 0 && (
                <SimpleVideosPlayer
                  videosInfo={shownVideos}
                  onVideosReady={() => setVideosReady(true)}
                />
              )}

              <ReviewBar
                episodeId={episodeId}
                episodes={navigableEpisodes}
                onNavigate={(ep) => router.push(`./episode_${ep}`)}
              />

              {/* Language Instruction */}
              {task && (
                <div className="mb-6 panel p-4">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">
                    Language Instruction
                  </p>
                  <div className="mt-1.5 space-y-0.5 text-sm text-slate-200">
                    {task
                      .split("\n")
                      .map((instruction: string, index: number) => (
                        <p key={index}>{instruction}</p>
                      ))}
                  </div>
                </div>
              )}

              {/* Graph */}
              <div className="mb-4">
                <Suspense fallback={null}>
                  <DataRecharts
                    data={chartDataGroups}
                    onChartsReady={() => setChartsReady(true)}
                  />
                </Suspense>
              </div>

              <PlaybackBar />
            </>
          )}

          {activeTab === "annotations" && (
            <div className="annotations-skin flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <p className="text-base font-medium text-slate-200 truncate">
                  {datasetInfo.repoId}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 tabular">
                  Episode · {episodeId}
                </p>
              </div>
              {shownVideos.length > 0 && (
                <SimpleVideosPlayer
                  videosInfo={shownVideos}
                  onVideosReady={() => setVideosReady(true)}
                />
              )}
              <div className="grounding-intro">
                <span className="section-kicker">Grounded VQA</span>
                <ul>
                  <li>
                    Draw directly on the active video to create visual
                    questions. Drag for a bounding box, click for a point. The
                    camera is detected from the video you draw on.
                  </li>
                  <li>
                    Drag on any video to add a bbox question. Click any video to
                    add a keypoint question. Confirm the popup with <kbd>↵</kbd>
                    , or cancel with <kbd>Esc</kbd>.
                  </li>
                </ul>
              </div>
              <PlaybackBar />
              <AnnotationsTimeline duration={data.duration} />
              <AnnotationsPanel
                cameraKeys={shownVideos.map((v) => v.filename)}
              />
            </div>
          )}

          {activeTab === "statistics" && (
            <StatsPanel
              datasetInfo={datasetInfo}
              episodeLengthStats={episodeLengthStats}
              loading={statsLoading}
            />
          )}

          {activeTab === "frames" && (
            <OverviewPanel
              data={episodeFramesData}
              loading={framesLoading}
              flaggedOnly={framesFlaggedOnly}
              onFlaggedOnlyChange={setFramesFlaggedOnly}
            />
          )}

          {activeTab === "insights" && (
            <Suspense fallback={<Loading />}>
              <ActionInsightsPanel
                flatChartData={data.flatChartData}
                fps={datasetInfo.fps}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={insightsLoading}
              />
            </Suspense>
          )}

          {activeTab === "filtering" && (
            <Suspense fallback={<Loading />}>
              <FilteringPanel
                repoId={datasetInfo.repoId}
                totalEpisodes={episodes.length}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={insightsLoading}
                episodeLengthStats={episodeLengthStats}
                flatChartData={data.flatChartData}
                onViewFlaggedEpisodes={() => {
                  setSidebarFilter("rejected");
                  handleTabChange("episodes");
                }}
              />
            </Suspense>
          )}

          {activeTab === "doctor" && (
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-between px-1 pb-2 text-xs text-slate-400">
                <span>
                  Dataset quality diagnostics &mdash; powered by{" "}
                  <a
                    href="https://github.com/jashshah999/lerobot-doctor"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-slate-200"
                  >
                    lerobot-doctor
                  </a>
                </span>
                <a
                  href={`https://jashshah999-lerobot-doctor.hf.space/?dataset=${org}/${dataset}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-slate-200"
                >
                  Open in new tab
                </a>
              </div>
              <iframe
                src={`https://jashshah999-lerobot-doctor.hf.space/?dataset=${org}/${dataset}`}
                title="lerobot-doctor"
                className="flex-1 w-full rounded border border-slate-700 bg-white"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              />
            </div>
          )}

          {activeTab === "urdf" && (
            <Suspense fallback={<Loading />}>
              <URDFViewer
                data={data}
                org={org}
                dataset={dataset}
                episodeChangerRef={urdfChangerRef}
                playToggleRef={urdfPlayToggleRef}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
