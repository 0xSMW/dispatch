import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeys } from "../../../src/commands/api-keys/index.js";
import { captureExit, errorJson, list, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

describe("api-keys", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default and with the ls alias", async () => {
    method("apiKeys.list").mockResolvedValue(list([]));
    spies();
    await run(apiKeys, []);
    await run(apiKeys, ["ls", "--limit", "50"]);
    expect(method("apiKeys.list").mock.calls).toEqual([[{ limit: 10 }], [{ limit: 50 }]]);
  });

  it("create maps old scope names to permissions", async () => {
    method("apiKeys.create").mockResolvedValue(ok({ id: "key_1", token: "sk_x" }));
    const { stdout } = spies();
    await run(apiKeys, ["create", "Web", "--scope", "send"]);
    expect(method("apiKeys.create")).toHaveBeenCalledWith({ name: "Web", permission: "sending_access", domainId: undefined });
    expect(JSON.parse(stdout()).token).toBe("sk_x");
    await run(apiKeys, ["create", "--name", "Ops", "--permission", "full_access", "--domain-id", "d_1"]);
    expect(method("apiKeys.create")).toHaveBeenLastCalledWith({ name: "Ops", permission: "full_access", domainId: "d_1" });
  });

  it("create rejects an unknown permission", async () => {
    const { stderr } = spies();
    expect(await run(apiKeys, ["create", "x", "--permission", "admin"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("invalid_permission");
  });

  it("update renames and delete needs --yes", async () => {
    spies();
    await run(apiKeys, ["update", "key_1", "--name", "New"]);
    expect(method("apiKeys.update")).toHaveBeenCalledWith("key_1", { name: "New" });
    expect(await run(apiKeys, ["rm", "key_1"])).toBe(1);
    expect(await run(apiKeys, ["delete", "key_1", "--yes"])).toBe(0);
    expect(method("apiKeys.remove")).toHaveBeenCalledWith("key_1");
  });
});
