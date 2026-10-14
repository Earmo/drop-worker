import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const dockerfileUrl = new URL("deploy/Dockerfile", root);

test("Docker 发布工作流显式指定 Dockerfile 并保留根目录构建上下文", async () => {
  const workflow = await readFile(new URL(".github/workflows/docker-publish.yml", root), "utf8");
  assert.match(workflow, /context: \./);
  assert.ok(workflow.includes("file: deploy/Dockerfile"), "发布工作流必须指定 deploy/Dockerfile，根目录没有默认 Dockerfile");
  await access(dockerfileUrl);
});

test("Docker 运行阶段复制的源码路径必须存在", async () => {
  const dockerfile = await readFile(dockerfileUrl, "utf8");
  // 当前 Dockerfile 的源码 COPY 均使用 /app 下的字面路径；dist 由构建阶段生成。
  const copies = [...dockerfile.matchAll(/^COPY --from=build (.+) \.\/\S*$/gm)];
  assert.ok(copies.length > 0);
  for (const [, sources] of copies) {
    for (const source of sources.split(" ")) {
      assert.ok(source.startsWith("/app/"));
      const relative = source.slice("/app/".length);
      if (relative === "dist") continue;
      await access(new URL(relative, root));
    }
  }
});

test("Docker 运行镜像包含 Node 服务端直接加载的 API 源码", async () => {
  const dockerfile = await readFile(dockerfileUrl, "utf8");
  assert.ok(dockerfile.includes("COPY --from=build /app/api ./api"), "npm start 使用的 server/local.ts 需要 api/ 目录");
});

test("外部存储 CI 和 Compose 示例使用固定版本 Silo，不依赖上游 MinIO 镜像", async () => {
  const paths = [
    ".github/workflows/storage-integration.yml",
    "examples/compose/postgres-minio.yaml",
    "examples/compose/mysql-minio.yaml",
  ];
  for (const path of paths) {
    const config = await readFile(new URL(path, root), "utf8");
    assert.doesNotMatch(config, /\bminio\/(?:minio|mc):/, path);
    assert.doesNotMatch(config, /pgsty\/silo:latest/, path);
    assert.match(config, /pgsty\/silo:RELEASE\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z/, path);
    assert.match(config, /mcli alias set local/, path);
    assert.match(config, /mcli mb --ignore-existing local\/drop-worker/, path);
    // Silo 保留 MINIO_* 配置协议，替换镜像不能改变已有凭据与数据卷。
    assert.match(config, /MINIO_ROOT_USER/, path);
    assert.match(config, /MINIO_ROOT_PASSWORD/, path);
    if (path.startsWith("examples/")) {
      assert.match(config, /minio-data:\/data/, path);
      assert.match(config, /condition: service_healthy/, path);
    } else {
      assert.match(config, /timeout-minutes:/, path);
      assert.match(config, /docker logs silo/, path);
    }
  }
});
