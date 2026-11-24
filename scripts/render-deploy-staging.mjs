import { pathToFileURL } from 'node:url';

/** Request a deploy of the tested commit after validating both staging services. */
export async function deployStaging(env, request = fetch, report = console.log) {
  const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY,
    GITHUB_RUN_ATTEMPT, RENDER_API_KEY, RENDER_STAGING_WEB_SERVICE_ID, RENDER_STAGING_API_SERVICE_ID } = env;
  const targets = [
    ['founders-lens-staging-api', RENDER_STAGING_API_SERVICE_ID],
    ['founders-lens-staging-web', RENDER_STAGING_WEB_SERVICE_ID]
  ];
  if (GITHUB_ACTIONS !== 'true' || GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    GITHUB_REF !== 'refs/heads/staging' || GITHUB_RUN_ATTEMPT !== '1' ||
    !/^[0-9a-f]{40}$/.test(GITHUB_SHA ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? '') ||
    !RENDER_API_KEY || /\s/.test(RENDER_API_KEY) ||
    !targets.every(([, id]) => /^srv-[a-z0-9]+$/.test(id ?? '')) ||
    RENDER_STAGING_WEB_SERVICE_ID === RENDER_STAGING_API_SERVICE_ID) {
    throw new Error('Staging deployment configuration rejected');
  }

  const repo = 'https://github.com/' + GITHUB_REPOSITORY.toLowerCase();
  const call = (id, method = 'GET') => request(
    'https://api.render.com/v1/services/' + id + (method === 'POST' ? '/deploys' : ''),
    { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: 'Bearer ' + RENDER_API_KEY, Accept: 'application/json',
        ...(method === 'POST' && { 'Content-Type': 'application/json' }) },
      ...(method === 'POST' && { body: JSON.stringify({ commitId: GITHUB_SHA }) }) }
  );

  for (const [name, id] of targets) {
    const response = await call(id);
    if (!response.ok) throw new Error('Render service verification failed');
    const service = await response.json();
    if (service.id !== id || service.name !== name || service.type !== 'web_service' ||
      service.branch !== 'staging' || service.autoDeploy !== 'no' ||
      (service.autoDeployTrigger !== undefined && service.autoDeployTrigger !== 'off') ||
      service.repo?.toLowerCase().replace(/\.git$/, '') !== repo || service.serviceDetails?.plan !== 'free') {
      throw new Error('Render service does not match the staging release policy');
    }
  }

  // A lost response may follow an accepted deploy. Leave reconciliation to the operator.
  for (const [name, id] of targets) {
    const response = await call(id, 'POST');
    if (response.status !== 201 && response.status !== 202) throw new Error('Render deploy request failed');
    report(JSON.stringify({ event: 'staging_deploy_requested', service: name, commit: GITHUB_SHA }));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await deployStaging(process.env).catch(() => {
    console.error('Staging deployment did not finish submitting. Inspect Render deploy history before another dispatch.');
    process.exitCode = 1;
  });
}
