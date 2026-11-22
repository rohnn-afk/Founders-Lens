// Architecture tests. The TypeScript parser inspects application imports so
// the web and process workspaces keep their intended dependency boundaries.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const apps = ['web', 'api', 'worker', 'dispatcher'];
const browserPackages = new Set(['next', 'react', 'react-dom']);
const clerkUi = '@clerk/nextjs', clerkServer = '@clerk/nextjs/server';
const authEntrypoints = new Map([
  ['proxy.ts', [clerkServer]],
  ['app/layout.tsx', [clerkUi]],
  ['app/app/layout.tsx', [clerkUi, clerkServer]],
  ['app/sign-in/[[...sign-in]]/page.tsx', [clerkUi, clerkServer]]
]);
const authModules = new Set([...authEntrypoints.keys()].map(file => file.replace(/\.tsx?$/, '')));

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(target));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) result.push(target);
  }
  return result;
}

// The abstract syntax tree represents parsed code. Walking it lets the test
// inspect imports and re-exports without executing application modules.
function inspect(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const processReferences = [];
  const client = source.statements.some(statement => ts.isExpressionStatement(statement) &&
    ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client');
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier), `Nonliteral module in ${file}`);
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      assert.ok(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), `Dynamic module in ${file}`);
      imports.push(node.arguments[0].text);
    }
    if (ts.isImportEqualsDeclaration(node)) assert.fail(`CommonJS import in ${file}`);
    if ((ts.isIdentifier(node) ||
      (ts.isStringLiteral(node) && ts.isElementAccessExpression(node.parent) &&
        node.parent.argumentExpression === node)) && node.text === 'process') processReferences.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { imports, processReferences, client };
}

function assertWebBoundary(file, { imports, processReferences, client }) {
  const authImports = authEntrypoints.get(file);
  if (authImports) assert.equal(client, false, `Client authentication entry point in ${file}`);
  for (const reference of processReferences) {
    const env = reference.parent, read = env.parent;
    assert.ok(authImports && ts.isPropertyAccessExpression(env) && env.expression === reference &&
      env.name.text === 'env' && ts.isPropertyAccessExpression(read) && read.expression === env,
    `Process configuration in ${file}`);
    const name = read.name.text;
    if (name === 'CLERK_SECRET_KEY') {
      // These server entry points only need to know whether a key is present.
      assert.ok(ts.isPrefixUnaryExpression(read.parent) && read.parent.operator === ts.SyntaxKind.ExclamationToken,
        `Raw Clerk secret access in ${file}`);
    } else {
      assert.ok(name === 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY' ||
        (file === 'proxy.ts' && name === 'CLERK_AUTHORIZED_PARTIES'), `Unauthorized configuration in ${file}`);
    }
  }
  for (const specifier of imports) {
    if (specifier.startsWith('.')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.[cm]?[jt]sx?$/, '');
      assert.ok(!authModules.has(target), `Authentication entry point imported by ${file}`);
    } else {
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      const workspaceSession = client && file === 'features/workspace/read-only-ideas.tsx' && specifier === '@clerk/nextjs';
      assert.ok(browserPackages.has(packageName) || authImports?.includes(specifier) || workspaceSession,
        `Backend dependency ${specifier} in ${file}`);
    }
  }
}

test('application imports remain inside their own workspace and browser-safe dependencies', async () => {
  for (const app of apps) {
    const appRoot = path.join(root, 'apps', app);
    const manifest = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
    for (const file of await sources(appRoot)) {
      const inspected = inspect(file, await readFile(file, 'utf8'));
      const { imports } = inspected;
      if (app === 'web') assertWebBoundary(path.relative(appRoot, file).split(path.sep).join('/'), inspected);
      for (const specifier of imports) {
        if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(file), specifier);
          assert.ok(target.startsWith(appRoot + path.sep), `Cross-workspace import in ${file}: ${specifier}`);
        } else if (!specifier.startsWith('node:')) {
          const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
          assert.ok(manifest.dependencies?.[packageName], `Undeclared runtime dependency ${specifier} in ${file}`);
        } else {
          assert.notEqual(app, 'web', `Node dependency ${specifier} in ${file}`);
        }
      }
    }
    if (app === 'web') {
      assert.deepEqual(Object.keys(manifest.dependencies).sort(), [...browserPackages, clerkUi].sort());
    } else if (app === 'dispatcher' || app === 'worker') {
      assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ['bullmq', 'ioredis', 'pg']);
    }
  }
});

test('boundary inspection sees static, re-exported and dynamic imports', () => {
  assert.deepEqual(inspect('fixture.ts', "import x from 'express'; export { y } from '../../api/src/app.js'; import('node:fs');").imports,
    ['express', '../../api/src/app.js', 'node:fs']);
  assert.throws(() => inspect('fixture.ts', 'import(variable);'), /Dynamic module/);
  assert.equal(inspect('fixture.ts', 'const secret = process.env.SECRET;').processReferences.length, 1);
});

test('web auth exceptions are limited to named server entry points and exact configuration reads', () => {
  const check = (file, source) => assertWebBoundary(file, inspect(file, source));
  check('proxy.ts', `import { clerkMiddleware } from '${clerkServer}';
    const configured = !!process.env.CLERK_SECRET_KEY;
    const parties = process.env.CLERK_AUTHORIZED_PARTIES;`);
  for (const [file, source, error] of [
    ['features/workspace/create-controller.ts', `import { auth } from '${clerkServer}';`, /Backend dependency/],
    ['app/page.tsx', `import { ClerkProvider } from '${clerkUi}';`, /Backend dependency/],
    ['app/layout.tsx', `import { auth } from '${clerkServer}';`, /Backend dependency/],
    ['proxy.ts', "import { x } from '@clerk/nextjs/internal';", /Backend dependency/],
    ['app/app/layout.tsx', `'use client'; import { auth } from '${clerkServer}';`, /Client authentication/],
    ['app/page.tsx', "export { default } from './app/layout.js';", /entry point imported/],
    ['features/workspace/create-controller.ts', 'const flag = !!process.env.CLERK_SECRET_KEY;', /Process configuration/],
    ['proxy.ts', 'const secret = process.env.CLERK_SECRET_KEY;', /Raw Clerk secret/],
    ['proxy.ts', 'const env = process.env;', /Process configuration/],
    ['proxy.ts', "const secret = globalThis['process'].env.CLERK_SECRET_KEY;", /Process configuration/],
    ['app/layout.tsx', 'const parties = process.env.CLERK_AUTHORIZED_PARTIES;', /Unauthorized configuration/],
    ['proxy.ts', 'const database = process.env.DATABASE_URL;', /Unauthorized configuration/]
  ]) assert.throws(() => check(file, source), error);
});
