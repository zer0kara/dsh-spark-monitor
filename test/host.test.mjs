/**
 * Host-half tests: drive `apply()` with a stubbed SSH runner and a stubbed
 * Cordis context, then exercise the registered Fetch routes directly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, setRemoteRunner } from '../index.js';

const SAMPLES = {
  'node-1': [
    'host node-1',
    'uptime 12345.6',
    'load 0.42 0.31 0.25 1/234 5678',
    'MemTotal:       131072000 kB',
    'MemAvailable:    80000000 kB',
    'SwapTotal:       16777216 kB',
    'SwapFree:        16000000 kB',
    'hwmon hwmon0 acpitz temp1_input 61400',
    'hwmon hwmon0 acpitz temp2_input 56700',
    'hwmon hwmon1 nvme temp1_input 45800',
  ].join('\n'),
  'node-2': [
    'host node-2',
    'uptime 23456.7',
    'load 1.20 1.10 0.90 2/345 6789',
    'MemTotal:       131072000 kB',
    'MemAvailable:   10000000 kB',
    'SwapTotal:       0 kB',
    'SwapFree:        0 kB',
    'hwmon hwmon0 acpitz temp1_input 72300',
  ].join('\n'),
};

/** Fake runner: routes by command shape and echoes the requested tier. */
async function fakeRunner(alias, command) {
  if (command.includes('-lgc') || command.includes('-rgc')) {
    const match = /-lgc 0,(\d+)/u.exec(command);
    const tier = match !== null ? match[1] : 'unlimited';
    return { error: null, stdout: `tier=${tier}\ngr=1700\n`, stderr: '' };
  }
  if (command.includes('clocks.gr')) {
    const graphics = alias === 'node-1' ? 1677 : 1703;
    return { error: null, stdout: `tier=1710\ngr=${graphics}\n`, stderr: '' };
  }
  const sample = SAMPLES[alias];
  if (sample === undefined) return { error: new Error('ssh failed'), stdout: '', stderr: 'ssh: connect to host failed' };
  return { error: null, stdout: sample, stderr: '' };
}

/** Stub context capturing registered Fetch routes and effect disposers. */
function makeContext() {
  const routes = [];
  const disposers = [];
  /** Mirror cordis effect ownership: the callback's disposer runs on dispose. */
  const effect = (callback) => {
    const disposer = callback();
    disposers.push(disposer);
    return () => {
      if (typeof disposer === 'function') disposer();
    };
  };
  return {
    routes,
    logger: { warn() {}, info() {} },
    effect,
    inject: (deps, callback) => {
      // A real injected child context is a forked scope with its own `effect`.
      callback({
        effect,
        connection: {
          fetch: {
            register: (route) => {
              routes.push(route);
              return () => {
                const index = routes.indexOf(route);
                if (index !== -1) routes.splice(index, 1);
              };
            },
          },
        },
      });
    },
    dispose() {
      for (const disposer of disposers.splice(0)) {
        if (typeof disposer === 'function') disposer();
      }
    },
  };
}

/** Resolve the route by path. */
function routeOf(context, path) {
  const route = context.routes.find((candidate) => candidate.path === path);
  assert.ok(route, `route ${path} registered`);
  return route;
}

/** Wait one macrotask so the initial sampling round settles. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('snapshot aggregates two hosts with per-host metrics', async (t) => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, {
    hosts: [
      { alias: 'node-1', label: 'node 1', temperature: true, memory: true },
      { alias: 'node-2', label: 'node 2', temperature: true, memory: true },
    ],
  });
  await settle();

  const response = await routeOf(context, '/api/spark-monitor/snapshot').fetch(new Request('http://probe/api/spark-monitor/snapshot'));
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.clock, true);
  assert.deepEqual(body.metrics, { temperature: true, memory: true });
  assert.equal(body.hosts.length, 2);
  const first = body.hosts.find((host) => host.alias === 'node-1');
  const second = body.hosts.find((host) => host.alias === 'node-2');
  assert.equal(first.maxCelsius, 61.4);
  assert.equal(first.memory.usedPercent, 39);
  assert.equal(first.swap.usedPercent, 4.6);
  assert.equal(second.maxCelsius, 72.3);
  assert.equal(second.memory.usedPercent, 92.4);
  assert.equal(second.swap.usedPercent, null);
  assert.ok(first.ageSeconds >= 0);
});

test('per-host failure does not break the other hosts', async (t) => {
  setRemoteRunner(async (alias, command) => {
    if (alias === 'node-2' && !command.includes('clocks.gr')) {
      return { error: new Error('boom'), stdout: '', stderr: 'connection refused' };
    }
    return fakeRunner(alias, command);
  });
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, {
    hosts: [
      { alias: 'node-1', temperature: true, memory: true },
      { alias: 'node-2', temperature: true, memory: true },
    ],
  });
  await settle();

  const body = await (await routeOf(context, '/api/spark-monitor/snapshot').fetch(new Request('http://probe/x'))).json();
  assert.equal(body.ok, true);
  const first = body.hosts.find((host) => host.alias === 'node-1');
  const second = body.hosts.find((host) => host.alias === 'node-2');
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.error, /connection refused/);
});

test('metrics flags follow the per-host switches', async (t) => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, {
    hosts: [{ alias: 'node-1', temperature: false, memory: true }],
  });
  await settle();

  const body = await (await routeOf(context, '/api/spark-monitor/snapshot').fetch(new Request('http://probe/x'))).json();
  assert.deepEqual(body.metrics, { temperature: false, memory: true });
  assert.equal(body.hosts[0].sensors, undefined);
  assert.equal(typeof body.hosts[0].memory.usedPercent, 'number');
});

test('clock route reads tiers and applies a valid tier to every host', async (t) => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, {
    hosts: [
      { alias: 'node-1', label: 'node 1' },
      { alias: 'node-2', label: 'node 2' },
    ],
    tiers: [1710, 1950, 2190, 'unlimited'],
  });

  const clockRoute = routeOf(context, '/api/spark-monitor/clock');
  const state = await (await clockRoute.fetch(new Request('http://probe/x', { method: 'GET' }))).json();
  assert.equal(state.tier, 1710);
  assert.deepEqual(state.tiers, [1710, 1950, 2190, 'unlimited']);
  assert.equal(state.hosts.length, 2);
  assert.equal(state.hosts[0].graphicsClockMHz, 1677);

  const applied = await (await clockRoute.fetch(new Request('http://probe/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier: 1710 }),
  }))).json();
  assert.equal(applied.ok, true);
  assert.equal(applied.tier, 1710);
  assert.equal(applied.hosts.length, 2);
});

test('clock route rejects tiers outside the configured list', async (t) => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, { hosts: [{ alias: 'node-1' }], tiers: [1710, 'unlimited'] });
  const clockRoute = routeOf(context, '/api/spark-monitor/clock');

  const bad = await clockRoute.fetch(new Request('http://probe/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier: 2190 }),
  }));
  assert.equal(bad.status, 400);
  const invalid = await clockRoute.fetch(new Request('http://probe/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  }));
  assert.equal(invalid.status, 400);
});

test('clock: false disables the clock route and reports it in the snapshot', async (t) => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, { hosts: [{ alias: 'node-1' }], clock: false });
  await settle();

  assert.equal(context.routes.some((route) => route.path === '/api/spark-monitor/clock'), false);
  const body = await (await routeOf(context, '/api/spark-monitor/snapshot').fetch(new Request('http://probe/x'))).json();
  assert.equal(body.clock, false);
});

test('invalid and duplicate aliases are dropped', async (t) => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, {
    hosts: [
      { alias: 'bad alias; rm -rf /' },
      { alias: 'ok-node' },
      { alias: 'ok-node' },
      { alias: 'b' },
      { alias: 'c' },
      { alias: 'd' },
      { alias: 'e' },
    ],
  });
  await settle();

  const body = await (await routeOf(context, '/api/spark-monitor/snapshot').fetch(new Request('http://probe/x'))).json();
  assert.equal(body.hosts.length, 4);
  assert.deepEqual(body.hosts.map((host) => host.alias), ['ok-node', 'b', 'c', 'd']);
});

test('no hosts configured samples nothing and hides the clock control', async (t) => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, {});
  await settle();

  assert.equal(context.routes.some((route) => route.path === '/api/spark-monitor/clock'), false);
  const body = await (await routeOf(context, '/api/spark-monitor/snapshot').fetch(new Request('http://probe/x'))).json();
  assert.deepEqual(body.hosts, []);
  assert.equal(body.ok, false);
  assert.equal(body.clock, false);
  assert.deepEqual(body.metrics, { temperature: false, memory: false });
});

test('an explicitly empty hosts list stays empty', async (t) => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  t.after(() => context.dispose());
  apply(context, { hosts: [], tiers: [1710] });
  await settle();

  const body = await (await routeOf(context, '/api/spark-monitor/snapshot').fetch(new Request('http://probe/x'))).json();
  assert.deepEqual(body.hosts, []);
  assert.equal(context.routes.some((route) => route.path === '/api/spark-monitor/clock'), false);
});

test('disposing the plugin withdraws its routes', async () => {
  setRemoteRunner(fakeRunner);
  const context = makeContext();
  apply(context, { hosts: [{ alias: 'node-1' }] });
  assert.equal(context.routes.length, 2);
  context.dispose();
  assert.deepEqual(context.routes, []);
});

