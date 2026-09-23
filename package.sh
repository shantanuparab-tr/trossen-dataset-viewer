#!/usr/bin/env bash
# Builds the shareable zip: the source, the installer and the tools, without
# the build products, the local data or anyone's .env.
set -euo pipefail

cd "$(dirname "$0")"
name="trossen-dataset-viewer-$(date +%Y%m%d).zip"

rm -f "$name"
zip -qr "$name" . \
  -x '*/node_modules/*' 'node_modules/*' \
     '*/.next/*' '.next/*' \
     '*/.venv/*' '.venv/*' \
     '.env' 'run.sh' '.no-mcap/*' \
     '*.mcap' '*.zip' '*.log' \
     '*/.git/*' '.git/*'

printf '%s  (%s)\n' "$name" "$(du -h "$name" | cut -f1)"
printf 'unpack it and run ./install.sh\n'
