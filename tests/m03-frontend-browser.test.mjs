// Opt-in Edge journey using its built-in DevTools protocol. An isolated
// Next.js build supplies synthetic identities and responses only in this test.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const edge = process.env.WORKSPACE_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const next = path.join(root, 'node_modules/next/dist/bin/next');
const run = promisify(execFile);

const fixture = `// Temporary test composition. Never copied into the real application.
'use client';
import { WorkspaceProvider } from '../../features/workspace/workspace-provider';
import type { Conversation, Idea, MessageApi, SessionSource, WorkspaceApi } from '../../features/workspace/contracts';
import { useMemo, type ReactNode } from 'react';

function fixture() {
  let account = { localAccountId: 'a' } as ReturnType<SessionSource['getSnapshot']>;
  const founderA = '11111111-1111-4111-8111-111111111111';
  const founderB = '22222222-2222-4222-8222-222222222222';
  const recoveryIdeaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const recoveryChatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const messageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const generationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const statusUrl = '/api/v1/generations/' + generationId;
  const listeners = new Set<() => void>();
  const change = (id: string | null) => {
    account = id ? { localAccountId: id } : null;
    listeners.forEach(listener => listener());
  };
  const idea = (id: string, title: string, status: Idea['status'] = 'ACTIVE'): Idea =>
    ({ id, title, status, version: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
  const a = idea('a', 'Alpha idea');
  const archived = idea('archived', 'Archived idea', 'ARCHIVED');
  const b = idea('b', 'Beta idea ' + 'LongTitle'.repeat(12));
  const saved: Conversation = { id: 'saved', ideaId: 'a', title: 'Saved conversation', status: 'ACTIVE',
    proactiveResearch: false, version: 1 };
  const ideas = [a, archived];
  const conversations = [saved];
  let unlock: (() => void) | undefined;
  let blockedRead: Promise<void> | undefined;
  const session: SessionSource = {
    getSnapshot: () => account && ({ localAccountId: account.localAccountId === 'a' ? founderA : founderB }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async revalidate() {}
  };
  const api: WorkspaceApi = {
    async ideas(cursor) {
      const owner = account?.localAccountId;
      if (blockedRead && owner === 'a') await blockedRead;
      return { status: 200, data: { items: owner === 'a' ? (cursor ? ideas.slice(1) : ideas.slice(0, 1)) : [b],
        page: { nextCursor: owner === 'a' && !cursor ? 'second' : null, hasMore: owner === 'a' && !cursor } } };
    },
    async idea(id) {
      if (id === recoveryIdeaId && account?.localAccountId === 'a') return { status: 200, data: idea(id, 'Recovery idea') };
      const found = (account?.localAccountId === 'a' ? ideas : [b]).find(value => value.id === id);
      return found ? { status: 200, data: found } : { status: 404 };
    },
    async conversations(id) {
      return { status: 200, data: { items: conversations.filter(value => value.ideaId === id), page: { hasMore: false, nextCursor: null } } };
    },
    async conversation(id) {
      if (id === recoveryChatId && account?.localAccountId === 'a') {
        return { status: 200, data: { ...saved, id, ideaId: recoveryIdeaId, title: 'Recovery conversation' } };
      }
      const found = account?.localAccountId === 'a' && conversations.find(value => value.id === id);
      return found ? { status: 200, data: found } : { status: 404 };
    },
    async createIdea(body) {
      const made = idea('new', body.title);
      ideas.push(made);
      return { status: 201, data: made };
    },
    async createConversation(id, body) {
      conversations.push({ ...saved, id: 'new-chat', ideaId: id, title: body.title ?? 'New conversation' });
      throw Error('Synthetic response lost after create');
    }
  };
  const messageApi: MessageApi = {
    async submit() {
      sessionStorage.setItem('synthetic-posts', String(Number(sessionStorage.getItem('synthetic-posts')) + 1));
      throw Error('Synthetic acknowledgement lost');
    },
    async correlate(id, clientSubmissionId) {
      if (id !== recoveryChatId || account?.localAccountId !== 'a') return { status: 404 };
      const count = Number(sessionStorage.getItem('synthetic-checks')) + 1;
      sessionStorage.setItem('synthetic-checks', String(count));
      return count === 1 ? { status: 404 } : { status: 200, data: {
        clientSubmissionId, messageId, generationId, statusUrl, eventsUrl: statusUrl + '/events'
      } };
    },
    async history(id) {
      const saved = id === recoveryChatId && account?.localAccountId === 'a' &&
        Number(sessionStorage.getItem('synthetic-checks')) >= 2;
      return { status: 200, data: { page: { nextCursor: null, hasMore: false }, items: saved ? [{
        id: messageId, conversationId: id, sequence: 1, role: 'USER', content: 'Synthetic message',
        createdAt: '2026-01-01T00:00:00.000Z'
      }] : [] } };
    }
  };
  return { session, api, messageApi, change, hold() { blockedRead = new Promise(resolve => { unlock = resolve; }); },
    release() { unlock?.(); blockedRead = undefined; } };
}
export default function TestLayout({ children }: { children: ReactNode }) {
  const harness = useMemo(fixture, []);
  return <>
    <aside aria-label="Synthetic test controls">
      <button onClick={() => harness.change('a')}>Use founder A</button>
      <button onClick={() => harness.change('b')}>Use founder B</button>
      <button onClick={() => harness.change(null)}>Sign out fixture</button>
      <button onClick={harness.hold}>Hold founder A reads</button>
      <button onClick={harness.release}>Release held reads</button>
    </aside>
    <WorkspaceProvider api={harness.api} session={harness.session} messageApi={harness.messageApi} recoveryTtl={600_000}>
      {children}
    </WorkspaceProvider>
  </>;
}
`;

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 160; attempt++) {
    try { const result = await check(); if (result) return result; } catch { /* Startup and navigation can briefly disconnect. */ }
    await delay(125);
  }
  throw Error('Timed out waiting for ' + label);
}

function contrast(first, second) {
  // Convert displayed sRGB channels to relative luminance before comparing.
  const luminance = color => {
    const channels = color.match(/\d+/g).map(value => Number(value) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const levels = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (levels[0] + 0.05) / (levels[1] + 0.05);
}

async function connectDevTools(port) {
  const endpoint = await waitFor(async () => {
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    return pages.find(page => page.type === 'page')?.webSocketDebuggerUrl;
  }, 'Edge DevTools page');
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  async function command(method, params = {}) {
    const id = ++sequence;
    const response = Promise.withResolvers();
    const alarm = setTimeout(() => response.reject(Error('DevTools timeout: ' + method)), 5000);
    function receive(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      if (message.error) response.reject(Error(method + ': ' + message.error.message));
      else response.resolve(message.result);
    }
    socket.addEventListener('message', receive);
    try {
      socket.send(JSON.stringify({ id, method, params }));
      return await response.promise;
    } finally {
      clearTimeout(alarm);
      socket.removeEventListener('message', receive);
    }
  }
  return { command, close: () => socket.close() };
}

test('Edge synthetic navigation, history, accessibility and identity isolation', {
  skip: !process.argv.includes('--browser'), timeout: 240_000
}, async t => {
  const isolated = await mkdtemp(path.join(tmpdir(), 'founders-lens-m03-browser-'));
  const web = path.join(isolated, 'apps/web');
  await mkdir(web, { recursive: true });
  await cp(path.join(root, 'tsconfig.base.json'), path.join(isolated, 'tsconfig.base.json'));
  for (const name of ['app', 'features', 'package.json', 'tsconfig.json', 'next.config.ts', 'next-env.d.ts']) {
    await cp(path.join(root, 'apps/web', name), path.join(web, name), { recursive: true });
  }
  await symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(web, 'app/app/layout.tsx'), fixture);
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  await run(process.execPath, [next, 'build', '--webpack'], { cwd: web, env, timeout: 120_000 });
  const port = await freePort();
  const server = spawn(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: web, env, stdio: 'ignore', windowsHide: true
  });
  t.after(() => { server.kill(); });
  const origin = 'http://127.0.0.1:' + port;
  await waitFor(async () => (await fetch(origin)).ok, 'isolated Next.js server');
  const debugPort = await freePort();
  const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(isolated, 'edge-profile'), 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  browser.on('error', () => {});
  t.after(() => { browser.kill(); });
  const { command, close } = await connectDevTools(debugPort);
  t.after(async () => { try { await command('Browser.close'); } catch { /* Child cleanup is registered above. */ } finally { close(); } });
  const evaluate = async expression => {
    const output = await command('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!output.exceptionDetails, expression);
    return output.result.value;
  };
  async function text(value) {
    try {
      await waitFor(() => evaluate('document.querySelector("main")?.innerText.includes(' + JSON.stringify(value) + ')'), value);
    } catch (error) {
      t.diagnostic(JSON.stringify(await evaluate('({ path: location.pathname, text: document.querySelector("main")?.innerText })')));
      throw error;
    }
  }
  const open = route => command('Page.navigate', { url: origin + route });
  const locationIs = route => waitFor(() => evaluate('location.pathname === ' + JSON.stringify(route)), route);
  const traverse = async offset => {
    const { currentIndex, entries } = await command('Page.getNavigationHistory');
    assert.ok(entries[currentIndex + offset], 'Expected a browser history entry');
    await command('Page.navigateToHistoryEntry', { entryId: entries[currentIndex + offset].id });
  };
  const click = async label => {
    const selector = '[...document.querySelectorAll("button,a")].find(el => el.innerText.trim()===' + JSON.stringify(label) + ')';
    await waitFor(() => evaluate('Boolean(' + selector + ')'), label);
    await evaluate(selector + '.click()');
  };
  async function fill(id, value) {
    const field = 'document.getElementById(' + JSON.stringify(id) + ')';
    await evaluate('Object.getOwnPropertyDescriptor(Object.getPrototypeOf(' + field + '),"value").set.call(' +
      field + ',' + JSON.stringify(value) + ')');
    await evaluate(field + '.dispatchEvent(new InputEvent("input", { bubbles: true }))');
    assert.equal(await evaluate(field + '.value'), value);
  }
  const appearance = 'document.querySelector("header select")';
  const storageKey = 'founders-lens.appearance';
  const mode = () => evaluate(appearance + '.value');
  const appearanceShell = 'document.querySelector("[data-workspace-appearance]")';
  const background = () => evaluate('getComputedStyle(' + appearanceShell + ').backgroundColor');
  const osMode = value => command('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value }
  ] });
  const choose = async value => {
    await evaluate(appearance + '.value = ' + JSON.stringify(value));
    await evaluate(appearance + '.dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor(() => evaluate(appearanceShell + '.dataset.workspaceAppearance === ' + JSON.stringify(value)), value);
  };
  async function reload() {
    await evaluate('window.workspaceReloadMarker = true');
    await command('Page.reload');
    await waitFor(async () => !await evaluate('Boolean(window.workspaceReloadMarker)'), 'fresh document');
  }
  async function appearanceChecks() {
    const light = 'rgb(247, 249, 246)', dark = 'rgb(20, 32, 29)';
    assert.equal(await mode(), 'system');
    assert.equal(await background(), light);
    const { nodes } = await command('Accessibility.getFullAXTree');
    assert.ok(nodes.some(node => node.role?.value === 'combobox' && node.name?.value === 'Appearance'));
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    assert.equal(await evaluate(appearance + '.tabIndex'), 0);
    await evaluate(appearance + '.focus()');
    assert.equal(await evaluate('document.activeElement === ' + appearance), true);
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await waitFor(async () => await mode() === 'light', 'native keyboard appearance selection');
    assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineWidth'), '3px');
    await choose('system');
    const checkContrast = async () => {
      const [textColor, surface, focus, header] = await evaluate('(() => { const s = getComputedStyle(' + appearance +
        '); return [s.color,s.backgroundColor,s.outlineColor,getComputedStyle(document.querySelector("header")).backgroundColor]; })()');
      assert.ok(contrast(textColor, surface) >= 4.5, 'Appearance text contrast');
      assert.ok(contrast(focus, header) >= 3, 'Appearance focus contrast');
    };
    await checkContrast();
    await osMode('dark');
    assert.equal(await background(), dark);
    await checkContrast();
    await choose('light');
    assert.equal(await background(), light);
    await choose('dark');
    await osMode('light');
    assert.equal(await background(), dark);

    // Blocking Next.js scripts leaves the parser-time initializer as the
    // only code applying the stored theme on this hard reload.
    await command('Network.enable');
    await command('Network.setBlockedURLs', { urls: ['*/_next/static/*.js'] });
    await reload();
    await waitFor(async () => await background() === dark, 'saved dark paint before React hydration');
    await command('Network.setBlockedURLs', { urls: [] });
    await reload();
    await text('Alpha idea');
    assert.equal(await mode(), 'dark');

    await evaluate('localStorage.setItem(' + JSON.stringify(storageKey) + ',"unsupported")');
    await reload();
    await text('Alpha idea');
    assert.equal(await mode(), 'system');
    assert.equal(await background(), light);

    const { identifier } = await command('Page.addScriptToEvaluateOnNewDocument', {
      source: 'Object.defineProperty(window,"localStorage",{get(){throw new DOMException("Denied","SecurityError")}})'
    });
    await reload();
    await text('Alpha idea');
    assert.equal(await mode(), 'system');
    await choose('dark');
    assert.equal(await background(), dark);
    await command('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await reload();
    await text('Alpha idea');
    await choose('dark');
  }

  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
  await open('/app');
  await text('Alpha idea');
  await osMode('light');
  await appearanceChecks();
  const viewport = await evaluate('({ viewport: innerWidth, width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth })');
  assert.equal(viewport.viewport, 320);
  assert.equal(viewport.content, viewport.width, JSON.stringify(viewport));
  assert.equal(await evaluate('Boolean(document.querySelector("nav[aria-label=Workspace]") && document.querySelector("label[for=idea-title]"))'), true);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate('document.activeElement.matches(":focus-visible")'), true);
  await click('Next page');
  await text('Archived idea');
  await click('Archived idea');
  await locationIs('/app/ideas/archived/think');
  await text('Archived (read only)');
  assert.equal(await mode(), 'dark');
  assert.equal(await evaluate('Boolean(document.getElementById("conversation-title"))'), false);
  await traverse(-1);
  await locationIs('/app');
  await text('Alpha idea');
  await traverse(1);
  await locationIs('/app/ideas/archived/think');
  await text('Archived (read only)');
  await open('/app/ideas/a/conversations/saved');
  await text('Saved conversation');
  assert.equal(await mode(), 'dark');
  await reload();
  await text('Saved conversation');
  await open('/app/ideas/archived/conversations/saved');
  await text('This workspace item is unavailable.');
  assert.equal(await evaluate('document.querySelector("main").innerText.includes("Saved conversation")'), false);
  await open('/app');
  await text('Alpha idea');
  await fill('idea-title', 'New synthetic idea');
  await click('Create idea');
  await locationIs('/app/ideas/new/think');
  await text('New synthetic idea');
  await fill('conversation-title', 'Recovered conversation');
  await click('Create conversation');
  await text('Creation could not be confirmed');
  await click('Check conversations');
  await text('Recovered conversation');
  assert.equal(await evaluate('[...document.links].filter(link => link.pathname.endsWith("/new-chat")).length'), 1);
  assert.equal(await evaluate('Boolean(document.getElementById("conversation-title"))'), false);
  await open('/app');
  await text('Alpha idea');
  await click('Hold founder A reads');
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await text('Loading workspace');
  await click('Use founder B');
  await text('Beta idea');
  assert.equal(await evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth'), true);
  await click('Release held reads');
  assert.equal(await evaluate('document.querySelector("main").innerText.includes("Alpha idea")'), false);
  await click('Sign out fixture');
  await text('Workspace unavailable');
  assert.equal(await evaluate('document.querySelector("main").innerText.includes("Beta idea")'), false);
  assert.equal(await mode(), 'dark');
  assert.deepEqual(await evaluate('Object.entries(localStorage)'), [[storageKey, 'dark']]);
  assert.deepEqual(await evaluate('Object.entries(sessionStorage)'), []);

  await click('Use founder A');
  const recoveryRoute = '/app/ideas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await open(recoveryRoute);
  await text('No saved messages.');
  await fill('workspace-message', 'Synthetic message');
  await click('Send message');
  await text('Acceptance is unknown.');
  const recoveryRecord = 'Object.entries(sessionStorage).find(([key]) => key.startsWith("founders-lens.submission.v1:"))';
  const [key, raw] = await evaluate(recoveryRecord);
  assert.equal(raw.includes('Synthetic message'), false);
  const record = JSON.parse(raw);
  assert.equal(record.expiresAt - record.createdAt, 600_000);
  await open('/app');
  await text('Alpha idea');
  await traverse(-1);
  await locationIs(recoveryRoute);
  await text('Acceptance is unknown.');
  await traverse(1);
  await locationIs('/app');
  await traverse(-1);
  await locationIs(recoveryRoute);
  await reload();
  await text('Acceptance is unknown.');
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "Check Again").focus()');
  assert.equal(await evaluate('document.activeElement.textContent'), 'Check Again');
  const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...space, text: ' ', unmodifiedText: ' ' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
  try {
    await waitFor(() => evaluate('sessionStorage.getItem("synthetic-checks") === "1"'), 'keyboard recovery GET');
  } catch (error) {
    t.diagnostic(JSON.stringify(await evaluate('({ checks: sessionStorage.getItem("synthetic-checks"), active: document.activeElement?.textContent })')));
    throw error;
  }
  await text('Acceptance is unknown.');
  assert.equal(await evaluate('sessionStorage.getItem(' + JSON.stringify(key) + ')'), raw);
  await click('Check Again');
  await text('Message accepted.');
  await text('Synthetic message');
  assert.equal(await evaluate('sessionStorage.getItem("synthetic-posts")'), '1');
  assert.equal(await evaluate('sessionStorage.getItem(' + JSON.stringify(key) + ')'), null);
  await evaluate('sessionStorage.setItem(' + JSON.stringify(key) + ',' + JSON.stringify(raw) + ')');
  await click('Use founder B');
  await text('This workspace item is unavailable.');
  assert.equal(await evaluate('document.querySelector("main").innerText.includes("Synthetic message")'), false);
  assert.equal(await evaluate('sessionStorage.getItem(' + JSON.stringify(key) + ')'), null);
});
