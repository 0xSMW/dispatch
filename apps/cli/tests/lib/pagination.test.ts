import { Command } from "@commander-js/extra-typings";
import { describe, expect, it, vi } from "vitest";
import { nextPageHint, page, pageOptions } from "../../src/lib/pagination.js";

describe("page", () => {
  it("defaults to 10 and passes one cursor through", () => {
    expect(page({})).toEqual({ limit: 10 });
    expect(page({ limit: "25", after: "a" })).toEqual({ limit: 25, after: "a" });
    expect(page({ limit: "100", before: "b" })).toEqual({ limit: 100, before: "b" });
  });

  it.each(["0", "101", "1.5", "-1", "ten"])("rejects --limit %s with invalid_limit", (limit) => {
    expect(() => page({ limit })).toThrowError(expect.objectContaining({ code: "invalid_limit" }));
  });

  it("rejects both cursors with invalid_pagination", () => {
    expect(() => page({ after: "a", before: "b" })).toThrowError(expect.objectContaining({ code: "invalid_pagination" }));
  });
});

describe("nextPageHint", () => {
  it("prints the exact next command, positional arguments included", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const group = new Command("segments");
    const contacts = pageOptions(new Command("contacts"))
      .argument("[id]")
      .action(() => undefined);
    group.addCommand(contacts);
    await group.parseAsync(["contacts", "seg_1", "--limit", "5"], { from: "user" });
    nextPageHint(contacts, "ct_9", { limit: "5" });
    expect(log.mock.calls[0]![0]).toContain("dispatch segments contacts seg_1 --limit 5 --after ct_9");
    nextPageHint(contacts, "ct_1", { limit: "5", before: "x" });
    expect(log.mock.calls[1]![0]).toContain("--before ct_1");
    log.mockRestore();
  });

  it("keeps the filters and the global flags, quoted for the shell", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = new Command("dispatch").option("-p, --profile <name>").option("--api-key <key>").option("--json");
    const group = new Command("emails");
    const listing = pageOptions(new Command("list"))
      .option("--status <status>")
      .option("--query <text>")
      .option("--mine")
      .action(() => undefined);
    group.addCommand(listing);
    root.addCommand(group);
    await root.parseAsync(["-p", "prod", "--api-key", "sk_secret", "emails", "list", "--status", "bounced", "--query", "it's here", "--mine"], {
      from: "user",
    });
    nextPageHint(listing, "email_9", {});
    const hint = log.mock.calls[0]![0] as string;
    expect(hint).toContain(`dispatch emails list --status bounced --query 'it'\\''s here' --mine --profile prod --limit 10 --after email_9`);
    expect(hint).not.toContain("sk_secret");
    log.mockRestore();
  });
});
