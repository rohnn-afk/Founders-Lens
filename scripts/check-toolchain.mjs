// Build and CI guard. Uses Node's filesystem and process APIs to enforce
// the repository's pinned toolchain, the Node and npm versions used to build.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const expectedNode = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
const expectedNpm = root.packageManager.slice('npm@'.length);
// When invoked through npm, check the exact CLI that launched this script.
// The PATH fallback also supports running this file directly with Node.
const npmCli = process.env.npm_execpath;
const result = npmCli
  ? spawnSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' })
  : spawnSync(process.platform === 'win32' ? 'npm.cmd --version' : 'npm --version', {
      encoding: 'utf8', shell: true
    });

if (process.versions.node !== expectedNode || result.status !== 0 || result.stdout.trim() !== expectedNpm) {
  console.error(`Required toolchain: Node ${expectedNode}, npm ${expectedNpm}.`);
  process.exitCode = 1;
} else {
  console.log(`Toolchain verified: Node ${expectedNode}, npm ${expectedNpm}.`);
}
