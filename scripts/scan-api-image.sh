#!/usr/bin/env bash
set -euo pipefail

docker run --rm -v "$PWD/release:/release" \
  aquasec/trivy:0.70.0@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e \
  image --input /release/api.tar --scanners vuln,secret --image-config-scanners secret \
  --format json --output /release/scan.json
config_file=$(tar -xOf release/api.tar manifest.json | jq -er 'if length == 1 then .[0].Config else error("Expected one archived image") end')
config_digest="sha256:$(tar -xOf release/api.tar "$config_file" | sha256sum | cut -d ' ' -f 1)"
node scripts/check-image-scan.mjs release/scan.json release/scan-summary.json founders-lens-api:ci "$config_digest"
