/**
 * @zer0kara/dsh-spark-monitor — Host half.
 *
 * Samples temperature, memory and swap from 1-4 SSH-reachable Linux nodes and
 * applies GPU clock tiers (`nvidia-smi -lgc` / `-rgc`) to all of them. The
 * applied tier is recorded in /var/lib/gpu-clock-lock/tier on each host
 * because the driver exposes no query for the locked clock (only set/reset).
 */
import { execFile } from 'node:child_process';
import z from '@deepseek-ai/schemastery';

/** Sampling defaults and bounds. */
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86_400;
const DEFAULT_TIMEOUT_SECONDS = 20;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 120;
const CONNECT_TIMEOUT_SECONDS = 8;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_HOSTS = 4;

/** Tier record written by the plugin and by the boot service on each host. */
const CLOCK_TIER_FILE = '/var/lib/gpu-clock-lock/tier';
/** Exact Fetch routes served by the Host half. */
const SNAPSHOT_PATH = '/api/spark-monitor/snapshot';
const CLOCK_PATH = '/api/spark-monitor/clock';

/**
 * Clock tiers offered when a profile config omits them: MHz values plus
 * `unlimited`. The defaults are ordinary NVIDIA limits, not a specific
 * machine's tuning — override them in the profile patch.
 */
const DEFAULT_TIERS = [1710, 1950, 2190, 'unlimited'];

/** SSH alias charset: host names only, never shell metacharacters. */
const ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/u;

const HostConfig = z.object({
  alias: z.string().pattern(ALIAS_PATTERN).required().description('SSH alias from ~/.ssh/config / ~/.ssh/config 中的 SSH 别名'),
  label: z.string().default('').description('Display label / 显示名称'),
  temperature: z.boolean().default(true).description('Sample temperatures / 采集温度'),
  memory: z.boolean().default(true).description('Sample memory and swap / 采集内存与 swap'),
});

/** Profile config schema, rendered as a form by the Desktop plugin manager. */
export const Config = z.object({
  hosts: z.array(HostConfig).max(MAX_HOSTS).default([]).description('Nodes to monitor (1-4); empty means nothing is sampled / 监控节点（1-4 台）；留空则不采样'),
  tiers: z.array(z.union([z.number().min(100).max(4000), z.const('unlimited')])).default(DEFAULT_TIERS).description('GPU clock tiers / GPU 时钟档位'),
  clock: z.boolean().default(true).description('Enable GPU clock tier control; false hides the clock button / 启用 GPU 时钟档位控制；false 隐藏时钟按钮'),
  intervalSeconds: z.number().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS).default(DEFAULT_INTERVAL_SECONDS).description('Sampling interval in seconds / 采样间隔（秒）'),
  timeoutSeconds: z.number().min(MIN_TIMEOUT_SECONDS).max(MAX_TIMEOUT_SECONDS).default(DEFAULT_TIMEOUT_SECONDS).description('SSH command timeout in seconds / SSH 命令超时（秒）'),
});

/**
 * Remote collector. One line per fact keeps the Host parser a plain line
 * scanner: no JSON tooling, no root privileges, no lm-sensors install.
 * Temperature values are millidegrees Celsius in sysfs.
 */
const REMOTE_SCRIPT = [
  'LANG=C; export LANG',
  'echo "host $(hostname 2>/dev/null)"',
  "echo \"uptime $(cut -d' ' -f1 /proc/uptime 2>/dev/null)\"",
  'echo "load $(cat /proc/loadavg 2>/dev/null)"',
  'grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null',
  'for d in /sys/class/hwmon/hwmon*; do',
  '  chip=$(cat "$d/name" 2>/dev/null || echo unknown)',
  '  for f in "$d"/temp*_input; do',
  '    [ -e "$f" ] || continue',
  '    v=$(cat "$f" 2>/dev/null) || continue',
  '    echo "hwmon $(basename "$d") $chip $(basename "$f") $v"',
  '  done',
  'done',
].join('\n');

/** Clamp one configured number into a safe integer range. */
function clamp(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** First non-empty line of a text, trimmed and capped for display. */
function firstLine(text) {
  if (typeof text !== 'string') return '';
  const line = text.split(/\r?\n/u).find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.trim().slice(0, 300);
}

/** Round to one decimal without a trailing `.0`. */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Normalize configured hosts into 0-4 unique, validated aliases.
 * An empty or fully invalid list stays empty: the plugin assumes no host
 * names of its own, so nothing is sampled until the user configures one.
 * @param {unknown} raw configured `hosts`.
 * @returns {Array<{alias: string, label: string, temperature: boolean, memory: boolean}>}
 */
function normalizeHosts(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const hosts = [];
  for (const entry of list) {
    if (hosts.length >= MAX_HOSTS) break;
    const alias = entry !== null && typeof entry === 'object' && typeof entry.alias === 'string' ? entry.alias.trim() : '';
    if (alias === '' || !ALIAS_PATTERN.test(alias) || seen.has(alias)) continue;
    seen.add(alias);
    hosts.push({
      alias,
      label: typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : alias,
      temperature: entry.temperature !== false,
      memory: entry.memory !== false,
    });
  }
  return hosts;
}

/**
 * Normalize configured tiers into unique numbers and `unlimited`.
 * @param {unknown} raw configured `tiers`.
 * @returns {Array<number | 'unlimited'>}
 */
function normalizeTiers(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const tiers = [];
  for (const entry of list) {
    if (entry === 'unlimited') {
      if (!tiers.includes('unlimited')) tiers.push('unlimited');
      continue;
    }
    const value = Number(entry);
    if (!Number.isFinite(value) || value < 100 || value > 4000) continue;
    const rounded = Math.round(value);
    if (!tiers.includes(rounded)) tiers.push(rounded);
  }
  return tiers.length > 0 ? tiers : [...DEFAULT_TIERS];
}

/**
 * Parse the collector's line-oriented output.
 * @param {string} stdout collector output.
 * @returns {{host?: string, uptimeSeconds?: number, load?: string, meminfo: Record<string, number>, sensors: Array<{chip: string, chipInstance: string, file: string, celsius: number}>}}
 */
function parseSample(stdout) {
  const parsed = { meminfo: {}, sensors: [] };
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('host ')) {
      parsed.host = line.slice(5).trim();
      continue;
    }
    if (line.startsWith('uptime ')) {
      const seconds = Number(line.slice(7));
      if (Number.isFinite(seconds)) parsed.uptimeSeconds = seconds;
      continue;
    }
    if (line.startsWith('load ')) {
      parsed.load = line.slice(5).trim();
      continue;
    }
    const meminfo = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB$/u.exec(line);
    if (meminfo !== null) {
      parsed.meminfo[meminfo[1]] = Number(meminfo[2]);
      continue;
    }
    const hwmon = /^hwmon (\S+) (\S+) (temp\d+_input) (\d+)$/u.exec(line);
    if (hwmon !== null) {
      const millidegrees = Number(hwmon[4]);
      if (Number.isFinite(millidegrees)) {
        parsed.sensors.push({
          chip: hwmon[2],
          chipInstance: hwmon[1],
          file: hwmon[3],
          celsius: millidegrees / 1000,
        });
      }
    }
  }
  return parsed;
}

/**
 * Build one host's snapshot from the parsed collector output.
 * @param {ReturnType<typeof parseSample>} parsed parsed collector output.
 * @param {{alias: string, label: string, temperature: boolean, memory: boolean}} host normalized host.
 * @param {number} sampledAt sampling timestamp.
 * @returns {object} per-host snapshot.
 */
function buildHostSnapshot(parsed, host, sampledAt) {
  const memTotal = (parsed.meminfo.MemTotal ?? 0) * 1024;
  const memAvailable = (parsed.meminfo.MemAvailable ?? 0) * 1024;
  const swapTotal = (parsed.meminfo.SwapTotal ?? 0) * 1024;
  const swapFree = (parsed.meminfo.SwapFree ?? 0) * 1024;
  const snapshot = {
    alias: host.alias,
    label: host.label,
    ok: false,
    sampledAt,
    host: parsed.host ?? host.alias,
    uptimeSeconds: parsed.uptimeSeconds,
    load: parsed.load,
  };
  if (host.temperature) {
    const sensors = parsed.sensors.map((sensor) => ({ ...sensor, celsius: round1(sensor.celsius) }));
    snapshot.sensors = sensors;
    snapshot.maxCelsius = sensors.length === 0 ? null : Math.max(...sensors.map((sensor) => sensor.celsius));
  }
  if (host.memory) {
    const usedBytes = Math.max(0, memTotal - memAvailable);
    const swapUsed = Math.max(0, swapTotal - swapFree);
    snapshot.memory = {
      totalBytes: memTotal,
      usedBytes,
      availableBytes: memAvailable,
      usedPercent: memTotal > 0 ? round1((usedBytes / memTotal) * 100) : null,
    };
    snapshot.swap = {
      totalBytes: swapTotal,
      usedBytes: swapUsed,
      freeBytes: swapFree,
      usedPercent: swapTotal > 0 ? round1((swapUsed / swapTotal) * 100) : null,
    };
  }
  const temperatureOk = host.temperature === false || (snapshot.sensors !== undefined && snapshot.sensors.length > 0);
  const memoryOk = host.memory === false || memTotal > 0;
  snapshot.ok = temperatureOk && memoryOk;
  if (!snapshot.ok) snapshot.error = 'no temperature or memory data reported';
  return snapshot;
}

/**
 * Build the remote command that applies one tier and records it.
 * @param {number | 'unlimited'} tier one configured tier.
 * @returns {string} one shell command string for the remote shell.
 */
function clockCommand(tier) {
  const apply = tier === 'unlimited'
    ? '/usr/bin/nvidia-smi -rgc'
    : `/usr/bin/nvidia-smi -lgc 0,${tier}`;
  const record = `mkdir -p /var/lib/gpu-clock-lock && echo ${tier} > ${CLOCK_TIER_FILE} && chmod 644 ${CLOCK_TIER_FILE}`;
  return `sudo -n sh -c '${apply} && ${record}'`;
}

/** Remote command that reports the recorded tier and the live graphics clock. */
const CLOCK_PROBE = [
  `printf 'tier=%s\\n' "$(cat ${CLOCK_TIER_FILE} 2>/dev/null || echo unknown)"`,
  `printf 'gr=%s\\n' "$(nvidia-smi --query-gpu=clocks.gr --format=csv,noheader,nounits 2>/dev/null | head -n 1)"`,
].join('; ');

/**
 * Parse the clock probe output.
 * @param {string} stdout probe output.
 * @param {Array<number | 'unlimited'>} tiers configured tiers.
 * @returns {{tier: number | 'unlimited' | null, graphicsClockMHz: number | null}} parsed facts.
 */
function parseClockProbe(stdout, tiers) {
  const parsed = { tier: null, graphicsClockMHz: null };
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith('tier=')) {
      const value = line.slice(5).trim();
      const tier = value === 'unlimited' ? 'unlimited' : Number(value);
      if (tiers.includes(tier)) parsed.tier = tier;
    } else if (line.startsWith('gr=')) {
      const value = Number(line.slice(3));
      if (Number.isFinite(value)) parsed.graphicsClockMHz = value;
    }
  }
  return parsed;
}

/** Default SSH runner: `execFile` with argument-array arguments, never a shell. */
const defaultRunner = (alias, command, timeoutMs) => new Promise((resolve) => {
  execFile('ssh', [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    '-o', 'ClearAllForwardings=yes',
    alias,
    command,
  ], { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
    resolve({ error: error ?? null, stdout: stdout ?? '', stderr: stderr ?? '' });
  });
});

/** Active SSH runner; swapped by {@link setRemoteRunner} in tests. */
let remoteRunner = defaultRunner;

/**
 * Replace the SSH runner (test seam). Pass nothing to restore the default.
 * @param {unknown} runner `(alias, command, timeoutMs) => Promise<{error, stdout, stderr}>`.
 */
export function setRemoteRunner(runner) {
  remoteRunner = typeof runner === 'function' ? runner : defaultRunner;
}

const runRemote = (alias, command, timeoutMs) => remoteRunner(alias, command, timeoutMs);

/**
 * Activate the Host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config row config (`hosts`, `tiers`, `intervalSeconds`, `timeoutSeconds`).
 */
export function apply(ctx, config) {
  const row = config !== null && typeof config === 'object' ? config : {};
  const hosts = normalizeHosts(row.hosts);
  const tiers = normalizeTiers(row.tiers);
  const intervalSeconds = clamp(row.intervalSeconds, DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
  const timeoutSeconds = clamp(row.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  const metrics = {
    temperature: hosts.some((host) => host.temperature),
    memory: hosts.some((host) => host.memory),
  };
  /**
   * `clock: false` turns the tier control off entirely (no route, no button).
   * With no configured host there is nothing to apply a tier to, so the
   * control stays off as well.
   */
  const clockEnabled = row.clock !== false && hosts.length > 0;

  if (hosts.length === 0) {
    ctx.logger?.info?.('spark-monitor: no hosts configured; add at least one SSH alias to start sampling');
  }

  /** Latest per-host snapshot; replaced atomically per sampling round. */
  const states = new Map(hosts.map((host) => [host.alias, {
    alias: host.alias,
    label: host.label,
    ok: false,
    sampledAt: Date.now(),
    error: 'first sample still running',
  }]));

  const sampleHost = async (host) => {
    const sampledAt = Date.now();
    try {
      const { error, stdout, stderr } = await runRemote(host.alias, REMOTE_SCRIPT, timeoutSeconds * 1000);
      if (error !== null) {
        const detail = firstLine(stderr) || firstLine(stdout) || (error.killed ? `ssh timed out after ${timeoutSeconds}s` : error.message);
        states.set(host.alias, { alias: host.alias, label: host.label, ok: false, sampledAt, error: detail });
        ctx.logger?.warn(`spark-monitor: sample of ${host.alias} failed: ${detail}`);
        return;
      }
      const snapshot = buildHostSnapshot(parseSample(stdout), host, sampledAt);
      states.set(host.alias, snapshot);
      if (snapshot.ok === false) ctx.logger?.warn(`spark-monitor: ${host.alias}: ${snapshot.error}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      states.set(host.alias, { alias: host.alias, label: host.label, ok: false, sampledAt, error: detail });
      ctx.logger?.warn(`spark-monitor: sample of ${host.alias} threw: ${detail}`);
    }
  };

  const sampleAll = async () => {
    await Promise.all(hosts.map((host) => sampleHost(host)));
  };

  const view = () => {
    const now = Date.now();
    return {
      ok: [...states.values()].some((state) => state.ok === true),
      metrics,
      clock: clockEnabled,
      hosts: [...states.values()].map((state) => ({
        ...state,
        ageSeconds: Math.max(0, Math.round((now - state.sampledAt) / 1000)),
      })),
    };
  };

  void sampleAll();
  ctx.effect(() => {
    const timer = setInterval(() => {
      void sampleAll();
    }, intervalSeconds * 1000);
    return () => clearInterval(timer);
  }, 'spark-monitor: sampler');

  /** Read the recorded tier and live graphics clock of every host. */
  const readClockState = async () => {
    const results = await Promise.all(hosts.map(async (host) => {
      const { error, stdout, stderr } = await runRemote(host.alias, CLOCK_PROBE, timeoutSeconds * 1000);
      if (error !== null) {
        return {
          alias: host.alias,
          label: host.label,
          tier: null,
          graphicsClockMHz: null,
          error: firstLine(stderr) || firstLine(stdout) || (error.killed ? `ssh timed out after ${timeoutSeconds}s` : error.message),
        };
      }
      return { alias: host.alias, label: host.label, ...parseClockProbe(stdout, tiers), error: null };
    }));
    const primary = results[0];
    return { ok: results.every((result) => result.error === null), tiers, tier: primary?.tier ?? null, hosts: results };
  };

  /** Apply one tier to every configured host and report the result. */
  const applyClockTier = async (tier) => {
    const command = `${clockCommand(tier)}; ${CLOCK_PROBE}`;
    const results = await Promise.all(hosts.map(async (host) => {
      const { error, stdout, stderr } = await runRemote(host.alias, command, timeoutSeconds * 1000);
      if (error !== null) {
        return {
          alias: host.alias,
          label: host.label,
          tier: null,
          graphicsClockMHz: null,
          error: firstLine(stderr) || firstLine(stdout) || (error.killed ? `ssh timed out after ${timeoutSeconds}s` : error.message),
        };
      }
      return { alias: host.alias, label: host.label, ...parseClockProbe(stdout, tiers), error: null };
    }));
    // A node can reject the tier (for example `GPU requires reset`), so the
    // response carries a top-level message naming every failing host. Without
    // it a caller only sees per-host detail and reports a bare HTTP status.
    const failures = results.filter((result) => result.error !== null);
    const mismatched = results.filter((result) => result.error === null && result.tier !== tier);
    const ok = failures.length === 0 && mismatched.length === 0;
    const error = failures.length > 0
      ? failures.map((result) => `${result.label ?? result.alias}: ${result.error}`).join('; ')
      : mismatched.length > 0
        ? `tier ${String(tier)} was not recorded on ${mismatched.map((result) => result.label ?? result.alias).join(', ')}`
        : null;
    return { ok, tiers, tier, hosts: results, error };
  };

  // `rpc.handle` resolves its route owner against the connection service's own
  // scope and fails on `owner.webServer`; an exact Fetch route needs no web
  // server access and is served by the authenticated `/api` carrier instead.
  // Each registration is owned by the injected child context through
  // `ctx.effect`, so unloading or reloading the plugin withdraws the routes.
  ctx.inject(['connection'], (child) => {
    const register = (route) => child.effect(() => {
      try {
        return child.connection.fetch.register(route);
      } catch (error) {
        ctx.logger?.warn(`spark-monitor: could not register ${route.path}: ${error instanceof Error ? error.stack : String(error)}`);
        return () => {};
      }
    }, `spark-monitor: ${route.path}`);
    register({
      path: SNAPSHOT_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => Response.json(view()),
    });
    if (clockEnabled) {
      register({
        path: CLOCK_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method === 'POST') {
            let body = null;
            try {
              body = await request.json();
            } catch {
              return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
            }
            const tier = body !== null && typeof body === 'object' && (typeof body.tier === 'number' || typeof body.tier === 'string') ? body.tier : null;
            if (tier === null || !tiers.includes(tier)) {
              return Response.json({ ok: false, error: `unknown tier ${JSON.stringify(tier)}` }, { status: 400 });
            }
            const result = await applyClockTier(tier);
            ctx.logger?.info?.(`spark-monitor: clock tier ${String(tier)} ${result.ok ? 'applied' : `failed: ${result.error}`}`);
            return Response.json(result);
          }
          return Response.json(await readClockState());
        },
      });
    }
  });
}
