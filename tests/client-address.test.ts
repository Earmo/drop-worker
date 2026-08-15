import assert from "node:assert/strict";
import test from "node:test";
import { createClientAddressResolver, PEER_ADDRESS_HEADER } from "../server/runtime/client-address";

function request(peer: string, forwarded?: string): Request {
  const headers = new Headers({ [PEER_ADDRESS_HEADER]: peer });
  if (forwarded) headers.set("x-forwarded-for", forwarded);
  return new Request("http://localhost/api/public/shares/token/verify", { headers });
}

test("只有可信代理可以提供分享限流来源地址", () => {
  const direct = createClientAddressResolver(undefined);
  assert.equal(direct(request("203.0.113.10", "198.51.100.9")), "203.0.113.10");

  const proxied = createClientAddressResolver("10.0.0.0/8, 127.0.0.1");
  assert.equal(proxied(request("10.20.30.40", "198.51.100.9, 10.20.30.40")), "198.51.100.9");
  assert.equal(proxied(request("10.20.30.40", "not-an-address")), "10.20.30.40");
  assert.equal(proxied(request("203.0.113.10", "198.51.100.9")), "203.0.113.10");
});

test("可信代理配置拒绝无效地址和网段", () => {
  assert.throws(() => createClientAddressResolver("example.com"), /无效地址/);
  assert.throws(() => createClientAddressResolver("10.0.0.0/99"), /无效网段/);
});
