#!/usr/bin/env bash
set -euo pipefail

sha=${1:?Pass the full application source SHA}
image=${2:?Pass the local image tag}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]]
[[ "$(git rev-parse "$sha^{commit}")" == "$sha" ]]
context=$(mktemp -d)
trap 'rm -rf -- "$context"' EXIT

git archive "$sha" | tar -xf - -C "$context"
cp "$context/apps/api/Dockerfile" "$context/Dockerfile"
cp "$context/apps/api/Dockerfile.dockerignore" "$context/.dockerignore"
docker build --platform linux/amd64 --build-arg "SOURCE_SHA=$sha" --tag "$image" "$context"
