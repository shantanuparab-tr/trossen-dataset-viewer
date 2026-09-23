# One image, one origin: the UI is served on $PORT and forwards `/data/*` to
# the dataset server running beside it. Nothing about the host is baked in, so
# the same image runs on any machine, port or LAN address.
FROM oven/bun:1-debian

# ffmpeg builds the depth and MCAP previews; python runs the dataset server.
# python3-venv is used because Debian's python is externally managed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV VENV=/opt/venv
# mcap* reads recordings; pandas/pyarrow/numpy are what the checks in tools/
# need, so they run in the container exactly as they do on a host.
RUN python3 -m venv $VENV \
    && $VENV/bin/pip install --no-cache-dir \
        "mcap>=1.3" "mcap-protobuf-support>=0.5" "protobuf>=5" \
        "pandas>=2.0" "pyarrow>=14" "numpy>=1.24"
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

# `/data` is a path, not a host, so the bundle is portable. Next rewrites it to
# the dataset server at request time (see next.config.ts).
ENV DATASET_URL=/data
RUN bun run build

# Defaults match the mount points in docker-compose.yml; every one is an
# override away (see .env.example).
ENV PORT=3000 \
    VIZ_DATASET_ROOTS=/data/datasets \
    VIZ_MCAP_ROOTS=/data/mcap \
    VIZ_DEPTH_CACHE=/cache/previews \
    DATA_SERVER_URL=http://127.0.0.1:8080

EXPOSE 3000
VOLUME ["/cache"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

COPY docker-entrypoint.sh /usr/local/bin/
ENTRYPOINT ["docker-entrypoint.sh"]
