#!/usr/bin/env bash
set -euo pipefail

image=${1:?Pass the local image reference}
sha=${2:?Pass the application source SHA}
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "linux/amd64 1000:1000 $sha"
env=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image")
grep -Fx 'NODE_ENV=production' <<< "$env"
if grep -Eq '^(FL_|CLERK_|.*DATABASE_URL=|NODE_TLS_REJECT_UNAUTHORIZED=)' <<< "$env"; then
  echo 'Unexpected runtime configuration in the image.' >&2
  exit 1
fi

staging=$(docker create --network none -e FL_DEPLOYMENT=staging -e PORT=3001 "$image")
local_api=
cleanup() {
  docker rm -f "$staging" >/dev/null
  if [[ -n "$local_api" ]]; then docker rm -f "$local_api" >/dev/null; fi
}
trap cleanup EXIT
docker start "$staging" >/dev/null
test "$(docker wait "$staging")" = 1
docker logs "$staging" 2>&1 | grep -F '"event":"api_startup_denied"'

local_api=$(docker run -d --network none "$image")
docker exec "$local_api" node --input-type=module -e '
  import assert from "node:assert/strict";
  import { access } from "node:fs/promises";
  import { setTimeout } from "node:timers/promises";
  await access("/etc/ssl/certs/ca-certificates.crt");
  await assert.rejects(access("/usr/local/bin/npm"), { code: "ENOENT" });
  await assert.rejects(access("/usr/bin/openssl"), { code: "ENOENT" });
  const { PrismaClient } = await import("/app/apps/api/dist/generated/prisma/client.js");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: "postgresql://fixture@127.0.0.1:1/fixture" })
  });
  await db.$disconnect();
  for (const name of ["prisma", "typescript", "next"]) {
    await assert.rejects(access("/app/node_modules/" + name), { code: "ENOENT" });
  }
  const base = "http://127.0.0.1:3001";
  for (let retries = 0; ; retries++) {
    try {
      assert.equal((await fetch(base + "/health/live")).status, 200);
      break;
    } catch (error) {
      if (retries === 39) throw error;
      await setTimeout(250);
    }
  }
  assert.equal((await fetch(base + "/health/ready")).status, 503);
  assert.equal((await fetch(base + "/api/v1/ideas")).status, 404);
  const docs = await fetch(base + "/docs");
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /\/docs\/swagger-ui-bundle\.js/);
  const bundle = await fetch(base + "/docs/swagger-ui-bundle.js");
  assert.equal(bundle.status, 200);
  assert.ok((await bundle.arrayBuffer()).byteLength > 0);
  const initializer = await fetch(base + "/docs/initialize.js");
  assert.equal(initializer.status, 200);
  assert.match(await initializer.text(), /supportedSubmitMethods: \[\]/);
  const response = await fetch(base + "/openapi.json");
  assert.equal(response.status, 200);
  const spec = await response.json();
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(Object.keys(spec.paths).sort(), ["/health/live", "/health/ready"]);
'
