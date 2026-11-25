#!/usr/bin/env bash
set -euo pipefail

docker run --rm -v "$PWD/release:/release" \
  aquasec/trivy:0.70.0@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e \
  image --input /release/api.tar --scanners vuln,secret --image-config-scanners secret \
  --format json --output /release/scan.json
node scripts/check-image-scan.mjs release/scan.json release/scan-summary.json founders-lens-api:ci
