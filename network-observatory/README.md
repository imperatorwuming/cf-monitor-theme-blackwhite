# Blackwhite 网络观测

配套服务连接 CF-Server-Monitor，使用同一节点 ID，并验证原生后台会话。服务持久化检测清单、探测器凭证、计划、报告、首页发布范围和累计流量归档。原主题的三网去回程、国际路径和延迟、测速、BGP、IP 质量、流媒体和 AI 解锁、TcpQuality 与 NodeQuality 配置由这项服务运行。

## 启动服务

1. 在 CF-Server-Monitor 后台的安全设置中配置 **App 访问口令**，供网络观测服务定期读取清单和流量计数器。私有站点、隐藏节点或启用了全局 Turnstile 时需要该口令。
2. 在有持久磁盘的服务器上获取本仓库，运行 `npm ci` 和 `npm run package`。
3. 复制 `.env.observatory.example` 到 `.env.observatory`，填写 `CFSM_ORIGIN` 和 `CFSM_APP_PASSWORD`。在 `BLACKWHITE_ALLOWED_ORIGINS` 填写额外允许访问的主题来源。将 `BLACKWHITE_DATA_DIR` 指向持久目录，并为这个目录保留单一运行实例。
4. 运行 `npm run observatory`。用 HTTPS 反代服务，探测器与浏览器通过该地址访问。健康检查为 `/api/blackwhite-network-observatory/health`。

可以同域反代 `/api/blackwhite-network-observatory/*` 到这个服务，其余流量交给 CF Worker。如果使用独立域名，在 CF 后台的自定义 Head 中添加：

```html
<meta name="blackwhiteObservatory" content="https://observatory.example.com">
```

同时在 CF 后台外观设置的 `csp_api` 允许该域名，在服务的 `BLACKWHITE_ALLOWED_ORIGINS` 允许主题页面的 origin。静态主题也可用 `VITE_BLACKWHITE_OBSERVATORY` 在构建时指定服务地址。独立域名下用原生后台保存的 JWT 验证管理员操作。反代同域时请保留 Cookie、Authorization 和 Turnstile 请求头。若使用主题默认汇率查询，给 `csp_api` 添加 `https://api.frankfurter.dev`。

## 接入节点

1. 到 **Blackwhite 工作室 → 网络观测 → 探测器**，选择和 CF 监控对应的节点。创建节点凭证，执行页面生成的命令，在交互提示中输入凭证。安装脚本和校验后的发布包由网络观测服务的 HTTPS 下载端点提供。
2. 在 **测量点和资源** 配置需要的公网端点。CF 公共 API 只显示网络可达性，公网测量目标由管理员填写。根据检测方案选择 IPv4、IPv6、本地探测器或 Globalping 测量点。
3. 建立计划并运行一轮。在 **实例 → 网络检测** 检查队列、结果和报告；需要公开展示时，在工作室逐项选择发布节点。公开摘要依照 CF 的站点可见性和计划的发布范围，具体报告可单独生成限时分享链接。
4. **完整 TcpQuality / NodeQuality** 需要启用完整检测执行器，具体依赖在计划面板列出。现有探测器可用页面生成的升级命令保留凭证。报告采集和外部服务可用性取决于实际网络与测量节点。

探测器支持 Linux systemd 与 OpenRC，常规采集继续使用 CF-Server-Monitor 的原生 Agent。月流量重置的提示直接读取 CF 节点的重置日，并按 UTC 计算。报告状态、凭证和流量数据库都保存在同一个持久目录，迁移服务时请一起备份。
