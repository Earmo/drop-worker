import type { ItemType } from "../../packages/contracts";

/** 页面中所有容量都使用同一套单位和精度，避免摘要、队列和条目显示不一致。 */
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

export function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function typeLabel(type: ItemType): string {
  return type === "text" ? "文本" : type === "link" ? "链接" : "文件";
}
