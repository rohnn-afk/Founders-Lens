#!/usr/bin/env bash
set -euo pipefail
[[ "$GITHUB_ACTIONS" == true && "$GITHUB_EVENT_NAME" == push && "$GITHUB_REF" == refs/heads/staging ]]
[[ "$GITHUB_REPOSITORY" == rohnn-afk/Founders-Lens && "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
image=ghcr.io/rohnn-afk/founders-lens-api
tag="$image:$GITHUB_SHA"
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf -- "$DOCKER_CONFIG"' EXIT
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
docker load --input release/api.tar
[[ "$(docker image inspect --format '{{.Id}}' founders-lens-api:ci)" == "$(cat release/index-digest)" ]]
bash scripts/smoke-api-image.sh founders-lens-api:ci "$GITHUB_SHA"
config_file=$(tar -xOf release/api.tar manifest.json | jq -er '.[0].Config')
config_digest="sha256:$(tar -xOf release/api.tar "$config_file" | sha256sum | cut -d ' ' -f 1)"

# A rerun can verify a previously published commit, but never replaces its tag.
if ! docker buildx imagetools inspect --raw "$tag" > release/remote-index.json 2> release/registry-error.log; then
  grep -Eqi 'not found|manifest unknown' release/registry-error.log
  docker tag founders-lens-api:ci "$tag"
  docker push "$tag"
  docker buildx imagetools inspect --raw "$tag" > release/remote-index.json
fi
digest=$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}')
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
ref="$image@$digest"
docker buildx imagetools inspect --raw "$ref" > release/remote-index.json
platform="$digest"
if jq -e 'has("manifests")' release/remote-index.json >/dev/null; then
  platform=$(jq -er '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")] | if length == 1 then .[0].digest else error("Unexpected registry platform") end' release/remote-index.json)
fi
[[ "$platform" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$(docker buildx imagetools inspect --raw "$image@$platform" | jq -er .config.digest)" == "$config_digest" ]]
jq -n --arg source "$GITHUB_SHA" --arg tag "$tag" --arg ref "$ref" --arg platform "$platform" \
  '{sourceRevision:$source, tag:$tag, reference:$ref, linuxAmd64ManifestDigest:$platform}' > release/manifest.json
