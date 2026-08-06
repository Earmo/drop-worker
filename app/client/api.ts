import type { ApiError } from "../../packages/contracts";

/**
 * 前端 API 的统一接口：负责 JSON 请求头、错误体解码和错误信息兜底。
 * 页面和组件只处理成功返回值，不重复编写 fetch/error 分支。
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof Blob ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = "操作失败，请稍后重试";
    try {
      const payload = (await response.json()) as ApiError;
      message = payload.error?.message || message;
    } catch {
      message = response.statusText || message;
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

/** 网络抖动只重试幂等/可安全重复的调用；调用方对 complete 等状态操作负责幂等。 */
export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 600 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}
