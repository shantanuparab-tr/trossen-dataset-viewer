# Handoff — local LeRobot dataset visualizer

You are taking over the **visualizer** only. Another agent owns the dataset
transfers and the MCAP→LeRobot conversion; do not touch `~/NVIDIA_DATASETS`
except to read from it.

## What this is and why it exists

`~/lerobot_dataset_viz` is a clone of the HuggingFace Space
[`lerobot/visualize_dataset`](https://huggingface.co/spaces/lerobot/visualize_dataset),
patched to read datasets from a **local directory** instead of the HF Hub.

The reason: we reconverted 9 robot datasets (939 episodes) with a fixed
MCAP→LeRobot v3.0 converter and need to eyeball every episode before publishing
them to a public S3 bucket. The datasets are 8–34 GB each, so uploading them to
the Hub just to look at them is not viable. The stock local tool
(`lerobot-dataset-viz`, lerobot 0.6.1) only renders **one episode per
invocation** through Rerun, which is why we run this Space locally instead — it
gives the scrollable episode list.

The clone was taken 2026-09-18 at package version 0.1.0. **`.git` was removed
during setup**, so there is no upstream remote and no way to `git pull` changes.
If you need to diff against upstream, re-clone to a scratch directory and
compare.

## Running it

Two processes. Both must be up.

```bash
# 1. the Hub stand-in, serving dataset files (port 8080)
cd ~/lerobot_dataset_viz
python3 serve_datasets.py \
    --root ~/NVIDIA_DATASETS/converted \
    --mcap-root ~/mcap_samples --port 8080
#    --root is repeatable; the first root holding a path wins
#    --depth-cache DIR      where 8-bit depth previews are kept
#                           (default ~/.cache/lerobot_depth_preview)
#    --no-depth-preview     serve depth as stored; tiles then render empty
#    --mcap-root DIR        raw .mcap recordings to expose at /mcap

# 2. the app (port 3000)
DATASET_URL=http://127.0.0.1:8080 ~/.bun/bin/bun run start -- -p 3000
```

The landing page at `http://127.0.0.1:3000/` lists the datasets under `--root`
(from the server's `/api/datasets`), so no URL typing is needed. Direct links
still work: `http://127.0.0.1:3000/<org>/<dataset>/episode_0`.

Toolchain: `bun` at `~/.bun/bin/bun`, node v22.22.0 via nvm. `bun install` is
already done (428 packages).

## Packaging

`./install.sh` is what someone unpacking the zip runs: it asks for the data
directories, writes `.env`, then builds and starts with Docker, or falls back to
a native install (venv, bun, a generated `run.sh`) when Docker is unusable. It
takes `--datasets`, `--mcap`, `--port`, `--native`, `--docker` and `--no-start`,
and re-running it is how a changed `.env` is applied. `./package.sh` builds the
zip, excluding node_modules, .next, .venv, `.env` and any data.

Underneath, `docker compose up -d --build` is the portable path: one image carrying ffmpeg,
the Python MCAP reader and the built UI, with the data directories bind-mounted
read-only and the preview cache in a named volume. `.env.example` lists the
three settings anyone needs (`VIZ_DATASETS_DIR`, `VIZ_MCAP_DIR`, `VIZ_UI_PORT`).
README.md is the user-facing version of this.

The container serves one origin: the UI forwards `/data/*` to the file server
beside it (a Next.js rewrite, `DATA_SERVER_URL`), and `DATASET_URL` is baked as
the relative path `/data`. That is what makes the image portable — no hostname,
port or LAN address is compiled into the bundle, and there is no CORS story. The
native two-port setup above still works and is unchanged.

Every server option also reads an environment variable (`VIZ_DATASET_ROOTS`,
`VIZ_MCAP_ROOT`, `VIZ_DEPTH_CACHE`, `VIZ_PORT`, `VIZ_HOST`), so a container or a
service file configures it without a command line. A root that does not exist is
reported and skipped rather than fatal, because an unmounted volume is normal.

## Branding

The palette, typeface and wordmark come from the Trossen SDK webapp
(`experimental/trossen-webapp`, `webapp/frontend/src/styles/theme.css`): #0b0b0b
page, #0d0d0d surfaces, #252525 edges, #b9b8ae muted text, #55bde3 accent, and
JetBrains Mono throughout. The Tailwind `cyan-200..600` scale is redefined to the
brand cyan in `globals.css`, so the UI's many `text-cyan-300`-style utilities are
rebranded without touching components. The logo is `public/trossen-logo.png`,
copied from the webapp's assets.

The landing page's stock hero video was removed: it was fetched from
huggingface.co, so it broke on a machine with no internet. The Hub search box,
the "Explore Open Datasets" CTA and the sign-in button now hide themselves
whenever local datasets are served.

## Tools

`tools/` holds the command-line checks, each a script plus a `<name>.tool.json`
manifest. `GET /api/tools` lists the manifests (read per request, so a new tool
needs no restart) and `GET /api/tools/run?id=&target=&<flags>` runs one and
returns its exit code, duration, stdout, stderr and, when the output parses, the
JSON. `/tools` in the UI is a generic front end: the tool list, the target picker
and the options form are all built from the manifest, so a new tool needs no UI
work.

The browser never sends a filesystem path. It names a dataset (`<org>/<name>`) or
a recording (path relative to the MCAP root), and `resolve_target` maps that
inside a configured root.

Vendored from `~/NVIDIA_DATASETS/scripts`: `validate_lerobot_v3.py` (structure,
counts, cadence, image/state sync lag) and `mcap_analyze.py` (per-channel rates
and jitter). `--json` was added to the validator, which its docstring already
advertised but it did not implement. The container carries pandas, pyarrow and
numpy for them.

Running the validator over `open_drawer_v3_fixed` reports a median lag of -11
frames on camera_high, which is the camera/state alignment issue, not a tool
fault.

## The four non-obvious things

Each of these cost time to find. Do not undo them.

**1. `DATASET_URL` must be set at BUILD time, not just at start time.**
`src/utils/versionUtils.ts` reads `process.env.DATASET_URL` from client
components, and Next.js only inlines variables into the browser bundle if they
are `NEXT_PUBLIC_`-prefixed. Without help, the browser silently falls back to
`https://huggingface.co/datasets` and every page dies with
`Failed to fetch dataset info: 401`. The fix is an `env` block added to
`next.config.ts`. So a rebuild is:

```bash
DATASET_URL=http://127.0.0.1:8080 ~/.bun/bin/bun run build
```

Forgetting the variable on the build line produces a bundle hardcoded to
huggingface.co, and the symptom (a 401) looks like an auth problem rather than
a build problem.

**2. `serve_datasets.py` must answer byte-range requests.**
LeRobot v3.0 concatenates many episodes into one mp4 per chunk and records each
episode's span as `from_timestamp`/`to_timestamp` in `meta/episodes/*.parquet`.
The player seeks into the middle of those files, which needs HTTP 206. A plain
`python -m http.server` returns 200 with the whole file and every episode plays
from the start of the chunk. The server also strips the `resolve/<rev>` path
segments, because the app builds every URL as
`${DATASET_URL}/${repoId}/resolve/main/${path}`.

**3. Depth is transcoded on demand, not served as stored.**
Depth streams are HEVC Main 12 / `gray12le` (confirmed in `meta/info.json`),
which no browser decodes. The viewer asks for
`<video url>?depth8=1&start=<s>&end=<s>` and the server returns an 8-bit H.264
clip of exactly that episode's span, cached under `--depth-cache`. A clip is
~0.7s of ffmpeg for a 6s episode; the existing viridis colormap path then
recolors it, and the q10/q90 band still applies because `format=gray` rescales
12-bit luma linearly. Depth tiles stay hidden behind the `Depth · N` toggle on
the Episodes tab, so the transcodes only run when someone asks to see depth.
Depth is never preloaded for adjacent episodes: those requests are transcode
jobs, and holding several of the browser's six per-host connections on ffmpeg
starves the metadata fetches. `&warm=1` on a preview URL answers 202 and builds
the clip in a background thread; the viewer fires those for the next episodes.

**4. The server caps open-ended byte ranges at 4 MiB.**
A `<video>` asks for `bytes=N-` and then reads lazily, so the rest of the file
sits in the socket's send buffer against a zero receive window and the
connection is pinned while the tile is on screen. Six tiles (three colour plus
three depth) is exactly the browser's per-host connection budget, and the next
episode's metadata fetch then never gets a slot: the page hangs on "preparing
data & videos" forever. Observed directly as three sockets with ~3 MB stuck in
`Send-Q`. Answering an open-ended range with a bounded slice keeps connections
short-lived; the player asks for the next slice when it needs one. A 20s socket
timeout backs this up. Do not remove the cap: three colour cameras hid the
problem, six tiles surface it every time.

## Reviewing episodes

The point of the tool. On the Episodes tab: <kbd>g</kbd> good, <kbd>b</kbd>
reject, <kbd>x</kbd> clear; marking a verdict jumps to the next episode, so a
pass is one keystroke per episode. Verdicts live in `localStorage` under
`review:<repoId>` (they survive reloads and restarts, and are per browser).

Episodes carry any number of labels, independent of the verdict: the built-in
set is `change task prompt`, `too short`, `incomplete task`, `blurry`,
`collision`, `wrong task`, `truncated`, and a pass can add its own, which are
stored with it under `palette`. Keys `1`-`9` toggle the first nine. The single
`reasons` map earlier versions wrote is migrated to that episode's first label
on load, in both the episode store and the MCAP one. `n` jumps to the next
unreviewed episode, wrapping around.

The sidebar shows a dot per episode (green / red / unreviewed), the reviewed
count, and filters for `Rejected · n` and `Unreviewed · n` that span the whole
dataset rather than the current page. The Filtering tab shows progress and the
reason tally, exports the verdicts as JSON (`{repoId, reviewedAt, good[],
rejected[], reasons, verdicts}`), imports one back (merging, imported wins),
and keeps the existing `lerobot-edit-dataset` delete command for the rejects. A
"bad" verdict and a heuristic flag (low movement, jerky, outlier length) are the
same thing, so the Filtering tab's bulk flag buttons feed the same reject list.

A `Dataset ▾` menu in the tab bar switches between local datasets, showing each
one's episode count. It hides itself when fewer than two are served.

Verdicts are per dataset (`review:<repoId>` in localStorage), so switching
datasets switches review passes; the counters and sidebar dots follow.

## Inspecting raw MCAP

`/mcap` lists the recordings under `--mcap-root` and, for one file, reports
duration, message count, per-topic message counts and rates, whether the file
carries an index, and the `trossen_sdk_recording` metadata block. Messages are
counted through the summary section, never decoded, so a multi-gigabyte file
answers in milliseconds.

Each image topic has a `Preview` button. The server decodes that topic's frames
out of the recording, pipes them into ffmpeg and returns an H.264 clip, cached
like the depth previews (11 frames took 0.2s; a full episode is seconds). Only
the clip crosses the wire: the stored frames are uncompressed BGR8 or 16-bit
depth, which no browser decodes and nobody wants to download. 16-bit depth is
rescaled with ffmpeg's `normalize`, since raw millimetres occupy a small part of
the 16-bit range and truncating renders near-black.

Every image topic previews by default when a recording is opened, and the tiles
play as one: a single play/pause and scrub bar drives them, with any tile more
than 0.15s off the leader snapped back. The cameras free-run on their own clocks
(28.29 Hz next to 31.12 Hz in a real episode), so position in seconds is the
only thing they can share. A build takes ~0.5s even on a 1 GB recording, because
the topic's chunks are read through the index; `&warm=1` builds one in the
background.

The page is laid out metadata first, then the camera tiles, then the topic
table. The topic table's Hardware column prints whatever the recorder attached
to that channel, key by key, so anything added to the channel metadata (camera
model, serial, arm model) appears without touching this page. Today only
`stream_type` (and `video_format` on video recordings) is written; joint
channels carry nothing and read "not recorded". The write side is
`TrossenMCAPBackend::ensure_image_channel_with_metadata` for cameras and the
joint channel creation next to it, which currently passes `std::nullopt`.

Recordings are reviewed the same way as LeRobot episodes: Good / Reject, reject
reasons, verdict dots in the list, a `Rejected · n` filter, and a verdicts JSON
download. Marking a verdict moves to the next recording. These verdicts live
under `review:mcap` and are keyed by file path, separate from the per-dataset
episode verdicts.

`~/mcap_samples` holds five recordings (3.3 GB) pulled from `trossen@totl-01`,
laid out as `<dataset>/<run>/episode_*.mcap`, which is what the dataset picker
groups on: three from `push_red_button` and two from `open_drawer`.
`push_red_button/.../episode_000056.mcap` is a cut-short episode (0.35s, 108
messages, six cameras) and a useful test case.

Full raw datasets are 66–329 GB each and stay on totl-01 / totl-02 under
`~/NVIDIA_DATASETS/raw_mcap/`; the tailnet only permits `ssh trossen@totl-01`,
not your own username.

`~/NVIDIA_DATASETS/converted` is the only dataset root. The conversion agent
renames as it reconverts: the `*_v3_fixed` names are gone, replaced by `*_v3`
and `*_v3_depth` (15 datasets as of 2026-09-18). Verdicts are keyed by repo id,
so a rename orphans a review pass rather than moving it.

Two colour-only copies pulled from totl-01 for multi-root testing lived in
`~/viz_datasets` and were deleted once the converted root carried the same
tasks under current names. Pull them again from
`trossen@totl-01:~/NVIDIA_DATASETS/converted_v2/...` if a second root is needed.

## Verified working

Screenshot-confirmed on `pull_handle_door_v3_fixed` (Firefox, 2026-09-18):
episode list of all 100 episodes down the left, colour camera grid playing, task
string rendered, header reading 20,667 frames / 100 episodes / 30 fps — matching
the conversion log. Routes `/` and `/explore` return 200; `/<org>/<dataset>`
307-redirects to episode 0.

Also screenshot-confirmed: the landing page lists the local dataset and opens it;
the `Depth · 3` toggle brings up all three depth feeds in viridis; `b` then `g`
marks episodes 0 and 1 and walks forward; the verdicts survive a hard reload and
show as red/green dots plus "2 / 100 reviewed · 1 good · 1 rejected" on the
Filtering tab; reason chips tag a reject and the tally shows "collision · 1";
four `n` presses walk the unreviewed episodes with all six tiles live and no
stall; `/mcap` reports the sample recording's ten channels, rates and metadata,
and previews both a colour and a depth topic as playing video.

`bun run type-check`, `bun test` (157 pass) and `bun run lint` are clean.

## Known gaps — candidate work

1. **`/explore` still lists Hub datasets.** It calls
   `https://huggingface.co/api/datasets?...`. The landing page covers local
   datasets now, so this page is only worth pointing at `/api/datasets` if
   someone actually uses it.

2. **Dead HF coupling.** Harmless but confusing: `hf-auth-button.tsx`,
   `src/app/api/auth/*`, `postParentMessage.ts` (posts to a
   `https://huggingface.co` parent origin that will never exist here), and
   `src/app/api/proxy/[...path]/route.ts` (hardcodes `HF_HOST`, only reachable
   when signed in, so currently unused). Removing these is optional; if you do,
   check `proxyHfUrl()` in `src/utils/auth.ts` first — it is called on video
   URLs and returns them unchanged only because no auth token is present.

3. **MCAP inspector has no plots.** Image topics preview, but there are no
   joint timeseries and no inter-message jitter, both of which
   `~/NVIDIA_DATASETS/scripts/mcap_analyze.py` already computes on the command
   line. Decoding `trossen_sdk.msg.JointState` server-side and returning a
   downsampled series would be the next step.

4. **URDF 3D viewer** pulls robot models from `huggingface.co/buckets/lerobot`.
   Untested here. Our arms are Trossen WXAI, which are not in that set.

## Ground rules

- Do not modify anything under `~/NVIDIA_DATASETS` — another agent is writing
  conversion output there and deletions have already cost us a re-run.
- `pull_handle_door_v3_fixed` is the only dataset on this laptop right now
  (8.1 GB). The other eight are still on `totl-01` and `totl-02`. If you need a
  second dataset to test against, ask rather than pulling ~130 GB over WiFi.
- Datasets are destined for a **public** S3 bucket, so do not add anything to
  this tool that writes into the dataset trees.
