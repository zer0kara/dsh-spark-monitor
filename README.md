# dsh-spark-monitor

**English** | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts a live status monitor for **1–4 DGX Spark nodes** at the far right of the composer status bar, and lets you switch their **GPU clock tiers** from the same button.

Temperature, memory and swap are sampled over SSH (sysfs `hwmon` and `/proc/meminfo`); the clock tiers are applied with `sudo -n nvidia-smi -lgc` on every configured node.

## Features

- **Aggregate status pills** — one pill shows the hottest node, one shows the fullest memory; hovering either lists every node with its own value and sample age.
- **Configurable nodes** — 1 to 4 nodes, each with its own SSH alias, display label, and per-node temperature / memory switches.
- **Configurable clock tiers** — any list of MHz values plus `unlimited`, applied to all nodes from a single click; the popover highlights the current tier.
- **Per-node failure isolation** — one unreachable node does not break the others; its pill line shows the error.
- **en / zh** dictionaries and a native settings form in the Desktop plugin manager.

## Requirements

- DeepSeek Harness `>= 0.2.1-rc.2` (Web UI / Desktop profile).
- Node.js `>= 20` (only for local development).
- SSH aliases for every node in `~/.ssh/config`, reachable without a password prompt (`BatchMode=yes`).
- Passwordless sudo on every node for `nvidia-smi` (`sudo -n nvidia-smi ...` must work).
- `nvidia-smi` installed on the nodes (only needed for the clock feature).

### Passwordless sudo (clock feature only)

Sampling temperature and memory needs no privileges. Applying a clock tier runs `sudo -n nvidia-smi -lgc ...`, so the SSH user needs a NOPASSWD rule:

```sudoers
# /etc/sudoers.d/dsh-spark-monitor
your-user ALL=(root) NOPASSWD: /usr/bin/nvidia-smi
```

Replace `your-user` with the SSH user. Without the rule the monitoring pills still work; set `clock: false` in the config to hide the clock button entirely.

## Install

This package is distributed from GitHub; it is not published to npm.

**Desktop:** open the Plugins page, choose **Add plugin**, and enter `github:zer0kara/dsh-spark-monitor` (or the absolute path of a local checkout), then reload the page. The Desktop profile is owned by the Electron app, so `dsh plugin --profile desktop` is not the way to install there.

**CLI profiles:**

```bash
dsh plugin --profile web add github:zer0kara/dsh-spark-monitor
# a local checkout works the same way:
dsh plugin --profile web add file:/absolute/path/to/dsh-spark-monitor
```

## Configuration

The plugin assumes **no host names of its own**: with no `hosts` configured it samples nothing and draws nothing in the status bar. Add your nodes in your profile's patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`) or in the Desktop plugin-manager form. Replace `node-1` / `node-2` below with the SSH aliases from your own `~/.ssh/config`:

```yaml
- id: spark-monitor
  name: "@zer0kara/dsh-spark-monitor"
  config:
    hosts:
      - alias: node-1
        label: node 1
        temperature: true
        memory: true
      - alias: node-2
        label: node 2
        temperature: true
        memory: true
    tiers:
      - 1710
      - 1950
      - 2190
      - unlimited
    clock: true
    intervalSeconds: 300
    timeoutSeconds: 20
```

| Field | Default | Meaning |
|---|---|---|
| `hosts[].alias` | — (required) | SSH alias from `~/.ssh/config`. Allowed characters: `A-Z a-z 0-9 . _ -`. With no hosts, nothing is sampled. |
| `hosts[].label` | alias | Display label used in tooltips. |
| `hosts[].temperature` | `true` | Sample temperatures for this node. |
| `hosts[].memory` | `true` | Sample memory and swap for this node. |
| `tiers[]` | `1710, 1950, 2190, unlimited` | Clock tiers offered by the popover. Numbers are MHz; `unlimited` runs `nvidia-smi -rgc`. |
| `clock` | `true` | Enable the GPU clock tier control. Set `false` to hide the clock button when `nvidia-smi` needs a password. |
| `intervalSeconds` | `300` | Host sampling interval (30–86400). |
| `timeoutSeconds` | `20` | Whole SSH command deadline (5–120). |

The Desktop plugin manager renders the same fields as a form.

## How it works

- **Sampling.** The Host half runs one SSH command per node per interval. It reads `hwmon` `temp*_input` files (millidegrees), `/proc/meminfo` (`MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree`), uptime and load. Each node's snapshot is stored independently; `ageSeconds` is computed by the Host per request.
- **Clock tiers.** Applying a tier runs `sudo -n sh -c 'nvidia-smi -lgc 0,<MHz> && …'` (or `-rgc` for `unlimited`) and records the tier in `/var/lib/gpu-clock-lock/tier` on the node. The record file exists because the driver exposes **no query** for the locked clock — only set/reset; the optional boot service below writes the same file so the pill can show the boot tier after a reboot.

## Optional: persist the clock limit across reboots

`nvidia-smi -lgc` is a runtime setting, so a reboot clears it. The plugin never installs or edits any service — this is only a companion example for people who want the limit to survive a reboot.

```ini
# /etc/systemd/system/gpu-clock-lock.service
[Unit]
Description=Lock GPU clocks for thermal control

[Service]
Type=oneshot
ExecStart=/usr/bin/nvidia-smi -lgc 0,2190
ExecStartPost=/bin/sh -c 'mkdir -p /var/lib/gpu-clock-lock && echo 2190 > /var/lib/gpu-clock-lock/tier && chmod 644 /var/lib/gpu-clock-lock/tier'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Replace both `2190` values with your tier. `ExecStartPost` only writes the tier record so the status pill can show the boot tier (the driver has no query for the locked clock). Without this service the plugin still works: the tier applies at runtime, and after a reboot the clocks revert and the pill shows `—` until you pick a tier again.

## Limitations

- There is no way to read the *actual* locked clock back from the driver; the plugin shows the last tier it applied (or the boot service's tier). A manual `nvidia-smi -lgc` outside the plugin is invisible.
- `nvidia-smi -lgc` does not survive a reboot; use the optional boot service above to persist it.
- The clock feature needs passwordless sudo; without it the apply fails and the error is shown per node.
- SSH aliases must resolve without interactive prompts; use `BatchMode=yes`-friendly keys.

## Development

```bash
pnpm install
node --test
```

The Host tests use a fake SSH runner (`setRemoteRunner`) and exercise the registered Fetch routes directly.

## License

MIT
