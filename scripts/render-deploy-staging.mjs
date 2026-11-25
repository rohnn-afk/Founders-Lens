import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const repository = 'rohnn-afk/Founders-Lens';
const image = 'ghcr.io/rohnn-afk/founders-lens-api';
const api = 'https://founders-lens-staging-api.onrender.com';
const digest = /^sha256:[0-9a-f]{64}$/;
const busy = new Set(['created', 'queued', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress']);

export async function deployStaging(env, release, request = fetch, pause = delay, report = console.log) {
  const id = env.RENDER_STAGING_API_SERVICE_ID;
  if (env.GITHUB_ACTIONS !== 'true' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_REF !== 'refs/heads/staging' || env.GITHUB_REPOSITORY !== repository ||
    !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') || release.sourceRevision !== env.GITHUB_SHA ||
    !release.reference?.startsWith(image + '@') || !digest.test(release.reference.slice(image.length + 1)) ||
    !digest.test(release.linuxAmd64ManifestDigest ?? '') ||
    !/^srv-[a-z0-9]+$/.test(id ?? '') || !env.RENDER_API_KEY || /\s/.test(env.RENDER_API_KEY)) {
    throw new Error('Staging deployment configuration rejected');
  }
  const call = async (suffix, body) => {
    const response = await request('https://api.render.com/v1/services/' + id + suffix, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: 'Bearer ' + env.RENDER_API_KEY, Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new Error(`Render ${body ? 'submission' : 'verification'} returned HTTP ${response.status}`);
    return response.json();
  };
  const service = await call('');
  if (service.id !== id || service.name !== 'founders-lens-staging-api' || service.type !== 'web_service' ||
    service.autoDeploy !== 'no' || (service.autoDeployTrigger && service.autoDeployTrigger !== 'off') ||
    service.serviceDetails?.runtime !== 'image' || service.serviceDetails.url !== api ||
    !['/health/live', '/health/ready'].includes(service.serviceDetails.healthCheckPath) ||
    !new RegExp('^ghcr\\.io/rohnn-afk/founders-lens-api(?=[:@]|$)').test(service.imagePath ?? '')) {
    throw new Error('Render API service image configuration does not match staging policy');
  }
  const mode = await call('/env-vars/FL_STAGING_DECISION_SOURCE');
  if (mode.value !== 'authority') throw new Error('Render API decision renewal is not configured');
  const history = await call('/deploys?limit=1');
  if (!Array.isArray(history) || history.some(item => busy.has(item.deploy?.status))) {
    throw new Error('Render already has an active deploy, or deploy history is unavailable');
  }
  const match = item => item.image?.ref === release.reference &&
    [release.reference.slice(image.length + 1), release.linuxAmd64ManifestDigest].includes(item.image.sha);
  const latest = history[0]?.deploy;
  const deploy = latest?.status === 'live' && match(latest) ? latest :
    await call('/deploys', { imageUrl: release.reference });
  if (!/^dep-[a-z0-9]+$/.test(deploy.id ?? '')) throw new Error('Render deploy ID missing. Reconcile deploy history before retrying.');
  report(JSON.stringify({ event: 'staging_deploy_tracking', deployment: deploy.id, revision: release.sourceRevision }));
  let live = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    const current = await call('/deploys/' + deploy.id);
    if (current.status === 'live') {
      if (!match(current)) throw new Error('Render live digest differs from the release manifest');
      live = true;
      break;
    }
    if (!busy.has(current.status)) throw new Error('Render deploy failed. Inspect events for ' + deploy.id);
    await pause(10_000);
  }
  if (!live) throw new Error('Render deploy timed out. Inspect events for ' + deploy.id);
  for (let attempt = 0; attempt < 12; attempt++) {
    const statuses = await Promise.all(['/health/live', '/health/ready', '/api/v1/ideas'].map(path =>
      request(api + path, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
        .then(async response => { await response.body?.cancel(); return response.status; }).catch(() => 0)));
    if (statuses[2] === 200) throw new Error('Staging API unexpectedly allowed an unauthenticated read');
    if (statuses[0] === 200 && statuses[1] === 200 && statuses[2] === 401) {
      report(JSON.stringify({ event: 'staging_smoke_passed', deployment: deploy.id }));
      return;
    }
    await pause(5_000);
  }
  throw new Error('Staging smoke failed. Check readiness, decision renewal and auth denial for ' + deploy.id);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await deployStaging(process.env, JSON.parse(await readFile(process.argv[2], 'utf8')));
  } catch (error) {
    // Provider responses contain configuration and URLs. Print only our own diagnostics.
    console.error(error.constructor === Error ? error.message : 'Staging deployment verification failed.');
    process.exitCode = 1;
  }
}
