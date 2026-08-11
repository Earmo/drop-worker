import { BlockList, isIP } from "node:net";

export const PEER_ADDRESS_HEADER = "x-drop-worker-peer-address";

function trustedProxyList(value: string | undefined): BlockList {
  const blockList = new BlockList();
  for (const entry of (value || "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const [address, prefixText] = entry.split("/");
    const family = isIP(address || "");
    if (!family) throw new Error(`TRUST_PROXY 包含无效地址：${entry}`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefixText === undefined) {
      blockList.addAddress(address!, type);
      continue;
    }
    const prefix = Number(prefixText);
    const maximum = family === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error(`TRUST_PROXY 包含无效网段：${entry}`);
    }
    blockList.addSubnet(address!, prefix, type);
  }
  return blockList;
}

export function createClientAddressResolver(trustProxy: string | undefined): (request: Request) => string {
  const trusted = trustedProxyList(trustProxy);
  return (request) => {
    const peer = request.headers.get(PEER_ADDRESS_HEADER)?.trim() || "unknown";
    const family = isIP(peer);
    if (!family || !trusted.check(peer, family === 4 ? "ipv4" : "ipv6")) return peer;
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
    return isIP(forwarded) ? forwarded : peer;
  };
}
