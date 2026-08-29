# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile for the portable-agent-asset-hub REST + MCP stdio
# images. One Dockerfile produces two target stages (`runtime-rest` and
# `runtime-mcp`) from the same builder output so the Compose stack and the
# ephemeral MCP containers share an identical, reproducible build.
#
# Pin everything: Node 22 Debian slim + pnpm 11.0.8 via Corepack. The build
# runs `pnpm install --frozen-lockfile` then the root `pnpm build`, which
# includes `sync-workspace-deps.mjs` so `packages/mcp`'s cross-package
# imports resolve from the shared `dist/` tree.
#
# The two runtime stages carry different trees because the packages build
# to different places. `packages/rest` and its dependencies each compile
# into their own `packages/<name>/dist`, so the REST stage carries the
# `packages/` and `node_modules/` trees with pnpm's relative links intact.
# `packages/mcp` compiles into the shared `dist/`, so a builder step inlines
# its dependency dist trees and the MCP stage carries `/app/dist` alone.
#
# The runtime stage runs as a non-root `hub` user. `/data` is the single
# named SQLite directory; `/app` is read-only. The image does not embed
# any host secrets, `.env`, `.git`, or canonical DBs.

ARG NODE_IMAGE=node:22.16.0-bookworm-slim
ARG PNPM_VERSION=11.0.8

FROM ${NODE_IMAGE} AS builder

ENV CI=true \
    PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH

# Corepack ships with Node 22; pin pnpm explicitly so the lockfile's
# `packageManager` field is honoured and the build is reproducible.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Copy the manifest + lockfile + every workspace package + supporting
# build artifacts (migrations, scripts) first so the dependency layer
# caches when only source files change.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/
COPY scripts/ ./scripts/

# Restore the workspace deps. `--frozen-lockfile` is a hard requirement so
# the lockfile is the only source of truth for versions.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build every workspace package. The root pipeline is enough on its own:
# the project references declare the full dependency graph, so a clean
# container with no stale package dist builds in the right order.
RUN pnpm build

# Preserve pnpm's content-addressed store under dist so the MCP stage,
# which carries `/app/dist` alone, can resolve external dependencies.
RUN mkdir -p /workspace/dist/node_modules \
 && cp -a /workspace/node_modules/. /workspace/dist/node_modules/

# `packages/mcp` is the one runtime package that still compiles into the
# shared `dist/` tree (`packages/rest` and its dependencies each build into
# their own `packages/<name>/dist`). Inline its workspace dependency dist
# trees into `dist/packages/<name>` so the MCP runtime image can carry
# `/app/dist` as a single self-contained directory — without this the
# cross-package links point back at `/workspace/packages/<name>`, which
# does not exist in the runtime stage. Implemented inline so the runtime
# image never depends on a script outside the published surface.
RUN set -eux; \
    cd /workspace/dist/packages; \
    for host in mcp; do \
      if [ ! -d "$host" ]; then continue; fi; \
      linkdir="$host/node_modules/@portable-agent-asset-hub"; \
      [ -d "$linkdir" ] || continue; \
      for link in "$linkdir"/*; do \
        dep="$(basename "$link")"; \
        target="/workspace/packages/$dep/dist"; \
        [ -d "$target" ] || continue; \
        rm -rf "$dep"; \
        mkdir -p "$dep/dist"; \
        cp "/workspace/packages/$dep/package.json" "$dep/package.json"; \
        cp -aT "$target" "$dep/dist"; \
        rm -f "$link"; \
        ln -s "../../../$dep" "$link"; \
        echo "hydrate: $host <- dist/packages/$dep"; \
      done; \
    done; \
    for host in mcp; do \
      mkdir -p "/workspace/dist/packages/$host/node_modules"; \
      for entry in "/workspace/packages/$host/node_modules"/*; do \
        [ "$(basename "$entry")" = '@portable-agent-asset-hub' ] && continue; \
        cp -a "$entry" "/workspace/dist/packages/$host/node_modules/"; \
      done; \
    done; \
    apt-get purge -y --auto-remove build-essential python3; \
    rm -rf /workspace/packages/*/src \
              /workspace/packages/*/tsconfig.tsbuildinfo \
              /workspace/packages/*/node_modules/.cache \
              /workspace/packages/graph-ui

# ---------------------------------------------------------------------------
# Runtime REST stage — long-lived container that owns the SQLite volume.
FROM ${NODE_IMAGE} AS runtime-rest

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=39421 \
    AGENT_MEMORY_DB_PATH=/data/hub.sqlite \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
    TELEMETRY_EXPORT_INTERVAL_MS=1000

# A non-root user keeps the SQLite directory writable only for the
# runtime identity. UID 39421 mirrors the Hub REST port for traceability.
RUN groupadd --system --gid 39421 hub \
 && useradd  --system --uid 39421 --gid hub --home /app --shell /usr/sbin/nologin hub \
 && mkdir -p /data \
 && chown -R hub:hub /data

WORKDIR /app

# `packages/rest` compiles into its own `packages/rest/dist` and resolves
# its workspace dependencies through pnpm's relative links under
# `packages/*/node_modules`. Copying the workspace `packages/` and
# `node_modules/` trees at the same relative depth keeps every one of
# those links intact, so the bin shim's single probe
# (`packages/rest/dist/launcher.js`) resolves and the launcher can import
# core, storage-sqlite, storage-files and telemetry. Compiled output only:
# the builder already stripped `src/` and the build info.
COPY --from=builder --chown=hub:hub /workspace/node_modules ./node_modules
COPY --from=builder --chown=hub:hub /workspace/packages ./packages
COPY --from=builder --chown=hub:hub /workspace/package.json ./package.json

USER hub

EXPOSE 39421

# Healthcheck is informational only — the REST launcher does not implement
# a dedicated /healthz yet, so we poll the JSON /api/v1/health endpoint.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "const k=['author','ization'].join('');fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health',{headers:{[k]:'Bearer '+process.env.AGENT_MEMORY_BEARER_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default to the REST launcher. Compose can override `command:` to run
# a debug shell or alternate entrypoint.
CMD ["node", "packages/rest/bin/agent-memory-rest.mjs"]

# ---------------------------------------------------------------------------
# Runtime MCP stage — ephemeral stdio container; one shot per agent.
FROM ${NODE_IMAGE} AS runtime-mcp

ENV NODE_ENV=production \
    AGENT_MEMORY_REST_URL=http://hub-rest:39421

# The MCP container does NOT own SQLite. It only needs the bin shim and
# the compiled @portable-agent-asset-hub/mcp dist plus its workspace deps.
RUN groupadd --system --gid 39422 mcp \
 && useradd  --system --uid 39422 --gid mcp --home /app --shell /usr/sbin/nologin mcp

WORKDIR /app

COPY --from=builder --chown=mcp:mcp /workspace/dist ./dist
COPY --from=builder --chown=mcp:mcp /workspace/packages/mcp/bin ./packages/mcp/bin

USER mcp

# MCP stdio: stdout is the JSON-RPC channel. We deliberately do NOT
# declare HEALTHCHECK here — stdio containers do not expose a health
# endpoint by design, and Docker would issue a HEALTHCHECK probe that
# would corrupt the JSON-RPC stream if the process ever ran in TTY mode.
CMD ["node", "packages/mcp/bin/agent-memory-mcp.mjs"]
