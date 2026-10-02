import { beforeEach, describe, expect, it, vi } from "vitest";
import { domains } from "../../../src/commands/domains/index.js";
import { captureExit, errorJson, list, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

describe("domains", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default and prints the raw list as JSON when piped", async () => {
    method("domains.list").mockResolvedValue(list([{ id: "domain_1", name: "example.com", status: "verified" }]));
    const { stdout } = spies();
    expect(await run(domains, ["--limit", "5"])).toBe(0);
    expect(method("domains.list")).toHaveBeenCalledWith({ limit: 5 });
    expect(JSON.parse(stdout())).toMatchObject({ object: "list", data: [{ id: "domain_1" }] });
  });

  it("creates from the positional name with camelCase options", async () => {
    method("domains.create").mockResolvedValue(ok({ object: "domain", id: "domain_1", name: "example.com" }));
    spies();
    expect(await run(domains, ["create", "example.com", "--region", "eu-west-1", "--open-tracking", "--receiving", "enabled"])).toBe(0);
    expect(method("domains.create")).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "example.com",
        region: "eu-west-1",
        openTracking: true,
        capabilities: { sending: undefined, receiving: "enabled" },
      }),
    );
  });

  it("fails with missing_flags when create has no name and no terminal", async () => {
    const { stderr } = spies();
    expect(await run(domains, ["create"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("missing_flags");
  });

  it("fails with missing_id when get has no id and no terminal", async () => {
    const { stderr } = spies();
    expect(await run(domains, ["get"])).toBe(1);
    expect(errorJson(stderr()).error).toEqual({ message: "Missing domain id", code: "missing_id" });
  });

  it("requires --yes to delete without a terminal", async () => {
    const { stderr } = spies();
    expect(await run(domains, ["rm", "domain_1"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("confirmation_required");
    expect(method("domains.remove")).not.toHaveBeenCalled();
  });

  it("deletes with --yes", async () => {
    method("domains.remove").mockResolvedValue(ok({ object: "domain", id: "domain_1", deleted: true }));
    const { stdout } = spies();
    expect(await run(domains, ["delete", "domain_1", "--yes"])).toBe(0);
    expect(method("domains.remove")).toHaveBeenCalledWith("domain_1");
    expect(JSON.parse(stdout())).toMatchObject({ deleted: true });
  });

  it("updates only the flags that were set", async () => {
    method("domains.update").mockResolvedValue(ok({ object: "domain", id: "domain_1" }));
    spies();
    await run(domains, ["update", "domain_1", "--no-click-tracking"]);
    expect(method("domains.update")).toHaveBeenCalledWith({ id: "domain_1", clickTracking: false });
  });

  it("passes the API error name through as the CLI error code", async () => {
    method("domains.get").mockResolvedValue({
      data: null,
      error: { name: "not_found", statusCode: 404, message: "Domain not found" },
      headers: {},
    });
    const { stderr } = spies();
    expect(await run(domains, ["get", "domain_x"])).toBe(1);
    expect(errorJson(stderr()).error).toEqual({ message: "Domain not found", code: "not_found", statusCode: 404 });
  });

  it("doctor defaults to the first domain", async () => {
    method("domains.list").mockResolvedValue(list([{ id: "domain_1", name: "example.com" }]));
    method("domains.doctor").mockResolvedValue(ok({ checks: [] }));
    spies();
    expect(await run(domains, ["doctor"])).toBe(0);
    expect(method("domains.doctor")).toHaveBeenCalledWith("domain_1");
  });
});
