import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NewDepsSignal } from '../src/modules/analysis/signals/new-deps.signal.js';
import type { AnalysisContext, PackageInfo, VersionManifest } from '../src/modules/analysis/signal.js';

const manifest = (name: string, version = '1.0.0', owner?: string): VersionManifest => ({
  name, version, _npmUser: owner ? { name: owner } : undefined,
  dist: { tarball: 'https://fixture.invalid/package.tgz' },
});
const established = (name: string, owner?: string): PackageInfo => ({
  name, created: '2020-01-01T00:00:00Z', versionCount: 20, weeklyDownloads: 50000,
  latest: manifest(name, '2.0.0', owner),
});
function context(dependencies: Record<string, string>, name = 'fixture'): AnalysisContext {
  return { name, target: { ...manifest(name, '2.0.0'), dependencies }, baseline: [manifest(name)], time: {},
    loadFiles: async () => new Map([['index.js', Buffer.from(Object.keys(dependencies).map(n => `import '${n}';`).join('\n'))]]),
    lookupPackage: async n => established(n),
  };
}
const signal = new NewDepsSignal();

test('more than thirty added dependencies report exact unexamined count', async () => {
  const ctx = context(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`fixture-dependency-${i}`, '^1'])));
  const calls: string[] = [];
  ctx.lookupPackage = async name => { calls.push(name); return established(name); };
  const result = await signal.evaluate(ctx);
  assert.equal(calls.length, 30);
  assert.ok(result.some(f => f.title === '2 new dependencies not examined' && f.severity === 'warn' && f.weight === 15));
});

test('twenty-five own-publisher platform dependencies are all examined without coverage warnings', async () => {
  const ctx = context(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`@typescript/platform-${i}`, '^1'])), 'typescript');
  ctx.target._npmUser = { name: 'maintainer' };
  const calls: string[] = [];
  ctx.lookupPackage = async name => { calls.push(name); return established(name, 'maintainer'); };
  const result = await signal.evaluate(ctx);
  assert.equal(calls.length, 25);
  assert.ok(!result.some(f => f.title.includes('not examined')));
  assert.ok(result.some(f => f.title === "25 new dependencies from the project's own scope or publisher"));
});

test('dependency lookups run at concurrency five and do not start more after cancellation', async () => {
  const controller = new AbortController();
  const ctx = { ...context(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`fixture-dependency-${i}`, '^1']))),
    signal: controller.signal };
  const releases: (() => void)[] = [];
  let started!: () => void;
  const fiveStarted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  ctx.lookupPackage = async name => {
    calls++;
    await new Promise<void>(resolve => {
      releases.push(resolve);
      if (calls === 5) started();
    });
    return established(name);
  };
  const pending = signal.evaluate(ctx);
  await fiveStarted;
  assert.equal(calls, 5);
  controller.abort();
  releases.forEach(release => release());
  const result = await pending;
  assert.equal(calls, 5);
  assert.ok(result.some(f => f.title === '20 new dependencies not examined'));
});

test('an unscoped target does not own similarly named scoped dependencies', async () => {
  const ctx = context({ '@fixture/missing': '^1' });
  let calls = 0;
  ctx.lookupPackage = async name => { calls++; assert.equal(name, '@fixture/missing'); return null; };
  const result = await signal.evaluate(ctx);
  assert.equal(calls, 1);
  assert.ok(result.some(f => f.severity === 'critical' && f.evidence.some(e => e.includes('does not exist'))));
});

test('a scoped target can exempt its actual own scope but examines other scopes', async () => {
  const ctx = context({ '@fixture/platform': '^1', '@other/platform': '^1' }, '@fixture/core');
  const calls: string[] = [];
  ctx.lookupPackage = async name => { calls.push(name); return null; };
  const result = await signal.evaluate(ctx);
  assert.deepEqual(calls, ['@other/platform']);
  assert.ok(result.some(f => f.severity === 'info' && f.evidence.includes('@fixture/platform')));
  assert.ok(result.some(f => f.severity === 'critical'));
});

test('publisher ownership requires both names and uses resolved before latest', async () => {
  for (const [targetOwner, resolvedOwner, latestOwner, exempt] of [
    ['maintainer', 'maintainer', 'other', true],
    ['maintainer', 'other', 'maintainer', false],
    ['maintainer', undefined, undefined, false],
    [undefined, undefined, undefined, false],
    [undefined, 'maintainer', 'maintainer', false],
  ] as const) {
    const ctx = context({ 'fixture-platform': '^1' });
    ctx.target._npmUser = targetOwner ? { name: targetOwner } : undefined;
    ctx.lookupPackage = async name => ({ ...established(name, latestOwner),
      resolved: { ...manifest(name, '1.0.0', resolvedOwner), scripts: { install: 'node setup.js' } } });
    const result = await signal.evaluate(ctx);
    assert.equal(result.some(f => f.title.includes('own scope or publisher')), exempt);
    assert.equal(result.some(f => f.severity === 'warn'), !exempt);
  }
});

test('publisher ownership falls back to latest when no resolved manifest is provided', async () => {
  const ctx = context({ 'fixture-platform': '^1' });
  ctx.target._npmUser = { name: 'maintainer' };
  ctx.lookupPackage = async name => established(name, 'maintainer');
  const result = await signal.evaluate(ctx);
  assert.ok(result.some(f => f.title.includes('own scope or publisher')));
});

test('dependency ranges are passed through and install scripts come from the installed version', async () => {
  for (const pinnedHasScripts of [true, false]) {
    const ctx = context({ 'fixture-platform': '~1.0.0' });
    ctx.lookupPackage = async (name, range) => {
      assert.equal(range, '~1.0.0');
      return { ...established(name),
        latest: { ...manifest(name, '2.0.0'), scripts: pinnedHasScripts ? {} : { postinstall: 'node latest.js' } },
        resolved: { ...manifest(name), scripts: pinnedHasScripts ? { postinstall: 'node pinned.js' } : {} } };
    };
    const result = await signal.evaluate(ctx);
    assert.equal(result.some(f => f.severity === 'warn'), pinnedHasScripts);
    if (pinnedHasScripts) assert.ok(result.some(f => f.evidence.some(e => e.includes('node pinned.js'))));
    assert.ok(!result.some(f => f.evidence.some(e => e.includes('node latest.js'))));
  }
});

test('resolved OSV malware blocks even when established, imported and owned by the publisher', async () => {
  const ctx = context({ 'fixture-platform': '1.0.0' });
  ctx.target._npmUser = { name: 'maintainer' };
  ctx.lookupPackage = async name => ({ ...established(name, 'maintainer'),
    resolved: manifest(name, '1.0.0', 'maintainer'), knownMalicious: true });
  const result = await signal.evaluate(ctx);
  assert.ok(result.some(f => f.severity === 'critical' && f.weight === 70
    && f.evidence.some(e => e.includes('fixture-platform@1.0.0 listed as malware in OSV'))));
});

test('dependency lookups stop after cancellation and after the deadline', async () => {
  for (const mode of ['abort', 'deadline'] as const) {
    const controller = new AbortController();
    const ctx = { ...context({ 'fixture-first': '^1', 'fixture-next': '^1' }),
      signal: controller.signal, deadline: Date.now() + 60000 };
    const calls: string[] = [];
    ctx.lookupPackage = async name => {
      calls.push(name);
      if (mode === 'abort') controller.abort();
      else ctx.deadline = Date.now() - 1;
      return established(name);
    };
    const result = await signal.evaluate(ctx);
    assert.deepEqual(calls, ['fixture-first']);
    assert.ok(result.some(f => f.title === '1 new dependencies not examined' && f.weight === 15));
  }
});

test('an already-expired check performs no package lookups', async () => {
  const ctx = { ...context({ 'fixture-first': '^1' }), deadline: Date.now() - 1 };
  ctx.lookupPackage = async () => { assert.fail('lookup after deadline'); };
  const result = await signal.evaluate(ctx);
  assert.ok(result.some(f => f.title === '1 new dependencies not examined'));
});
