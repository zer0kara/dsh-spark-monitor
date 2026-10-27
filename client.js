/**
 * @zer0kara/dsh-spark-monitor — browser half.
 *
 * Renders two aggregate pills (hottest temperature, fullest memory) plus a
 * GPU-clock button at the far right of the composer status row. Hovering a
 * pill lists every configured host; the clock popover offers the configured
 * tiers and applies the chosen one to all hosts.
 */
window.__ModuleLoader__.load({
  id: '@zer0kara/dsh-spark-monitor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Must match the Host half's exact Fetch routes. */
    const SNAPSHOT_URL = '/api/spark-monitor/snapshot';
    const CLOCK_URL = '/api/spark-monitor/clock';
    /** Browser poll cadence; the Host only resamples on its own interval. */
    const POLL_MS = 10_000;
    /** Clock state refresh cadence inside the pill. */
    const CLOCK_POLL_MS = 30_000;

    /** Severity thresholds. */
    const TEMP_WARN_C = 75;
    const TEMP_CRITICAL_C = 85;
    const MEMORY_WARN_PERCENT = 85;
    const MEMORY_CRITICAL_PERCENT = 95;
    const SWAP_WARN_PERCENT = 50;
    const SWAP_CRITICAL_PERCENT = 90;

    const DICTS = {
      en: {
        connecting: 'connecting…',
        unavailable: 'unavailable',
        noSwap: 'no swap',
        secondsAgo: 'sampled {n}s ago',
        minutesAgo: 'sampled {n}m ago',
        temperature: 'Temp',
        memory: 'RAM',
        swap: 'SWAP',
        monitor: 'spark monitor',
        sensors: 'sensors',
        peak: 'peak',
        used: 'used',
        host: 'host',
        load: 'load',
        nodes: 'nodes',
        clock: 'Clock',
        clockTitle: 'GPU clock limit',
        unlimited: 'Unlimited',
        applying: 'applying…',
        clockFailed: 'failed',
      },
      zh: {
        connecting: '连接中…',
        unavailable: '不可用',
        noSwap: '无 swap',
        secondsAgo: '{n} 秒前采样',
        minutesAgo: '{n} 分钟前采样',
        temperature: '温度',
        memory: '内存',
        swap: 'SWAP',
        monitor: 'spark 监控',
        sensors: '传感器',
        peak: '最高',
        used: '已用',
        host: '主机',
        load: '负载',
        nodes: '节点',
        clock: '时钟',
        clockTitle: 'GPU 时钟上限',
        unlimited: '无限制',
        applying: '应用中…',
        clockFailed: '失败',
      },
    };

    /** Human byte size; `—` for anything that is not a finite count. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      const digits = value >= 100 || unit === 0 ? 0 : 1;
      return `${value.toFixed(digits)} ${units[unit]}`;
    }

    /** One-decimal percentage; `—` when unknown. */
    function formatPercent(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—';
      return `${percent.toFixed(1)}%`;
    }

    /** Severity token color for a metric value. */
    function severityColor(kind) {
      if (kind === 'error') return 'var(--dsw-alias-state-error-primary)';
      if (kind === 'warn') return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-label-primary)';
    }

    /** Relative sample age through the active locale. */
    function formatAge(seconds, t) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
      if (seconds < 90) return t('secondsAgo', { n: Math.max(0, Math.round(seconds)) });
      return t('minutesAgo', { n: Math.max(1, Math.round(seconds / 60)) });
    }

    /** Group sensors by chip instance, e.g. `hwmon0 acpitz  61.4 / 56.7 °C`. */
    function sensorGroups(sensors) {
      if (!Array.isArray(sensors) || sensors.length === 0) return [];
      const groups = new Map();
      for (const sensor of sensors) {
        const instance = typeof sensor.chipInstance === 'string' ? sensor.chipInstance : '';
        const chip = typeof sensor.chip === 'string' ? sensor.chip : 'sensor';
        const key = `${instance} ${chip}`.trim();
        const value = typeof sensor.celsius === 'number' ? sensor.celsius.toFixed(1) : '—';
        const values = groups.get(key);
        if (values === undefined) groups.set(key, [value]);
        else values.push(value);
      }
      return [...groups].map(([label, values]) => `${label}  ${values.join(' / ')}°C`);
    }

    const ICON_PROPS = { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { flex: 'none' } };

    const ThermometerIcon = () => h('svg', ICON_PROPS,
      h('path', {
        fill: 'currentColor',
        d: 'M8 1.25a2.25 2.25 0 0 0-2.25 2.25v4.9a3.75 3.75 0 1 0 4.5 0V3.5A2.25 2.25 0 0 0 8 1.25Zm-.75 2.25a.75.75 0 0 1 1.5 0v5.55l.35.15a2.25 2.25 0 1 1-2.2 0l.35-.15V3.5Z',
      }),
      h('circle', { cx: 8, cy: 11.75, r: 1.5, fill: 'currentColor' }));

    const MemoryIcon = () => h('svg', ICON_PROPS,
      h('path', {
        fill: 'currentColor',
        d: 'M4.5 2A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 11.5 2h-7Zm0 1.5h7v9h-7v-9Zm1.5 1.5h4v6H6v-6Z',
      }),
      h('path', { fill: 'currentColor', d: 'M5 0h1v2H5V0Zm2.5 0h1v2h-1V0ZM10 0h1v2h-1V0Zm0 14h1v2h-1v-2Zm-2.5 0h1v2h-1v-2ZM5 14h1v2H5v-2Z' }));

    const GaugeIcon = () => h('svg', ICON_PROPS,
      h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', d: 'M2.75 11.25a5.25 5.25 0 0 1 10.5 0' }),
      h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', d: 'M8 11.25 10.4 8.6' }),
      h('circle', { cx: 8, cy: 11.25, r: 1.1, fill: 'currentColor' }));

    /** One icon + value pill with a hover detail card, matching the shipped dock pills. */
    function MetricPill(props) {
      const { icon, label, detail, kind } = props;
      const [hover, setHover] = React.useState(false);
      return h('span', {
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '1px 8px',
          borderRadius: 'var(--dsw-radius-sm)',
          color: hover ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          fontSize: 12,
          lineHeight: '20px',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          cursor: 'default',
        },
      },
      h('span', { style: { display: 'inline-flex', color: severityColor(kind) } }, icon),
      h('span', { style: { color: severityColor(kind) } }, label),
      hover ? h('div', {
        style: {
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          right: 0,
          zIndex: 1000,
          minWidth: 180,
          maxWidth: 420,
          padding: '8px 10px',
          borderRadius: 'var(--dsw-radius-md)',
          background: 'var(--dsw-alias-bg-overlay)',
          border: '1px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel)',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 12,
          lineHeight: '18px',
          whiteSpace: 'pre',
          textAlign: 'left',
          fontVariantNumeric: 'tabular-nums',
          pointerEvents: 'none',
        },
      }, detail) : null);
    }

    /**
     * Turn a failed clock response into a message that names the hosts.
     * The Host reports per-host failures inside `hosts[]`; reading only a
     * top-level `error` would leave a bare `HTTP 200` when a node rejects the
     * tier (for example `GPU requires reset`).
     */
    const describeClockFailure = (result, status) => {
      if (result !== null && typeof result === 'object') {
        if (typeof result.error === 'string' && result.error !== '') return result.error;
        const hosts = Array.isArray(result.hosts) ? result.hosts : [];
        const lines = hosts
          .filter((host) => host !== null && typeof host === 'object' && typeof host.error === 'string' && host.error !== '')
          .map((host) => `${host.label ?? host.alias}: ${host.error}`);
        if (lines.length > 0) return lines.join('\n');
      }
      return `HTTP ${String(status)}`;
    };

    /** Clock-tier button: click opens the configured GPU clock tiers. */
    function ClockPill(props) {
      const { t } = props;
      const [state, setState] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [hover, setHover] = React.useState(false);

      const load = async () => {
        try {
          const response = await fetch(CLOCK_URL, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          setState(await response.json());
          setError(null);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      };

      React.useEffect(() => {
        void load();
        const timer = setInterval(() => {
          void load();
        }, CLOCK_POLL_MS);
        return () => clearInterval(timer);
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const close = () => setOpen(false);
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
      }, [open]);

      const apply = async (tier) => {
        setBusy(true);
        setError(null);
        try {
          const response = await fetch(CLOCK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tier }),
          });
          const result = await response.json();
          if (!response.ok || result === null || result.ok !== true) {
            throw new Error(describeClockFailure(result, response.status));
          }
          setState(result);
          setOpen(false);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      };

      const tier = state !== null ? state.tier ?? null : null;
      const tiers = state !== null && Array.isArray(state.tiers) ? state.tiers : [];
      const label = tier === null ? '—' : tier === 'unlimited' ? '∞' : String(tier);
      const tierText = tier === null ? t('unavailable') : tier === 'unlimited' ? t('unlimited') : `${String(tier)} MHz`;
      const detail = state === null
        ? `${t('clockTitle')} · ${t('applying')}`
        : [
          `${t('clockTitle')} · ${tierText}`,
          ...(Array.isArray(state.hosts) ? state.hosts : []).map((host) => {
            const clock = typeof host.graphicsClockMHz === 'number' ? ` · ${String(host.graphicsClockMHz)} MHz` : '';
            return `${host.label ?? host.alias} ${host.tier ?? t('unavailable')}${clock}`;
          }),
        ].join('\n');

      const stop = (event) => event.stopPropagation();

      return h('span', { style: { position: 'relative', display: 'inline-flex' } },
        h('span', {
          role: 'button',
          tabIndex: 0,
          onMouseDown: stop,
          onClick: () => setOpen((value) => !value),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: detail,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '1px 8px',
            borderRadius: 'var(--dsw-radius-sm)',
            color: hover || open ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
            background: hover || open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            fontSize: 12,
            lineHeight: '20px',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          },
        },
        h('span', { style: { display: 'inline-flex' } }, h(GaugeIcon)),
        h('span', {}, label)),
        open ? h('div', {
          onMouseDown: stop,
          style: {
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            right: 0,
            zIndex: 1001,
            minWidth: 170,
            padding: 6,
            borderRadius: 'var(--dsw-radius-md)',
            background: 'var(--dsw-alias-bg-overlay)',
            border: '1px solid var(--dsw-alias-border-l1)',
            boxShadow: 'var(--dsw-elevation-panel)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
          },
        },
        h('div', { style: { padding: '2px 6px 6px', color: 'var(--dsw-alias-label-tertiary)' } }, t('clockTitle')),
        ...tiers.map((value) => h('div', {
          key: String(value),
          role: 'button',
          onClick: () => {
            if (!busy) void apply(value);
          },
          style: {
            padding: '4px 6px',
            borderRadius: 'var(--dsw-radius-sm)',
            cursor: busy ? 'default' : 'pointer',
            color: value === tier ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            background: value === tier ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          },
        }, value === 'unlimited' ? t('unlimited') : `${String(value)} MHz`)),
        busy ? h('div', { style: { padding: '4px 6px 0', color: 'var(--dsw-alias-label-tertiary)' } }, t('applying')) : null,
        error !== null ? h('div', { style: { padding: '4px 6px 0', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', maxWidth: 260 } }, error) : null) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale');

        // Fallback used only if the locale service or its dictionaries are
        // unavailable; it must interpolate `{n}` itself so callers always get
        // rendered text rather than a raw template.
        const interpolate = (template, params) => {
          if (typeof template !== 'string') return String(template);
          const values = params !== null && typeof params === 'object' ? params : {};
          return template.replace(/\{(\w+)\}/gu, (match, name) => (name in values ? String(values[name]) : match));
        };
        let translate = (key, params) => interpolate(DICTS.en[key] ?? key, params);

        try {
          // `locale.register` returns the disposer that withdraws the
          // dictionaries. Owning it as an effect keeps a reload clean:
          // re-registering a namespace locale that is still present throws.
          ctx.effect(() => locale.register('spark-monitor', 'en', DICTS.en), 'spark-monitor: en dictionary');
          ctx.effect(() => locale.register('spark-monitor', 'zh', DICTS.zh), 'spark-monitor: zh dictionary');
          translate = locale.bind('spark-monitor');
        } catch (error) {
          console.error('spark-monitor: could not register locale dictionaries', error);
        }

        function StatusBar() {
          const [snapshot, setSnapshot] = React.useState(null);
          const [failure, setFailure] = React.useState(null);
          const [, bump] = React.useState(0);

          React.useEffect(() => {
            const unsubscribe = locale.subscribe(() => bump((value) => value + 1));
            return () => unsubscribe();
          }, []);

          React.useEffect(() => {
            let alive = true;
            const tick = async () => {
              try {
                const response = await fetch(SNAPSHOT_URL, { headers: { accept: 'application/json' } });
                if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
                const data = await response.json();
                if (alive) {
                  setSnapshot(data);
                  setFailure(null);
                }
              } catch (error) {
                if (alive) setFailure(error instanceof Error ? error.message : String(error));
              }
            };
            void tick();
            const timer = setInterval(() => {
              void tick();
            }, POLL_MS);
            return () => {
              alive = false;
              clearInterval(timer);
            };
          }, []);

          const t = translate;
          const wrapStyle = { order: 9999, display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' };
          /** The Host hides the clock route when `clock: false`; mirror that here. */
          const clockOn = snapshot !== null && snapshot.clock === true;

          if (failure !== null) {
            const detail = `${t('monitor')} · ${t('unavailable')}\n${failure}`;
            return h('div', { style: wrapStyle },
              h(MetricPill, { icon: h(ThermometerIcon), label: '⚠', kind: 'error', detail }),
              h(MetricPill, { icon: h(MemoryIcon), label: '⚠', kind: 'error', detail }),
              clockOn ? h(ClockPill, { key: 'clock', t }) : null);
          }

          if (snapshot === null) {
            const detail = `${t('monitor')} · ${t('connecting')}`;
            return h('div', { style: wrapStyle },
              h(MetricPill, { icon: h(ThermometerIcon), label: '—', kind: 'ok', detail }),
              h(MetricPill, { icon: h(MemoryIcon), label: '—', kind: 'ok', detail }),
              clockOn ? h(ClockPill, { key: 'clock', t }) : null);
          }

          const hosts = Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
          // No host configured: this plugin assumes no host names of its own,
          // so it renders nothing until the user adds one.
          if (hosts.length === 0) return null;

          if (snapshot.ok !== true) {
            const detail = `${t('monitor')} · ${t('unavailable')}`;
            return h('div', { style: wrapStyle },
              h(MetricPill, { icon: h(ThermometerIcon), label: '⚠', kind: 'error', detail }),
              h(MetricPill, { icon: h(MemoryIcon), label: '⚠', kind: 'error', detail }),
              clockOn ? h(ClockPill, { key: 'clock', t }) : null);
          }

          const metrics = snapshot.metrics ?? {};
          const children = [];

          if (metrics.temperature !== false) {
            const measured = hosts.filter((host) => typeof host.maxCelsius === 'number');
            const peak = measured.length === 0 ? null : Math.max(...measured.map((host) => host.maxCelsius));
            const tempKind = peak === null
              ? 'ok'
              : peak >= TEMP_CRITICAL_C ? 'error' : peak >= TEMP_WARN_C ? 'warn' : 'ok';
            const tempValue = peak === null ? '—' : `${peak.toFixed(1)}°C`;
            const lines = hosts.map((host) => {
              if (typeof host.maxCelsius !== 'number') return `${host.label ?? host.alias}  ${t('unavailable')}`;
              return `${host.label ?? host.alias}  ${host.maxCelsius.toFixed(1)}°C  · ${formatAge(host.ageSeconds, t)}`;
            });
            const detail = [
              `${t('monitor')} · ${t('temperature')} · ${t('peak')} ${tempValue} · ${String(hosts.length)} ${t('nodes')}`,
              ...lines,
            ].join('\n');
            children.push(h(MetricPill, { key: 'temp', icon: h(ThermometerIcon), label: tempValue, kind: tempKind, detail }));
          }

          if (metrics.memory !== false) {
            const measured = hosts.filter((host) => typeof host.memory?.usedPercent === 'number');
            const peak = measured.length === 0 ? null : Math.max(...measured.map((host) => host.memory.usedPercent));
            const memKind = peak === null
              ? 'ok'
              : peak >= MEMORY_CRITICAL_PERCENT ? 'error' : peak >= MEMORY_WARN_PERCENT ? 'warn' : 'ok';
            const memValue = peak === null ? '—' : `${Math.round(peak)}%`;
            const lines = hosts.map((host) => {
              if (typeof host.memory?.usedPercent !== 'number') return `${host.label ?? host.alias}  ${t('unavailable')}`;
              const swap = typeof host.swap?.totalBytes === 'number' && host.swap.totalBytes > 0
                ? `${t('swap')} ${formatPercent(host.swap.usedPercent)}`
                : `${t('swap')} ${t('noSwap')}`;
              return `${host.label ?? host.alias}  ${formatPercent(host.memory.usedPercent)} · ${formatBytes(host.memory.usedBytes)} / ${formatBytes(host.memory.totalBytes)} · ${swap} · ${formatAge(host.ageSeconds, t)}`;
            });
            const detail = [
              `${t('monitor')} · ${t('memory')} ${memValue} · ${String(hosts.length)} ${t('nodes')}`,
              ...lines,
            ].join('\n');
            children.push(h(MetricPill, { key: 'mem', icon: h(MemoryIcon), label: memValue, kind: memKind, detail }));
          }

          children.push(clockOn ? h(ClockPill, { key: 'clock', t }) : null);
          return h('div', { style: wrapStyle }, children);
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'spark-monitor',
          order: 100,
        }, StatusBar));
      },
    };
  },
});
