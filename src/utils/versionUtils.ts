/**
 * Utility functions for checking dataset version compatibility
 */

import { authHeaders } from "./auth";

export const DATASET_URL =
  process.env.DATASET_URL || "https://huggingface.co/datasets";

/** One entry of the local server's `/api/datasets` listing. */
export interface LocalDatasetEntry {
  repoId: string;
  total_episodes?: number;
  total_frames?: number;
  fps?: number;
  robot_type?: string | null;
  codebase_version?: string;
  cameras?: string[];
}

/**
 * Datasets served from the configured root. Empty when DATASET_URL points at
 * the Hub, which has no such endpoint — the caller then falls back to search.
 */
export async function listLocalDatasets(): Promise<LocalDatasetEntry[]> {
  try {
    const res = await fetch(`${DATASET_URL}/api/datasets`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as LocalDatasetEntry[]) : [];
  } catch {
    return [];
  }
}

/** One raw recording under the server's --mcap-root. */
export interface McapFileEntry {
  path: string;
  size: number;
  modified: number;
}

export interface McapChannel {
  topic: string;
  schema: string;
  encoding: string;
  /** Whatever the recorder attached to the channel (stream_type, and any
   * hardware identification it writes). */
  channelMetadata?: Record<string, string>;
  count: number;
  hz: number | null;
}

export interface McapSummary {
  path: string;
  size: number;
  profile: string;
  library: string;
  indexed: boolean;
  messageCount: number;
  durationSeconds: number;
  channels: McapChannel[];
  metadata: Record<string, Record<string, string>>;
  error?: string;
}

/** Raw recordings the server can inspect; empty when it serves none. */
export async function listMcapFiles(): Promise<McapFileEntry[]> {
  try {
    const res = await fetch(`${DATASET_URL}/api/mcap`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as McapFileEntry[]) : [];
  } catch {
    return [];
  }
}

/** One check in tools/, as its manifest declares it. */
export interface ToolOption {
  flag: string;
  label: string;
  type: "number" | "boolean" | "string";
  default?: number | boolean | string;
}

export interface ToolManifest {
  id: string;
  name: string;
  description?: string;
  target: "dataset" | "mcap";
  script: string;
  jsonFlag?: string;
  options?: ToolOption[];
}

export interface ToolRun {
  id: string;
  target?: string;
  command?: string;
  exitCode?: number;
  ok: boolean;
  timedOut?: boolean;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  json?: unknown;
}

export async function listTools(): Promise<ToolManifest[]> {
  try {
    const res = await fetch(`${DATASET_URL}/api/tools`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as ToolManifest[]) : [];
  } catch {
    return [];
  }
}

export async function runTool(
  id: string,
  target: string,
  options: Record<string, string>,
): Promise<ToolRun> {
  const params = new URLSearchParams({ id, target, ...options });
  const res = await fetch(`${DATASET_URL}/api/tools/run?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`tool run failed: HTTP ${res.status}`);
  return (await res.json()) as ToolRun;
}

/** URL of the H.264 clip the server builds for one image topic. */
export function mcapPreviewUrl(path: string, topic: string): string {
  return `${DATASET_URL}/api/mcap/preview?path=${encodeURIComponent(
    path,
  )}&topic=${encodeURIComponent(topic)}`;
}

export async function fetchMcapSummary(path: string): Promise<McapSummary> {
  const res = await fetch(
    `${DATASET_URL}/api/mcap/summary?path=${encodeURIComponent(path)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`summary failed: HTTP ${res.status}`);
  return (await res.json()) as McapSummary;
}

/** A directory the server looks in for datasets. */
export interface DatasetRoot {
  path: string;
  exists: boolean;
  datasets: number;
  /** Passed on the command line, so it cannot be removed from the browser. */
  fixed: boolean;
}

interface RootsResult {
  ok: boolean;
  error: string | null;
  roots: DatasetRoot[];
}

/** Which set of folders a roots call acts on. */
export type RootKind = "datasets" | "mcap";

/** Dataset roots and MCAP roots are the same shape on two endpoints. */
function rootsEndpoint(kind: RootKind): string {
  return kind === "mcap" ? "/api/mcap/roots" : "/api/roots";
}

export async function listRoots(kind: RootKind): Promise<DatasetRoot[]> {
  try {
    const res = await fetch(`${DATASET_URL}${rootsEndpoint(kind)}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return ((await res.json()).roots ?? []) as DatasetRoot[];
  } catch {
    return [];
  }
}

export async function changeRoot(
  kind: RootKind,
  action: "add" | "remove",
  path: string,
): Promise<RootsResult> {
  try {
    const res = await fetch(
      `${DATASET_URL}${rootsEndpoint(kind)}/${action}?path=${encodeURIComponent(
        path,
      )}`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, roots: [] };
    }
    return (await res.json()) as RootsResult;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      roots: [],
    };
  }
}

/** One robot's joint positions over an episode, as the plots read them. */
export interface McapJointStream {
  topic: string;
  stream: string;
  /** Joint names from the recording's dataset_info; empty when it has none. */
  names: string[];
  /** Seconds from the first message in the file. */
  t: number[];
  /** One row per sample, one value per joint. */
  positions: number[][];
}

export async function fetchMcapJoints(
  path: string,
): Promise<McapJointStream[]> {
  const res = await fetch(
    `${DATASET_URL}/api/mcap/joints?path=${encodeURIComponent(path)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`joints failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.streams ?? []) as McapJointStream[];
}

/**
 * Dataset information structure from info.json
 */
type FeatureInfo = {
  dtype: string;
  shape: number[];
  names: string[] | Record<string, unknown> | null;
  info?: Record<string, unknown>;
};

export interface DatasetInfo {
  codebase_version: string;
  robot_type: string | null;
  total_episodes: number;
  total_frames: number;
  total_tasks: number;
  chunks_size: number;
  data_files_size_in_mb: number;
  video_files_size_in_mb: number;
  fps: number;
  splits: Record<string, string>;
  data_path: string;
  video_path: string;
  features: Record<string, FeatureInfo>;
}

// In-memory cache for dataset info (5 min TTL, max 200 entries)
const datasetInfoCache = new Map<
  string,
  { data: DatasetInfo; expiry: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = Math.max(
  8,
  parseInt(process.env.MAX_DATASET_INFO_CACHE_ENTRIES ?? "64", 10) || 64,
);

function pruneDatasetInfoCache(now: number) {
  // Remove expired entries first.
  for (const [key, value] of datasetInfoCache) {
    if (now >= value.expiry) {
      datasetInfoCache.delete(key);
    }
  }

  // Then cap overall cache size to prevent unbounded growth.
  while (datasetInfoCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = datasetInfoCache.keys().next().value;
    if (!oldestKey) break;
    datasetInfoCache.delete(oldestKey);
  }
}

export async function getDatasetInfo(repoId: string): Promise<DatasetInfo> {
  const now = Date.now();
  pruneDatasetInfoCache(now);

  const cached = datasetInfoCache.get(repoId);
  if (cached && now < cached.expiry) {
    // Keep insertion order fresh so the cache behaves closer to LRU.
    datasetInfoCache.delete(repoId);
    datasetInfoCache.set(repoId, cached);
    console.log(`[perf] getDatasetInfo cache HIT for ${repoId}`);
    return cached.data;
  }
  console.log(`[perf] getDatasetInfo cache MISS for ${repoId} — fetching`);

  try {
    const testUrl = `${DATASET_URL}/${repoId}/resolve/main/meta/info.json`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(testUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: authHeaders(),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch dataset info: ${response.status}`);
    }

    const data = await response.json();

    if (!data.features) {
      throw new Error(
        "Dataset info.json does not have the expected features structure",
      );
    }

    datasetInfoCache.set(repoId, {
      data: data as DatasetInfo,
      expiry: Date.now() + CACHE_TTL_MS,
    });
    pruneDatasetInfoCache(Date.now());
    return data as DatasetInfo;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(
      `Dataset ${repoId} is not compatible with this visualizer. ` +
        "Failed to read dataset information from the main revision.",
    );
  }
}

// Per-feature statistics from meta/stats.json (min/max/mean/std and, when
// present, quantiles like q10/q90). Not every dataset ships this file, so the
// fetch is best-effort and returns null on any failure.
const datasetStatsCache = new Map<
  string,
  { data: Record<string, unknown> | null; expiry: number }
>();

export async function getDatasetStats(
  repoId: string,
): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  const cached = datasetStatsCache.get(repoId);
  if (cached && now < cached.expiry) return cached.data;

  let data: Record<string, unknown> | null = null;
  try {
    const url = `${DATASET_URL}/${repoId}/resolve/main/meta/stats.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: authHeaders(),
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      const json = await response.json();
      if (json && typeof json === "object") {
        data = json as Record<string, unknown>;
      }
    }
  } catch {
    data = null;
  }

  datasetStatsCache.set(repoId, { data, expiry: Date.now() + CACHE_TTL_MS });
  return data;
}

const SUPPORTED_VERSIONS = ["v3.0", "v2.1", "v2.0"];

/**
 * Returns both the validated version string and the dataset info in one call,
 * avoiding a duplicate info.json fetch.
 */
export async function getDatasetVersionAndInfo(
  repoId: string,
): Promise<{ version: string; info: DatasetInfo }> {
  const info = await getDatasetInfo(repoId);
  const version = info.codebase_version;
  if (!version) {
    throw new Error("Dataset info.json does not contain codebase_version");
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(
      `Dataset ${repoId} has codebase version ${version}, which is not supported. ` +
        "This tool only works with dataset versions 3.0, 2.1, or 2.0. " +
        "Please use a compatible dataset version.",
    );
  }
  return { version, info };
}

export async function getDatasetVersion(repoId: string): Promise<string> {
  const { version } = await getDatasetVersionAndInfo(repoId);
  return version;
}

export function buildVersionedUrl(
  repoId: string,
  version: string,
  path: string,
): string {
  return `${DATASET_URL}/${repoId}/resolve/main/${path}`;
}
