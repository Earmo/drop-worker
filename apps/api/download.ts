import type { BlobRange, BlobStore } from "./platform";

type ParsedRange = BlobRange | "invalid" | null;

function parseRange(header: string | null, totalSize: number): ParsedRange {
  if (!header) return null;
  if (!header.startsWith("bytes=") || header.includes(",")) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, totalSize);
    return { offset: totalSize - length, length };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= totalSize
  ) {
    return "invalid";
  }
  const end = Math.min(requestedEnd, totalSize - 1);
  return { offset: start, length: end - start + 1 };
}

export async function fileDownloadResponse(input: {
  request: Request;
  blobs: BlobStore;
  objectKey: string;
  fileName: string;
  mimeType: string | null;
  attachmentOnly: boolean;
}): Promise<Response | null> {
  const totalSize = await input.blobs.size(input.objectKey);
  if (totalSize === null) return null;
  const range = parseRange(input.request.headers.get("range"), totalSize);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        "content-range": `bytes */${totalSize}`,
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
      },
    });
  }

  const isHead = input.request.method.toUpperCase() === "HEAD";
  const object = isHead ? null : await input.blobs.get(input.objectKey, range ?? undefined);
  if (!isHead && !object) return null;
  const selectedSize = range?.length ?? totalSize;
  const inline = !input.attachmentOnly
    && Boolean(input.mimeType?.startsWith("image/") && input.mimeType !== "image/svg+xml");
  const headers = new Headers({
    "content-type": inline ? (object?.contentType || input.mimeType || "application/octet-stream") : "application/octet-stream",
    "content-length": String(selectedSize),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "accept-ranges": "bytes",
  });
  if (object?.etag) headers.set("etag", object.etag);
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${totalSize}`);
  }
  return new Response(isHead ? null : object!.body, {
    status: range ? 206 : 200,
    headers,
  });
}
