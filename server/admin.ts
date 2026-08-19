import "dotenv/config";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createExportBundle } from "../api/items/export";
import { openLocalMetadataStore } from "../api/stores/local";
import {
  UPLOAD_CONCURRENCY,
  UPLOAD_PART_SIZE,
  type DropItem,
  type ExportBundle,
  type ListItemsResponse,
  type UploadPartUrl,
  type UploadSessionResponse,
} from "../packages/contracts";
import { createPasswordHash } from "./auth/local-auth";
import { migrateConfiguredDatabase } from "./storage/migrate-database";
import {
  createPortableBackup,
  migratePortableStorage,
  restorePortableBackup,
  type PortableStorageProgress,
} from "./storage/portable-storage";

type PortableManifest = {
  format: "drop-worker-portable-backup";
  version: 1 | 2;
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

async function hashFile(path: string, onBytes?: (completedBytes: number) => void): Promise<string> {
  // 使用流式哈希，备份大文件时不会把整个对象一次性读入内存。
  const hash = createHash("sha256");
  let completedBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    completedBytes += chunk.length;
    onBytes?.(completedBytes);
  }
  return hash.digest("hex");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function createProgressReporter(): {
  onProgress(progress: PortableStorageProgress): void;
  end(): void;
} {
  const phaseLabels: Record<PortableStorageProgress["phase"], string> = {
    preparing: "准备",
    verifying: "校验",
    transferring: "传输",
    finalizing: "收尾",
  };
  let lastPhase: PortableStorageProgress["phase"] | null = null;
  let lastOutputAt = 0;
  let lineOpen = false;
  return {
    onProgress(progress) {
      const now = Date.now();
      const completed = progress.completedObjects === progress.totalObjects;
      const minimumInterval = process.stderr.isTTY ? 100 : 2_000;
      if (progress.phase === lastPhase && !completed && now - lastOutputAt < minimumInterval) return;
      const percent = progress.totalBytes > 0
        ? Math.min(100, Math.floor(progress.completedBytes / progress.totalBytes * 100))
        : 100;
      const reused = progress.reusedObjects > 0 ? `，复用 ${progress.reusedObjects}` : "";
      const line = `${phaseLabels[progress.phase]}：${progress.completedObjects}/${progress.totalObjects} 个对象，`
        + `${formatBytes(progress.completedBytes)}/${formatBytes(progress.totalBytes)} (${percent}%)${reused}`;
      if (process.stderr.isTTY) {
        process.stderr.write(`\r\u001b[2K${line}`);
        lineOpen = true;
      } else {
        process.stderr.write(`${line}\n`);
      }
      lastPhase = progress.phase;
      lastOutputAt = now;
    },
    end() {
      if (lineOpen) process.stderr.write("\n");
      lineOpen = false;
    },
  };
}

function safeManifestPath(root: string, path: string): string {
  // 清单中的路径属于不可信输入；恢复前强制限制在备份目录内，阻断 ../ 越界写入。
  const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`备份清单包含越界路径：${path}`);
  }
  return candidate;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readPortableManifest(path: string, tolerateInvalid = false): Promise<PortableManifest | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as PortableManifest;
    if (
      value.format !== "drop-worker-portable-backup" ||
      (value.version !== 1 && value.version !== 2) ||
      !Array.isArray(value.items)
    ) {
      throw new Error("远程备份格式不受支持");
    }
    return value;
  } catch (error) {
    if (isMissingFile(error) || tolerateInvalid) return null;
    throw error;
  }
}

async function writePortablePartial(destination: string, manifest: PortableManifest): Promise<void> {
  const currentPath = resolve(destination, "manifest.partial.json");
  const nextPath = resolve(destination, "manifest.partial.next.json");
  const previousPath = resolve(destination, "manifest.partial.previous.json");
  await writeFile(nextPath, JSON.stringify(manifest, null, 2), "utf8");
  await rm(previousPath, { force: true });
  let movedCurrent = false;
  try {
    await rename(currentPath, previousPath);
    movedCurrent = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  try {
    await rename(nextPath, currentPath);
  } catch (error) {
    if (movedCurrent) await rename(previousPath, currentPath).catch(() => undefined);
    throw error;
  }
  await rm(previousPath, { force: true });
}

async function commitPortableManifest(destination: string, manifest: PortableManifest): Promise<void> {
  const currentPath = resolve(destination, "manifest.json");
  const nextPath = resolve(destination, "manifest.next.json");
  const previousPath = resolve(destination, "manifest.previous.json");
  await writeFile(nextPath, JSON.stringify(manifest, null, 2), "utf8");
  await rm(previousPath, { force: true });
  let movedCurrent = false;
  try {
    await rename(currentPath, previousPath);
    movedCurrent = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  try {
    await rename(nextPath, currentPath);
  } catch (error) {
    if (movedCurrent) await rename(previousPath, currentPath).catch(() => undefined);
    throw error;
  }
  await rm(previousPath, { force: true });
  await Promise.all([
    "manifest.partial.json",
    "manifest.partial.next.json",
    "manifest.partial.previous.json",
  ].map((name) => rm(resolve(destination, name), { force: true })));
}

async function commitPortableInventory(destination: string, inventory: ExportBundle): Promise<void> {
  const currentPath = resolve(destination, "inventory.json");
  const nextPath = resolve(destination, "inventory.next.json");
  const previousPath = resolve(destination, "inventory.previous.json");
  await writeFile(nextPath, JSON.stringify(inventory, null, 2), "utf8");
  await rm(previousPath, { force: true });
  let movedCurrent = false;
  try {
    await rename(currentPath, previousPath);
    movedCurrent = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  try {
    await rename(nextPath, currentPath);
  } catch (error) {
    if (movedCurrent) await rename(previousPath, currentPath).catch(() => undefined);
    throw error;
  }
  await rm(previousPath, { force: true });
}

function remoteHeaders(json = false): Headers {
  // 远程迁移只从环境变量读取 Cookie，并统一附加到每个 API 请求，不把凭据写入备份清单。
  const headers = new Headers();
  if (json) headers.set("content-type", "application/json");
  if (process.env.DROP_WORKER_COOKIE) headers.set("cookie", process.env.DROP_WORKER_COOKIE);
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

async function downloadRemoteFile(
  item: DropItem,
  backupPath: string,
  onBytes?: (completedBytes: number) => void,
): Promise<string> {
  const temporary = `${backupPath}.partial`;
  await mkdir(dirname(temporary), { recursive: true });
  let resumedSize = 0;
  try {
    resumedSize = (await stat(temporary)).size;
    if (resumedSize > item.sizeBytes) {
      await rm(temporary, { force: true });
      resumedSize = 0;
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const hash = createHash("sha256");
  if (resumedSize > 0) {
    let hashedBytes = 0;
    for await (const chunk of createReadStream(temporary)) {
      hash.update(chunk);
      hashedBytes += chunk.length;
      onBytes?.(hashedBytes);
    }
  }
  onBytes?.(resumedSize);
  let response: Response | null = null;
  if (resumedSize < item.sizeBytes) {
    response = await remoteFetch(`/api/files/${item.id}`, resumedSize > 0
      ? { headers: { range: `bytes=${resumedSize}-` } }
      : undefined);
    if (resumedSize > 0 && response.status !== 206) {
      await response.body?.cancel();
      await rm(temporary, { force: true });
      resumedSize = 0;
      return downloadRemoteFile(item, backupPath, onBytes);
    }
  }
  if (response && !response.body) throw new Error(`远程文件 ${item.id} 没有响应正文`);
  const file = await open(temporary, resumedSize > 0 ? "a" : "w");
  let sizeBytes = resumedSize;
  const reader = response?.body?.getReader();
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await file.write(value);
        hash.update(value);
        sizeBytes += value.byteLength;
        onBytes?.(sizeBytes);
      }
    }
  } finally {
    reader?.releaseLock();
    await file.close();
  }
  if (sizeBytes !== item.sizeBytes) throw new Error(`远程文件 ${item.id} 长度不一致`);
  await rm(backupPath, { force: true });
  await rename(temporary, backupPath);
  return hash.digest("hex");
}

export async function remoteBackup(
  destinationArgument?: string,
  onProgress?: (progress: PortableStorageProgress) => void,
): Promise<void> {
  // 远程备份逐文件流式落盘；部分文件和部分清单保留在目标目录，下一次可续传。
  const destination = resolve(destinationArgument || `./backups/portable-${Date.now()}`);
  await mkdir(destination, { recursive: true });
  const previous = await readPortableManifest(resolve(destination, "manifest.json"));
  const partial = await readPortableManifest(resolve(destination, "manifest.partial.json"), true)
    || await readPortableManifest(resolve(destination, "manifest.partial.next.json"), true)
    || await readPortableManifest(resolve(destination, "manifest.partial.previous.json"), true);
  if (!previous && !partial && (await readdir(destination)).length > 0) {
    throw new Error("备份目录非空且不包含有效清单，已拒绝写入");
  }
  const filesRoot = resolve(destination, "files");
  await mkdir(filesRoot, { recursive: true });
  const bundle = (await (await remoteFetch("/api/export")).json()) as ExportBundle;
  const fileItems = bundle.items.filter((item) => item.type === "file");
  const totalBytes = fileItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  const baseProgress: PortableStorageProgress = {
    operation: "backup",
    phase: "preparing",
    completedObjects: 0,
    totalObjects: fileItems.length,
    completedBytes: 0,
    totalBytes,
    reusedObjects: 0,
    currentObjectKey: null,
  };
  onProgress?.(baseProgress);
  const items: PortableManifest["items"] = [];
  const candidates = new Map(
    [...(previous?.items || []), ...(partial?.items || [])].map((item) => [item.id, item]),
  );
  const createdAt = partial?.createdAt || new Date().toISOString();
  let completedObjects = 0;
  let completedBytes = 0;
  let reusedObjects = 0;
  await writePortablePartial(destination, {
    format: "drop-worker-portable-backup",
    version: 2,
    createdAt,
    items,
  });
  for (const item of bundle.items) {
    if (item.type !== "file") {
      items.push(item);
      await writePortablePartial(destination, {
        format: "drop-worker-portable-backup",
        version: 2,
        createdAt,
        items,
      });
      continue;
    }
    const backupFile = `files/${item.id}.bin`;
    const backupPath = safeManifestPath(destination, backupFile);
    const candidate = candidates.get(item.id);
    onProgress?.({
      ...baseProgress,
      phase: "verifying",
      completedObjects,
      completedBytes,
      reusedObjects,
      currentObjectKey: item.id,
    });
    let backupSha256: string | undefined;
    if (candidate?.backupFile && candidate.backupSha256 && candidate.sizeBytes === item.sizeBytes) {
      try {
        const candidatePath = safeManifestPath(destination, candidate.backupFile);
        const info = await stat(candidatePath);
        if (
          info.size === item.sizeBytes &&
          await hashFile(candidatePath, (objectBytes) => onProgress?.({
            ...baseProgress,
            phase: "verifying",
            completedObjects,
            completedBytes: completedBytes + objectBytes,
            reusedObjects,
            currentObjectKey: item.id,
          })) === candidate.backupSha256
        ) {
          backupSha256 = candidate.backupSha256;
          if (candidatePath !== backupPath) {
            await mkdir(dirname(backupPath), { recursive: true });
            await copyFile(candidatePath, backupPath);
          }
          await rm(`${backupPath}.partial`, { force: true });
          reusedObjects += 1;
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    if (!backupSha256) {
      onProgress?.({
        ...baseProgress,
        phase: "transferring",
        completedObjects,
        completedBytes,
        reusedObjects,
        currentObjectKey: item.id,
      });
      backupSha256 = await downloadRemoteFile(
        item,
        backupPath,
        (objectBytes) => onProgress?.({
          ...baseProgress,
          phase: "transferring",
          completedObjects,
          completedBytes: completedBytes + objectBytes,
          reusedObjects,
          currentObjectKey: item.id,
        }),
      );
    }
    items.push({ ...item, backupFile, backupSha256 });
    completedObjects += 1;
    completedBytes += item.sizeBytes;
    await writePortablePartial(destination, {
      format: "drop-worker-portable-backup",
      version: 2,
      createdAt,
      items,
    });
    onProgress?.({
      ...baseProgress,
      phase: "transferring",
      completedObjects,
      completedBytes,
      reusedObjects,
      currentObjectKey: item.id,
    });
  }
  const manifest: PortableManifest = {
    format: "drop-worker-portable-backup",
    version: 2,
    createdAt,
    items,
  };
  onProgress?.({
    ...baseProgress,
    phase: "finalizing",
    completedObjects,
    completedBytes,
    reusedObjects,
    currentObjectKey: null,
  });
  await commitPortableManifest(destination, manifest);
  await commitPortableInventory(destination, bundle);
  const currentFiles = new Set(items.flatMap((item) => item.backupFile ? [item.backupFile] : []));
  for (const stale of previous?.items || []) {
    if (stale.backupFile && !currentFiles.has(stale.backupFile)) {
      await rm(safeManifestPath(destination, stale.backupFile), { force: true });
    }
  }
  console.log(`可移植备份已创建：${destination}`);
}

async function uploadRemoteFile(
  filePath: string,
  item: PortableManifest["items"][number],
  onBytes?: (completedBytes: number) => void,
): Promise<DropItem> {
  // 恢复文件复用正式分片上传 API，即使目标是 Cloudflare 也不会绕过配额和对象状态机。
  const sizeBytes = (await stat(filePath)).size;
  const create = await remoteFetch("/api/uploads", {
    method: "POST",
    body: JSON.stringify({
      fileName: item.originalName || item.displayName || "restored-file",
      mimeType: item.mimeType || "application/octet-stream",
      sizeBytes,
      fingerprint: `restore:${item.id}:${sizeBytes}`,
    }),
  });
  let upload = (await create.json()) as UploadSessionResponse;
  const partNumbers = Array.from(
    { length: Math.ceil(sizeBytes / UPLOAD_PART_SIZE) },
    (_, index) => index + 1,
  );
  const file = await open(filePath, "r");
  let completedBytes = 0;
  const readPart = async (partNumber: number): Promise<Uint8Array> => {
    const start = (partNumber - 1) * UPLOAD_PART_SIZE;
    const length = Math.min(UPLOAD_PART_SIZE, sizeBytes - start);
    const part = new Uint8Array(length);
    const { bytesRead } = await file.read(part, 0, length, start);
    if (bytesRead !== length) throw new Error(`恢复文件第 ${partNumber} 分片读取不完整`);
    return part;
  };
  try {
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
          const part = await readPart(partNumber);
          const url = urlByPart.get(partNumber);
          if (!url) throw new Error("远程实例未返回完整的分片上传地址");
          const body = part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer;
          const response = await fetch(url, { method: "PUT", body });
          if (!response.ok) throw new Error(`R2 分片上传失败 (${response.status})`);
          const etag = response.headers.get("etag");
          if (!etag) throw new Error("R2 未返回分片 ETag，请检查存储桶 CORS 配置");
          return { partNumber, etag, sizeBytes: part.byteLength };
        }));
        const confirm = await remoteFetch(`/api/uploads/${upload.id}/parts/confirm`, {
          method: "POST",
          body: JSON.stringify({ parts: parts.map(({ partNumber, etag }) => ({ partNumber, etag })) }),
        });
        upload = (await confirm.json()) as UploadSessionResponse;
        completedBytes += parts.reduce((sum, part) => sum + part.sizeBytes, 0);
        onBytes?.(completedBytes);
      }
    } else {
      for (const partNumber of partNumbers) {
        const part = await readPart(partNumber);
        const body = part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer;
        const response = await remoteFetch(`/api/uploads/${upload.id}/parts/${partNumber}`, {
          method: "PUT",
          body,
          headers: { "content-type": "application/octet-stream", "content-length": String(part.byteLength) },
        });
        upload = (await response.json()) as UploadSessionResponse;
        completedBytes += part.byteLength;
        onBytes?.(completedBytes);
      }
    }
  } finally {
    await file.close();
  }
  return (await (await remoteFetch(`/api/uploads/${upload.id}/complete`, { method: "POST", body: "{}" })).json()) as DropItem;
}

export async function remoteRestore(
  sourceArgument?: string,
  onProgress?: (progress: PortableStorageProgress) => void,
): Promise<void> {
  if (!sourceArgument) throw new Error("remote-restore 需要提供备份目录");
  const source = resolve(sourceArgument);
  const manifest = await readPortableManifest(resolve(source, "manifest.json"));
  if (!manifest) throw new Error("可移植备份清单不存在");
  const fileItems = manifest.items.filter((item) => item.type === "file");
  const totalBytes = fileItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  const baseProgress: PortableStorageProgress = {
    operation: "restore",
    phase: "preparing",
    completedObjects: 0,
    totalObjects: fileItems.length,
    completedBytes: 0,
    totalBytes,
    reusedObjects: 0,
    currentObjectKey: null,
  };
  onProgress?.(baseProgress);
  let verifiedObjects = 0;
  let verifiedBytes = 0;
  // 在目标产生任何写入前完整校验所有文件，避免恢复到一半才发现备份损坏。
  for (const item of fileItems) {
    if (!item.backupFile) throw new Error(`文件条目 ${item.id} 缺少备份文件`);
    const backupPath = safeManifestPath(source, item.backupFile);
    onProgress?.({
      ...baseProgress,
      phase: "verifying",
      completedObjects: verifiedObjects,
      completedBytes: verifiedBytes,
      currentObjectKey: item.id,
    });
    const info = await stat(backupPath);
    if (
      info.size !== item.sizeBytes ||
      !item.backupSha256 ||
      await hashFile(backupPath, (objectBytes) => onProgress?.({
        ...baseProgress,
        phase: "verifying",
        completedObjects: verifiedObjects,
        completedBytes: verifiedBytes + objectBytes,
        currentObjectKey: item.id,
      })) !== item.backupSha256
    ) {
      throw new Error(`文件条目 ${item.id} 完整性校验失败`);
    }
    verifiedObjects += 1;
    verifiedBytes += item.sizeBytes;
    onProgress?.({
      ...baseProgress,
      phase: "verifying",
      completedObjects: verifiedObjects,
      completedBytes: verifiedBytes,
      currentObjectKey: item.id,
    });
  }
  // 恢复前并行确认目标的活动区和回收站都为空，避免把内容混入已有实例。
  const [active, trash] = await Promise.all([
    remoteFetch("/api/items?limit=1&trash=false").then((response) => response.json() as Promise<ListItemsResponse>),
    remoteFetch("/api/items?limit=1&trash=true").then((response) => response.json() as Promise<ListItemsResponse>),
  ]);
  if (active.items.length || trash.items.length) {
    throw new Error("目标实例不是空实例。为防止覆盖或重复，恢复已停止。");
  }
  let transferredObjects = 0;
  let transferredBytes = 0;
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
      onProgress?.({
        ...baseProgress,
        phase: "transferring",
        completedObjects: transferredObjects,
        completedBytes: transferredBytes,
        currentObjectKey: item.id,
      });
      created = await uploadRemoteFile(
        backupPath,
        item,
        (objectBytes) => onProgress?.({
          ...baseProgress,
          phase: "transferring",
          completedObjects: transferredObjects,
          completedBytes: transferredBytes + objectBytes,
          currentObjectKey: item.id,
        }),
      );
      transferredObjects += 1;
      transferredBytes += item.sizeBytes;
      onProgress?.({
        ...baseProgress,
        phase: "transferring",
        completedObjects: transferredObjects,
        completedBytes: transferredBytes,
        currentObjectKey: item.id,
      });
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
  onProgress?.({
    ...baseProgress,
    phase: "finalizing",
    completedObjects: transferredObjects,
    completedBytes: transferredBytes,
    currentObjectKey: null,
  });
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
    const progress = createProgressReporter();
    try {
      await remoteBackup(argument, progress.onProgress);
    } finally {
      progress.end();
    }
    return;
  }

  if (command === "remote-restore") {
    const progress = createProgressReporter();
    try {
      await remoteRestore(argument, progress.onProgress);
    } finally {
      progress.end();
    }
    return;
  }

  if (command === "migrate-database") {
    await migrateConfiguredDatabase();
    return;
  }

  if (command === "storage-backup") {
    const progress = createProgressReporter();
    let result: Awaited<ReturnType<typeof createPortableBackup>>;
    try {
      result = await createPortableBackup(argument, undefined, { onProgress: progress.onProgress });
    } finally {
      progress.end();
    }
    console.log(`可移植存储备份已创建：${result.destination}`);
    return;
  }

  if (command === "storage-restore") {
    if (!argument) throw new Error("storage-restore 需要提供备份目录");
    const progress = createProgressReporter();
    try {
      await restorePortableBackup(argument, undefined, revokeShares, { onProgress: progress.onProgress });
    } finally {
      progress.end();
    }
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
    const metadataSnapshot = openLocalMetadataStore(resolve(destination, "drop-worker.sqlite"));
    try {
      const [items, shares] = await Promise.all([
        metadataSnapshot.store.listPortableItems(),
        metadataSnapshot.store.listPortableShares(),
      ]);
      await writeFile(
        resolve(destination, "inventory.json"),
        JSON.stringify(createExportBundle(items, shares, Date.parse(manifest.createdAt)), null, 2),
        "utf8",
      );
    } finally {
      metadataSnapshot.close();
    }
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
