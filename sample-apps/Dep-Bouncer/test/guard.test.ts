import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { findInstalls, decide } from '../guard/parse-command.mjs';

const request = (manager: string, name: string, spec?: string, raw = `${name}${spec ? `@${spec}` : ''}`) =>
  ({ manager, name, ...(spec ? { spec } : {}), raw });

for (const [command, expected] of [
  ['npm i axios@1.14.1', [request('npm', 'axios', '1.14.1')]],
  ['npm install -D vitest typescript', [request('npm', 'vitest'), request('npm', 'typescript')]],
  ['pnpm add @ctrl/tinycolor@^4', [request('pnpm', '@ctrl/tinycolor', '^4')]],
  ['yarn add lodash', [request('yarn', 'lodash')]],
  ['bun add zod', [request('bun', 'zod')]],
  ['npx -y create-vite@5 app', [request('npx', 'create-vite', '5')]],
  ['npm exec --package=foo -- bar', [request('npx', 'foo')]],
  ['cd web && npm i react', [request('npm', 'react')]],
  ['FOO=1 npm i x', [request('npm', 'x')]],
  ['npm i ./local ../x git+https://x/y.git user/repo file:z http://x/y.tgz', []],
  ['npm i alias@npm:real@1.2.3', [request('npm', 'real', '1.2.3', 'alias@npm:real@1.2.3')]],
  ['npm ci', []],
  ['npm install', []],
  ['echo npm i axios', []],
  ['npm i a && pnpm add b; yarn add c', [request('npm', 'a'), request('pnpm', 'b'), request('yarn', 'c')]],
  ['npm i "react@latest" \'@types/node\' "x@>=1 <2"', [request('npm', 'react', 'latest'), request('npm', '@types/node'), request('npm', 'x', '>=1 <2')]],
] as const) {
  test(`findInstalls: ${command}`, () => assert.deepEqual(findInstalls(command), expected));
}

test('all npm install aliases and case-insensitive verbs', () => {
  for (const verb of ['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isntall']) {
    assert.deepEqual(findInstalls(`npm ${verb.toUpperCase()} x`), [request('npm', 'x')]);
  }
});

test('pnpm and bun accept install and i with explicit packages', () => {
  for (const manager of ['pnpm', 'bun']) {
    for (const verb of ['install', 'i']) {
      assert.deepEqual(findInstalls(`${manager} ${verb} x`), [request(manager, 'x')]);
      assert.deepEqual(findInstalls(`${manager} ${verb}`), []);
    }
  }
});

test('runner forms check only the package, or explicitly specified packages', () => {
  for (const [command, manager] of [
    ['npm x foo arg', 'npx'], ['npm exec foo arg', 'npx'],
    ['pnpm dlx foo arg', 'pnpm dlx'], ['yarn dlx foo arg', 'yarn dlx'], ['bunx foo arg', 'bunx'],
  ]) assert.deepEqual(findInstalls(command), [request(manager, 'foo')]);
  assert.deepEqual(findInstalls('npx --package foo --package=@scope/bar@2 program --package=ignored'),
    [request('npx', 'foo'), request('npx', '@scope/bar', '2')]);
  assert.deepEqual(findInstalls('npm exec -p foo -- bar'), [request('npx', 'foo')]);
  assert.deepEqual(findInstalls('npx -- foo arg'), [request('npx', 'foo')]);
  assert.deepEqual(findInstalls('npx foo --package=argument'), [request('npx', 'foo')]);
});

test('leading flags, environment assignments, sudo, and flag values are skipped', () => {
  assert.deepEqual(findInstalls('FOO="some value" sudo -u root BAR=2 npm --prefix web i --registry https://example.test --tag next -w app --workspace other --filter target -D --save-dev --registry=x -g react'),
    [request('npm', 'react')]);
});

test('paths, URLs, shorthands, named non-registry versions and tarballs are ignored', () => {
  assert.deepEqual(findInstalls('npm i /x ~/x C:\\x link:x git:x github:user/repo https://x/y a.tgz @scope/pkg@file:../x foo@github:user/repo foo@user/repo'), []);
  assert.deepEqual(findInstalls('npm i @scope/alias@npm:@real/pkg@^2'),
    [request('npm', '@real/pkg', '^2', '@scope/alias@npm:@real/pkg@^2')]);
});

test('pipes, OR and newlines separate commands; quoted separators do not', () => {
  assert.deepEqual(findInstalls('npm i a || pnpm add b | yarn add c\nbun add d'),
    [request('npm', 'a'), request('pnpm', 'b'), request('yarn', 'c'), request('bun', 'd')]);
  assert.deepEqual(findInstalls('echo "npm i nope && npm i nope2"; npm i "x@>=1 || <2"'), [request('npm', 'x', '>=1 || <2')]);
  assert.deepEqual(findInstalls('npm i a # npm i nope\nnpm i b'), [request('npm', 'a'), request('npm', 'b')]);
  assert.deepEqual(findInstalls('npm i \\\nreact'), [request('npm', 'react')]);
});

const report = (verdict: 'ALLOW' | 'REVIEW' | 'BLOCK', name = 'axios') => ({
  package: name, version: '1.14.1', verdict, summary: 'Release summary',
  findings: [{ severity: 'high', title: 'First finding' }, { severity: 'medium', title: 'Second finding' }, { severity: 'low', title: 'Third finding' }],
});

test('BLOCK wins over REVIEW and includes two findings and a safe version', () => {
  const result = decide([report('REVIEW', 'other'), { ...report('BLOCK'), safeVersion: { version: '1.14.0', reason: 'Trusted release' } }]);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /Dep Bouncer BLOCK axios@1\.14\.1: First finding; Second finding\./);
  assert.match(result.reason, /Install axios@1\.14\.0 instead\./);
  assert.doesNotMatch(result.reason, /Third finding/);
});

test('REVIEW asks with the top finding', () => {
  const result = decide([report('ALLOW'), report('REVIEW', 'other')]);
  assert.equal(result.decision, 'ask');
  assert.match(result.reason, /Dep Bouncer REVIEW other@1\.14\.1: First finding\. Ask the user before installing\./);
});

test('all ALLOW and empty reports allow, with summary fallback', () => {
  assert.equal(decide([report('ALLOW')]).decision, 'allow');
  assert.deepEqual(decide([]), { decision: 'allow', reason: '' });
  assert.match(decide([{ ...report('ALLOW'), findings: [] }]).reason, /Release summary/);
});

// Run the I/O script in an isolated context: no subprocesses or network required.
const hookSource = readFileSync(new URL('../guard/dep-bouncer-guard.mjs', import.meta.url), 'utf8')
  .replace(/^#!.*\r?\n/, '').replace("import { findInstalls, decide } from './parse-command.mjs';", '');
async function runHook(payload: unknown, options: { cursor?: boolean; closed?: boolean; mode?: string } = {}) {
  let stdout = '', stderr = '';
  const calls: { name: string; version?: string }[] = [];
  const mockFetch: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://offline.invalid/mcp');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('mcp-protocol-version'), '2025-06-18');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.match(headers.get('accept')!, /text\/event-stream/);
    assert.ok(init?.signal);
    const rpc = JSON.parse(String(init?.body));
    assert.equal(rpc.method, 'tools/call');
    assert.equal(rpc.params.name, 'bouncer_check_package');
    const { name, version } = rpc.params.arguments;
    calls.push(rpc.params.arguments);
    const mode = options.mode;
    if (mode === 'unavailable' || name === 'offline') throw Error('offline fixture');
    if (mode === 'http') return new Response('', { status: 503 });
    const result = mode === 'tool-error' ? { isError: true, content: [{ text: 'tool fixture error' }] }
      : { content: [{ text: JSON.stringify({ package: name, version: version || 'latest',
        verdict: name === 'blocked' ? 'BLOCK' : name === 'review' ? 'REVIEW' : 'ALLOW',
        findings: [], summary: 'Fixture report' }) }] };
    const message = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
    return new Response(mode === 'bad' ? 'invalid' : mode === 'sse'
      ? 'event: message\r\ndata: {"method":"notification"}\r\n\r\nevent: message\r\ndata: ' + message + '\r\n\r\n' : message);
  };
  await runInNewContext(`(async () => { ${hookSource} })()`, {
    findInstalls, decide, AbortSignal, fetch: mockFetch,
    process: {
      stdin: Readable.from([JSON.stringify(payload)]),
      argv: ['node', 'guard.mjs', ...(options.cursor ? ['--cursor'] : [])],
      env: { DEP_BOUNCER_URL: 'https://offline.invalid/mcp', DEP_BOUNCER_FAIL_CLOSED: options.closed ? '1' : '0' },
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    },
  });
  return { stdout, stderr, result: stdout ? JSON.parse(stdout) : undefined, calls };
}

const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

test('hook ignores other tools and emits the correct no-install output', async () => {
  assert.equal((await runHook({ tool_name: 'Read', tool_input: { command: 'npm i x' } })).stdout, '');
  assert.equal((await runHook(bash('echo hello'))).stdout, '');
  assert.deepEqual((await runHook({ command: 'echo hello' }, { cursor: true })).result, { permission: 'allow' });
});

test('hook accepts JSON and SSE MCP results in both host formats', async () => {
  assert.equal((await runHook(bash('npm i blocked@1'))).result.hookSpecificOutput.permissionDecision, 'deny');
  const result = (await runHook({ command: 'npx review' }, { cursor: true, mode: 'sse' })).result;
  assert.equal(result.permission, 'ask');
  assert.equal(result.agentMessage, result.userMessage);
  assert.equal((await runHook(bash('npm i good'))).result.hookSpecificOutput.permissionDecision, 'allow');
});

test('unavailable, HTTP, tool errors and bad responses fail open or ask when configured', async () => {
  for (const mode of ['unavailable', 'http', 'tool-error', 'bad']) {
    const open = await runHook(bash('npm i good'), { mode });
    assert.equal(open.result.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(open.stderr, /Dep Bouncer unavailable: .*; allowing npm i good/);
    assert.equal((await runHook(bash('npm i good'), { mode, closed: true })).result.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal((await runHook({ command: 'npm i good' }, { cursor: true, mode, closed: true })).result.permission, 'ask');
  }
});

test('known BLOCK wins even when other checks are unavailable', async () => {
  assert.equal((await runHook(bash('npm i offline blocked'), { closed: true })).result.hookSpecificOutput.permissionDecision, 'deny');
});

test('hook deduplicates by name/spec, omits unspecified versions, and caps requests at eight', async () => {
  const result = await runHook(bash('npm i a a a@1 a@1 b c d e f g h'));
  assert.equal(result.calls.length, 8);
  assert.deepEqual(result.calls.slice(0, 2), [{ name: 'a' }, { name: 'a', version: '1' }]);
});
