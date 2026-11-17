import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const apps = ['web', 'api', 'worker', 'dispatcher'];
const browserPackages = new Set(['next', 'react', 'react-dom']);

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

function inspect(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  let readsEnvironment = false;
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
    if (ts.isIdentifier(node) && node.text === 'process') readsEnvironment = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { imports, readsEnvironment };
}

test('application imports remain inside their own workspace and browser-safe dependencies', async () => {
  for (const app of apps) {
    const appRoot = path.join(root, 'apps', app);
    const manifest = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
    for (const file of await sources(appRoot)) {
      const { imports, readsEnvironment } = inspect(file, await readFile(file, 'utf8'));
      if (app === 'web') assert.equal(readsEnvironment, false, `Process configuration in ${file}`);
      for (const specifier of imports) {
        if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(file), specifier);
          assert.ok(target.startsWith(appRoot + path.sep), `Cross-workspace import in ${file}: ${specifier}`);
        } else if (!specifier.startsWith('node:')) {
          const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
          assert.ok(manifest.dependencies?.[packageName], `Undeclared runtime dependency ${specifier} in ${file}`);
          if (app === 'web') assert.ok(browserPackages.has(packageName), `Backend dependency ${specifier} in ${file}`);
        } else {
          assert.notEqual(app, 'web', `Node dependency ${specifier} in ${file}`);
        }
      }
    }
    if (app === 'web') {
      assert.deepEqual(Object.keys(manifest.dependencies).sort(), [...browserPackages].sort());
    } else if (app === 'worker' || app === 'dispatcher') {
      assert.deepEqual(manifest.dependencies ?? {}, {}, `${app} must have no integration clients`);
    }
  }
});

test('boundary inspection sees static, re-exported and dynamic imports', () => {
  assert.deepEqual(inspect('fixture.ts', "import x from 'express'; export { y } from '../../api/src/app.js'; import('node:fs');").imports,
    ['express', '../../api/src/app.js', 'node:fs']);
  assert.throws(() => inspect('fixture.ts', 'import(variable);'), /Dynamic module/);
  assert.equal(inspect('fixture.ts', 'const secret = process.env.SECRET;').readsEnvironment, true);
});
