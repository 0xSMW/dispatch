import { describe, expect, it, vi } from "vitest";
import { emailCommand, rankCommands, searchRecords, type Command } from "./commands";
import { ApiError, type Client } from "./client";

const command = (label: string): Command => ({ id: label, label, detail: "Open page", group: "Pages" });
describe("command matching", () => {
  it("ranks exact names ahead of prefixes and matches every word", () => {
    expect(rankCommands([command("Email logs"), command("Emails"), command("Email")], "email").map((r) => r.label)).toEqual(["Email", "Email logs", "Emails"]);
    expect(rankCommands([command("API keys"), command("API reference")], "keys api").map((r) => r.label)).toEqual(["API keys"]);
  });
  it("translates status, recipient, and date intent without dropping unknown words", () => {
    const result = emailCommand("show bounced emails this week", new Date(2026, 9, 8));
    expect(result?.to).toBe("/emails?range=custom&start=2026-10-05&end=2026-10-08&status=bounced");
    expect(result?.detail).toContain("Status: bounced");
    expect(emailCommand("emails to ada@example.com last 7 days")?.to).toBe("/emails?range=7d&q=ada%40example.com");
    expect(emailCommand("emails to ada@example.com")?.detail).toBe("Recipient or subject: ada@example.com");
    expect(emailCommand("emails yesterday")?.to).toBe("/emails?range=yesterday");
    expect(emailCommand("bounced emails last month")).toBeNull();
    expect(emailCommand("delete failed emails today")).toBeNull();
  });
  it("searches only bounded tenant endpoints and keeps partial results on failure", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/domains") throw new Error("offline");
      if (path === "/emails") return { data: [{ id: "email_1", subject: "Receipt", to: ["bob@example.com"], cc: ["ada@example.com"] }] };
      if (path === "/broadcasts") return { data: [{ id: "broadcast_1", name: "Onboarding", subject: "Ada welcome" }] };
      if (path === "/contacts") return { data: [{ id: "contact_1", email: "ada@example.com", first_name: "Ada" }] };
      return { data: [] };
    });
    const result = await searchRecords({ get } as unknown as Client, "Ada");
    expect(get).toHaveBeenCalledTimes(6);
    expect(get).toHaveBeenCalledWith("/emails", { q: "Ada", limit: 5 });
    expect(result.commands.map((row) => row.to)).toContain("/audience/contacts/contact_1");
    expect(result.commands.map((row) => row.to)).toContain("/broadcasts/broadcast_1");
    expect(result.commands.map((row) => row.to)).toContain("/emails/email_1");
    expect(result.failed).toEqual(["Domain"]);
  });
  it("resolves an exact resource id through its detail endpoint", async () => {
    const get = vi.fn().mockResolvedValue({ id: "automation_abc", name: "Welcome", status: "enabled" });
    const result = await searchRecords({ get } as unknown as Client, "automation_abc");
    expect(get).toHaveBeenCalledExactlyOnceWith("/automations/automation_abc");
    expect(result.commands[0].related?.map((r) => r.to)).toEqual(["/automations/automation_abc/editor", "/automations/automation_abc/editor?tab=runs", "/automations/automation_abc/editor?tab=metrics"]);
    get.mockRejectedValue(new ApiError("not_found", 404, "Missing"));
    expect(await searchRecords({ get } as unknown as Client, "automation_missing")).toEqual({ commands: [], failed: [] });
  });
});
