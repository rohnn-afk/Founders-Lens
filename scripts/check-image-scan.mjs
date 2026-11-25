import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repository = 'rohnn-afk/Founders-Lens';
const runtimePaths = ['.dockerignore', 'apps/api', 'apps/web/package.json',
  'apps/worker/package.json', 'apps/dispatcher/package.json', 'package-lock.json',
  'prisma.config.ts', 'tsconfig.base.json', 'scripts/build-api-image.sh'];
const operatorCommands = ['signer:check', 'signer:start', 'signer:stop', 'signer:status', 'deploy:staging-api'];
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).replaceAll('\r\n', '\n');

export function sourceFingerprint(revision) {
  const rootManifest = JSON.parse(git(['show', `${revision}:package.json`]));
  for (const command of operatorCommands) delete rootManifest.scripts[command];
  return fingerprint(git(['ls-tree', revision, '--', ...runtimePaths]) + JSON.stringify(rootManifest));
}

function inspectRuntime(image) {
  const program = `const { createHash } = require('node:crypto');
    const { readFileSync } = require('node:fs');
    const paths = ['/usr/local/bin/node', '/usr/lib/x86_64-linux-gnu/libssl.so.3',
      '/usr/lib/x86_64-linux-gnu/libcrypto.so.3'];
    console.log(JSON.stringify(paths.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'))));`;
  return JSON.parse(execFileSync('docker', ['run', '--rm', '--network=none',
    '--platform', 'linux/amd64', '--entrypoint', 'node', image, '-e', program], { encoding: 'utf8' }));
}

export function stagingContext(env) {
  return env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === repository &&
    ((env.GITHUB_EVENT_NAME === 'pull_request' && env.GITHUB_BASE_REF === 'staging') ||
      (['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) && env.GITHUB_REF === 'refs/heads/staging'));
}

export function assessScan(scan, policy, { staging, now, source, runtime }) {
  if (scan.SchemaVersion !== 2 || !Array.isArray(scan.Results) ||
    !scan.Results.some(result => result.Class === 'os-pkgs' && result.Type === 'debian') ||
    !scan.Results.some(result => result.Class === 'lang-pkgs' && result.Type === 'node-pkg')) {
    throw new Error('Missing API OS or dependency scan results');
  }
  const approvedFrom = Date.parse(policy.approvedAt);
  const expiresAt = Date.parse(policy.expiresAt);
  const eligible = staging && now >= approvedFrom && now < expiresAt &&
    expiresAt - approvedFrom <= 30 * 86_400_000 && source === policy.runtimeSourceFingerprint &&
    Array.isArray(runtime) && JSON.stringify(runtime) === JSON.stringify(policy.runtimeBinaryFingerprints);
  const vulnerabilities = scan.Results.flatMap(result => (result.Vulnerabilities ?? []).map(v => ({
    id: v.VulnerabilityID, severity: v.Severity, package: v.PkgName,
    installed: v.InstalledVersion, fixed: v.FixedVersion,
    accepted: Boolean(eligible && v.Severity === 'HIGH' && result.Class === 'os-pkgs' &&
      result.Type === 'debian' && !v.FixedVersion && policy.trivyIds.includes(v.VulnerabilityID) &&
      v.PkgName === policy.binaryPackage && v.InstalledVersion === policy.packageVersion)
  })));
  const secretCount = scan.Results.reduce((count, result) => count + (result.Secrets?.length ?? 0), 0);
  const blockers = vulnerabilities.filter(v => v.severity === 'CRITICAL' || (v.severity === 'HIGH' && !v.accepted));
  return { vulnerabilities, secretCount, blockers, exceptionExpiresAt: eligible ? policy.expiresAt : null };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [input, output, image] = process.argv.slice(2);
  const scan = JSON.parse(readFileSync(input, 'utf8'));
  const policy = JSON.parse(readFileSync(new URL('./staging-image-risk.json', import.meta.url), 'utf8'));
  const staging = stagingContext(process.env);
  const revision = git(['rev-parse', 'HEAD']).trim();
  const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' }).trim();
  if (imageId !== scan.Metadata?.ImageID || revision !== process.env.GITHUB_SHA) {
    throw new Error('Image scan identity does not match the selected CI run');
  }
  const source = sourceFingerprint(revision);
  const runtime = staging && source === policy.runtimeSourceFingerprint ? inspectRuntime(image) : null;
  const report = assessScan(scan, policy, { staging, now: Date.now(), source, runtime });
  writeFileSync(output, JSON.stringify(report, null, 2));
  const accepted = report.vulnerabilities.filter(v => v.accepted).length;
  console.log(`Image scan: ${report.blockers.length} blocking high/critical, ${accepted} reviewed staging-only, ${report.secretCount} secret matches.`);
  if (report.blockers.length || report.secretCount) process.exitCode = 1;
}
