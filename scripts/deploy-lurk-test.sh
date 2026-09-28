#!/usr/bin/env sh
set -eu

IMAGE="${1:-lurk:perf-watch-loop}"
REMOTE="${REMOTE:-hyperion}"
REMOTE_COMPOSE="${REMOTE_COMPOSE:-~/docker/lurk-test/compose.yaml}"
VERSION="$(git rev-parse --short HEAD)"

docker build --pull --build-arg "LURK_VERSION=$VERSION" -t "$IMAGE" .
docker save "$IMAGE" | ssh "$REMOTE" docker load
ssh "$REMOTE" "docker compose -f $REMOTE_COMPOSE up -d --force-recreate"
ssh "$REMOTE" "curl -fsS --retry 30 --retry-delay 2 --retry-all-errors http://127.0.0.1:1738/api/health"
