# syntax=docker/dockerfile:1
# Build context is server/ (compose and CI set it). Builder and runtime share the
# Debian codename so the libvips the binary links against is the one it runs with.
#
# CI builds this once per commit and pushes ghcr.io/softmato/hostelpalika-api:<sha>;
# the VPS only pulls (deploy/deploy.sh). Building Go + libvips on the VPS would
# compete with the running API for its 1 GB.

FROM golang:1.27.4-trixie AS build
# apt cache mounts: a rebuild that changes only Go code skips the download.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update && apt-get install -y --no-install-recommends libvips-dev pkg-config
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY internal ./internal
# GOFLAGS=-p=2 on a small builder; empty (all cores) by default.
ARG GOFLAGS=""
ARG REVISION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -tags=sonic -trimpath -ldflags="-s -w -X main.revision=${REVISION}" -o /out/api ./cmd/api \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/indexes ./cmd/indexes \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ops ./cmd/ops

FROM debian:trixie-slim
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update && apt-get install -y --no-install-recommends \
        libvips42t64 poppler-utils ca-certificates tzdata \
    && useradd --system --uid 10001 --no-create-home api
COPY --from=build /out/api /out/indexes /out/ops /usr/local/bin/
ARG REVISION=dev
LABEL org.opencontainers.image.source="https://github.com/softmato/hostelpalika" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.title="hostelpalika-api"
# Indexes are a migration: `docker compose run --rm --entrypoint indexes api` (RULES.md 6).
USER api
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["api", "healthcheck"]
ENTRYPOINT ["api"]
