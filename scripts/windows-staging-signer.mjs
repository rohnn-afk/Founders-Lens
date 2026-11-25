import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseEnv } from 'node:util';

const task = 'FoundersLens-StagingSigner';
const script = fileURLToPath(import.meta.url);
const repo = dirname(dirname(script));
const store = join(process.env.LOCALAPPDATA, 'FoundersLens', 'NeonStaging');
const log = join(store, 'continuous-signer.log');
const ps = (code, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from("$ErrorActionPreference='Stop'; " + code, 'utf16le').toString('base64')],
{ input, encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const decrypt = ciphertext => ps(
  "$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()); [Console]::Write([Net.NetworkCredential]::new('', $s).Password)", ciphertext);

function loadCredentials() {
  const read = name => JSON.parse(readFileSync(join(store, name), 'utf8'));
  const env = JSON.parse(decrypt(read('mailbox-signer.dpapi.json').dpapi));
  const bytes = Buffer.from(decrypt(read('identity-and-signer.dpapi.json').operatorPkcs8Der), 'base64');
  let operatorKey;
  try { operatorKey = createPrivateKey({ key: bytes, type: 'pkcs8', format: 'der' }); }
  finally { bytes.fill(0); }
  const manifest = parseEnv(readFileSync(join(repo, '.env.render-staging-api.local'), 'utf8'));
  if (operatorKey.asymmetricKeyType !== 'ed25519' ||
    createPublicKey(operatorKey).export({ format: 'der', type: 'spki' }).toString('base64') !== manifest.FL_OPERATOR_PUBLIC_KEY ||
    env.FL_EXPECTED_PRIMARY_IDENTITY !== '7711730470614474440:24576' ||
    env.FL_EXPECTED_AUTHORITY_IDENTITY !== '7711490023970028889:16397' ||
    env.FL_OPERATOR_AUTHORITY_READ_URL !== manifest.FL_AUTHORITY_DATABASE_URL) throw new Error();
  return { env, operatorKey };
}

function report(message) {
  if (existsSync(log) && statSync(log).size >= 262_144) writeFileSync(log, '');
  appendFileSync(log, new Date().toISOString() + ' ' + message + '\n');
}

async function main() {
  const command = process.argv[2];
  if (process.platform !== 'win32' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error();
  if (command === 'status') {
    console.log(ps(`$t=Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue
      if($t){$t.State; (Get-ScheduledTaskInfo -TaskName '${task}').LastTaskResult}else{'Not registered'}`).trim());
    if (existsSync(log)) console.log(readFileSync(log, 'utf8').trimEnd().split('\n').slice(-8).join('\n'));
    return;
  }
  if (command === 'stop') {
    ps(`Disable-ScheduledTask -TaskName '${task}' | Out-Null; Stop-ScheduledTask -TaskName '${task}'`);
    console.log('Signer task disabled and stopped. Published pairs expire on schedule.');
    return;
  }
  if (!['check', 'start', 'worker'].includes(command)) throw new Error();
  const { env, operatorKey } = loadCredentials();
  const { renew } = await import('./renew-staging-decisions.mjs');
  if (command === 'check') {
    console.log('Encrypted credentials, verification key, staging identities and signer build passed local checks.');
    return;
  }
  if (command === 'start') {
    if (!process.stdin.isTTY) throw new Error();
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (await prompt.question('After approval, type START STAGING SIGNER: ') !== 'START STAGING SIGNER') return;
    } finally { prompt.close(); }
    ps(`$existing=Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue
      if($existing -and $existing.State -in 'Running','Queued'){throw 'Signer already active'}
      $action=New-ScheduledTaskAction -Execute ${quote(process.execPath)} -Argument ${quote('"' + script + '" worker')} -WorkingDirectory ${quote(repo)}
      $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
      $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName '${task}' -Action $action -Settings $settings -Principal $principal -Force | Out-Null
      Start-ScheduledTask -TaskName '${task}'`);
    console.log('Signer task started. Check npm.cmd run signer:status for publication events.');
    return;
  }
  // A loopback-only lock also excludes a worker launched outside Task Scheduler.
  const lock = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    lock.once('error', reject);
    lock.listen({ host: '127.0.0.1', port: 49617, exclusive: true }, resolve);
  });
  try {
    await renew({ ...env, FL_CONFIRM_STAGING_RENEWAL: 'approve-continuous-staging-read-only',
      FL_CONFIRM_STAGING_READ: 'approve-staging-read-only' }, new AbortController().signal, { operatorKey, report });
  } finally {
    lock.close();
  }
}

await main().catch(() => {
  if (process.argv[2] === 'worker') { try { report('staging_signer_worker_failed'); } catch { /* Task Scheduler records exit status. */ } }
  else console.error('Signer command failed. Check the encrypted configuration, API build, and Windows Task Scheduler.');
  process.exitCode = 1;
});
