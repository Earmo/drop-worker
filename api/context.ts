import {
  createMetadataPorts,
  type AppContext,
  type AuthProvider,
  type BlobStore,
  type DirectUploadService,
  type MetadataStore,
} from "./platform";
import { createUploadTransport } from "./uploads/transport";

export type AppContextOptions = {
  metadata: MetadataStore;
  blobs: BlobStore;
  directUploads?: DirectUploadService;
  auth: AuthProvider;
  publicFilesUrl?: URL;
  quotaBytes: number;
  insecureHttp: boolean;
  sharing: AppContext["sharing"];
};

/**
 * 共享应用组合模块。
 *
 * Node.js 与 Cloudflare 只需提供各自的基础设施 adapter；元数据能力视图、上传传输
 * 以及 AppContext 的公共组装规则集中在这里，避免两个运行时分别维护同一套 wiring。
 */
export function createAppContext(options: AppContextOptions): AppContext {
  return {
    metadata: createMetadataPorts(options.metadata),
    blobs: options.blobs,
    uploads: createUploadTransport(options.blobs, options.directUploads),
    auth: options.auth,
    publicFilesUrl: options.publicFilesUrl,
    quotaBytes: options.quotaBytes,
    insecureHttp: options.insecureHttp,
    sharing: options.sharing,
  };
}
