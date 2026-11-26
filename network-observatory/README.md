# Blackwhite 网络观测

配套服务连接 CF-Server-Monitor，使用同一节点 ID，并验证原生后台会话。服务持久化检测清单、探测器凭证、计划、报告、首页发布范围和累计流量归档。原主题的三网去回程、国际路径和延迟、测速、BGP、IP 质量、流媒体和 AI 解锁、TcpQuality 与 NodeQuality 配置由这项服务运行。

## 启动服务

安装 Blackwhite 主题后，首页和实例指标从 CF Worker 加载。详情页的「网络检测」还需要一份独立运行的网络观测服务，实际检测由接入的探测器执行。

### 1. 在 VPS 上准备服务和探测器安装文件

选一台常开的 Linux VPS，通过 SSH 登录后执行本节的命令。可以使用已接入 CF-Server-Monitor 的 VPS。持久磁盘指 VPS 重启后文件仍保留的存储，服务会把报告、探测器凭证和流量数据库写到这个磁盘上。整个面板运行一份观测服务即可。

在 VPS 上准备 `git`、`curl` 和 Node.js 22.13 或更新版本。以下命令将 `v1.0.0` 的服务源码克隆到当前用户的家目录。

```bash
cd "$HOME"
git clone --depth 1 --branch v1.0.0 \
  https://github.com/imperatorwuming/cf-monitor-theme-blackwhite.git
cd cf-monitor-theme-blackwhite
node --version
```

**从源码打包**需要安装 `zip`。`npm ci` 按锁文件安装构建依赖，`npm run package` 生成 `dist/` 的主题文件和 `release/runner/` 的探测器安装文件。

```bash
npm ci
npm run package
```

**使用已打包的文件**可以省去以上两条命令，适合内存较小的 VPS。仍需保留刚才克隆的仓库，因为运行服务需要其中的源码。在仓库根目录执行以下命令，把 [v1.0.0 Release](https://github.com/imperatorwuming/cf-monitor-theme-blackwhite/releases/tag/v1.0.0) 的探测器安装文件和校验文件下载到服务读取的目录。

```bash
(
  set -e
  mkdir -p release/runner
  cd release/runner
  base=https://github.com/imperatorwuming/cf-monitor-theme-blackwhite/releases/download/v1.0.0
  for file in Blackwhite-Network-Observatory-install.sh \
              Blackwhite-Network-Observatory-latest.zip \
              Blackwhite-Network-Observatory-v1.0.0.zip; do
    curl -fsSL --retry 2 "$base/$file" -o "$file"
    curl -fsSL --retry 2 "$base/$file.sha256" -o "$file.sha256"
    sha256sum -c "$file.sha256"
  done
)
```

### 2. 配置并启动服务

在 CF-Server-Monitor 后台的安全设置中配置 **App 访问口令**，供观测服务定期读取节点清单和流量计数器。私有站点、隐藏节点或启用了全局 Turnstile 时需要该口令。初次部署时，在仓库根目录创建配置文件。

```bash
install -m 600 .env.observatory.example .env.observatory
nano .env.observatory
```

```dotenv
CFSM_ORIGIN=https://status.example.com
CFSM_APP_PASSWORD="填写 CF 后台的 App 访问口令"
BLACKWHITE_ALLOWED_ORIGINS=https://status.example.com
BLACKWHITE_DATA_DIR=network-observatory/data
BLACKWHITE_HOST=127.0.0.1
BLACKWHITE_PORT=8788
```

`CFSM_ORIGIN` 填写 CF-Server-Monitor 的 HTTPS 地址。`BLACKWHITE_ALLOWED_ORIGINS` 填写浏览器实际打开主题的 origin，多个地址用逗号分隔。地址只包含协议、域名和可选端口。`BLACKWHITE_DATA_DIR` 默认指向仓库内的数据目录，也可以填当前用户可写的持久磁盘绝对路径。同一个数据目录只由一个运行实例使用。

```bash
npm run observatory
```

先保持前台进程运行，另开一个 SSH 窗口执行以下请求。预期返回 `{"ok":true}`。

```bash
curl -fsS http://127.0.0.1:8788/api/blackwhite-network-observatory/health
```

### 3. 配置 HTTPS 和 CF 面板

如果面板部署在 Cloudflare Workers 上，可以给观测服务分配独立域名，例如 `observatory.example.com`。把域名的 DNS 记录指向 VPS，由 VPS 上的 HTTPS 反向代理把完整请求路径转发到 `127.0.0.1:8788`。以下是 [Caddy 反代](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 配置示例。

```caddyfile
observatory.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

在 CF 后台的 **外观设置 → 自定义 Head** 添加以下内容，再将同一个 `https://observatory.example.com` 加入 **CSP API 域名白名单**（`csp_api`）。独立域名下，主题会使用 CF 后台登录保存的 JWT 验证管理员操作。

```html
<meta name="blackwhiteObservatory" content="https://observatory.example.com">
```

用公网地址检查 HTTPS 反代，同样应返回 `{"ok":true}`。

```bash
curl -fsS https://observatory.example.com/api/blackwhite-network-observatory/health
```

也可以使用面板同域的反代，把 `/api/blackwhite-network-observatory/*` 转发到观测服务，保留完整路径、Cookie、Authorization 和 Turnstile 请求头，其余流量交给 CF Worker。同域使用主题的默认服务地址。静态部署主题时，可以在构建阶段通过 `VITE_BLACKWHITE_OBSERVATORY` 指定观测服务地址。若使用主题默认汇率查询，另将 `https://api.frankfurter.dev` 加入 `csp_api`。

### 4. 设置开机启动

前台验证通过后，在使用 systemd 的系统上可将服务设为开机启动。先按 `Ctrl+C` 停止前台进程，再用 `sudoedit /etc/systemd/system/blackwhite-observatory.service` 创建服务文件。把示例的 `ubuntu` 和仓库路径换成实际值，`ExecStart` 中的 `/usr/bin/node` 换成 `command -v node` 显示的绝对路径。

```ini
[Unit]
Description=Blackwhite Network Observatory
Wants=network-online.target
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/cf-monitor-theme-blackwhite
ExecStart=/usr/bin/node --env-file=.env.observatory network-observatory/service/server.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now blackwhite-observatory
sudo systemctl status blackwhite-observatory
```

再检查一次公网健康接口。重新登录 CF 后台并刷新主题，然后接入需要执行检测的节点。

## 接入节点

1. 到 **Blackwhite 工作室 → 网络观测 → 探测器**，选择和 CF 监控对应的节点。创建节点凭证，执行页面生成的命令，在交互提示中输入凭证。安装脚本和校验后的发布包由网络观测服务的 HTTPS 下载端点提供。
2. 在 **测量点和资源** 配置需要的公网端点。CF 公共 API 只显示网络可达性，公网测量目标由管理员填写。根据检测方案选择 IPv4、IPv6、本地探测器或 Globalping 测量点。
3. 建立计划并运行一轮。在 **实例 → 网络检测** 检查队列、结果和报告；需要公开展示时，在工作室逐项选择发布节点。公开摘要依照 CF 的站点可见性和计划的发布范围，具体报告可单独生成限时分享链接。
4. **完整 TcpQuality / NodeQuality** 需要启用完整检测执行器，具体依赖在计划面板列出。现有探测器可用页面生成的升级命令保留凭证。报告采集和外部服务可用性取决于实际网络与测量节点。

探测器支持 Linux systemd 与 OpenRC，常规采集继续使用 CF-Server-Monitor 的原生 Agent。月流量重置的提示直接读取 CF 节点的重置日，并按 UTC 计算。报告状态、凭证和流量数据库都保存在同一个持久目录，迁移服务时请一起备份。

## 排查网络检测报错

「无法读取网络报告能力」下显示「网络报告 API 返回 HTTP 200」时，在浏览器开发者工具的 **网络** 面板查看 `/api/blackwhite-network-observatory/v3/capabilities` 的请求地址和响应。

| 看到的结果 | 排查方法 |
| --- | --- |
| `200`，响应是 HTML | 请求通常落到了 CF Worker 的页面。检查主题是否加载了 `blackwhiteObservatory`，或同域反代是否转发了该路径。 |
| 本地健康检查失败 | 确认观测服务已启动，并用 `journalctl -u blackwhite-observatory -n 50` 查看 systemd 服务日志。 |
| 本地健康检查通过，公网检查失败 | 检查观测域名的 DNS、HTTPS 证书和反代配置。两处健康检查都应返回 `{"ok":true}`。 |
| 浏览器提示 CSP 或 CORS 拦截 | 确认 CF 后台的 CSP API 白名单包含观测服务 origin，观测服务的 `BLACKWHITE_ALLOWED_ORIGINS` 包含主题页面的 origin。 |
| 能力接口返回 `401` 或提示需要 Turnstile 验证 | 在 CF 后台重新登录并完成验证，再从主题重试。直接用未登录的 `curl` 请求能力接口时，收到 `401` 是预期行为。 |

能力接口返回 JSON 且网络检测页能打开后，先确认对应 VPS 的探测器已上线，再运行一轮计划生成第一份报告。
