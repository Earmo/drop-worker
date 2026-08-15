import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createAppContext } from "../../api/context";
import type { AppContext, BlobStore } from "../../api/platform";
import { LocalBlobStore } from "../../api/stores/local";
import { openRelationalMetadataStore, type OpenRelationalStore } from "../../api/stores/relational";
import { createS3BlobStoreFromEnv, S3BlobStore } from "../../api/stores/s3";
import { createClientAddressResolver } from "./client-address";
import type { NodeRuntimeConfig } from "./config";
import { LocalAuth } from "../auth/local-auth";
import { NodeSmtpMailSender } from "../auth/mail";

export type NodeRuntime = {
  services: AppContext;
  metadata: OpenRelationalStore;
  blobs: BlobStore;
  auth: LocalAuth;
};

/**
 * Node.js 组合根：配置已经在进入这里前完成校验，适配器在此集中创建并组装成 AppContext。
 */
export async function createNodeRuntime(config: NodeRuntimeConfig): Promise<NodeRuntime> {
  await mkdir(config.dataRoot, { recursive: true });
  const metadata = await openRelationalMetadataStore(
    join(config.dataRoot, "drop-worker.sqlite"),
    config.databaseDriver,
  );
  await metadata.store.ensureSchema();
  await metadata.store.ensureApplicationReady();

  const blobs: BlobStore = config.blobDriver === "local"
    ? new LocalBlobStore(config.dataRoot)
    : createS3BlobStoreFromEnv();
  await blobs.healthCheck();

  const mailer = config.auth.smtp ? new NodeSmtpMailSender(config.auth.smtp) : undefined;
  const auth = new LocalAuth(metadata.store, config.auth, mailer);
  const services = createAppContext({
    metadata: metadata.store,
    blobs,
    quotaBytes: config.quotaBytes,
    auth,
    insecureHttp: config.auth.insecureHttp,
    sharing: {
      enabled: config.sharingEnabled,
      publicUrl: config.auth.publicUrl,
      secret: config.auth.sessionSecret,
      resolveClientAddress: createClientAddressResolver(config.trustProxy),
    },
  });
  return { services, metadata, blobs, auth };
}

export function closeNodeBlobStore(blobs: BlobStore): void {
  if (blobs instanceof S3BlobStore) blobs.close();
}
