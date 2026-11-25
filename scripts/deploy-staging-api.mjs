import { createPublicKey, verify } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const revision = '1bd2af0405fe97982a9a1f39bad2ff494ffe7579';
const repository = 'ghcr.io/rohnn-afk/founders-lens-api';
const digest = 'sha256:4ef05e90cddf434b77a6aebf6041dc1f7b7e52ad01f12ae8f167590f6cd4a18d';
const platform = 'sha256:6f54e8c2b9bd20ca30d6f6e1d5d99e15e4a113e6bdcfcca8833c341d8cb69f17';
const ref = repository + '@' + digest;
const origin = 'https://founders-lens-staging-api.onrender.com';
const decisions = ['FL_STAGING_IDEAS_DECISION', 'FL_STAGING_TRANSCRIPT_DECISION'];
const active = new Set(['created', 'queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress']);
const terminal = new Set(['live', 'deactivated', 'build_failed', 'pre_deploy_failed', 'update_failed', 'canceled']);
class DeploymentError extends Error {}
const stop = message => { throw new DeploymentError(message); };

function signedDeadline(pair, manifest) {
  const key = createPublicKey({ key: Buffer.from(manifest.FL_OPERATOR_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
  const payloads = decisions.map(name => {
    const envelope = JSON.parse(pair[name]);
    const bytes = Buffer.from(envelope.payload, 'base64url');
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(envelope.signature, 'base64url'))) {
      stop('The signed pair failed local verification.');
    }
    return JSON.parse(bytes);
  });
  const [ideas, transcript] = payloads;
  const { issuedAt, expiresAt } = ideas;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt > Date.now() ||
    expiresAt - issuedAt !== 300_000 || ideas.purpose !== 'founders-lens:staging-workspace:read-only' ||
    transcript.purpose !== 'founders-lens:staging-workspace:read-conversations' ||
    ideas.primaryTarget !== '7711730470614474440:24576' || ideas.authorityIdentity !== '7711490023970028889:16397' ||
    ideas.epoch !== manifest.FL_AUTHORITY_EPOCH || ideas.namespace !== manifest.FL_AUTHORITY_NAMESPACE ||
    payloads.some(item => item.version !== 1 || JSON.stringify(item.subjectVersions) !== '[1]') ||
    ['issuedAt', 'expiresAt', 'epoch', 'namespace', 'primaryTarget', 'authorityIdentity', 'recoveryRun', 'inventoryDigest']
      .some(field => ideas[field] !== transcript[field])) stop('The signed pair does not share the approved window.');
  return expiresAt;
}

export async function deployStagingApi({ id, token, manifest, dryRun, confirm, issue, smokeToken,
  request = fetch, pause = sleep, report = console.log }) {
  if (!/^srv-[a-z0-9]+$/.test(id ?? '') || !token || /\s/.test(token)) stop('Render credential or service ID is invalid.');
  let deadline, monotonicDeadline;
  const timeLeft = () => Math.min(deadline - Date.now(), monotonicDeadline - performance.now());
  const timeout = () => {
    const remaining = deadline === undefined ? 12_000 : Math.floor(timeLeft()) - 5_000;
    if (remaining <= 0) stop('The signing window ended. Check Render Events before another activation.');
    return AbortSignal.timeout(Math.min(12_000, remaining));
  };
  const call = async (method, path, body) => {
    const signal = timeout();
    const response = await request('https://api.render.com/v1/services/' + id + path, {
      method, redirect: 'error', signal,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) })
    }).catch(() => stop(`Render ${method} request failed before a response. Check Render Events before retrying.`));
    if (!response.ok) stop(`Render ${method} returned HTTP ${response.status}. Check service access and deployment history.`);
    if (method === 'PUT') { await response.body?.cancel(); return; }
    return response.json();
  };
  const verifyIdle = async () => {
    const list = await call('GET', '/deploys?limit=1');
    if (!Array.isArray(list) || list.some(entry => !terminal.has(entry.deploy?.status))) {
      stop('Render has a deploy in progress or its deploy state is unknown.');
    }
  };
  const savedEnvironment = async () => {
    const vars = new Map();
    let query = '?limit=100';
    for (let page = 0; page < 10; page++) {
      const list = await call('GET', '/env-vars' + query);
      if (!Array.isArray(list) || list.length > 100) stop('Render environment response is incomplete.');
      for (const { envVar } of list) {
        if (!envVar?.key || typeof envVar.value !== 'string' || vars.has(envVar.key)) stop('Render environment cannot be preserved exactly.');
        vars.set(envVar.key, envVar.value);
      }
      if (list.length < 100) return vars;
      const cursor = list.at(-1)?.cursor;
      if (!cursor) stop('Render environment pagination is incomplete.');
      query = '?limit=100&cursor=' + encodeURIComponent(cursor);
    }
    stop('Render environment pagination exceeded its limit.');
  };
  const service = await call('GET', '');
  if (service.id !== id || service.name !== 'founders-lens-staging-api' || service.type !== 'web_service' ||
    service.serviceDetails?.url !== origin || service.autoDeploy !== 'no' ||
    (service.autoDeployTrigger && service.autoDeployTrigger !== 'off')) stop('Render target does not match the staging API.');
  if (service.serviceDetails.runtime !== 'image' || service.imagePath?.split(/[:@]/, 1)[0] !== repository ||
    !service.registryCredential) stop('Configure this API service as image-backed with its private GHCR pull credential first.');
  await verifyIdle();
  const before = await savedEnvironment();
  if (before.has('FL_STAGING_DECISION_SOURCE') || [...before.keys()].some(name => /^(FL_P[6789]_|P9_|GROQ_API_KEY$)/.test(name))) {
    stop('Render has decision-source or worker settings incompatible with this static-decision image.');
  }
  for (const [name, value] of Object.entries(manifest)) {
    if (name !== 'NODE_VERSION' && name !== 'SKIP_INSTALL_DEPS' && !decisions.includes(name) && before.get(name) !== value) {
      stop('Saved Render staging environment differs from the approved manifest at ' + name + '.');
    }
  }
  report('Render staging target, saved environment and idle deploy status verified.');
  if (dryRun) return;
  if (!await confirm()) stop('Activation canceled before signing.');
  const pair = await issue();
  try { deadline = signedDeadline(pair, manifest); }
  catch (error) {
    if (error instanceof DeploymentError) throw error;
    stop('The signer output could not be decoded or verified. No Render update was submitted.');
  }
  monotonicDeadline = performance.now() + deadline - Date.now();
  await verifyIdle();
  const latest = await savedEnvironment();
  if (latest.size !== before.size || [...before].some(([name, value]) => latest.get(name) !== value)) {
    stop('Render environment changed during signing. No update submitted.');
  }
  const requireTime = () => {
    if (timeLeft() < 60_000) stop('Less than one minute remains. No deploy submitted.');
  };
  requireTime();
  for (const name of decisions) latest.set(name, pair[name]);
  await call('PUT', '/env-vars', [...latest].map(([key, value]) => ({ key, value })));
  requireTime();
  const deploy = await call('POST', '/deploys', { imageUrl: ref });
  if (!/^dep-[a-z0-9]+$/.test(deploy.id ?? '')) stop('Render did not return a deploy ID. Reconcile Events before retrying.');
  report('Tracking Render deploy ' + deploy.id + '.');
  while (true) {
    const current = await call('GET', '/deploys/' + deploy.id);
    if (current.status === 'live') {
      if (current.image?.ref !== ref || ![digest, platform].includes(current.image.sha)) stop('The live Render digest differs from the approved image.');
      break;
    }
    if (!active.has(current.status)) stop('Render deploy failed. Inspect Events for ' + deploy.id + '.');
    await pause(4000);
  }
  const probe = async (path, bearer) => {
    const signal = timeout();
    return request(origin + path, { redirect: 'error', signal,
      ...(bearer && { headers: { Authorization: 'Bearer ' + bearer } }) }).then(async response => {
      await response.body?.cancel();
      return response.status;
    }).catch(() => 0);
  };
  while (true) {
    const [live, ready, denied] = await Promise.all([
      probe('/health/live'), probe('/health/ready'), probe('/api/v1/ideas')
    ]);
    if (denied === 200) stop('Unauthenticated workspace read unexpectedly succeeded.');
    if (live === 200 && ready === 200 && denied === 401) break;
    await pause(3000);
  }
  report('API live and ready. Unauthenticated ideas request returned 401.');
  if (!smokeToken) report('Authenticated smoke requires an approved signed-in browser session.');
  else if (await probe('/api/v1/ideas', smokeToken) === 200) report('Authenticated ideas request returned 200.');
  else stop('Authenticated ideas smoke failed. Check the approved session in the deployed workspace.');
}

async function main(args) {
  const suppliedId = args[0] === '--setup' && args.length === 2 && /^srv-[a-z0-9]+$/.test(args[1]) ? args[1] : undefined;
  if (args.length && !suppliedId && (args.length !== 1 || !['--dry-run', '--setup'].includes(args[0]))) {
    stop('Usage: npm run deploy:staging-api [-- --dry-run | --setup [srv-id]]');
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') stop('Verified TLS is required.');
  if (args[0] === '--setup') {
    if (!stdin.isTTY || !stdout.isTTY) stop('Run setup in an interactive PowerShell terminal.');
    const setup = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
      $ErrorActionPreference='Stop'
      $phase='credential path'
      try {
        $dir=Join-Path $env:LOCALAPPDATA 'FoundersLens\\NeonStaging'
        $file=Join-Path $dir 'render-api.dpapi.json'
        if (!(Test-Path -LiteralPath $dir -PathType Container) -or (Test-Path -LiteralPath $file)) {
          throw 'Existing or unavailable credential path'
        }
        $secret=Read-Host 'Render API key' -AsSecureString
        $key=[Net.NetworkCredential]::new('', $secret).Password.Trim()
        if (!$key -or $key -match '\\s') {
          [Console]::Error.WriteLine('The key was empty or contained whitespace. Paste only the Render API key.')
          exit 1
        }
        $id='${suppliedId ?? ''}'
        if (!$id) {
        $headers=@{Authorization='Bearer ' + $key}
        $phase='Render service lookup'
        $result=Invoke-RestMethod -MaximumRedirection 0 -TimeoutSec 15 -Headers $headers -Uri 'https://api.render.com/v1/services?name=founders-lens-staging-api&includePreviews=false&limit=100'
        $targets=@(foreach ($entry in $result) {
          $service=$entry.service
          if ($service.name -ceq 'founders-lens-staging-api' -and $service.type -ceq 'web_service' -and
              $service.id -cmatch '^srv-[a-z0-9]+$' -and $service.serviceDetails.url -ceq 'https://founders-lens-staging-api.onrender.com') {
            $service
          }
        })
        if ($targets.Count -ne 1 -or @($result).Count -ge 100) {
          [Console]::Error.WriteLine('Render accepted the key, but it did not identify exactly one staging API service at the expected URL. Check the workspace and the key service access.')
          exit 1
        }
        $id=$targets[0].id
        }
        $phase='local encrypted credential save'
        $json=@{serviceId=$id;token=(ConvertFrom-SecureString (ConvertTo-SecureString $key -AsPlainText -Force))} | ConvertTo-Json -Compress
        $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $bytes=[Text.Encoding]::ASCII.GetBytes($json); $stream.Write($bytes,0,$bytes.Length) }
        finally { $stream.Dispose() }
        Write-Host 'Render key stored with Windows user encryption. Run the dry run next.'
      } catch {
        $status=$null
        if ($_.Exception.Response) { $status=[int]$_.Exception.Response.StatusCode }
        if ($status -eq 401) { [Console]::Error.WriteLine('Render returned HTTP 401. Check that this is an active Render API key, then retry.') }
        elseif ($status -eq 403) { [Console]::Error.WriteLine('Render returned HTTP 403. Give the key read access to services in the staging workspace.') }
        elseif ($status) { [Console]::Error.WriteLine('Render service lookup returned HTTP ' + $status + '.') }
        else { [Console]::Error.WriteLine('Setup stopped during ' + $phase + '. Check the credential path or Render connectivity as appropriate.') }
        exit 1
      }
    `], { stdio: 'inherit' });
    if (setup.status !== 0) process.exitCode = 1;
    return;
  }
  const dryRun = args.length === 1;
  const operator = join(process.env.LOCALAPPDATA, 'FoundersLens', 'NeonStaging');
  const signer = join(operator, 'invoke-staging-read-window.mjs');
  const run = (command, args, input, timeout = 600_000) => execFileSync(command, args,
    { input, timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const imageDigest = run('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{.Manifest.Digest}}']).trim();
  if (imageDigest !== digest) stop('Private registry digest differs from the approved image.');
  run(process.execPath, [signer, '--check', revision]);
  console.log('Approved registry image and protected staging signer verified.');
  const manifest = parseEnv(await readFile('.env.render-staging-api.local', 'utf8'));
  const credential = JSON.parse(await readFile(join(operator, 'render-api.dpapi.json'), 'utf8').catch(() =>
    stop('Render credential is absent. Configure the user-scoped DPAPI file described in DEPLOYMENT.md.')));
  const token = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $s=ConvertTo-SecureString ([Console]::In.ReadToEnd()); [Console]::Write([Net.NetworkCredential]::new('', $s).Password)"],
  credential.token, 15000);
  await deployStagingApi({ id: credential.serviceId, token, manifest, dryRun, smokeToken: process.env.FL_STAGING_SMOKE_TOKEN,
    confirm: async () => {
      if (!stdin.isTTY || !stdout.isTTY) stop('Live activation requires an interactive terminal.');
      const prompt = createInterface({ input: stdin, output: stdout });
      try { return await prompt.question('Start one five-minute staging API window now? Type DEPLOY STAGING API: ') === 'DEPLOY STAGING API'; }
      finally { prompt.close(); }
    },
    issue: async () => {
      let output;
      try { output = run(process.execPath, [signer, '--issue-in-approved-window', revision]); }
      catch (error) {
        const phase = /^Operator preparation stopped during (arguments and exact local release|verified Git archive and local application build|protected staging manifest and signer|approval-window target|private activation directory and signer|approved signer invocation|private dotenv export)\.$/m
          .exec(typeof error.stderr === 'string' ? error.stderr : '')?.[1];
        if (phase) stop('Signer stopped during ' + phase + '. No Render update was submitted.');
        if (error.code === 'ETIMEDOUT') stop('The signer timed out. No Render update was submitted.');
        stop('The signer failed without a recognized diagnostic. No Render update was submitted.');
      }
      const match = / from ([^\r\n]+) into the authenticated API service immediately\./.exec(output);
      const file = match && resolve(match[1]);
      if (!file || dirname(dirname(file)) !== resolve(operator) ||
        !/^read-window-[^\\/]+[\\/]render-decisions\.env$/.test(file.slice(resolve(operator).length + 1))) stop('Signer did not return a protected pair.');
      try { return parseEnv(await readFile(file, 'utf8')); }
      finally { await unlink(file); }
    }
  });
  if (dryRun) console.log('Dry run passed. No signing or Render writes were performed.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof DeploymentError ? error.message :
      'Activation stopped during local verification, signing or a Render request. Check Render Events before retrying.');
    process.exitCode = 1;
  });
}
