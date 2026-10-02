import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, pick, promptMissing } from "../../src/lib/prompts.js";
import { captureExit, list, method, setInteractive, setNonInteractive, spies } from "../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../helpers.js")).sdk);

const clack = vi.hoisted(() => ({
  text: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@clack/prompts", () => ({ ...clack, isCancel: (value: unknown) => typeof value === "symbol" }));

const fields = [
  { key: "from" as const, flag: "--from", label: "From" },
  { key: "to" as const, flag: "--to", label: "To" },
];

describe("prompts without a terminal", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("promptMissing returns values that are all present", async () => {
    expect(await promptMissing({ from: "a", to: "b" }, fields, {})).toEqual({ from: "a", to: "b" });
  });

  it("promptMissing fails with missing_flags listing every missing flag", async () => {
    await expect(promptMissing({ from: undefined, to: undefined }, fields, {})).rejects.toMatchObject({
      code: "missing_flags",
      message: "Missing required flags: --from, --to",
    });
    expect(clack.text).not.toHaveBeenCalled();
  });

  it("pick fails with missing_id and never lists", async () => {
    await expect(
      pick(undefined, { globals: {}, noun: "domain", list: (api) => api.domains.list(), label: () => "" }),
    ).rejects.toMatchObject({
      code: "missing_id",
    });
    expect(method("domains.list")).not.toHaveBeenCalled();
    expect(await pick("d_1", { globals: {}, noun: "domain", list: (api) => api.domains.list(), label: () => "" })).toBe("d_1");
  });

  it("confirm needs --yes", async () => {
    await expect(confirm("Delete?", false, {})).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(confirm("Delete?", true, {})).resolves.toBeUndefined();
  });

  it("--json counts as non-interactive even on a terminal", async () => {
    setInteractive();
    await expect(promptMissing({ from: undefined }, [fields[0]!], { json: true })).rejects.toMatchObject({ code: "missing_flags" });
  });
});

describe("prompts on a terminal", () => {
  beforeEach(() => {
    setInteractive();
    captureExit();
    spies();
  });

  it("asks for each missing value, with password for secrets", async () => {
    clack.text.mockResolvedValueOnce("hello@acme.com");
    clack.password.mockResolvedValueOnce("sk_1");
    const values = await promptMissing(
      { from: undefined, key: undefined, to: "x" },
      [fields[0]!, { key: "key", flag: "--key", label: "Key", secret: true }],
      {},
    );
    expect(values).toEqual({ from: "hello@acme.com", key: "sk_1", to: "x" });
  });

  it("throws Cancelled when a prompt is cancelled", async () => {
    clack.text.mockResolvedValueOnce(Symbol("cancel"));
    await expect(promptMissing({ from: undefined }, [fields[0]!], {})).rejects.toMatchObject({ code: "cancelled" });
  });

  it("pick lists and returns the chosen id", async () => {
    method("domains.list").mockResolvedValue(
      list([
        { id: "d_1", name: "a.com" },
        { id: "d_2", name: "b.com" },
      ]),
    );
    clack.select.mockImplementationOnce(async (options: { options: Array<{ value: string; label: string }> }) => {
      expect(options.options.map((option) => option.label)).toEqual(["a.com", "b.com"]);
      return "d_2";
    });
    expect(
      await pick(undefined, {
        globals: {},
        noun: "domain",
        list: (api) => api.domains.list({ limit: 100 }),
        label: (row: { name: string }) => row.name,
      }),
    ).toBe("d_2");
  });
});
