import { beforeEach, describe, expect, it, vi } from "vitest";
import { contactProperties } from "../../../src/commands/contact-properties/index.js";
import { captureExit, errorJson, list, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

beforeEach(() => {
  setNonInteractive();
  captureExit();
});

describe("contact-properties", () => {
  it("lists, creates with a typed fallback, updates, and deletes", async () => {
    method("contactProperties.list").mockResolvedValue(list([]));
    spies();
    await run(contactProperties, []);
    expect(method("contactProperties.list")).toHaveBeenCalledWith({ limit: 10 });
    await run(contactProperties, ["create", "--key", "seats", "--type", "number", "--fallback-value", "1"]);
    expect(method("contactProperties.create")).toHaveBeenCalledWith({ key: "seats", type: "number", fallbackValue: 1 });
    method("contactProperties.get").mockResolvedValue(ok({ id: "prop_1", type: "number" }));
    await run(contactProperties, ["update", "prop_1", "--fallback-value", "2"]);
    expect(method("contactProperties.update")).toHaveBeenCalledWith({ id: "prop_1", fallbackValue: 2 });
    method("contactProperties.get").mockResolvedValue(ok({ id: "prop_2", type: "string" }));
    await run(contactProperties, ["update", "prop_2", "--fallback-value", "2"]);
    expect(method("contactProperties.update")).toHaveBeenLastCalledWith({ id: "prop_2", fallbackValue: "2" });
    await run(contactProperties, ["get", "prop_1"]);
    expect(method("contactProperties.get")).toHaveBeenCalledWith("prop_1");
    expect(await run(contactProperties, ["delete", "prop_1", "--yes"])).toBe(0);
  });

  it("refuses a fallback that is not a number for a number property", async () => {
    const { stderr } = spies();
    expect(await run(contactProperties, ["create", "--key", "seats", "--type", "number", "--fallback-value", "abc"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("invalid_flag");
    expect(method("contactProperties.create")).not.toHaveBeenCalled();
  });
  it("creates and updates actual boolean and unchanged ISO date fallbacks", async () => {
    spies();
    await run(contactProperties, ["create", "--key", "activated", "--type", "boolean", "--fallback-value", "false"]);
    expect(method("contactProperties.create")).toHaveBeenCalledWith({ key: "activated", type: "boolean", fallbackValue: false });
    await run(contactProperties, ["create", "--key", "last_active_at", "--type", "date", "--fallback-value", "2026-10-01T01:02:03+02:00"]);
    expect(method("contactProperties.create")).toHaveBeenLastCalledWith({ key: "last_active_at", type: "date", fallbackValue: "2026-10-01T01:02:03+02:00" });
    method("contactProperties.get").mockResolvedValue(ok({ id: "prop_bool", type: "boolean" }));
    await run(contactProperties, ["update", "prop_bool", "--fallback-value", "true"]);
    expect(method("contactProperties.update")).toHaveBeenLastCalledWith({ id: "prop_bool", fallbackValue: true });
    method("contactProperties.get").mockResolvedValue(ok({ id: "prop_date", type: "date" }));
    await run(contactProperties, ["update", "prop_date", "--fallback-value", "2026-10-02"]);
    expect(method("contactProperties.update")).toHaveBeenLastCalledWith({ id: "prop_date", fallbackValue: "2026-10-02" });
  });
  it("refuses invalid boolean flag text instead of sending a string or false", async () => {
    const { stderr } = spies();
    expect(await run(contactProperties, ["create", "--key", "activated", "--type", "boolean", "--fallback-value", "maybe"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("invalid_flag");
    expect(method("contactProperties.create")).not.toHaveBeenCalled();
  });
});
