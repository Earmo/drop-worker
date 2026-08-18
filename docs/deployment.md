# Drop Worker 部署指南

本文档覆盖生产部署、存储配置、数据库迁移、备份恢复和发布流水线。项目概览、界面预览、开发命令和代码结构请参阅 [README.md](../README.md)。

## 部署方式

| 方式 | 适用场景 | 数据与文件存储 |
| --- | --- | --- |
| 本地 Node.js | 单机或内网自托管 | SQLite/MySQL/PostgreSQL + 本地文件系统/S3 兼容存储 |
| Docker Compose | 隔离运行环境，或使用 Docker Hub 镜像 | 默认 SQLite + 本地文件系统，也可接外部数据库和 S3/MinIO |
| Cloudflare Worker | 使用 Cloudflare 托管公网服务；可手工或自动发布 | D1 或 Hyperdrive + R2/S3 兼容对象存储 |

仓库的 GitHub Actions 发布流程不是独立部署方式，而是专门面向 Cloudflare Worker 的自动化部署入口。它不会部署本地 Node.js 或 Docker Compose 实例，也不是可复用于其他平台的通用发布流水线。

### 通用要求

- Node.js 22.13 或更新版本（生产环境建议使用 Node.js 24）。
- npm 11 或 pnpm 10。
- Windows 11、Linux x64 与 arm64 均可运行；Docker 镜像跟随 Node 官方多架构镜像。
- Cloudflare 部署需要 Wrangler 4。
- Docker 部署需要 Docker Compose 2.24 或更新版本。

## 本地 Node.js

### 安装与启动

在仓库根目录安装依赖并创建配置：

~~~powershell
npm ci
Copy-Item .env.example .env
~~~

密码模式先生成密码哈希：

~~~powershell
npm run admin -- hash-password "一条至少 12 个字符的强密码"
~~~

将输出写入 .env 的 ADMIN_PASSWORD_HASH，同时设置 ADMIN_EMAIL 和长度至少 32 个字符的 SESSION_SECRET。随后构建并启动：

~~~powershell
npm run build
npm start
~~~

默认地址为 http://localhost:3000。SQLite、文件对象和未完成上传默认保存在 ./data。

本地自托管入口是 server/local.ts。默认元数据使用 Node.js 内置 SQLite，文件和上传分片使用 DATA_DIR 下的本地文件系统；也可改用 MySQL/PostgreSQL 与 S3 兼容存储。本模式不读取 wrangler.jsonc，也不需要 Cloudflare 账号与 Wrangler。

### 邮件验证码模式

将 .env 中的 AUTH_MODE 改为 smtp-otp，并填写：

- SMTP_HOST
- SMTP_PORT
- SMTP_SECURE
- SMTP_USERNAME / SMTP_PASSWORD（服务器需要认证时）
- SMTP_FROM
- AUTH_FROM_NAME

验证码 10 分钟有效，登录会话保持 30 天。

### HTTP 与 HTTPS

localhost 可以直接使用 HTTP。局域网中的非 localhost HTTP 地址必须显式设置：

~~~dotenv
ALLOW_INSECURE_HTTP=true
~~~

该模式会持续显示安全警告，不能直接暴露到公网。公网或不受信任的局域网应使用 Caddy、Nginx 等反向代理提供 HTTPS，并把 PUBLIC_URL 设置为最终 HTTPS 地址。

反向代理后的口令限流只会读取显式信任的转发头。按代理地址或 CIDR 配置 TRUST_PROXY，多个值使用逗号分隔；未配置时以直连地址为准。

## Docker Compose

在仓库根目录准备 .env，然后进入部署目录运行：

~~~powershell
Copy-Item .env.example .env
cd deploy
docker compose up -d --build
~~~

已有镜像且不需要重新构建时，可以直接执行 docker compose up -d。默认映射到主机 3000 端口；需要更换主机端口时，在执行 Compose 前设置 shell 环境变量 HOST_PORT。应用数据存入命名卷 drop-worker-data，容器内进程使用非 root 用户运行。

默认 Docker Compose 与直接命令运行使用相同的 SQLite 和本地文件系统适配器，不会使用 Cloudflare D1/R2。

### MySQL、PostgreSQL 与 S3/MinIO

关系型数据库与对象存储可以独立组合：

- DATABASE_DRIVER=sqlite|mysql|postgres；MySQL 要求 8.0+，PostgreSQL 要求 14+，当前不承诺 MariaDB。
- BLOB_DRIVER=local|s3；S3 模式配置 region、私有桶、对象前缀与可选自定义 endpoint。
- 外部数据库使用 DATABASE_URL，应用启动时只校验架构，不自动执行 DDL。首次启动或升级前运行 npm run admin -- migrate-database。
- S3 桶必须预先创建且保持私有。未配置静态密钥时使用 AWS 默认凭据链；MinIO 通常需要 S3_FORCE_PATH_STYLE=true。
- 数据库和 S3 默认要求加密连接。局域网明文连接必须分别显式开启 DATABASE_ALLOW_INSECURE 或 S3_ALLOW_INSECURE。

仓库在 examples/compose/ 提供 PostgreSQL+MinIO 与 MySQL+MinIO 的完整 Compose 示例。自托管当前仍只承诺单个活动应用实例，不代表高可用集群。

### 使用 Docker Hub 镜像

仓库提供 [examples/compose/dockerhub.yaml](../examples/compose/dockerhub.yaml) 示例，可以直接拉取已发布的多架构镜像：

~~~powershell
Copy-Item .env.example .env
docker compose --env-file .env -f examples/compose/dockerhub.yaml pull
docker compose --env-file .env -f examples/compose/dockerhub.yaml up -d
~~~

默认访问地址为 http://localhost:3000。设置 HOST_PORT 可更换主机端口；设置 DROP_WORKER_TAG 可固定镜像版本，例如 DROP_WORKER_TAG=v0.1.0。应用数据保存在 drop-worker-data 命名卷中。

也可直接使用 Docker CLI：

~~~powershell
docker run -d --name drop-worker --restart unless-stopped --env-file .env -e DATA_DIR=/app/data -p 3000:3000 -v drop-worker-data:/app/data earmo/drop-worker:latest
~~~

### 自动发布 Docker 镜像

向 GitHub 仓库推送任意 tag 后，发布 Docker 镜像工作流会自动构建并推送 linux/amd64 和 linux/arm64 多架构镜像到 Docker Hub。每个 tag 会生成同名镜像标签，同时更新 latest 标签。

首次使用前，在仓库 Settings → Secrets and variables → Actions 中配置 Repository variable DOCKERHUB_USERNAME 和 Repository secret DOCKERHUB_TOKEN。推送 v0.1.0 后，镜像地址为 docker.io/<DOCKERHUB_USERNAME>/drop-worker:v0.1.0。

## 备份与恢复

完整备份和迁移需要一致的只读窗口：先停止应用写入（本地部署建议停止服务或容器），再执行备份；备份结束后才能恢复写入。远程迁移时同样不要在源实例继续投递、编辑或删除内容。

### 本地实例

~~~powershell
pnpm admin -- backup ./backups/manual
pnpm admin -- restore ./backups/manual
~~~

恢复命令默认拒绝覆盖已有数据库。网页中的“导出元数据”适合审阅和轻量备份；完整文件备份使用管理命令或 R2 兼容工具。

可移植备份和恢复：

~~~powershell
npm run admin -- storage-backup ./backups/storage
npm run admin -- storage-restore ./backups/storage
~~~

可移植备份包含条目、已完成文件、有效/近期分享及校验清单，不包含登录会话、验证码挑战、限流窗口和未完成上传。归档本身不加密，应写入加密磁盘或由成熟备份工具继续保护。

### 自托管存储迁移

迁移时通过 SOURCE_ 和 TARGET_ 前缀分别提供 DATA_DIR、数据库、对象存储与 SESSION_SECRET 配置，然后运行：

~~~powershell
npm run admin -- migrate-storage ./backups/migration-work
~~~

迁移直接丢弃未完成上传，首次只接受空目标，并校验每个已完成对象的 SHA-256。migration-report.json 会记录丢弃项、multipart 中止结果和最终状态；失败时源数据保持不动，使用同一个工作目录重试会继续同一迁移。源/目标密钥不同会拒绝恢复，可显式传入 --revoke-shares 以撤销全部分享后完成迁移。

### Cloudflare 与本地实例迁移

管理 CLI 可以通过已认证的 HTTP API 创建可移植备份：

~~~powershell
$env:DROP_WORKER_BASE_URL="https://drop.example.com"
pnpm admin -- remote-backup ./backups/cloudflare
pnpm admin -- remote-restore ./backups/cloudflare
~~~

将 DROP_WORKER_BASE_URL 和认证环境变量指向空的目标实例后恢复。本地密码部署也可以通过 DROP_WORKER_COOKIE 提供已登录会话 Cookie。恢复不保留旧条目 ID，也不提供两个运行实例之间的实时同步。

## Cloudflare Worker

Cloudflare 部署使用 Workers Static Assets + Worker，并在数据库和对象存储之间选择一种组合：

- DATABASE_DRIVER=sqlite：Cloudflare D1。
- DATABASE_DRIVER=mysql|postgres：Cloudflare Hyperdrive 连接 MySQL/PostgreSQL。
- BLOB_DRIVER=r2：R2 绑定，生产环境支持浏览器直传。
- BLOB_DRIVER=s3：S3 兼容对象存储，分片经过 Worker 代理。

### 配置 Wrangler

仓库只提交脱敏的 wrangler.example.jsonc。首次部署前复制一份本地配置：

~~~powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
~~~

SQLite 替换 D1_DATABASE_ID；MySQL/PostgreSQL 替换 HYPERDRIVE_CONFIG_ID，并删除未使用的另一类数据库绑定。对象存储默认使用 BLOB_DRIVER=r2 和 FILES 绑定；改为 BLOB_DRIVER=s3 时，删除 r2_buckets，填写与本地服务端相同的 S3_* 配置。

真实 wrangler.jsonc 已被 .gitignore 忽略，不要强制提交；它包含部署资源 ID 和个人邮箱等实例信息。模板只保留可公开的配置结构和占位值。

### 首次部署

1. 配置 OWNER_EMAIL、AUTH_FROM_NAME、SMTP_HOST、SMTP_PORT、SMTP_SECURE、SMTP_FROM 和 SMTP_TIMEOUT_MS。
2. 使用 wrangler secret put SMTP_USERNAME 与 wrangler secret put SMTP_PASSWORD 保存 SMTP 凭据。
3. R2 模式为目标桶创建“对象读写”S3 API Token，并配置 R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_ACCOUNT_ID 与 R2_BUCKET_NAME；S3 模式配置 S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY、S3_REGION、S3_BUCKET 等变量。
4. 使用 wrangler secret put AUTH_SESSION_SECRET 设置至少 32 字节的随机会话密钥。
5. 在 Worker 的 Custom Domains 中绑定域名，并把 PUBLIC_URL 设为最终 HTTPS 地址。
6. 仅 R2 直传模式需要配置桶 CORS；GitHub Actions 会自动生成并应用，S3 模式的分片经过 Worker 代理。
7. 生成类型并应用所选数据库的迁移。D1 使用 Wrangler；MySQL/PostgreSQL 使用管理命令直连数据库迁移。
8. 构建并部署 Worker。

~~~powershell
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
~~~

MySQL/PostgreSQL Worker 部署必须在 Cloudflare 创建对应的 Hyperdrive 配置，并以 HYPERDRIVE 绑定注入。迁移用的 DATABASE_URL 只提供给管理命令或 CI，不写入 Worker 变量。

生产环境上传使用 16 MiB 分片和四路并发。R2 模式下，浏览器通过 15 分钟有效的预签名 URL 直接写入私有桶；生产部署流程会把缺少 R2 S3 API 凭据视为配置错误。通用 S3 模式的分片由 Worker 代理到私有桶，因此必须配置静态 S3 凭据，且不启用 R2 直传与 R2_PUBLIC_URL。

#### 腾讯云 COS S3 兼容配置示例

COS 的 S3_ENDPOINT 使用地域通用域名，桶名单独填写完整的“桶名-AppID”；不要把带桶名的访问域名直接填入 S3_ENDPOINT。

~~~dotenv
BLOB_DRIVER=s3
S3_ENDPOINT=https://cos.ap-hongkong.myqcloud.com
S3_REGION=ap-hongkong
S3_BUCKET=test-hk-1301234567
S3_PREFIX=drop-worker/
S3_FORCE_PATH_STYLE=false
S3_ALLOW_INSECURE=false
~~~

~~~powershell
"你的 COS SecretId" | npx wrangler secret put S3_ACCESS_KEY_ID --config wrangler.jsonc
"你的 COS SecretKey" | npx wrangler secret put S3_SECRET_ACCESS_KEY --config wrangler.jsonc
~~~

可选配置 R2_PUBLIC_URL 为 R2 桶的公开自定义域名。文件下载会先经过应用权限校验，再重定向到该地址；图片预览仍由应用受控返回。任何拿到对象直链的人都可以访问，直到对象被删除或更换对象键。

手工部署时可创建临时 r2-cors.json，并允许 PUBLIC_URL 来源执行 GET、HEAD、PUT，允许 Range，并暴露下载响应头：

~~~json
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
~~~

~~~powershell
npx wrangler r2 bucket cors set drop-worker-files --file r2-cors.json --force
~~~

验证码 10 分钟有效，连续输入错误 5 次后失效，同一邮箱 60 秒内不能重复发送。登录会话通过 HttpOnly、Secure Cookie 保持 30 天；R2 桶保持私有。

### Cloudflare SMTP

Cloudflare Worker 只使用自定义 SMTP。Workers 的 TCP Socket 不允许连接 25 端口，因此 SMTP 使用 465/994（隐式 TLS）或 587（STARTTLS）：

~~~jsonc
{
  "vars": {
    "SMTP_HOST": "smtp.example.com",
    "SMTP_PORT": "587",
    "SMTP_SECURE": "false",
    "SMTP_FROM": "drop-worker@example.com",
    "AUTH_FROM_NAME": "Drop Worker"
  }
}
~~~

然后把凭据写入 Worker Secret：

~~~powershell
"你的 SMTP 用户名" | npx wrangler secret put SMTP_USERNAME
"你的 SMTP 密码" | npx wrangler secret put SMTP_PASSWORD
npm run cf:deploy
~~~

SMTP 用户名和密码不会写入 wrangler.jsonc 或日志；SMTP 端口只支持 465、587 和 994。

### 从本机部署

以下命令虽然从本机执行，但部署目标仍是 Cloudflare Worker，生产数据使用配置中的 D1/Hyperdrive 与 R2/S3：

~~~powershell
npm ci
npm run build
npm run cf:types:check
npm run cf:dry-run
npm run cf:deploy
~~~

cf:dry-run 会构建并检查本机 wrangler.jsonc，但不会上传；cf:deploy 会使用同一份本机配置完成构建和部署。也可以直接执行 npx wrangler deploy --config wrangler.jsonc。

### Cloudflare 专用 GitHub Actions 自动部署

仓库的 [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) 是为 Cloudflare Worker 定制的发布流水线。它生成 Wrangler 生产配置，应用 D1 或外部 MySQL/PostgreSQL 迁移，配置 R2 直传 CORS，并通过 Wrangler 发布 Worker；它不会构建或发布本地 Node.js、Docker Compose 或 Docker Hub 部署。

Pull Request 只使用 `wrangler.example.jsonc` 执行构建、类型检查、Lint 和测试，不会读取生产配置，也不会触发部署。代码 push 到 `main` 后，部署任务才会从 GitHub `production` Environment 读取配置；验证全部通过后生成临时 `wrangler.jsonc`，完成数据库迁移、Worker Secret 同步和 Cloudflare Worker 发布。

在 GitHub 仓库的 `Settings > Environments` 中创建 `production` Environment，并配置以下 Variables：

| Variable | 用途 | 留空时的默认值 |
| --- | --- | --- |
| `WORKER_NAME` | Cloudflare Worker 名称 | `drop-worker` |
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
| `PUBLIC_URL` | 生成分享链接及 R2 CORS 来源的可信 HTTPS 地址 | 必填 |
| `SHARING_ENABLED` | 是否允许创建和访问分享 | `true` |
| `AUTH_FROM_NAME` | 邮件显示的发件人名称 | Worker 名称 |
| `SMTP_PORT` | SMTP 端口，支持 465/994（隐式 TLS）或 587（STARTTLS） | `587` |
| `SMTP_SECURE` | 是否使用隐式 TLS | `false` |
| `SMTP_TIMEOUT_MS` | SMTP 超时毫秒数 | `15000` |

再配置以下 Secrets。GitHub Variables 不是机密存储，个人邮箱、资源 ID、账号凭据和密码必须放在 Secrets：

| Secret | 用途 | 要求 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署、D1 迁移与可选 R2 CORS 配置凭据 | 必填；权限必须覆盖目标 Cloudflare 账号和资源 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID，同时用于 R2 直传配置 | 必填 |
| `D1_DATABASE_ID` | 生产 D1 数据库 UUID | `sqlite` 模式必填 |
| `HYPERDRIVE_ID` | 生产 Hyperdrive 配置 UUID | `mysql`/`postgres` 模式必填 |
| `DATABASE_URL` | CI 执行 MySQL/PostgreSQL 迁移使用的直连 URL | `mysql`/`postgres` 模式必填；不会注入 Worker |
| `OWNER_EMAIL` | 唯一允许登录并接收验证码的邮箱 | 必填 |
| `AUTH_SESSION_SECRET` | 30 天会话签名密钥 | 必填，至少 32 个字符 |
| `R2_ACCESS_KEY_ID` | R2 S3 API Access Key ID | R2 模式必填；只授予目标桶对象读写权限 |
| `R2_SECRET_ACCESS_KEY` | R2 S3 API Secret Access Key | R2 模式必填；保存后不会发送到浏览器 |
| `S3_ACCESS_KEY_ID` | 通用 S3 Access Key ID | S3 模式必填 |
| `S3_SECRET_ACCESS_KEY` | 通用 S3 Secret Access Key | S3 模式必填 |
| `S3_SESSION_TOKEN` | 通用 S3 临时凭据的会话令牌 | 使用临时凭据时必填 |
| `SMTP_HOST` | 自定义 SMTP 服务器 | 必填 |
| `SMTP_FROM` | 自定义 SMTP 实际发件地址 | 必填 |
| `SMTP_USERNAME` | SMTP 用户名 | 必填 |
| `SMTP_PASSWORD` | SMTP 密码 | 必填 |

部署配置由 `scripts/render-wrangler-config.mjs` 校验。缺少所选驱动的 D1/Hyperdrive ID、ID 不是 UUID、SMTP 端口错误或 Secret 未配置时，工作流会明确失败，不会拿脱敏模板部署到生产。

生产数据库迁移是这条 Cloudflare 发布流水线中的独立步骤，不会在应用启动或请求处理中隐式执行。D1 迁移通过 Wrangler 远程执行；MySQL/PostgreSQL 迁移使用 `DATABASE_URL` 直连数据库执行。

## 部署后的安全检查

- 只把公网域名指向 HTTPS，并将 PUBLIC_URL 设置为该地址。
- R2/S3 桶保持私有；只授予应用所需的对象读写权限。
- wrangler.jsonc、.env、数据库 URL、SMTP 凭据和备份归档不要提交到 Git。
- 备份归档本身不加密，应写入加密磁盘或由成熟备份工具继续保护。
- 自托管当前只承诺单个活动应用实例，不代表高可用集群。
