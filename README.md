---
title: Visualize Dataset (v2.0+ latest dataset format)
emoji: 💻
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
hf_oauth: true
hf_oauth_scopes:
  - read-repos
hf_oauth_expiration_minutes: 480
---

# Trossen Dataset Viewer

Review robot data that lives on this machine: LeRobot v3.0 datasets and the raw
MCAP recordings they were converted from. No Hub account, no upload, no internet.

Built as a fork of the HuggingFace Space `lerobot/visualize_dataset`.

## Requirements

Docker install: Docker Engine 24+ with the Compose plugin. Nothing else.

Native install: ffmpeg on `PATH`, Python 3.10+, and [Bun](https://bun.sh) 1.x.

Disk: the preview cache holds transcoded clips, roughly 2 MB per depth episode
and per MCAP camera topic. A few hundred MB covers a large review pass.

## Install

Clone and run the installer. It asks where your data is, writes `.env`, then
builds and starts everything:

```bash
git clone https://github.com/shantanuparab-tr/trossen-dataset-viewer.git
cd trossen-dataset-viewer
./install.sh
```

The same installer runs from an unpacked zip (see `package.sh`), so a machine
with no network access to GitHub is handed the folder instead.

Non-interactive, and with a port of your choosing:

```bash
./install.sh --datasets ~/converted --mcap ~/raw_mcap --port 3000
```

Other flags: `--native` to skip Docker, `--docker` to require it, `--no-start`
to set up without launching. Re-running is safe and picks up an edited `.env`.

The installer uses Docker when it is available and usable. Open
`http://localhost:3000`, stop with `docker compose down`, follow along with
`docker compose logs -f`. Without Docker it installs into `.venv`, builds the
UI, and writes `run.sh` to start both processes.

### Doing it by hand with Docker

```bash
cp .env.example .env
$EDITOR .env                  # point VIZ_DATASETS_DIR / VIZ_MCAP_DIR at your data
docker compose up -d --build  # first build takes a few minutes
```

| Variable            | Meaning                                                                                           | Default          |
| ------------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| `VIZ_DATASETS_DIR`  | Host directory holding `<org>/<dataset>/meta/info.json` trees. Mounted read-only.                 | `./datasets`     |
| `VIZ_MCAP_DIR`      | Host directory of raw recordings, laid out `<dataset>/<run>/episode_*.mcap`. Mounted read-only.   | `./mcap`         |
| `VIZ_UI_PORT`       | Port the UI is served on.                                                                         | `3000`           |
| `VIZ_DATASET_ROOTS` | Container-side list of dataset roots, `:`-separated. Only needed when serving more than one tree. | `/data/datasets` |

Serving several dataset trees means mounting each one and listing them:

```yaml
# docker-compose.override.yml
services:
  viz:
    volumes:
      - /mnt/nas/converted:/data/datasets:ro
      - /mnt/ssd/converted:/data/datasets-ssd:ro
    environment:
      VIZ_DATASET_ROOTS: /data/datasets:/data/datasets-ssd
```

The viewer never writes into a dataset: both mounts are read-only, and previews
go to a named volume that survives restarts.

### Other people on the LAN

Publish the port and share `http://<this-machine>:3000`. Review verdicts are
stored per browser, so everyone keeps their own; the Filtering tab exports and
imports them as JSON when passes need to be merged.

### Doing it by hand without Docker

```bash
pip install "mcap>=1.3" "mcap-protobuf-support>=0.5"
bun install

# 1. the file server, in one terminal
python3 serve_datasets.py \
    --root /path/to/converted \
    --mcap-root /path/to/raw_mcap \
    --port 8080

# 2. the UI, in another
DATASET_URL=http://127.0.0.1:8080 bun run build
DATASET_URL=http://127.0.0.1:8080 bun run start -- -p 3000
```

`DATASET_URL` must be set on the **build** command, not only on start: Next.js
inlines it into the browser bundle. Without it the page falls back to
huggingface.co and every request fails with a 401.

`serve_datasets.py` options also read environment variables, which is what the
container uses: `VIZ_DATASET_ROOTS`, `VIZ_MCAP_ROOT`, `VIZ_DEPTH_CACHE`,
`VIZ_PORT`, `VIZ_HOST`, `VIZ_NO_DEPTH_PREVIEW`.

## Using it

### Datasets

The landing page lists every dataset found under the configured roots with its
episode, frame and fps counts. Open one to get the episode viewer:

- Cameras play in a grid, synchronized with the joint charts below them.
- Depth feeds sit behind the `Depth · N` toggle. They are stored in a format no
  browser decodes, so an 8-bit preview is transcoded on first view and cached.
- `Dataset ▾` in the tab bar switches to another dataset without going home.
- The sidebar lists episodes, with arrow keys for previous and next.

### Reviewing episodes

The review row sits under the cameras.

| Key     | Action                              |
| ------- | ----------------------------------- |
| `g`     | Mark good, move to the next episode |
| `b`     | Reject, move to the next episode    |
| `x`     | Clear the verdict                   |
| `n`     | Jump to the next unreviewed episode |
| `space` | Play / pause                        |
| `↑` `↓` | Previous / next episode             |

Any episode can carry several labels, whatever its verdict: `change task prompt`,
`too short`, `incomplete task`, `blurry`, `collision`, `wrong task`, `truncated`,
plus any you type into the `+ label` box, which then joins the palette for that
dataset. <kbd>1</kbd>-<kbd>9</kbd> toggle the first nine. A label is an action
item, not a rejection, so a good episode can still be marked "change task
prompt".

The sidebar shows a green or red dot per episode, the number of labels on it,
and `Rejected · n` and `Unreviewed · n` filters that span the whole dataset.

The Filtering tab holds the pass as a whole: progress, a tally per label (click
one to copy its episode ids), a `Download verdicts` JSON export, `Import` to
merge a file back in, and a `lerobot-edit-dataset` command that deletes the
rejected episodes. It also flags
low-movement, jerky and outlier-length episodes, which feed the same reject list.

Verdicts live in the browser under `review:<repoId>`, so each dataset keeps its
own pass and a reload does not lose it.

### Validation tools

`/tools` runs the checks in `tools/` against a dataset or a recording and shows
what they printed. Shipped with two:

| Tool                 | Target    | Reports                                                                                                                                                                                                                                                                                 |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LeRobot v3 validator | dataset   | Required files and metadata keys; agreement between info.json, the episode table, the data rows and the video frame counts; contiguous episode indices and uniform k/fps timestamps; and the image-to-state lag in frames, measured by correlating image motion against joint velocity. |
| MCAP stream timing   | recording | Per-channel message counts, span, mean rate, median interval, jitter and largest gap. Messages are counted, never decoded.                                                                                                                                                              |

Adding a tool is a script plus a `<name>.tool.json` manifest in `tools/`. The
server reads the manifests per request, so a new tool appears on the next page
load with no server or UI change. `tools/README.md` documents the manifest
fields. Both tools also run standalone:

```bash
python3 tools/validate_lerobot_v3.py /path/to/dataset --sync-episodes 5
python3 tools/mcap_analyze.py /path/to/episode.mcap --json
```

### Raw MCAP recordings

`/mcap` (linked from the landing page) inspects recordings before conversion:

- Pick a dataset, then an episode, from the left nav.
- Metadata first: duration, message count, channel count, writer, whether the
  file carries an index, and the recorder's own metadata block.
- Camera topics preview automatically, decoded from the raw frames and played
  through one shared transport bar so every camera moves together.
- The topic table lists message counts, per-topic rate and the hardware metadata
  the recorder attached to each channel.
- Recordings are reviewed like episodes: good, reject, reasons, and a verdicts
  export.

An unindexed file means the recorder was killed mid-episode. That is a finding,
not a viewer problem.

## Troubleshooting

| Symptom                                                   | Cause                                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Every page fails with `Failed to fetch dataset info: 401` | `DATASET_URL` was missing on the build command, so the bundle points at huggingface.co.                                          |
| Landing page lists no datasets                            | The root has no `<org>/<dataset>/meta/info.json` below it. Check the mount, not the app.                                         |
| Depth tiles are empty                                     | Previews are disabled (`VIZ_NO_DEPTH_PREVIEW`) or ffmpeg is missing.                                                             |
| A camera preview never appears                            | ffmpeg failed on that topic. The server logs the reason, usually an image encoding it does not map.                              |
| Episodes play from the wrong point                        | The file server is not answering byte-range requests. Use `serve_datasets.py`, not `python -m http.server`.                      |
| A tool is missing from `/tools`                           | Its manifest failed to parse, or names a script that is not beside it. The server prints the reason at request time.             |
| A tool run fails with a missing module                    | Native install only: the tools need `pandas`, `pyarrow` and `numpy` on top of the MCAP packages. The image already carries them. |

## The upstream project

Everything below is the original Space's documentation, kept for reference. Its
setup and deployment instructions describe the Hub-backed version, not this one.

### LeRobot Dataset Visualizer

LeRobot Dataset Tool and Visualizer is a web application for interactive exploration and visualization of robotics datasets, particularly those in the LeRobot format. It enables users to browse, view, and analyze episodes from large-scale robotics datasets, combining synchronized video playback with rich, interactive data graphs.

### Project Overview

This tool is designed to help robotics researchers and practitioners quickly inspect and understand large, complex datasets. It fetches dataset metadata and episode data (including video and sensor/telemetry data), and provides a unified interface for:

- Navigating between organizations, datasets, and episodes
- Watching episode videos
- Exploring synchronized time-series data with interactive charts
- Analyzing action quality and identifying problematic episodes
- Visualizing robot poses in 3D using URDF models
- Paginating through large datasets efficiently

### Key Features

- **Dataset & Episode Navigation:** Quickly jump between organizations, datasets, and episodes using a sidebar and navigation controls.
- **Synchronized Video & Data:** Video playback is synchronized with interactive data graphs for detailed inspection of sensor and control signals.
- **Overview Panel:** At-a-glance summary of dataset metadata, camera info, and episode details.
- **Statistics Panel:** Dataset-level statistics including episode count, total recording time, frames-per-second, and an episode-length histogram.
- **Action Insights Panel:** Data-driven analysis tools to guide training configuration — includes autocorrelation, state-action alignment, speed distribution, and cross-episode variance heatmap.
- **Filtering Panel:** Identify and flag problematic episodes (low movement, jerky motion, outlier length) for removal. Exports flagged episode IDs as a ready-to-run LeRobot CLI command.
- **3D URDF Viewer:** Visualize robot joint poses frame-by-frame in an interactive 3D scene, with end-effector trail rendering. Supports SO-100, SO-101, and OpenArm bimanual robots.
- **Annotations Panel:** Hand-edit the v3.1 language schema (`language_persistent` + `language_events`) — subtask, plan, memory, interjection + paired speech, and VQA atoms with bounding-box / keypoint / count / attribute / spatial answers. VQA bboxes and keypoints render as overlays on the video player; drag or click on a camera to draw new ones. Backed by an optional FastAPI service (in `backend/`) for parquet rewrites and HF Hub push.
- **Efficient Data Loading:** Uses parquet and JSON loading for large dataset support, with pagination, chunking, and lazy-loaded panels for fast initial load.
- **Responsive UI:** Built with React, Next.js, and Tailwind CSS for a fast, modern user experience.

### Technologies Used

- **Next.js** (App Router)
- **React**
- **Recharts** (for data visualization)
- **Three.js** + **@react-three/fiber** + **@react-three/drei** (for 3D URDF visualization)
- **urdf-loader** (for parsing URDF robot models)
- **hyparquet** (for reading Parquet files)
- **Tailwind CSS** (styling)

### Getting Started

### Prerequisites

This project uses [Bun](https://bun.sh) as its package manager. If you don't have it installed:

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
```

### Installation

Install dependencies:

```bash
bun install
```

### Development

Run the development server:

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `src/app/page.tsx` or other files in the `src/` directory. The app supports hot-reloading for rapid development.

### Other Commands

```bash
# Build for production
bun run build

# Start production server
bun start

# Run linter
bun run lint

# Format code
bun run format
```

### Environment Variables

- `DATASET_URL`: (optional) Base URL for dataset hosting (defaults to HuggingFace Datasets).
- `NEXT_PUBLIC_ANNOTATE_BACKEND_URL`: (optional) URL of the FastAPI annotation
  backend (`backend/app.py`). When set, the Annotations tab can save edits and
  rewrite parquet shards / push to the Hub. When unset the tab is read/edit
  only with sessionStorage persistence.

### Annotations backend (optional)

The Annotations tab edits LeRobot v3.1 language atoms — `language_persistent`
(broadcast subtask/plan/memory) and `language_events` (per-frame
interjection / vqa / speech) — and renders existing bbox/keypoint atoms over
the video player. Edits live in `sessionStorage` by default; to write the
new columns into `data/chunk-*/file-*.parquet` (matching the writer in
[lerobot#3471](https://github.com/huggingface/lerobot/pull/3471)) and push the
result to the Hub, run the bundled FastAPI service:

```bash
# 1. install + start the backend (port 7861 by default)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --port 7861 --reload

# 2. start the visualizer with the backend URL configured
cd ..
NEXT_PUBLIC_ANNOTATE_BACKEND_URL=http://127.0.0.1:7861 bun run dev
```

The backend exposes:

- `POST /api/dataset/load` — load a dataset by `repo_id` or `local_path`
- `GET  /api/episodes/{ep}/atoms` — list atoms for an episode
- `POST /api/episodes/{ep}/atoms` — replace atoms (event timestamps are
  snapped to exact source-frame timestamps before persisting)
- `GET  /api/episodes/{ep}/frame_timestamps` — used client-side for snapping
- `POST /api/export` — rewrite parquet with the new language columns plus
  the dataset-level `tools` column (drops legacy `subtask_index`)
- `POST /api/push_to_hub` — export and push to a target repo

### Docker Deployment

This application can be deployed using Docker with bun for optimal performance and self-contained builds.

### Build the Docker image

```bash
docker build -t lerobot-visualizer .
```

### Run the container

```bash
docker run -p 7860:7860 lerobot-visualizer
```

The application will be available at [http://localhost:7860](http://localhost:7860).

### Run with custom environment variables

```bash
docker run -p 7860:7860 -e DATASET_URL=your-url lerobot-visualizer
```

### Contributing

Contributions, bug reports, and feature requests are welcome! Please open an issue or submit a pull request.

### Acknowledgement

The app was orignally created by [@Mishig25](https://github.com/mishig25) and taken from this PR [#1055](https://github.com/huggingface/lerobot/pull/1055)
