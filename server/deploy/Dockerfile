# syntax=docker/dockerfile:1
# Build context is server/ (compose sets it). Builder and runtime share the
# Debian codename so the libvips the binary links against is the one it runs with.

FROM golang:1.27-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -tags=sonic -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        libvips42t64 poppler-utils ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home api
COPY --from=build /out/api /usr/local/bin/api
USER api
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["api", "healthcheck"]
ENTRYPOINT ["api"]
