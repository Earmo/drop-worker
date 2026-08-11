import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminArguments } from "../server/admin";

test("管理命令不会把 revoke-shares 选项当作工作目录", () => {
  assert.deepEqual(parseAdminArguments(["migrate-storage", "--revoke-shares"]), {
    command: "migrate-storage",
    argument: undefined,
    revokeShares: true,
  });
  assert.deepEqual(parseAdminArguments(["migrate-storage", "./work", "--revoke-shares"]), {
    command: "migrate-storage",
    argument: "./work",
    revokeShares: true,
  });
  assert.deepEqual(parseAdminArguments(["migrate-storage", "--revoke-shares", "./work"]), {
    command: "migrate-storage",
    argument: "./work",
    revokeShares: true,
  });
});
