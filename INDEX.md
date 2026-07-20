# Auto Company 索引

## 目标

本文件用于快速定位仓库目录结构、脚本职责和调用关系，便于后续维护与排障。

## 目录结构（当前）

### 实现目录（唯一脚本入口）

- `scripts/windows/`: Windows 控制、保活、自启脚本实现
- `scripts/core/`: 主循环与核心控制脚本实现
- `scripts/linux/`: 原生 Linux / WSL `systemd --user` 守护脚本实现（`scripts/wsl/` 保留兼容包装层）
- `scripts/macos/`: macOS `launchd` 守护脚本实现
- `packaging/`: Ubuntu 26.04 (amd64) 构建与发布（`.deb` + tarball），入口 `packaging/build-release.sh`（`make build`）

说明：根目录不再保留脚本包装层，执行与维护统一通过 `scripts/`。

### 其他关键目录

- `docs/`: 文档
- `logs/`: 运行日志
- `memories/`: 共识文件
- `projects/`: 自动公司产出项目

## 核心运行逻辑（Win + WSL）

调用链（默认）：

`scripts/windows/start-win.ps1` -> WSL `systemd --user auto-company.service` -> `scripts/core/auto-loop.sh`

说明：
- 默认引擎是 `ENGINE=claude`
- 可通过 `.auto-loop.env` 或 `start-win.ps1 -Engine codex` 切换到 Codex
- 不做自动引擎回退，所选引擎缺失时直接失败

停止链路：

`scripts/windows/stop-win.ps1` -> 停止 `auto-company.service` + 停止 `awake guardian` + 停止 `wsl anchor`

## 脚本职责表（入口 / 守护 / 自启 / 诊断）

| 类别 | 脚本路径 | 主要职责 |
|---|---|---|
| 入口 | `scripts/windows/start-win.ps1` | 启动 WSL daemon，写 `.auto-loop.env`（支持 `ENGINE/CLAUDE_PERMISSION_MODE/CODEX_SANDBOX_MODE`），启动防睡眠与 WSL keepalive |
| 入口 | `scripts/windows/stop-win.ps1` | 停止 daemon 并回收防睡眠与 WSL keepalive |
| 入口 | `scripts/windows/status-win.ps1` | 汇总 guardian/keepalive/autostart/daemon/loop 五层状态 |
| 诊断 | `scripts/windows/monitor-win.ps1` | 实时日志 |
| 诊断 | `scripts/windows/last-win.ps1` | 最近一轮完整输出 |
| 诊断 | `scripts/windows/cycles-win.ps1` | 周期摘要 |
| 诊断 | `scripts/windows/dashboard-win.ps1` | 启动本地 Web 可视化看板 |
| 保活 | `scripts/windows/awake-guardian-win.ps1` | 运行期防睡眠（`start/stop/status/run`） |
| 保活 | `scripts/windows/wsl-anchor-win.ps1` | 维持 WSL 会话常驻（`start/stop/status/run`） |
| 自启 | `scripts/windows/enable-autostart-win.ps1` | 创建登录自启任务 |
| 自启 | `scripts/windows/disable-autostart-win.ps1` | 删除登录自启任务 |
| 自启 | `scripts/windows/autostart-status-win.ps1` | 查询自启任务状态 |
| 守护 | `scripts/linux/install-linux-daemon.sh` | 安装并启用 `auto-company.service`（原生 Linux / WSL），并将 `.auto-loop.env` 权限收紧为 600 |
| 守护 | `scripts/linux/uninstall-linux-daemon.sh` | 卸载 Linux daemon |
| 守护 | `scripts/linux/linux-daemon-status.sh` | 查询 Linux daemon 状态 |
| 守护 | `scripts/linux/{status,start,stop}-linux.sh` | Dashboard/CLI 用的 Linux 状态与启停封装 |
| 守护 | `scripts/wsl/*.sh` | 兼容包装层，转发到 `scripts/linux/` |
| 守护 | `scripts/macos/install-daemon.sh` | macOS launchd 安装/卸载（plist 值经 XML 转义） |
| 核心 | `scripts/core/auto-loop.sh` | 主循环执行、熔断、预算上限、日志、共识更新 |
| 核心 | `scripts/core/loop-lib.sh` | 可单测的核心函数库（共识校验/预算/成本/引擎解析等），由 auto-loop 与 bats 共用 |
| 核心 | `scripts/core/monitor.sh` | 核心状态/日志输出 |
| 核心 | `scripts/core/stop-loop.sh` | 核心停止/暂停/恢复控制 |
| 安全 | `scripts/hooks/guard.sh` | PreToolUse 硬拦截（`.claude/settings.json` 挂载）：`rm -rf /`、删库、删 Cloudflare、force-push main、动 `~/.ssh`/`~/.claude` |
| 发布 | `packaging/build-release.sh` | 构建 Ubuntu 26.04 amd64 发布产物（`.deb` + tarball + 校验和） |
| 发布 | `packaging/deb/auto-company` | 安装后的 CLI 启动器（`init/start/stop/status/dashboard/...`） |
| 发布 | `.github/workflows/ubuntu-build-release.yml` | CI：lint + 测试（unittest + bats loop/hooks）+ 构建 + 安装冒烟 + tag 自动发布 |
| 发布 | `.github/workflows/snapog-ci.yml` | snapog：typecheck + wrangler dry-run（默认/staging/production） |

## 快速排障路径

1. 先看 `scripts/windows/status-win.ps1`
2. 再看 `scripts/windows/dashboard-win.ps1` 或 `scripts/windows/monitor-win.ps1`
3. 守护异常看 `scripts/linux/linux-daemon-status.sh`
4. 自启异常看 `scripts/windows/autostart-status-win.ps1`（权限问题优先检查管理员 PowerShell）

## 维护规则

1. 新功能优先改 `scripts/` 下实现脚本。
2. 文档变更需同步更新：
   - `README.md`
   - `README-ZH.md`
   - `docs/windows-setup.md`
   - `docs/ubuntu-build-release.md`
   - 本索引文件 `INDEX.md`
3. 发版流程：更新根目录 `VERSION`（与 `package.json` 同步）→ 提交 → 打 `v<VERSION>` tag 并推送，CI 自动构建并发布。
