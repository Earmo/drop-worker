import assert from "node:assert/strict";
import test from "node:test";
import { R2DirectUploadService } from "../worker/storage/r2-direct-uploads";

test("R2 直传服务签发 multipart 分片 URL 并完成同一 S3 会话", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string; headers: Headers; body: Promise<string> }> = [];
  globalThis.fetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.clone().text(),
    });
    const url = new URL(request.url);
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      return new Response("<InitiateMultipartUploadResult><UploadId>provider-upload-id</UploadId></InitiateMultipartUploadResult>");
    }
    if (request.method === "PUT") return new Response(null, { headers: { etag: '"etag-1"' } });
    return new Response(null, { status: 204 });
  };

  try {
    const direct = new R2DirectUploadService({
      accountId: "0123456789abcdef",
      bucketName: "drop-worker-files",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const uploadId = await direct.createMultipart(
      "objects/a/b",
      "application/octet-stream",
      "attachment; filename*=UTF-8''example.txt",
    );
    assert.equal(uploadId, "r2-s3:provider-upload-id");
    const create = requests.find((request) => request.method === "POST" && new URL(request.url).searchParams.has("uploads"));
    assert.ok(create);
    assert.equal(create.headers.get("content-disposition"), "attachment; filename*=UTF-8''example.txt");

    const signedUrl = new URL(await direct.createPartUploadUrl("objects/a/b", uploadId, 2, 900));
    assert.equal(signedUrl.hostname, "0123456789abcdef.r2.cloudflarestorage.com");
    assert.equal(signedUrl.pathname, "/drop-worker-files/objects/a/b");
    assert.equal(signedUrl.searchParams.get("partNumber"), "2");
    assert.equal(signedUrl.searchParams.get("uploadId"), "provider-upload-id");
    assert.equal(signedUrl.searchParams.get("X-Amz-Expires"), "900");
    assert.ok(signedUrl.searchParams.get("X-Amz-Signature"));
    assert.doesNotMatch(signedUrl.toString(), /test-secret-key/);

    const etag = await direct.putPart("objects/a/b", uploadId, 1, new Uint8Array([1, 2, 3]));
    assert.equal(etag, '"etag-1"');
    await direct.completeMultipart("objects/a/b", uploadId, [
      { partNumber: 1, etag, sizeBytes: 3 },
    ]);
    await direct.abortMultipart("objects/a/b", uploadId);

    const complete = requests.find((request) => request.method === "POST" && new URL(request.url).searchParams.has("uploadId"));
    assert.ok(complete);
    assert.equal(
      await complete.body,
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"etag-1"</ETag></Part></CompleteMultipartUpload>',
    );
    assert.ok(requests.some((request) => request.method === "DELETE"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
