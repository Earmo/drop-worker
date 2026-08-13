import "dotenv/config";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  UPLOAD_CONCURRENCY,
  UPLOAD_PART_SIZE,
  type DropItem,
  type ExportBundle,
  type ListItemsResponse,
  type UploadPartUrl,
  type UploadSessionResponse,
} from "../packages/contracts";
import { createPasswordHash } from "./local-auth";
import { migrateConfiguredDatabase } from "./migrate-database";
import {
  createPortableBackup,
  migratePortableStorage,
  restorePortableBackup,
} from "./portable-storage";

type PortableManifest = {
  format: "drop-worker-portable-backup";
  version: 1;
  createdAt: string;
  items: Array<DropItem & { backupFile?: string; backupSha256?: string }>;
};

type LocalManifest = {
  format: "drop-worker-backup";
  version: 1;
  createdAt: string;
  databaseSha256: string;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
};

export function parseAdminArguments(argv: string[]): {
  command?: string;
  argument?: string;
  revokeShares: boolean;
} {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  let parseOptions = true;

  for (const value of rest) {
    if (parseOptions && value === "--") {
      parseOptions = false;
    } else if (!parseOptions || !value.startsWith("--")) {
      positional.push(value);
    }
  }

  return {
    command,
    argument: positional[0],
    revokeShares: rest.includes("--revoke-shares"),
  };
}

async function hashFile(path: string): Promise<string> {
  // 使用流式哈希，备份大文件时不会把整个对象一次性读入内存。
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeManifestPath(root: string, path: string): string {
  // 清单中的路径属于不可信输入；恢复前强制限制在备份目录内，阻断 ../ 越界写入。
  const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`备份清单包含越界路径：${path}`);
  }
  return candidate;
}

function remoteHeaders(json = false): Headers {
  // 远程迁移只从环境变量读取认证信息，并统一附加到每个 API 请求，不把凭据写入备份清单。
  const headers = new Headers();
  if (json) headers.set("content-type", "application/json");
  if (process.env.DROP_WORKER_COOKIE) headers.set("cookie", process.env.DROP_WORKER_COOKIE);
  if (process.env.CF_ACCESS_CLIENT_ID) headers.set("cf-access-client-id", process.env.CF_ACCESS_CLIENT_ID);
  if (process.env.CF_ACCESS_CLIENT_SECRET) headers.set("cf-access-client-secret", process.env.CF_ACCESS_CLIENT_SECRET);
  if (process.env.OAI_SITES_AUTHORIZATION) {
    headers.set("oai-sites-authorization", `Bearer ${process.env.OAI_SITES_AUTHORIZATION}`);
  }
  return headers;
}

async function remoteFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = process.env.DROP_WORKER_BASE_URL;
  if (!baseUrl) throw new Error("远程命令缺少 DROP_WORKER_BASE_URL");
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: new Headers({ ...Object.fromEntries(remoteHeaders(Boolean(init?.body))), ...Object.fromEntries(new Headers(init?.headers)) }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`远程请求失败 (${response.status})：${detail.slice(0, 300)}`);
  }
  return response;
}

export async function remoteBackup(destinationArgument?: string): Promise<void> {
  // 远程备份先导出元数据，再逐个下载文件并记录 SHA-256；文本/链接只保留元数据。
  const destination = resolve(destinationArgument || `./backups/portable-${Date.now()}`);
  await mkdir(destination, { recursive: false });
  const filesRoot = resolve(destination, "files");
  await mkdir(filesRoot);
  const bundle = (await (await remoteFetch("/api/export")).json()) as ExportBundle;
  const items: PortableManifest["items"] = [];
  for (const item of bundle.items) {
    if (item.type !== "file") {
      items.push(item);
      continue;
    }
    const backupFile = `files/${item.id}.bin`;
    const response = await remoteFetch(`/api/files/${item.id}`);
    const backupPath = resolve(destination, backupFile);
    await writeFile(backupPath, new Uint8Array(await response.arrayBuffer()));
    items.push({ ...item, backupFile, backupSha256: await hashFile(backupPath) });
  }
  const manifest: PortableManifest = {
    format: "drop-worker-portable-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    items,
  };
  await writeFile(resolve(destination, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`可移植备份已创建：${destination}`);
}

async function uploadRemoteFile(filePath: string, item: PortableManifest["items"][number]): Promise<DropItem> {
  // 恢复文件复用正式分片上传 API，即使目标是 Cloudflare 也不会绕过配额和对象状态机。
  const bytes = new Uint8Array(await readFile(filePath));
  const create = await remoteFetch("/api/uploads", {
    method: "POST",
    body: JSON.stringify({
      fileName: item.originalName || item.displayName || "restored-file",
      mimeType: item.mimeType || "application/octet-stream",
      sizeBytes: bytes.byteLength,
      fingerprint: `restore:${item.id}:${bytes.byteLength}`,
    }),
  });
  let upload = (await create.json()) as UploadSessionResponse;
  const partNumbers = Array.from(
    { length: Math.ceil(bytes.byteLength / UPLOAD_PART_SIZE) },
    (_, index) => index + 1,
  );
  if (upload.uploadMode === "direct") {
    for (let offset = 0; offset < partNumbers.length; offset += UPLOAD_CONCURRENCY) {
      const batch = partNumbers.slice(offset, offset + UPLOAD_CONCURRENCY);
      const urlsResponse = await remoteFetch(`/api/uploads/${upload.id}/part-urls`, {
        method: "POST",
        body: JSON.stringify({ partNumbers: batch }),
      });
      const { urls } = (await urlsResponse.json()) as { urls: UploadPartUrl[] };
      const urlByPart = new Map(urls.map((value) => [value.partNumber, value.url]));
      const parts = await Promise.all(batch.map(async (partNumber) => {
        const start = (partNumber - 1) * UPLOAD_PART_SIZE;
        const part = bytes.slice(start, Math.min(bytes.byteLength, start + UPLOAD_PART_SIZE));
        const url = urlByPart.get(partNumber);
        if (!url) throw new Error("远程实例未返回完整的分片上传地址");
        const response = await fetch(url, { method: "PUT", body: part });
        if (!response.ok) throw new Error(`R2 分片上传失败 (${response.status})`);
        const etag = response.headers.get("etag");
        if (!etag) throw new Error("R2 未返回分片 ETag，请检查存储桶 CORS 配置");
        return { partNumber, etag };
      }));
      const confirm = await remoteFetch(`/api/uploads/${upload.id}/parts/confirm`, {
        method: "POST",
        body: JSON.stringify({ parts }),
      });
      upload = (await confirm.json()) as UploadSessionResponse;
    }
  } else {
    for (const partNumber of partNumbers) {
      const start = (partNumber - 1) * UPLOAD_PART_SIZE;
      const part = bytes.slice(start, Math.min(bytes.byteLength, start + UPLOAD_PART_SIZE));
      const response = await remoteFetch(`/api/uploads/${upload.id}/parts/${partNumber}`, {
        method: "PUT",
        body: part,
        headers: { "content-type": "application/octet-stream", "content-length": String(part.byteLength) },
      });
      upload = (await response.json()) as UploadSessionResponse;
    }
  }
  return (await (await remoteFetch(`/api/uploads/${upload.id}/complete`, { method: "POST", body: "{}" })).json()) as DropItem;
}

export async function remoteRestore(sourceArgument?: string): Promise<void> {
  if (!sourceArgument) throw new Error("remote-restore 需要提供备份目录");
  const source = resolve(sourceArgument);
  const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8")) as PortableManifest;
  if (manifest.format !== "drop-worker-portable-backup" || manifest.version !== 1) {
    throw new Error("可移植备份格式不受支持");
  }
  // 恢复前并行确认目标的活动区和回收站都为空，避免把内容混入已有实例。
  const [active, trash] = await Promise.all([
    remoteFetch("/api/items?limit=1&trash=false").then((response) => response.json() as Promise<ListItemsResponse>),
    remoteFetch("/api/items?limit=1&trash=true").then((response) => response.json() as Promise<ListItemsResponse>),
  ]);
  if (active.items.length || trash.items.length) {
    throw new Error("目标实例不是空实例。为防止覆盖或重复，恢复已停止。");
  }
  for (const item of manifest.items) {
    let created: DropItem;
    if (item.type === "text") {
      created = (await (await remoteFetch("/api/items/text", {
        method: "POST",
        body: JSON.stringify({ content: item.content || "" }),
      })).json()) as DropItem;
    } else if (item.type === "link") {
      created = (await (await remoteFetch("/api/items/link", {
        method: "POST",
        body: JSON.stringify({ url: item.content, title: item.title || undefined }),
      })).json()) as DropItem;
    } else {
      if (!item.backupFile) throw new Error(`文件条目 ${item.id} 缺少备份文件`);
      const backupPath = safeManifestPath(source, item.backupFile);
      // 每个文件恢复前都重新校验大小和摘要，防止备份目录在生成后被篡改。
      if (!item.backupSha256 || (await hashFile(backupPath)) !== item.backupSha256) {
        throw new Error(`文件条目 ${item.id} 完整性校验失败`);
      }
      created = await uploadRemoteFile(backupPath, item);
      if (item.displayName && item.displayName !== created.displayName) {
        created = (await (await remoteFetch(`/api/items/${created.id}`, {
          method: "PATCH",
          body: JSON.stringify({ displayName: item.displayName }),
        })).json()) as DropItem;
      }
    }
    if (item.favorite) {
      await remoteFetch(`/api/items/${created.id}`, {
        method: "PATCH",
        body: JSON.stringify({ favorite: true }),
      });
    }
    if (item.deletedAt) {
      await remoteFetch("/api/items/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [created.id], action: "trash" }),
      });
    }
  }
  console.log(`已恢复 ${manifest.items.length} 项内容。`);
}

async function main(): Promise<void> {
  const { command, argument, revokeShares } = parseAdminArguments(process.argv.slice(2));
  if (command === "hash-password") {
    const password = argument || process.env.DROP_WORKER_PASSWORD;
    if (!password) throw new Error("请把密码作为参数传入，或设置 DROP_WORKER_PASSWORD");
    console.log(createPasswordHash(password));
    return;
  }

  if (command === "remote-backup") {
    await remoteBackup(argument);
    return;
  }

  if (command === "remote-restore") {
    await remoteRestore(argument);
    return;
  }

  if (command === "migrate-database") {
    await migrateConfiguredDatabase();
    return;
  }

  if (command === "storage-backup") {
    const result = await createPortableBackup(argument);
    console.log(`可移植存储备份已创建：${result.destination}`);
    return;
  }

  if (command === "storage-restore") {
    if (!argument) throw new Error("storage-restore 需要提供备份目录");
    await restorePortableBackup(argument, undefined, revokeShares);
    console.log("可移植存储备份已恢复。");
    return;
  }

  if (command === "migrate-storage") {
    const destination = await migratePortableStorage(argument, revokeShares);
    console.log(`存储迁移完成，校验工作目录：${destination}`);
    return;
  }

  const dataRoot = resolve(process.cwd(), process.env.DATA_DIR || "./data");
  const databasePath = resolve(dataRoot, "drop-worker.sqlite");
  if (command === "backup") {
    // 本地备份先 checkpoint WAL，再复制 SQLite 和对象目录，并为每个文件生成清单摘要。
    const destination = resolve(argument || `./backups/drop-worker-${Date.now()}`);
    await mkdir(destination, { recursive: false });
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    await copyFile(databasePath, resolve(destination, "drop-worker.sqlite"));
    await cp(resolve(dataRoot, "objects"), resolve(destination, "objects"), { recursive: true });
    const objectsRoot = resolve(destination, "objects");
    const objectFiles = await readdir(objectsRoot, { recursive: true, withFileTypes: true });
    const files: LocalManifest["files"] = [];
    for (const entry of objectFiles) {
      if (!entry.isFile()) continue;
      const path = resolve(entry.parentPath, entry.name);
      const info = await stat(path);
      files.push({
        path: relative(destination, path).replaceAll("\\", "/"),
        sizeBytes: info.size,
        sha256: await hashFile(path),
      });
    }
    const manifest: LocalManifest = {
      format: "drop-worker-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      databaseSha256: await hashFile(resolve(destination, "drop-worker.sqlite")),
      files,
    };
    await writeFile(
      resolve(destination, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    console.log(`备份已创建：${destination}`);
    return;
  }

  if (command === "restore") {
    if (!argument) throw new Error("restore 需要提供备份目录");
    const source = resolve(argument);
    const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8")) as LocalManifest;
    if (manifest.format !== "drop-worker-backup" || manifest.version !== 1) {
      throw new Error("备份格式不受支持");
    }
    if ((await hashFile(resolve(source, "drop-worker.sqlite"))) !== manifest.databaseSha256) {
      throw new Error("数据库备份完整性校验失败");
    }
    // 先验证清单中所有对象，再检查目标数据库不存在；任何一步失败都不会开始写入恢复数据。
    for (const file of manifest.files) {
      const path = safeManifestPath(source, file.path);
      const info = await stat(path);
      if (info.size !== file.sizeBytes || (await hashFile(path)) !== file.sha256) {
        throw new Error(`备份文件完整性校验失败：${file.path}`);
      }
    }
    await stat(databasePath)
      .then(() => {
        throw new Error(`目标数据已存在：${basename(databasePath)}。为防止覆盖，恢复已停止。`);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes("恢复已停止")) throw error;
      });
    await mkdir(dataRoot, { recursive: true });
    await copyFile(resolve(source, "drop-worker.sqlite"), databasePath);
    await cp(resolve(source, "objects"), resolve(dataRoot, "objects"), { recursive: true });
    console.log(`备份已恢复到：${dataRoot}`);
    return;
  }

  console.log("用法：npm run admin -- <hash-password|migrate-database|storage-backup|storage-restore|migrate-storage|backup|restore|remote-backup|remote-restore> [参数]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
