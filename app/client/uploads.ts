export {
  UPLOAD_CONCURRENCY,
  UPLOAD_PART_SIZE as PART_SIZE,
} from "../../packages/contracts";

export type UploadTask = {
  id: string;
  fileName: string;
  sizeBytes: number;
  fingerprint: string;
  progress: number;
  status: "waiting" | "uploading" | "paused" | "failed";
  message?: string;
};

const UPLOAD_STORAGE_KEY = "drop-worker.pending-uploads";

/** 用文件名、大小和修改时间识别“同一个本地文件”，不读取文件正文，恢复速度更快。 */
export function fileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * 断点队列只保存服务端会话 ID 和进度，页面刷新后统一标记为 paused，等待用户重新选择原文件。
 * 浏览器不会允许应用从 localStorage 恢复 File 对象本身，因此不能自动偷偷读取本地文件。
 */
export function readSavedUploads(): UploadTask[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(UPLOAD_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? (value as UploadTask[]) : [];
  } catch {
    return [];
  }
}

export function saveUploads(tasks: UploadTask[]): void {
  localStorage.setItem(
    UPLOAD_STORAGE_KEY,
    JSON.stringify(tasks.filter((task) => task.status !== "failed" || task.progress > 0)),
  );
}
