# Drop Worker 备份与恢复指南

本文说明如何选择备份方式、准备环境变量、执行备份、检查产物并恢复数据。部署和运行环境配置见 [部署指南](deployment.md)。

## 快速选择

| 方式 | 适用场景 | 备份命令 | 恢复命令 | 能否续跑 |
| --- | --- | --- | --- | --- |
| 本地原样备份 | 本地 SQLite + 本地文件系统，原机快速灾备 | `npm run admin -- backup <目录>` | `npm run admin -- restore <目录>` | 否 |
| 可移植完整备份（推荐） | 大文件、长期备份、切换数据库或对象存储 | `npm run admin -- storage-backup <目录>` | `npm run admin -- storage-restore <目录>` | 备份和恢复均支持 |
| 远程 API 备份 | Cloudflare 实例，或只能通过 HTTPS 访问的实例 | `npm run admin -- remote-backup <目录>` | `npm run admin -- remote-restore <目录>` | 仅备份支持；恢复失败后需清空目标重来 |

除明确使用本地 SQLite 和本地文件系统的原机灾备外，优先使用可移植完整备份。

## 共通先决条件

执行任何完整备份或恢复前，先确认以下条件：

1. 在宿主机运行管理命令时，使用 Node.js 22.13 或更高版本，并已在仓库目录执行 `npm ci`；Docker 用户可以直接使用运行中的同版本镜像，见 Docker Compose 章节。
2. 备份目录位于容量充足、当前用户可写的位置。所需空间至少接近全部已完成文件的总大小。
3. 备份期间停止源实例写入。不要投递、编辑、删除内容或管理分享；本地部署建议直接停止服务或容器。
4. 恢复使用空目标：目标数据库没有业务数据，对象目录或存储桶前缀也没有对象。
5. 保留原部署的 `SESSION_SECRET`。备份不会复制 `.env`、数据库密码、S3 凭据或 SMTP 凭据。
6. 使用与备份版本兼容的 Drop Worker，通常应使用同版本或更新版本执行恢复。
7. 对 S3 或远程实例备份时，确认网络带宽、对象存储读取费用和本地可用空间满足需要。

可移植备份和远程备份不会生成巨大 ZIP，而是逐文件流式写入目录。所有备份目录都未加密，应存放在加密磁盘、受控共享目录或其他有访问控制的备份介质中。

## 备份目录内容

| 路径 | 用途 | 是否用于恢复 |
| --- | --- | --- |
| `manifest.json` | 机器清单、对象路径和 SHA-256；可能包含内部字段 | 是 |
| `inventory.json` | 人工审阅清单；不包含所有者、对象键、分享口令及其哈希 | 否 |
| `objects/` | `storage-backup` 导出的原始文件对象 | 是 |
| `files/` | `remote-backup` 通过 API 下载的文件 | 是 |
| `drop-worker.sqlite` | 本地原样备份复制的 SQLite 数据库 | 仅 `restore` 使用 |
| `*.partial` | 中断时保留的未完成文件 | 续跑时使用，不要手工改名 |

恢复程序只信任 `manifest.json` 及其中记录的 SHA-256。`inventory.json` 用于查看文本、链接、文件属性和分享摘要，不能单独恢复文件。

## 配置环境变量

管理命令会自动读取仓库根目录的 `.env`。最简单的做法是从示例开始：

```powershell
Copy-Item .env.example .env
```

不要把 `.env` 提交到 Git。临时恢复到另一套存储时，可以在当前 PowerShell 会话中设置 `$env:变量名`；进程环境变量优先于 `.env`。

### 通用变量

| 变量 | 默认值 | 何时需要 | 说明 |
| --- | --- | --- | --- |
| `DATA_DIR` | `./data` | 本地数据库或本地文件存储 | SQLite 位于 `<DATA_DIR>/drop-worker.sqlite`，文件位于 `<DATA_DIR>/objects/` |
| `DATABASE_DRIVER` | `sqlite` | 所有可移植命令 | 可选 `sqlite`、`mysql`、`postgres` |
| `BLOB_DRIVER` | `local` | 所有可移植命令 | 可选 `local`、`s3` |
| `SESSION_SECRET` | 无 | `storage-backup`、`storage-restore`、`migrate-storage` | 至少 32 个字符；用于确认分享加密密钥是否匹配 |

本地 SQLite + 本地文件系统示例：

```powershell
$env:DATA_DIR = "D:\drop-worker\data"
$env:DATABASE_DRIVER = "sqlite"
$env:BLOB_DRIVER = "local"
$env:SESSION_SECRET = "与原部署完全相同且至少32个字符的值"
```

### MySQL 或 PostgreSQL

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 无 | 外部数据库必填；协议必须与驱动匹配，例如 `postgresql://` 或 `mysql://` |
| `DATABASE_POOL_SIZE` | `10` | 连接池大小，范围 1 到 50 |
| `DATABASE_CA_FILE` | 无 | 非本机数据库的自定义 CA 证书文件 |
| `DATABASE_ALLOW_INSECURE` | `false` | 仅在确认风险后设为 `true`，允许非本机数据库不使用 TLS |

PostgreSQL 示例：

```powershell
$env:DATA_DIR = "D:\drop-worker\admin-work"
$env:DATABASE_DRIVER = "postgres"
$env:DATABASE_URL = "postgresql://backup_user:password@db.example.com:5432/drop_worker"
$env:DATABASE_POOL_SIZE = "5"
$env:DATABASE_CA_FILE = "D:\certs\database-ca.pem"
$env:BLOB_DRIVER = "local"
$env:SESSION_SECRET = "与原部署完全相同且至少32个字符的值"
```

`DATABASE_URL` 中的用户名或密码如果包含 `@`、`:`、`/` 等保留字符，必须先进行 URL 编码。证书路径必须能被运行管理命令的主机或容器读取。

恢复到 MySQL 或 PostgreSQL 时，`storage-restore` 会自动执行数据库迁移，但目标数据库必须为空，且账号必须有建表、修改表和写入数据的权限。

### S3 兼容对象存储

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `S3_BUCKET` | 无 | 必填，目标桶名称 |
| `S3_REGION` | 无 | 必填，例如 AWS 的 `ap-southeast-1`；部分兼容服务使用 `auto` |
| `S3_ENDPOINT` | AWS 默认端点 | MinIO、R2 S3 API 等兼容服务填写完整端点 URL |
| `S3_PREFIX` | `drop-worker/` | 对象前缀；恢复目标要求此前缀为空 |
| `S3_FORCE_PATH_STYLE` | `false` | MinIO 等需要路径风格寻址时设为 `true` |
| `S3_ACCESS_KEY_ID` | 默认凭据链 | 使用静态凭据时与 Secret 一起填写 |
| `S3_SECRET_ACCESS_KEY` | 默认凭据链 | 使用静态凭据时与 Access Key 一起填写 |
| `S3_SESSION_TOKEN` | 无 | 临时凭据需要时填写 |
| `S3_ALLOW_INSECURE` | `false` | HTTP 端点必须显式设为 `true`；不要用于公网 |
| `S3_SERVER_SIDE_ENCRYPTION` | 无 | 可选 `AES256` 或 `aws:kms` |
| `S3_KMS_KEY_ID` | 无 | 使用 `aws:kms` 时必填 |

S3 兼容存储示例：

```powershell
$env:BLOB_DRIVER = "s3"
$env:S3_ENDPOINT = "https://s3.example.com"
$env:S3_REGION = "us-east-1"
$env:S3_BUCKET = "drop-worker"
$env:S3_PREFIX = "production/"
$env:S3_ACCESS_KEY_ID = "<access-key>"
$env:S3_SECRET_ACCESS_KEY = "<secret-key>"
```

备份账号至少需要读取和列出源对象；恢复账号需要列出、写入和删除目标前缀中的对象。不要在文档、命令历史或日志中写入真实密钥。

## 本地原样备份

此方式直接复制 SQLite 和本地 `objects/`，适合相同部署布局下的快速灾备。它会保留数据库中的登录会话和内部状态，但不会复制 `.env`。

### 先决条件

- `DATABASE_DRIVER=sqlite` 且 `BLOB_DRIVER=local`。
- 应用已经停止，SQLite WAL 不再产生新写入。
- 备份目标目录尚不存在；该命令不支持覆盖和续跑。
- 恢复目标 `DATA_DIR` 为空，并准备使用原来的 `SESSION_SECRET` 和认证配置。

### 执行备份

```powershell
$env:DATA_DIR = "D:\drop-worker\data"
npm run admin -- backup "D:\backups\drop-worker-manual"
```

命令会先执行 SQLite WAL checkpoint，再生成以下内容：

```text
drop-worker-manual/
  drop-worker.sqlite
  inventory.json
  manifest.json
  objects/
```

### 检查备份

```powershell
$manifest = Get-Content "D:\backups\drop-worker-manual\manifest.json" -Raw | ConvertFrom-Json
$inventory = Get-Content "D:\backups\drop-worker-manual\inventory.json" -Raw | ConvertFrom-Json
$manifest.format
$manifest.files.Count
$inventory.items.Count
```

预期 `manifest.format` 为 `drop-worker-backup`。命令已经为数据库和对象生成 SHA-256，恢复时会重新校验。

### 执行恢复

```powershell
$env:DATA_DIR = "D:\drop-worker\restored-data"
npm run admin -- restore "D:\backups\drop-worker-manual"
```

恢复成功后，使用原来的 `.env` 启动应用并检查 `/health/ready`。如果目标中已经存在 `drop-worker.sqlite`，命令会拒绝覆盖。

## 可移植完整备份（推荐）

此方式从数据库导出条目和分享，并从本地或 S3 逐个读取已完成文件。它不备份登录会话、验证码、限流状态和未完成上传，适合跨数据库或对象存储恢复。

### 先决条件

- 已配置源实例的 `DATA_DIR`、`DATABASE_*`、`BLOB_DRIVER` 和 `S3_*`。
- `SESSION_SECRET` 与源部署完全一致。
- 数据库账号可读取全部业务表，对象存储账号可读取全部已完成对象。
- 备份目录为空，或已经是同一部署此前生成的有效可移植备份目录。

### 执行首次备份

```powershell
npm run admin -- storage-backup "D:\backups\drop-worker-storage"
```

命令会显示准备、校验、传输和收尾进度。成功后目录包含 `manifest.json`、`inventory.json` 和 `objects/`。

### 增量备份与中断续跑

继续使用同一个目录执行相同命令：

```powershell
npm run admin -- storage-backup "D:\backups\drop-worker-storage"
```

- 已完成且 SHA-256 一致的对象会直接复用。
- 未完成对象会从 `.partial` 的已有字节继续读取。
- 新清单完成前保留上一份可用清单。
- 已从源实例删除的旧对象会在新清单提交后清理。
- 同一目录只保留当前快照；需要历史恢复点时使用不同目录。

不要手工修改 `manifest.json`、对象路径或 `.partial` 文件。非空目录如果不包含有效清单会被拒绝。

### 检查备份

```powershell
$manifest = Get-Content "D:\backups\drop-worker-storage\manifest.json" -Raw | ConvertFrom-Json
$inventory = Get-Content "D:\backups\drop-worker-storage\inventory.json" -Raw | ConvertFrom-Json
$manifest.format
$manifest.objects.Count
($manifest.objects | Measure-Object sizeBytes -Sum).Sum
$inventory.items.Count
```

预期 `manifest.format` 为 `drop-worker-portable-storage`。对象摘要保存在 `manifest.objects[].sha256`，恢复开始前会校验全部文件。

### 恢复到空目标

在新的 PowerShell 会话中设置目标配置。下面示例恢复到新的本地目录：

```powershell
$env:DATA_DIR = "D:\drop-worker\restored-data"
$env:DATABASE_DRIVER = "sqlite"
$env:BLOB_DRIVER = "local"
$env:SESSION_SECRET = "与备份源完全相同的值"
npm run admin -- storage-restore "D:\backups\drop-worker-storage"
```

恢复到 PostgreSQL + S3 时，将同一组变量改为目标连接：

```powershell
$env:DATA_DIR = "D:\drop-worker\restore-work"
$env:DATABASE_DRIVER = "postgres"
$env:DATABASE_URL = "postgresql://restore_user:password@db.example.com:5432/drop_worker_new"
$env:BLOB_DRIVER = "s3"
$env:S3_ENDPOINT = "https://s3.example.com"
$env:S3_REGION = "us-east-1"
$env:S3_BUCKET = "drop-worker-restored"
$env:S3_PREFIX = "production/"
$env:S3_ACCESS_KEY_ID = "<access-key>"
$env:S3_SECRET_ACCESS_KEY = "<secret-key>"
$env:SESSION_SECRET = "与备份源完全相同的值"
npm run admin -- storage-restore "D:\backups\drop-worker-storage"
```

恢复中断后，修复网络或存储问题并使用相同备份目录、相同目标配置再次运行。程序会识别相同迁移 ID，并跳过目标端已经校验一致的对象。

如果无法取得原 `SESSION_SECRET`，只能显式撤销所有旧分享后恢复：

```powershell
npm run admin -- storage-restore "D:\backups\drop-worker-storage" --revoke-shares
```

这不会恢复旧分享的可访问状态。不要为了绕过配置错误而使用此选项。

## 远程 API 备份

此方式通过已部署实例的 HTTPS API 下载当前登录用户的文本、链接和文件，适合 Cloudflare 或无法直接访问数据库与对象存储的环境。

### 先决条件

- 源实例可通过 `DROP_WORKER_BASE_URL` 访问。
- 已取得有效登录 Cookie；开发身份模式不需要 Cookie。
- 本地磁盘容量足够保存全部文件。
- 备份期间当前用户不再投递、编辑或删除内容。严格一致性场景还应临时阻止其他入口写入。

### 配置远程认证

1. 在浏览器登录源实例。
2. 在浏览器开发者工具的 Application/Storage → Cookies 中找到 `drop_worker_session`。
3. 只在当前 PowerShell 会话设置地址和完整 Cookie：

```powershell
$env:DROP_WORKER_BASE_URL = "https://drop.example.com"
$env:DROP_WORKER_COOKIE = "drop_worker_session=<cookie-value>"
```

验证认证状态：

```powershell
Invoke-RestMethod `
  -Uri "$env:DROP_WORKER_BASE_URL/api/auth/status" `
  -Headers @{ Cookie = $env:DROP_WORKER_COOKIE }
```

返回结果中的 `authenticated` 应为 `true`。Cookie 等同登录凭据，不要写入 `.env`、脚本、聊天记录或备份目录；完成后执行：

```powershell
Remove-Item Env:DROP_WORKER_COOKIE
```

### 执行备份

```powershell
npm run admin -- remote-backup "D:\backups\drop-worker-remote"
```

命令先获取安全数据清单，再逐文件流式下载到 `files/`。中断后使用同一个目录重试；未完成文件使用 HTTP Range 继续下载，完整文件经 SHA-256 校验后复用。

### 执行恢复

1. 准备内容为空的目标实例并完成登录。
2. 将 `DROP_WORKER_BASE_URL` 和 `DROP_WORKER_COOKIE` 改为目标实例。
3. 确认目标活动区和回收站都为空。
4. 执行：

```powershell
npm run admin -- remote-restore "D:\backups\drop-worker-remote"
```

远程恢复会创建新的条目，因此不保留原条目 ID、原创建时间或原分享。收藏、显示名称和回收站状态会尽量恢复。远程恢复不是事务，也不支持中断后原地续跑；失败后应清空目标内容，再重新执行。

## Docker Compose

Docker 部署执行备份时，需要同时挂载数据卷和一个主机备份目录。先停止应用写入，再用一次性容器运行管理命令：

```powershell
New-Item -ItemType Directory -Force .\backups | Out-Null
docker compose -f deploy/compose.yaml stop drop-worker
docker compose -f deploy/compose.yaml run --rm `
  -v "${PWD}/backups:/app/backups" `
  drop-worker npm run admin -- storage-backup /app/backups/storage
docker compose -f deploy/compose.yaml start drop-worker
```

恢复时应把空数据卷挂载到 `/app/data`，把备份目录只读挂载到 `/app/backups`，并让容器获得目标数据库、S3 和 `SESSION_SECRET` 配置。下面示例先恢复到一个新的验证卷：

```powershell
$image = "earmo/drop-worker:latest"
docker volume create drop-worker-restored-data
docker run --rm --env-file .env `
  -e DATA_DIR=/app/data `
  -v "drop-worker-restored-data:/app/data" `
  -v "${PWD}/backups:/app/backups:ro" `
  $image npm run admin -- storage-restore /app/backups/storage
```

验证恢复结果后，再通过 Compose override 或部署配置让正式服务使用新卷。不要直接恢复到仍被运行中容器使用的数据卷，也不要在没有备份的情况下删除旧卷。

## 直接迁移存储

`migrate-storage` 将可移植备份和恢复串成一个任务，适合在同一管理机上直接迁移自托管存储。它会丢弃未完成上传，并在工作目录生成 `migration-report.json`。

源和目标变量使用 `SOURCE_`、`TARGET_` 前缀；`DATA_DIR`、`BLOB_DRIVER`、`SESSION_SECRET`、全部 `DATABASE_*` 和 `S3_*` 变量都可以加前缀：

```powershell
$env:SOURCE_DATA_DIR = "D:\drop-worker\data"
$env:SOURCE_DATABASE_DRIVER = "sqlite"
$env:SOURCE_BLOB_DRIVER = "local"
$env:SOURCE_SESSION_SECRET = "源部署的 SESSION_SECRET"

$env:TARGET_DATA_DIR = "D:\drop-worker\migrated-data"
$env:TARGET_DATABASE_DRIVER = "sqlite"
$env:TARGET_BLOB_DRIVER = "local"
$env:TARGET_SESSION_SECRET = "源部署的 SESSION_SECRET"

npm run admin -- migrate-storage "D:\backups\migration-work"
```

目标必须为空。失败后使用相同工作目录重试；如果源和目标密钥不同，只能添加 `--revoke-shares` 撤销旧分享。

## 恢复后检查

1. 启动目标实例并确认 `/health/ready` 返回 `ready`。
2. 登录后核对 `inventory.json` 中的条目数量、类型和总大小。
3. 随机下载几个大文件并确认可正常打开。
4. 检查收藏、回收站和分享状态。
5. 对已撤销分享或使用不同 `SESSION_SECRET` 的恢复，确认旧链接不可访问。
6. 完成一次恢复演练后再把备份流程用于唯一的生产副本。

## 常见错误

| 错误或现象 | 原因 | 处理方式 |
| --- | --- | --- |
| `备份目录非空且不包含有效清单` | 目标目录不是此前的同类备份，或清单损坏 | 使用新空目录；不要把不同备份格式混在一起 |
| `SESSION_SECRET 指纹不匹配` | 恢复配置不是源部署的密钥 | 设置正确密钥；确实无法取得时使用 `--revoke-shares` |
| `目标包含其他数据` | 目标数据库、对象目录或 S3 前缀不为空 | 换用全新的数据库和空对象前缀 |
| `完整性校验失败` | 文件缺失、被修改或传输损坏 | 从可信副本重新复制备份；不要跳过校验 |
| 远程请求返回 401 | Cookie 缺失、过期或属于其他实例 | 重新登录并更新 `DROP_WORKER_COOKIE` |
| 数据库连接失败 | URL、TLS、CA 或权限配置错误 | 检查 `DATABASE_URL`、`DATABASE_CA_FILE` 和数据库账号权限 |
| S3 连接失败 | Endpoint、区域、路径风格或凭据错误 | 检查 `S3_ENDPOINT`、`S3_REGION`、`S3_FORCE_PATH_STYLE` 和凭据 |
| 磁盘空间不足 | 备份需要保存全部文件或 `.partial` | 释放空间后使用同一可移植/远程备份目录续跑 |
