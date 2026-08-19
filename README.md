# Drop Worker

Drop Worker 是一个单用户、私有的跨设备投递箱，用于保存文本、链接和文件。它提供可切换最新置顶或置底的时间流、搜索和类型筛选、收藏、临时分享、回收站、存储清理，以及 500MB 文件分片上传与断点续传。

部署、环境变量、存储迁移、备份和发布流水线请阅读 [部署指南](docs/deployment.md)。

## 界面预览

<p align="center">
  <img src="docs/images/drop-worker-login.png" alt="Drop Worker 登录页" width="88%" /><br />
  <img src="docs/images/drop-worker-workspace.png" alt="Drop Worker 时间流工作区" width="88%" /><br />
  <img src="docs/images/drop-worker-cleanup.png" alt="Drop Worker 存储清理" width="88%" />
</p>

## 部署入口

应用支持以下部署方式：

- 本地 Node.js：单个进程，可选择 SQLite/MySQL/PostgreSQL 与本地文件系统/S3 兼容存储。
- Docker Compose：使用本地构建或 Docker Hub 多架构镜像运行。
- Cloudflare Worker：Workers Static Assets + Worker + D1/Hyperdrive + R2/S3 兼容对象存储，可使用 Wrangler 手工发布或仓库专用的 GitHub Actions 自动发布。

GitHub Actions 流水线只服务于 Cloudflare Worker 部署，不负责发布本地 Node.js 或 Docker Compose 实例。请根据运行环境选择 [部署方式](docs/deployment.md#部署方式)，不要混用本地自托管和 Cloudflare 的配置文件。

## 快速开始

开发环境安装依赖并启动：

~~~powershell
npm ci
Copy-Item .env.example .env
npm run dev
~~~

默认开发服务器使用本地模拟的 D1/R2 和固定开发身份，不对应生产数据。生产启动、SMTP、Docker、Cloudflare、备份和迁移统一以 [部署指南](docs/deployment.md) 为准。

## 主要能力

文本和文件条目可以创建公开分享或四位数字口令分享。每个条目最多一个有效链接，有效期可选 1 小时、1 天、7 天或 30 天；进入回收站、到期或手动撤销后立即失效。

图片分享在公开访问或口令验证通过后提供受控预览；SVG 和非图片文件不内联显示，下载始终作为附件并支持 HTTP Range 断点续传。紧急情况下可设置 SHARING_ENABLED=false 暂停全部分享。

## 开发与验证

~~~powershell
npm run dev
npm run typecheck
npm run lint
npm test
~~~

开发数据不是生产数据。提交代码前至少运行 typecheck、lint 和相关单元测试；完整 test 命令还会执行生产构建和渲染检查。

## 项目结构

- app/：React/Vinext 页面、布局和主工作区交互。
- app/client/：浏览器 API 客户端、显示格式和断点上传队列持久化。
- api/：与部署平台无关的 Hono 路由、HTTP 中间件、能力端口和共享上传传输。
- api/stores/：D1、SQLite、MySQL、PostgreSQL、R2、本地文件系统与 S3 适配器。
- packages/contracts/：前后端共享的 Zod 请求、响应和领域契约。
- worker/：Cloudflare Worker 入口；runtime/ 负责存储配置和组合，auth/ 负责邮件认证，storage/ 负责 R2 直传。
- server/：本地 Node.js 与管理命令入口；runtime/ 负责配置和组合，auth/ 负责认证，storage/ 负责数据库迁移和可移植备份。
- db/：SQLite/D1、MySQL 和 PostgreSQL 的方言 Schema。
- drizzle/config/：三种数据库方言的 Drizzle Kit 生成配置。
- drizzle/{sqlite,mysql,postgres}/：按数据库方言归档的正式迁移与 Drizzle 快照。

Node.js 与 Cloudflare 入口各自组装统一的 AppContext。API 只依赖元数据、文件对象、上传传输和认证等能力端口；数据库、文件服务、认证方式和直传能力在启动阶段依据部署配置选择，运行期间不会热切换。

## 数据与安全边界

- 只有显式创建且仍有效的文本/文件分享允许匿名访问；其他内容仍要求所有者身份。
- 不提供多用户空间、集合分享、永久分享、文件公开预览或访客上传。
- 不抓取链接元数据，不解析或索引文件内部内容。
- 不记录正文、链接、文件名、密码或验证码到日志。
- 不缓存 API 数据用于离线访问；Service Worker 只缓存应用外壳和静态资源。
- 不提供端到端加密。部署者仍需保护主机、Cloudflare 账号、SMTP 凭据和备份文件。

## 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。
