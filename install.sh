#!/usr/bin/env bash
# One-shot setup for the Trossen Dataset Viewer.
#
# Run it from the unpacked folder. It writes .env, then builds and starts the
# app with Docker, or sets up a native install when Docker is not available.
#
#   ./install.sh                                     ask for the data paths
#   ./install.sh --datasets ~/converted --mcap ~/raw_mcap
#   ./install.sh --native                            skip Docker
#   ./install.sh --no-start                          set up but do not launch
set -euo pipefail

cd "$(dirname "$0")"

DATASETS=""
MCAP=""
PORT="3000"
MODE="auto"
START="yes"

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --datasets) DATASETS="${2:-}"; shift 2 ;;
    --mcap)     MCAP="${2:-}"; shift 2 ;;
    --port)     PORT="${2:-}"; shift 2 ;;
    --native)   MODE="native"; shift ;;
    --docker)   MODE="docker"; shift ;;
    --no-start) START="no"; shift ;;
    -h|--help)  sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ── Where the data lives ──────────────────────────────────────────
# Asked for once and remembered in .env, which both paths read.
ask_path() {
  local prompt="$1" current="$2" answer=""
  [ -n "$current" ] && { printf '%s' "$current"; return; }
  read -r -p "$prompt" answer </dev/tty || true
  printf '%s' "${answer/#\~/$HOME}"
}

if [ -f .env ] && [ -z "$DATASETS$MCAP" ]; then
  say "reading existing .env"
  # shellcheck disable=SC1091
  . ./.env
  DATASETS="${VIZ_DATASETS_DIR:-}"
  MCAP="${VIZ_MCAP_DIR:-}"
  PORT="${VIZ_UI_PORT:-$PORT}"
fi

DATASETS=$(ask_path "Directory holding converted LeRobot datasets: " "$DATASETS")
MCAP=$(ask_path "Directory holding raw .mcap recordings (blank for none): " "$MCAP")

[ -n "$DATASETS" ] || die "a dataset directory is required"
[ -d "$DATASETS" ] || die "not a directory: $DATASETS"
# An empty MCAP mount is fine, but the path has to exist for Docker to bind it.
if [ -z "$MCAP" ] || [ ! -d "$MCAP" ]; then
  [ -n "$MCAP" ] && printf 'note: %s is not a directory, MCAP inspection disabled\n' "$MCAP"
  MCAP="$PWD/.no-mcap"
  mkdir -p "$MCAP"
fi

cat > .env <<ENV
# Written by install.sh. Edit and re-run ./install.sh to apply.
VIZ_DATASETS_DIR=$DATASETS
VIZ_MCAP_DIR=$MCAP
VIZ_UI_PORT=$PORT
ENV
say "wrote .env"

# ── Docker path ───────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$MODE" != "native" ] && have docker && docker compose version >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    die "docker is installed but not usable by this user. Start the daemon, or add yourself to the docker group, or re-run with --native"
  fi
  say "building the image (first run takes a few minutes)"
  docker compose build
  if [ "$START" = "yes" ]; then
    docker compose up -d
    say "running at http://localhost:$PORT"
    printf 'stop with:  docker compose down\nlogs with:  docker compose logs -f\n'
  else
    say "built. start with: docker compose up -d"
  fi
  exit 0
fi

[ "$MODE" = "docker" ] && die "docker or the compose plugin is missing"

# ── Native path ───────────────────────────────────────────────────
say "no usable Docker, setting up a native install"

have ffmpeg  || die "ffmpeg is required (apt install ffmpeg / brew install ffmpeg)"
have python3 || die "python3 is required"

BUN="$(command -v bun || true)"
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
if [ -z "$BUN" ]; then
  say "installing bun into ~/.bun"
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
fi
[ -x "$BUN" ] || die "bun install failed; install it from https://bun.sh and re-run"

say "installing python dependencies into .venv"
python3 -m venv .venv
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet \
  "mcap>=1.3" "mcap-protobuf-support>=0.5" "protobuf>=5" \
  "pandas>=2.0" "pyarrow>=14" "numpy>=1.24"

say "installing node dependencies"
"$BUN" install --frozen-lockfile

DATA_PORT=$((PORT + 5080))
say "building the UI"
DATASET_URL="http://127.0.0.1:$DATA_PORT" "$BUN" run build

cat > run.sh <<RUN
#!/usr/bin/env bash
# Written by install.sh. Starts the file server and the UI together.
set -euo pipefail
cd "\$(dirname "\$0")"
. ./.env

DATA_PORT=\$((VIZ_UI_PORT + 5080))
./.venv/bin/python3 serve_datasets.py \\
    --root "\$VIZ_DATASETS_DIR" --mcap-root "\$VIZ_MCAP_DIR" --port "\$DATA_PORT" &
data_server=\$!
trap 'kill \$data_server 2>/dev/null || true' EXIT INT TERM

DATASET_URL="http://127.0.0.1:\$DATA_PORT" $BUN run start -- -p "\$VIZ_UI_PORT"
RUN
chmod +x run.sh

if [ "$START" = "yes" ]; then
  say "starting at http://localhost:$PORT (ctrl-c to stop)"
  exec ./run.sh
else
  say "set up. start with: ./run.sh"
fi
