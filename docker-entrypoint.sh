#!/usr/bin/env bash
# Runs the dataset server and the UI side by side, and makes either one exiting
# take the container down rather than leaving a half-working instance up.
set -euo pipefail

mkdir -p "${VIZ_DEPTH_CACHE:-/cache/previews}"

python3 /app/serve_datasets.py --host 127.0.0.1 --port "${VIZ_DATA_PORT:-8080}" &
data_server=$!

bun run start -- -p "${PORT:-3000}" -H 0.0.0.0 &
ui=$!

# Forward a stop signal to both, so `docker stop` is not a 10s wait.
trap 'kill -TERM "$data_server" "$ui" 2>/dev/null || true' TERM INT

wait -n "$data_server" "$ui"
kill -TERM "$data_server" "$ui" 2>/dev/null || true
wait
