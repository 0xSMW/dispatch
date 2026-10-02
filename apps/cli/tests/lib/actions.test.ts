import { Command } from "@commander-js/extra-typings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCreate, runDelete, runGet, runList, runWrite } from "../../src/lib/actions.js";
import { pageOptions } from "../../src/lib/pagination.js";
import { captureExit, constructed, err, errorJson, list, method, ok, run, setInteractive, setNonInteractive, spies } from "../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../helpers.js")).sdk);

const confirmAnswer = vi.hoisted(() => ({ value: true as boolean | symbol }));
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(async () => confirmAnswer.value),
  isCancel: (value: unknown) => typeof value === "symbol",
  text: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

type Row = { id: string; name: string };

function listCommand() {
  return pageOptions(new Command("list")).action(async (_options, command) => {
    await runList<Row>(command, {
      call: (api, page) => api.domains.list(page),
      columns: ["Name", "ID"],
      row: (row) => [row.name, row.id],
      empty: "(none)",
    });
  });
}

describe("runList", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("passes the page and prints the raw list as JSON", async () => {
    method("domains.list").mockResolvedValue(list([{ id: "d_1", name: "a.com" }], true));
    const { stdout } = spies();
    expect(await run(listCommand(), ["--limit", "2", "--after", "d_0"])).toBe(0);
    expect(method("domains.list")).toHaveBeenCalledWith({ limit: 2, after: "d_0" });
    expect(JSON.parse(stdout())).toEqual({ object: "list", has_more: true, data: [{ id: "d_1", name: "a.com" }] });
  });

  it("renders a table and the next-page hint on a terminal", async () => {
    setInteractive();
    method("domains.list").mockResolvedValue(
      list(
        [
          { id: "d_1", name: "a.com" },
          { id: "d_2", name: "b.com" },
        ],
        true,
      ),
    );
    const { stdout } = spies();
    await run(listCommand(), []);
    expect(stdout()).toContain("a.com");
    expect(stdout()).toContain("Fetch the next page: dispatch list --limit 10 --after d_2");
  });

  it("prints the empty message on a terminal", async () => {
    setInteractive();
    method("domains.list").mockResolvedValue(list([]));
    const { stdout } = spies();
    await run(listCommand(), []);
    expect(stdout()).toBe("(none)");
  });

  it("validates the page before calling the API", async () => {
    const { stderr } = spies();
    expect(await run(listCommand(), ["--after", "a", "--before", "b"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("invalid_pagination");
    expect(method("domains.list")).not.toHaveBeenCalled();
  });

  it("fails with auth_error for a remote API with no key", async () => {
    const { stderr } = spies();
    const command = new Command("x").option("--api-url <url>").addCommand(listCommand());
    expect(await run(command, ["--api-url", "https://mail.example.com", "list"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("auth_error");
  });

  it("builds the client from the resolved key and URL", async () => {
    method("domains.list").mockResolvedValue(list([]));
    spies();
    process.env.DISPATCH_API_KEY = "sk_env";
    await run(listCommand(), []);
    expect(constructed[0]).toMatchObject({ apiKey: "sk_env", baseUrl: "http://localhost:3100" });
  });
});

describe("runGet, runCreate, runWrite", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("runGet prints the resource and uses fetch_error for unexpected failures", async () => {
    method("domains.get").mockResolvedValue(ok({ id: "d_1" }));
    const { stdout } = spies();
    const get = new Command("get").argument("<id>").action(async (id, _o, command) => {
      await runGet(command, { call: (api) => api.domains.get(id) });
    });
    expect(await run(get, ["d_1"])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ id: "d_1" });

    method("domains.get").mockRejectedValue(new Error("socket hang up"));
    const second = spies();
    expect(await run(get, ["d_1"])).toBe(1);
    expect(errorJson(second.stderr())).toEqual({ error: { message: "socket hang up", code: "fetch_error" } });
  });

  it("runCreate prints a done line on a terminal and JSON otherwise", async () => {
    method("domains.create").mockResolvedValue(ok({ id: "d_1" }));
    const create = new Command("create").action(async (_o, command) => {
      await runCreate(command, {
        call: (api) => api.domains.create({ name: "a.com" }),
        done: (data: { id: string }) => `Created ${data.id}`,
      });
    });
    const piped = spies();
    await run(create, []);
    expect(JSON.parse(piped.stdout())).toEqual({ id: "d_1" });
    setInteractive();
    const human = spies();
    await run(create, []);
    expect(human.stdout()).toContain("Created d_1");
  });

  it("runWrite uses its own error code and passes prepared input", async () => {
    method("domains.verify").mockResolvedValue(err("not_found", 404, "Domain not found"));
    const { stderr } = spies();
    const verify = new Command("verify").action(async (_o, command) => {
      await runWrite(command, { code: "verify_error", prepare: async () => "d_9", call: (api, id) => api.domains.verify(id) });
    });
    expect(await run(verify, [])).toBe(1);
    expect(method("domains.verify")).toHaveBeenCalledWith("d_9");
    expect(errorJson(stderr()).error).toEqual({ message: "Domain not found", code: "not_found", statusCode: 404 });
  });
});

describe("runDelete", () => {
  const remove = () =>
    new Command("delete")
      .argument("<id>")
      .option("--yes")
      .action(async (id, _o, command) => {
        await runDelete(command, { noun: "domain", id: async () => id, call: (api, target) => api.domains.remove(target) });
      });

  beforeEach(() => {
    setNonInteractive();
    captureExit();
    method("domains.remove").mockResolvedValue(ok({ object: "domain", id: "d_1", deleted: true }));
  });

  it("fails with confirmation_required when not interactive and --yes is missing", async () => {
    const { stderr } = spies();
    expect(await run(remove(), ["d_1"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("confirmation_required");
    expect(method("domains.remove")).not.toHaveBeenCalled();
  });

  it("deletes with --yes", async () => {
    const { stdout } = spies();
    expect(await run(remove(), ["d_1", "--yes"])).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ deleted: true });
  });

  it("asks on a terminal and exits 130 when declined", async () => {
    setInteractive();
    spies();
    confirmAnswer.value = true;
    expect(await run(remove(), ["d_1"])).toBe(0);
    expect(method("domains.remove")).toHaveBeenCalledTimes(1);
    confirmAnswer.value = false;
    expect(await run(remove(), ["d_1"])).toBe(130);
    expect(method("domains.remove")).toHaveBeenCalledTimes(1);
  });
});
