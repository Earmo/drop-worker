# drop-worker

`drop-worker` 是一个单用户、私有的跨设备投递箱，用于保存文本、链接和文件。它提供最新优先的时间流、搜索和类型筛选、收藏、回收站、存储清理、500 MB 分片上传与断点续传。

应用支持两种正式部署方式：

- Cloudflare：Workers Static Assets + Worker + D1 + R2，使用 Cloudflare Access 或私有 Sites 身份。
- 本地自托管：单个 Node.js 进程 + SQLite + 本地文件系统，可使用 Docker Compose 或直接命令运行。

## 环境要求

- Node.js 24 或更新版本
- npm 11 或 pnpm 10
- Windows 11、Linux x64 与 arm64 均可运行；Docker 镜像跟随 Node 官方多架构镜像。
- Cloudflare 部署需要 Wrangler 4
- Docker 部署需要 Docker Compose 2.24 或更新版本

## 本地直接运行

安装依赖并创建配置：

```powershell
pnpm install
Copy-Item .env.example .env
```

密码模式先生成密码哈希：

```powershell
pnpm admin -- hash-password "一条至少 12 个字符的强密码"
```

把输出写入 `.env` 的 `ADMIN_PASSWORD_HASH`，同时设置 `ADMIN_EMAIL` 和长度至少 32 个字符的 `SESSION_SECRET`。随后构建并启动：

```powershell
pnpm build
pnpm start
```

默认地址为 `http://localhost:3000`。SQLite、文件对象和未完成上传默认保存在 `./data`。

### 邮件验证码模式

将 `.env` 中的 `AUTH_MODE` 改为 `smtp-otp`，并填写：

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER` / `SMTP_PASSWORD`（服务器需要认证时）
- `SMTP_FROM`

验证码 10 分钟有效，登录会话保持 30 天。

### HTTP 与 HTTPS

localhost 可以直接使用 HTTP。局域网中的非 localhost HTTP 地址必须显式设置：

```dotenv
ALLOW_INSECURE_HTTP=true
```

该模式会持续显示安全警告，不能直接暴露到公网。公网或不受信任的局域网应使用 Caddy、Nginx 等反向代理提供 HTTPS，并把 `PUBLIC_URL` 设置为最终 HTTPS 地址。

## Docker Compose

准备 `.env` 后运行：

```powershell
docker compose up -d --build
```

默认映射到主机 `3000` 端口。需要更换主机端口时设置 `HOST_PORT`。应用数据存入命名卷 `drop-worker-data`，容器内进程使用非 root 用户运行。

## Linux systemd

仓库提供 `deploy/drop-worker.service` 示例。将项目安装到 `/opt/drop-worker`，创建专用 `drop-worker` 系统用户，准备 `.env` 并完成生产构建后，再安装和启用该服务。

## 备份与恢复

完整备份和迁移需要一致的只读窗口：先停止应用写入（本地部署建议停止服务或容器），再执行备份；备份结束后才能恢复写入。远程迁移时同样不要在源实例继续投递、编辑或删除内容。

本地完整备份：

```powershell
pnpm admin -- backup ./backups/manual
```

恢复到空数据目录：

```powershell
pnpm admin -- restore ./backups/manual
```

恢复命令默认拒绝覆盖已有数据库。网页中的“导出元数据”会生成 JSON 索引，适合审阅和轻量备份；完整文件备份使用管理命令或 R2 兼容工具。

### Cloudflare 与本地实例迁移

管理 CLI 也可以通过已认证的 HTTP API 创建可移植备份：

```powershell
$env:DROP_WORKER_BASE_URL="https://drop.example.com"
$env:CF_ACCESS_CLIENT_ID="你的 Access 服务令牌 ID"
$env:CF_ACCESS_CLIENT_SECRET="你的 Access 服务令牌 Secret"
pnpm admin -- remote-backup ./backups/cloudflare
```

将 `DROP_WORKER_BASE_URL` 和认证环境变量指向一个空的目标实例后恢复：

```powershell
pnpm admin -- remote-restore ./backups/cloudflare
```

本地密码部署也可以通过 `DROP_WORKER_COOKIE` 提供已登录会话 Cookie。恢复只允许写入空实例，不保留旧条目 ID，也不提供两个运行实例之间的实时同步。

## Cloudflare 直接部署

`wrangler.jsonc` 声明了 D1、R2、静态资源、每小时清理任务和可观测性。首次部署前：

1. 配置 `OWNER_EMAIL`、`CF_ACCESS_TEAM_DOMAIN` 和 `CF_ACCESS_AUD`。
2. 在 Cloudflare Zero Trust 中启用 One-time PIN，并为自己的域名或子域名创建仅允许该个人邮箱访问的 Access 应用。
3. 将 Access 应用的会话时长设置为 30 天，使已验证设备在 30 天内无需再次输入验证码。
4. 在 Worker 的 Custom Domains 中绑定自己的域名或子域名，并确保该主机名同时受上述 Access 应用保护。
5. 生成类型并应用 D1 迁移。
6. 构建并部署 Worker。

```powershell
npm run cf:types
npx wrangler d1 migrations apply drop-worker --remote --config wrangler.jsonc
npm run cf:deploy
```

`CF_ACCESS_TEAM_DOMAIN` 使用完整的团队域名，例如 `https://example.cloudflareaccess.com`。应用会验证 Access JWT 的签发方、Audience 和邮箱；R2 桶保持私有。

仓库中的 GitHub Actions 会在 Pull Request 上执行检查，并在 `main` 更新后自动部署。需要在仓库 Secrets 中设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。生产数据库迁移保持为独立人工步骤，不会在应用启动或每次部署时隐式执行。

## 开发与验证

```powershell
npm run dev
npm run typecheck
npm run lint
npm test
```

开发服务器默认使用本地模拟的 D1/R2，并以固定开发身份进入应用。开发数据不是生产数据。

## 项目结构

- Web PWA：React、Vinext 和 Vite
- API：Hono 与共享 Zod 契约
- Cloudflare 适配：D1、R2、Access/Sites 身份与计划任务
- 本地适配：Node.js、SQLite、本地文件系统、密码或 SMTP 验证码
- 数据迁移：Drizzle SQL 迁移

## 数据与安全边界

- 不提供公开分享、多用户空间或匿名文件访问。
- 不抓取链接元数据，不解析或索引文件内部内容。
- 不记录正文、链接、文件名、密码或验证码到日志。
- 不缓存 API 数据用于离线访问；Service Worker 只缓存应用外壳和静态资源。
- 不提供端到端加密。部署者仍需保护主机、Cloudflare 账号、SMTP 凭据和备份文件。
