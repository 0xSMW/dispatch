import { beforeEach, describe, expect, it, vi } from "vitest";
import { suppressions } from "../../../src/commands/suppressions/index.js";
import { captureExit, errorJson, list, method, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

beforeEach(() => {
  setNonInteractive();
  captureExit();
});

describe("suppressions", () => {
  it("lists with an origin filter, adds, gets, and deletes by email", async () => {
    method("suppressions.list").mockResolvedValue(list([]));
    spies();
    await run(suppressions, ["--origin", "bounce"]);
    expect(method("suppressions.list")).toHaveBeenCalledWith({ limit: 10, origin: "bounce" });
    await run(suppressions, ["add", "gone@example.com"]);
    expect(method("suppressions.add")).toHaveBeenCalledWith({ email: "gone@example.com", reason: "manual" });
    await run(suppressions, ["get", "gone@example.com"]);
    expect(method("suppressions.get")).toHaveBeenCalledWith("gone@example.com");
    expect(await run(suppressions, ["delete", "gone@example.com", "--yes"])).toBe(0);
    expect(method("suppressions.remove")).toHaveBeenCalledWith("gone@example.com");
  });

  it("batch add and batch remove", async () => {
    spies();
    await run(suppressions, ["batch", "add", "--emails", "a@x.com,b@x.com"]);
    expect(method("suppressions.batchAdd")).toHaveBeenCalledWith(["a@x.com", "b@x.com"]);
    await run(suppressions, ["batch", "remove", "--ids", "sup_1,sup_2", "--yes"]);
    expect(method("suppressions.batchRemove")).toHaveBeenCalledWith({ ids: ["sup_1", "sup_2"] });
    const { stderr } = spies();
    expect(await run(suppressions, ["batch", "remove", "--emails", "a@x.com"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("confirmation_required");
  });
});
