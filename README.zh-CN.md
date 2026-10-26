# dsh-spark-monitor

[English](README.md) | **简体中文**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在输入框下方状态栏最右侧显示 **1–4 台 DGX Spark 节点**的实时监控，并用同一个按钮切换它们的 **GPU 时钟档位**。

温度、内存和 swap 通过 SSH 采集（sysfs `hwmon` 与 `/proc/meminfo`）；时钟档位通过 `sudo -n nvidia-smi -lgc` 应用到所有配置的节点。

## 功能

- **聚合状态 pill** —— 一个显示最热的节点，一个显示内存占用最高的节点；悬停可列出每台节点的数值与采样时间。
- **可配置节点** —— 1 到 4 台，每台可单独设置 SSH 别名、显示名称、是否采集温度/内存。
- **可配置时钟档位** —— 任意 MHz 档位列表加 `unlimited`，一键应用到所有节点；弹层会高亮当前档位。
- **逐台失败隔离** —— 某台不可达不影响其他台；该台在悬停详情里显示错误。
- **中英词典**，Desktop 插件管理器里有原生表单。

## 要求

- DeepSeek Harness `>= 0.2.1-rc.2`（Web UI / Desktop profile）。
- Node.js `>= 20`（仅本地开发需要）。
- 每台节点在 `~/.ssh/config` 里有别名，且免交互可达（`BatchMode=yes`）。
- 每台节点免密 sudo 可执行 `nvidia-smi`（`sudo -n nvidia-smi ...` 能直接跑）。
- 节点上装有 `nvidia-smi`（仅时钟功能需要）。

### 免密 sudo（仅时钟功能）

采集温度/内存不需要任何权限。应用时钟档位会执行 `sudo -n nvidia-smi -lgc ...`，所以 SSH 用户需要一条 NOPASSWD 规则：

```sudoers
# /etc/sudoers.d/dsh-spark-monitor
your-user ALL=(root) NOPASSWD: /usr/bin/nvidia-smi
```

把 `your-user` 换成你的 SSH 用户。没有这条规则时监控 pill 仍然工作；也可以在配置里设 `clock: false` 直接隐藏时钟按钮。

## 安装

本包从 GitHub 分发，没有发布到 npm。

**Desktop**：打开 Plugins 页，选 **Add plugin**，填 `github:zer0kara/dsh-spark-monitor`（或本地 checkout 的绝对路径），然后刷新页面。Desktop profile 由 Electron 独占管理，不能用 `dsh plugin --profile desktop`。

**CLI profile：**

```bash
dsh plugin --profile web add github:zer0kara/dsh-spark-monitor
# 本地 checkout 同样可以：
dsh plugin --profile web add file:/absolute/path/to/dsh-spark-monitor
```

## 配置

插件**不假设任何主机名**：没有配置 `hosts` 时不采样，状态条里也不显示任何东西。在 profile 的 patch 层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）或 Desktop 插件管理器的表单里添加节点。下面的 `node-1` / `node-2` 请换成你自己 `~/.ssh/config` 里的别名：

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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `hosts[].alias` | —（必填） | `~/.ssh/config` 中的 SSH 别名。允许字符：`A-Z a-z 0-9 . _ -`。不配任何主机则不采样。 |
| `hosts[].label` | 同别名 | 悬停详情里的显示名称。 |
| `hosts[].temperature` | `true` | 是否采集该节点温度。 |
| `hosts[].memory` | `true` | 是否采集该节点内存与 swap。 |
| `tiers[]` | `1710, 1950, 2190, unlimited` | 弹层提供的档位。数字为 MHz；`unlimited` 执行 `nvidia-smi -rgc`。 |
| `clock` | `true` | 是否启用 GPU 时钟档位控制。`nvidia-smi` 需要密码时设为 `false`，时钟按钮会隐藏。 |
| `intervalSeconds` | `300` | 采样间隔（30–86400 秒）。 |
| `timeoutSeconds` | `20` | 单次 SSH 命令超时（5–120 秒）。 |

Desktop 插件管理器会把同样的字段渲染成表单。

## 工作原理

- **采样**：Host 半每个周期对每台节点执行一次 SSH 命令，读取 `hwmon` 的 `temp*_input`（毫度）、`/proc/meminfo`（`MemTotal`/`MemAvailable`/`SwapTotal`/`SwapFree`）、uptime 与负载。每台快照独立保存，`ageSeconds` 由 Host 按请求计算。
- **时钟档位**：应用档位时执行 `sudo -n sh -c 'nvidia-smi -lgc 0,<MHz> && …'`（`unlimited` 用 `-rgc`），并把档位写入节点的 `/var/lib/gpu-clock-lock/tier`。之所以有记录文件，是因为驱动**没有**锁定值的查询接口，只能设/重置；下一节的可选开机 service 也写同一个文件，这样重启后状态 pill 能显示开机档位。

## 可选：让限频在重启后保持

`nvidia-smi -lgc` 是运行时设置，重启后会失效。插件不会安装或修改任何 service——这里只是一个可选的配套示例，适合希望限频跨重启保留的人。

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

把两处 `2190` 换成你自己的档位。`ExecStartPost` 只负责写档位记录文件，让状态 pill 能显示开机档位（驱动没有锁定值的查询接口）。不装这个 service 插件也能用：档位在运行时生效，重启后恢复默认，pill 显示 `—`，直到你再选一次档位。

## 限制

- 驱动无法读回真实的锁定值；插件显示的是它最后一次应用的档位（或开机 service 的档位）。在插件之外手动执行 `nvidia-smi -lgc` 不会被感知。
- `nvidia-smi -lgc` 不跨重启保留；需要持久化请参考上方的可选开机 service。
- 时钟功能需要免密 sudo；没有的话应用会失败，并在对应节点上显示错误。
- SSH 别名必须免交互可用；请使用 `BatchMode=yes` 友好的密钥。

## 开发

```bash
pnpm install
node --test
```

Host 测试用假 SSH runner（`setRemoteRunner`），直接调用注册的 Fetch 路由。

## 许可证

MIT
