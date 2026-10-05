import { beforeEach, describe, expect, it, vi } from "vitest";
import { segments } from "../../../src/commands/segments/index.js";
import { captureExit, list, method, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

beforeEach(() => {
  setNonInteractive();
  captureExit();
});

describe("segments", () => {
  it("serializes filter creation preview and explicit null conversion", async () => {
    method("segments.preview").mockResolvedValue({ data: { count: 2, sample: [] }, error: null });
    const rule = { type: "rule", field: "email.opened", operator: "eq", value: false, scope: { automation_id: "auto_1" }, window: "30 days" };
    spies();
    await run(segments, ["create", "Filter", "--rule", JSON.stringify(rule)]);
    expect(method("segments.create")).toHaveBeenCalledWith({ name: "Filter", rule });
    await run(segments, ["preview", "--rule", JSON.stringify(rule)]);
    expect(method("segments.preview")).toHaveBeenCalledWith(rule);
    await run(segments, ["update", "seg_1", "--rule", "null"]);
    expect(method("segments.update")).toHaveBeenCalledWith("seg_1", { rule: null });
  });
  it("covers list, create, get, update, delete, and contacts", async () => {
    method("segments.list").mockResolvedValue(list([]));
    method("segments.contacts").mockResolvedValue(list([]));
    spies();
    await run(segments, []);
    await run(segments, ["create", "VIPs", "--description", "Top accounts"]);
    expect(method("segments.create")).toHaveBeenCalledWith({ name: "VIPs", description: "Top accounts" });
    await run(segments, ["get", "seg_1"]);
    await run(segments, ["update", "seg_1", "--name", "Gold"]);
    expect(method("segments.update")).toHaveBeenCalledWith("seg_1", { name: "Gold" });
    await run(segments, ["contacts", "seg_1", "--limit", "50"]);
    expect(method("segments.contacts")).toHaveBeenCalledWith("seg_1", { limit: 50 });
    expect(await run(segments, ["rm", "seg_1", "--yes"])).toBe(0);
    expect(method("segments.remove")).toHaveBeenCalledWith("seg_1");
  });
});
