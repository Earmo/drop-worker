# Drop Worker

Drop Worker 是一个单用户、私有的跨设备投递箱，用于保存文本、链接和文件。
提供最新优先的时间流、搜索和类型筛选、收藏、临时分享、回收站、存储清理、500MB 文件分片上传与断点续传。

## 界面预览

<p align="center">
  <img src="docs/images/drop-worker-login.png" alt="Drop Worker 登录页" width="88%" /><br />
  <img src="docs/images/drop-worker-workspace.png" alt="Drop Worker 时间流工作区" width="88%" /><br />
  <img src="docs/images/drop-worker-cleanup.png" alt="Drop Worker 存储清理" width="88%" />
</p>

应用支持两种正式部署方式：

- Cloudflare：Workers Static Assets + Worker + D1 或 Hyperdrive(MySQL/PostgreSQL) + R2/S3 兼容对象存储，使用自定义 SMTP 邮箱验证码。
- 本地自托管：单个 Node.js 进程，可选择 SQLite/MySQL/PostgreSQL 与本地文件系统/S3 兼容存储。

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

本地自托管入口是 `server/local.ts`。默认元数据使用 Node.js 内置 SQLite，文件和上传分片使用 `DATA_DIR` 下的本地文件系统；也可改用 MySQL/PostgreSQL 与 S3 兼容存储。该模式不读取 `wrangler.jsonc`，也不需要 Cloudflare 账号与 Wrangler。

### 邮件验证码模式

将 `.env` 中的 `AUTH_MODE` 改为 `smtp-otp`，并填写：

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USERNAME` / `SMTP_PASSWORD`（服务器需要认证时）
- `SMTP_FROM`
- `AUTH_FROM_NAME`

验证码 10 分钟有效，登录会话保持 30 天。

### HTTP 与 HTTPS

localhost 可以直接使用 HTTP。局域网中的非 localhost HTTP 地址必须显式设置：

```dotenv
ALLOW_INSECURE_HTTP=true
```

该模式会持续显示安全警告，不能直接暴露到公网。公网或不受信任的局域网应使用 Caddy、Nginx 等反向代理提供 HTTPS，并把 `PUBLIC_URL` 设置为最终 HTTPS 地址。

反向代理后的口令限流只会读取显式信任的转发头。按代理地址或 CIDR 配置 `TRUST_PROXY`，多个值使用逗号分隔；未配置时以直连地址为准。

## 临时分享

文本和文件条目可以创建公开分享或四位数字口令分享。每个条目最多一个有效链接，有效期可选 1 小时、1 天、7 天或 30 天；进入回收站、到期或手动撤销后立即失效。分享管理页会持续显示有效分享入口和四位口令并支持分别复制；受保护链接创建时会把口令放在 URL Fragment 中用于预填，访问者仍须点击确认。升级前创建的历史分享无法恢复原口令，需要重新创建后才会显示。

图片分享在公开访问或口令验证通过后提供受控预览；SVG 和非图片文件不内联显示，下载仍始终作为附件并支持 HTTP Range 断点续传。分享管理视图只保留聚合访问/下载统计，不保存访客原始 IP 或逐次访问日志。紧急情况下可设置 `SHARING_ENABLED=false` 暂停全部分享。

## Docker Compose

在仓库根目录准备 `.env`，然后进入部署目录运行：

```powershell
cd deploy
docker compose up -d --build
```

已有镜像且不需要重新构建时，可以直接执行 `docker compose up -d`。默认映射到主机 `3000` 端口；需要更换主机端口时，在执行 Compose 前设置 shell 环境变量 `HOST_PORT`。应用数据存入命名卷 `drop-worker-data`，容器内进程使用非 root 用户运行。

默认 Docker Compose 与直接命令运行使用相同的 SQLite 和本地文件系统适配器，不会使用 Cloudflare D1/R2。

### MySQL、PostgreSQL 与 S3/MinIO

关系型数据库与对象存储可以独立组合：

- `DATABASE_DRIVER=sqlite|mysql|postgres`；MySQL 要求 8.0+，PostgreSQL 要求 14+，当前不承诺 MariaDB。
- `BLOB_DRIVER=local|s3`；S3 模式配置 region、私有桶、对象前缀与可选自定义 endpoint。
- 外部数据库使用 `DATABASE_URL`，应用启动时只校验架构，不自动执行 DDL。首次启动或升级前运行 `npm run admin -- migrate-database`。
- S3 桶必须预先创建且保持私有。未配置静态密钥时使用 AWS 默认凭据链；MinIO 通常需要 `S3_FORCE_PATH_STYLE=true`。
- 数据库和 S3 默认要求加密连接。局域网明文连接必须分别显式开启 `DATABASE_ALLOW_INSECURE` 或 `S3_ALLOW_INSECURE`。

仓库在 `examples/compose/` 提供 PostgreSQL+MinIO 与 MySQL+MinIO 的完整 Compose 示例。自托管当前仍只承诺单个活动应用实例，不代表高可用集群。

### 使用 Docker Hub 镜像

也可以直接拉取已发布的多架构镜像，不需要在本地构建。仓库提供了
[`examples/compose/dockerhub.yaml`](examples/compose/dockerhub.yaml) 示例：

```powershell
Copy-Item .env.example .env
docker compose --env-file .env -f examples/compose/dockerhub.yaml pull
docker compose --env-file .env -f examples/compose/dockerhub.yaml up -d
```

默认访问地址为 `http://localhost:3000`。如需更换主机端口，设置 `HOST_PORT`；如需固定镜像版本，设置 `DROP_WORKER_TAG`，例如 `DROP_WORKER_TAG=v0.1.0`。应用数据保存在 `drop-worker-data` 命名卷中。

仍可直接使用 Docker CLI 运行镜像：

```powershell
docker run -d --name drop-worker --restart unless-stopped --env-file .env -e DATA_DIR=/app/data -p 3000:3000 -v drop-worker-data:/app/data earmo/drop-worker:latest
```

### 自动发布 Docker 镜像

向 GitHub 仓库推送任意 tag 后，`发布 Docker 镜像` 工作流会自动构建并推送多架构镜像（`linux/amd64` 和 `linux/arm64`）到 Docker Hub。每个 tag 会生成同名镜像标签，同时更新 `latest` 标签。

首次使用前，在仓库的 Settings → Secrets and variables → Actions 中配置：

- Repository variable：`DOCKERHUB_USERNAME`，Docker Hub 用户名或组织名。
- Repository secret：`DOCKERHUB_TOKEN`，具有推送权限的 Docker Hub Access Token。

例如推送 `v0.1.0` 后，镜像地址为 `docker.io/<DOCKERHUB_USERNAME>/drop-worker:v0.1.0`。

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

任意自托管存储组合使用可移植备份：

```powershell
npm run admin -- storage-backup ./backups/storage
npm run admin -- storage-restore ./backups/storage
```

可移植备份包含条目、已完成文件、有效/近期分享及校验清单，不包含登录会话、验证码挑战、限流窗口和未完成上传。归档本身不加密，应写入加密磁盘或由成熟备份工具继续保护。

### 自托管存储迁移

迁移时通过 `SOURCE_` 和 `TARGET_` 前缀分别提供 `DATA_DIR`、数据库、对象存储与 `SESSION_SECRET` 配置，然后运行：

```powershell
npm run admin -- migrate-storage ./backups/migration-work
```

迁移直接丢弃未完成上传，首次只接受空目标，并校验每个已完成对象的 SHA-256。工作目录中的 `migration-report.json` 会记录丢弃项、multipart 中止结果和最终状态；失败时源数据保持不动，使用同一个工作目录重试会继续同一迁移。源/目标密钥不同会拒绝恢复，可显式传入 `--revoke-shares`，以撤销全部分享后完成迁移。

### Cloudflare 与本地实例迁移

管理 CLI 也可以通过已认证的 HTTP API 创建可移植备份：

```powershell
$env:DROP_WORKER_BASE_URL="https://drop.example.com"
pnpm admin -- remote-backup ./backups/cloudflare
```

将 `DROP_WORKER_BASE_URL` 和认证环境变量指向一个空的目标实例后恢复：

```powershell
pnpm admin -- remote-restore ./backups/cloudflare
```

本地密码部署也可以通过 `DROP_WORKER_COOKIE` 提供已登录会话 Cookie。恢复只允许写入空实例，不保留旧条目 ID，也不提供两个运行实例之间的实时同步。

## Cloudflare 直接部署

仓库只提交脱敏的 `wrangler.example.jsonc`。首次部署前先复制一份本地配置：

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

模板中的 JSONC 中文注释会逐项说明 Worker 入口、静态资源、D1/Hyperdrive、R2/S3、SMTP、变量、定时任务和可观测性配置。

然后选择 `DATABASE_DRIVER=sqlite|mysql|postgres`。SQLite 替换 `<D1_DATABASE_ID>`；MySQL/PostgreSQL 则替换 `<HYPERDRIVE_CONFIG_ID>`，并可删除未使用的另一类数据库绑定。对象存储默认使用 `BLOB_DRIVER=r2` 和 `FILES` 绑定；改为 `BLOB_DRIVER=s3` 时，删除 `r2_buckets`，填写与本地服务端相同的 `S3_*` 配置。真实的 `wrangler.jsonc` 已被 `.gitignore` 忽略，不要强制提交它；它包含部署资源 ID 和个人邮箱等实例信息。`wrangler.example.jsonc` 只保留可公开的配置结构和占位值。

`wrangler.jsonc` 声明了所选数据库绑定、对象存储、静态资源、每小时清理任务和可观测性。首次部署前：

1. 配置 `OWNER_EMAIL`、`AUTH_FROM_NAME`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_FROM` 和 `SMTP_TIMEOUT_MS`。
2. 使用 `wrangler secret put SMTP_USERNAME` 与 `wrangler secret put SMTP_PASSWORD` 保存 SMTP 凭据。
3. R2 模式为目标桶创建“对象读写”S3 API Token，并配置 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ACCOUNT_ID` 与 `R2_BUCKET_NAME`；S3 模式则配置 `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 以及 `S3_REGION`、`S3_BUCKET` 等变量。
4. 使用 `wrangler secret put AUTH_SESSION_SECRET` 设置至少 32 字节的随机会话密钥。
5. 在 Worker 的 Custom Domains 中绑定自己的域名或子域名，并把 `PUBLIC_URL` 设为该 HTTPS 地址。
6. 仅 R2 直传模式需要为桶配置 CORS：允许 `PUBLIC_URL` 来源执行 `GET`、`HEAD`、`PUT`，允许 `Range`，并暴露下载响应头。GitHub Actions 会自动生成并应用该配置；S3 模式的分片经过 Worker 代理，不需要浏览器访问桶。
7. 生成类型并应用所选数据库的迁移。D1 使用 Wrangler；MySQL/PostgreSQL 使用现有管理命令直连数据库迁移。
8. 构建并部署 Worker。

```powershell
"你的 R2 Access Key ID" | npx wrangler secret put R2_ACCESS_KEY_ID --config wrangler.jsonc
"你的 R2 Secret Access Key" | npx wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.jsonc
# BLOB_DRIVER=s3 时改为：
"你的 S3 Access Key ID" | npx wrangler secret put S3_ACCESS_KEY_ID --config wrangler.jsonc
"你的 S3 Secret Access Key" | npx wrangler secret put S3_SECRET_ACCESS_KEY --config wrangler.jsonc
# 使用临时凭据时还需执行：
"你的 S3 Session Token" | npx wrangler secret put S3_SESSION_TOKEN --config wrangler.jsonc
npm run cf:types
# DATABASE_DRIVER=sqlite
npx wrangler d1 migrations apply drop-worker --remote --config wrangler.jsonc
# DATABASE_DRIVER=mysql|postgres（在当前 shell 配置 DATABASE_DRIVER 和 DATABASE_URL）
npm run admin -- migrate-database
npm run cf:deploy
```

MySQL/PostgreSQL Worker 部署必须在 Cloudflare 创建对应的 Hyperdrive 配置，并以 `HYPERDRIVE` 绑定注入。应用使用绑定内的临时连接信息：PostgreSQL 通过 `pg`，MySQL 通过启用 `disableEval` 的 `mysql2` 连接。每个 API/Cron 任务创建并关闭一个客户端，实际连接池由 Hyperdrive 管理。数据库版本要求与自托管一致，迁移用的 `DATABASE_URL` 只提供给管理命令或 CI，不写入 Worker 变量。

生产环境上传使用 16 MiB 分片和四路并发。R2 模式下，浏览器通过 15 分钟有效的预签名 URL 直接写入私有桶；未配置 R2 S3 API 凭据时会回退到 Worker 代理上传，便于本地开发，但生产部署流程会把缺少凭据视为配置错误。通用 S3 模式与 Node.js 服务端共用 AWS SDK v3 adapter，分片由 Worker 代理到私有桶，因此必须配置静态 S3 凭据，且不启用 R2 直传与 `R2_PUBLIC_URL`。

#### 腾讯云 COS S3 兼容配置示例

以下配置已使用香港地域 COS 桶完成连接、列举和 multipart 健康检查。COS 的 `S3_ENDPOINT` 使用地域通用域名，桶名单独填写完整的“桶名-AppID”；不要把带桶名的访问域名直接填入 `S3_ENDPOINT`。

```dotenv
BLOB_DRIVER=s3
S3_ENDPOINT=https://cos.ap-hongkong.myqcloud.com
S3_REGION=ap-hongkong
S3_BUCKET=test-hk-1301234567
S3_PREFIX=drop-worker/
S3_FORCE_PATH_STYLE=false
S3_ALLOW_INSECURE=false
```

凭据通过 Secret 注入：

```powershell
"你的 COS SecretId" | npx wrangler secret put S3_ACCESS_KEY_ID --config wrangler.jsonc
"你的 COS SecretKey" | npx wrangler secret put S3_SECRET_ACCESS_KEY --config wrangler.jsonc
# 使用临时密钥时再设置 S3_SESSION_TOKEN
```

可选配置 `R2_PUBLIC_URL` 为 R2 桶的公开自定义域名，例如 `https://drop-files.example.com`。配置后，文件下载会先经过应用的登录或分享权限校验，再重定向到 R2 自定义域名；图片预览仍由应用受控返回。该模式不会对最终 R2 地址继续鉴权，任何拿到对象直链的人都可以访问，直到对象被删除或更换对象键。

手工部署时可创建临时 `r2-cors.json` 并应用：

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://drop.example.com"],
        "methods": ["GET", "HEAD", "PUT"],
        "headers": ["content-type", "range"]
      },
      "exposeHeaders": ["accept-ranges", "content-disposition", "content-length", "content-range", "etag"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

```powershell
npx wrangler r2 bucket cors set drop-worker-files --file r2-cors.json --force
```

验证码 10 分钟有效，连续输入错误 5 次后失效，同一邮箱 60 秒内不能重复发送。登录会话通过 HttpOnly、Secure Cookie 保持 30 天；R2 桶保持私有。

### Cloudflare SMTP

Cloudflare Worker 只使用自定义 SMTP。Workers 的 TCP Socket 不允许连接 25 端口，因此 SMTP 使用 465/994（隐式 TLS）或 587（STARTTLS）：

```jsonc
{
  "vars": {
    "SMTP_HOST": "smtp.example.com",
    "SMTP_PORT": "587",
    "SMTP_SECURE": "false",
    "SMTP_FROM": "drop-worker@example.com",
    "AUTH_FROM_NAME": "Drop Worker"
  }
}
```

然后把凭据写入 Worker Secret：

```powershell
"你的 SMTP 用户名" | npx wrangler secret put SMTP_USERNAME
"你的 SMTP 密码" | npx wrangler secret put SMTP_PASSWORD
npm run cf:deploy
```

SMTP 用户名和密码不会写入 `wrangler.jsonc` 或日志。`SMTP_FROM` 是实际发件地址，`AUTH_FROM_NAME` 是显示名称；SMTP 端口只支持 465、587 和 994。Worker 的 SMTP 连接由独立适配器处理，认证流程与本地 Node.js 运行时共用。

### 从本机部署 Cloudflare Worker

以下命令虽然从本机执行，但部署目标仍是 Cloudflare Worker，因此生产数据使用配置中的 D1/Hyperdrive 与 R2/S3；它们不属于前文的本地自托管。GitHub Actions 自动部署是额外入口，不替代这些 Wrangler 命令。仓库根目录中保留自己的、已被 Git 忽略的 `wrangler.jsonc` 后，可直接运行：

```powershell
npm ci
npm run build
npm run cf:types:check
npm run cf:dry-run
npm run cf:deploy
```

`cf:dry-run` 会构建并检查本机 `wrangler.jsonc`，但不会上传；`cf:deploy` 会使用同一份本机配置完成构建和部署。也可以直接执行 `npx wrangler deploy --config wrangler.jsonc`。`scripts/render-wrangler-config.mjs` 只供 GitHub Actions 生成临时生产配置，不参与本地部署命令。

### GitHub Actions 自动部署

Pull Request 只使用 `wrangler.example.jsonc` 执行验证，不会读取生产配置。代码 push 到 `main` 后会先完成类型检查、Lint、测试和生产构建；全部通过后，部署任务会从 GitHub `production` Environment 读取配置，生成临时 `wrangler.jsonc`，先按驱动应用 D1 或外部数据库迁移，再同步 Worker Secret 并部署新版 Worker。迁移失败会阻断发布，真实配置不会进入仓库。

在 GitHub 仓库的 `Settings > Environments` 中创建 `production` Environment，并配置以下 Variables：

| Variable | 用途 | 留空时的默认值 |
| --- | --- | --- |
| `WORKER_NAME` | Worker 名称 | `drop-worker` |
| `DATABASE_DRIVER` | Worker 元数据驱动：`sqlite`、`mysql` 或 `postgres` | `sqlite` |
| `BLOB_DRIVER` | Worker 对象存储驱动：`r2` 或 `s3` | `r2` |
| `D1_DATABASE_NAME` | SQLite 模式的 D1 数据库名称 | 与 Worker 名称相同 |
| `R2_BUCKET_NAME` | R2 桶名称 | `<WORKER_NAME>-files` |
| `R2_PUBLIC_URL` | 可选的公开 R2 自定义下载域名 | 空，继续由 Worker 返回文件 |
| `S3_ENDPOINT` | S3 兼容服务 endpoint；AWS S3 可留空 | 空 |
| `S3_REGION` | S3 region | `us-east-1` |
| `S3_BUCKET` | S3 私有桶名称 | S3 模式必填 |
| `S3_PREFIX` | 桶内对象前缀 | `drop-worker/` |
| `S3_FORCE_PATH_STYLE` | 是否强制 path-style 地址 | `false` |
| `S3_ALLOW_INSECURE` | 是否显式允许 HTTP endpoint | `false` |
| `S3_SERVER_SIDE_ENCRYPTION` | 留空、`AES256` 或 `aws:kms` | 空 |
| `S3_KMS_KEY_ID` | KMS 密钥 ID | `aws:kms` 时必填 |
| `MAX_STORAGE_BYTES` | 最大存储字节数 | `10737418240` |
| `PUBLIC_URL` | 生成分享链接的可信 HTTPS 地址 | 必填 |
| `SHARING_ENABLED` | 是否允许创建和访问分享 | `true` |
| `AUTH_FROM_NAME` | 邮件显示的发件人名称 | Worker 名称 |
| `SMTP_PORT` | SMTP 端口，支持 465/994（隐式 TLS）或 587（STARTTLS） | `587` |
| `SMTP_SECURE` | 是否使用隐式 TLS | `false` |
| `SMTP_TIMEOUT_MS` | SMTP 超时毫秒数 | `15000` |

再配置以下 Secrets。GitHub Variables 不是机密存储，个人邮箱、资源 ID、账号凭据和密码应放在 Secrets：

| Secret | 用途 | 要求 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署、D1 迁移与可选 R2 CORS 配置凭据 | 必填；R2 模式还需相应 R2 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | 必填 |
| `D1_DATABASE_ID` | 生产 D1 数据库 UUID | `sqlite` 模式必填 |
| `HYPERDRIVE_ID` | 生产 Hyperdrive 配置 UUID | `mysql`/`postgres` 模式必填 |
| `DATABASE_URL` | CI 执行 MySQL/PostgreSQL 迁移使用的直连 URL | `mysql`/`postgres` 模式必填；不会注入 Worker |
| `OWNER_EMAIL` | 唯一允许登录并接收验证码的邮箱 | 必填 |
| `AUTH_SESSION_SECRET` | 30 天会话签名密钥 | 必填，至少 32 字节随机值 |
| `R2_ACCESS_KEY_ID` | R2 S3 API Access Key ID | R2 模式必填；只授予目标桶对象读写权限 |
| `R2_SECRET_ACCESS_KEY` | R2 S3 API Secret Access Key | R2 模式必填；保存后不会发送到浏览器 |
| `S3_ACCESS_KEY_ID` | 通用 S3 Access Key ID | S3 模式必填 |
| `S3_SECRET_ACCESS_KEY` | 通用 S3 Secret Access Key | S3 模式必填 |
| `S3_SESSION_TOKEN` | 通用 S3 临时凭据的会话令牌 | 使用临时凭据时必填 |
| `SMTP_HOST` | 自定义 SMTP 服务器 | 必填 |
| `SMTP_FROM` | 自定义 SMTP 实际发件地址 | 必填 |
| `SMTP_USERNAME` | SMTP 用户名 | SMTP 模式必填 |
| `SMTP_PASSWORD` | SMTP 密码 | SMTP 模式必填 |

部署配置由 `scripts/render-wrangler-config.mjs` 校验。缺少所选驱动的 D1/Hyperdrive ID、ID 不是 UUID、SMTP 端口错误或 Secret 未配置时，工作流会明确失败，不会拿脱敏模板部署到生产。

生产数据库迁移保持为独立发布步骤，不会在应用启动或请求处理中隐式执行。

## 开发与验证

```powershell
npm run dev
npm run typecheck
npm run lint
npm test
```

开发服务器默认使用本地模拟的 D1/R2，并以固定开发身份进入应用。开发数据不是生产数据。

## 项目结构

- `app/`：React/Vinext 页面、布局和主工作区交互。
- `app/client/`：浏览器 API 客户端、显示格式和断点上传队列持久化。
- `api/`：与部署平台无关的 Hono 路由、HTTP 中间件、能力端口和共享上传传输。
- `api/stores/`：D1、SQLite、MySQL、PostgreSQL、R2、本地文件系统与 S3 适配器。
- `packages/contracts/`：前后端共享的 Zod 请求、响应和领域契约。
- `worker/`：Cloudflare Worker 入口；`runtime/` 负责 R2/S3 配置和组合，`auth/` 负责邮件认证，`storage/` 负责 R2 直传，`types/` 保存环境声明和 Wrangler 生成类型。
- `server/`：本地 Node.js 与管理命令入口；`runtime/` 负责配置和组合，`auth/` 负责认证，`storage/` 负责数据库迁移和可移植备份。
- `db/`：SQLite/D1、MySQL 和 PostgreSQL 的方言 Schema。
- `drizzle/config/`：三种数据库方言的 Drizzle Kit 生成配置。
- `drizzle/{sqlite,mysql,postgres}/`：按数据库方言归档的正式迁移与 Drizzle 快照。

Node.js 与 Cloudflare 入口各自组装统一的 `AppContext`。API 只依赖元数据、文件对象、上传传输和认证等能力端口；数据库、文件服务、认证方式和直传能力在启动阶段依据部署配置选择，运行期间不会热切换。

## 数据与安全边界

- 只有显式创建且仍有效的文本/文件分享允许匿名访问；其他内容仍要求所有者身份。
- 不提供多用户空间、集合分享、永久分享、文件公开预览或访客上传。
- 不抓取链接元数据，不解析或索引文件内部内容。
- 不记录正文、链接、文件名、密码或验证码到日志。
- 不缓存 API 数据用于离线访问；Service Worker 只缓存应用外壳和静态资源。
- 不提供端到端加密。部署者仍需保护主机、Cloudflare 账号、SMTP 凭据和备份文件。

## 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。
