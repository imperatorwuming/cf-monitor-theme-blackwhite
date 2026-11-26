# CF Monitor Blackwhite

Blackwhite 是 [CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的第三方主题，从 [Komari Blackwhite](https://github.com/imperatorwuming/komari-theme-blackwhite) 移植。包含晶透亮色和暗色、卡片和列表、搜索与筛选、收藏和保存视图、资产与续费统计、实例图表、VPS 对比、Blackwhite 工作室，以及可导出的实例报告。

## 安装主题

以 CF-Server-Monitor **2.8.8 Beta2**（`1e4931f`）为适配基线。

```sh
npm ci
npm run package
```

在 CF-Server-Monitor 后台的第三方主题设置中粘贴 **[v1.0.0 主题目录](https://github.com/imperatorwuming/cf-monitor-theme-blackwhite/tree/v1.0.0/dist)**。Worker 通过这个目录读取页面和静态资源。离线部署和自定义分发可在 [GitHub Release](https://github.com/imperatorwuming/cf-monitor-theme-blackwhite/releases/tag/v1.0.0) 下载主题 ZIP 和校验文件。

本地构建需要 Node.js 22.13 或以上版本和 `zip`。构建结果写入 `dist/`，发布 ZIP 写入 `release/`。自行托管主题时，将 `index.html` 和 `assets/` 放入公开 GitHub 目录，在后台填写对应的 `tree/<版本>/dist` 地址。

主页 `/#/`。实例地址 `/#/server/<节点 ID>`，对比地址 `/#/compare`。先到 CF-Server-Monitor 自带后台 `/admin#/admin` 登录，然后在主题打开 **Blackwhite 工作室**（`/#/?view=theme-manage`）。站点设置保存在 CF 的 `theme_options.blackwhite`，默认使用后台站点标题和明暗偏好。工作室的草稿预览用独立的桌面或手机尺寸窗口，兼容 Worker 的嵌入限制。

同域发布沿用 CF 的登录、隐藏节点、私有站点和全局 Turnstile 策略。静态发布可设置 `VITE_CFSM_API_BASE` 或 `<meta name="apiBase" content="https://status.example.com">`。使用跨域站点时，给 Worker 配置 `CORS_ALLOWED_ORIGINS`。多个 API origin 的节点与实时订阅分别处理，第一站负责主题工作室和配套网络观测。私有站点和管理员操作优先使用 Worker 同域发布，以便原生后台会话可用。

## 功能与数据来源

| 功能 | 数据来源 |
| --- | --- |
| 首页、实例和实时图表 | CF 服务器列表、实例详情和 WebSocket。后台标签页暂停连接，达到 Worker 设置的时限后可手动继续。 |
| 负载、Ping、丢包与多 VPS 对比 | CF 历史接口。匿名可读最近 24 小时，登录后最多 168 小时。自定义范围按图表选择精确过滤，结果仍受上游保留窗口和抽样配置限制。 |
| 资产与配额 | CF 账期、续费、到期、配额和月累计计数器。首页流量明细和区间用量由配套服务归档计数器后提供。 |
| 完整实例报告 | 资源、Ping、流量与网络证据。可导出 HTML、打印 PDF，以及下载已保存检测的原图和 ZIP。 |
| 网络观测 | 配套服务与独立探测器提供路由、三网测速、BGP、IP 质量、流媒体及 AI 解锁、TcpQuality、NodeQuality、计划与分享。 |

配套服务部署后会归档 **真实的上下行累计计数器**，保留最近 45 天。CF 自带历史接口没有开放这些字段，归档从启用时开始。资源图继续使用 CF 自带历史，不受归档启用日期影响。

完整网络功能和流量归档的启动方式见 [网络观测部署](network-observatory/README.md)。

## 本地开发与验证

```sh
CFSM_DEV_UPSTREAM=http://127.0.0.1:8787 \
BLACKWHITE_DEV_UPSTREAM=http://127.0.0.1:8788 npm run dev
npm test
npm run lint
npm run test:network-observatory
```

`CFSM_DEV_UPSTREAM` 指向本地 CF Worker，`BLACKWHITE_DEV_UPSTREAM` 指向本地网络观测服务。这两个变量也适用于 `npm run preview`。构建产物仅包含主题 HTML 与资源。

## 来源

主题沿用 Komari Blackwhite 及其网络观测实现。感谢 Blackwhite、LuminaPlus、Lumina 和 CF-Server-Monitor 的贡献者。
