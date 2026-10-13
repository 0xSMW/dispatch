import assert from "node:assert/strict";
import test from "node:test";
import { checkPassword } from "../packages/core/src/crypto.js";
import { publicLookup } from "../packages/core/src/network.js";

test("a malformed stored password digest cannot authenticate", async () => {
  const salt = Buffer.alloc(16, 1).toString("base64url");
  assert.equal(await checkPassword("anything at all", `scrypt$16384$8$1$${salt}$!!!`), false);
});

test("connection-time DNS rejects real localhost resolution", async () => {
  await assert.rejects(
    new Promise((resolve, reject) => {
      publicLookup("localhost", { all: false }, (error, address) => error ? reject(error) : resolve(address));
    }),
    { code: "EHOSTBLOCKED" },
  );
});
