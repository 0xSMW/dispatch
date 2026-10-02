import { seal } from "@dispatchmail/core";
import { describe, expect, it, vi } from "vitest";
import { loadSharedEmail, readShareToken, shareExpiry, shareToken } from "./share.js";

describe("share links", () => {
  it("seals a sent email for 48 hours and rejects a file token or a longer window", () => {
    const now = Date.now();
    const exp = shareExpiry(undefined, now);
    expect(exp).toBe(Math.floor(now / 1000) + 48 * 60 * 60);
    expect(shareExpiry("10m", now) - Math.floor(now / 1000)).toBe(600);
    expect(() => shareExpiry("3 days", now)).toThrow(/48 hours/);

    const token = shareToken({ tenantId: "tenant_1", emailId: "email_1", kind: "sent", exp }, "secret");
    expect(readShareToken(token, "secret")).toMatchObject({
      use: "share",
      tenant_id: "tenant_1",
      email_id: "email_1",
      kind: "sent",
    });
    const file = seal({ use: "file", key: "raw/tenant_1/email_1", exp }, "secret");
    expect(readShareToken(file, "secret")).toBeNull();
    expect(readShareToken(token, "other")).toBeNull();
  });

  it("loads the original html for the tenant and email named in the token", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        subject: "Hello",
        from_email: "ada@example.com",
        from_name: "Ada",
        created_at: "2026-07-01T00:00:00.000Z",
        html: "<p>Hi</p>",
        text: "Hi",
        recipients: ["you@example.net"],
      }],
    }));
    const email = await loadSharedEmail({ query }, { tenant_id: "tenant_1", email_id: "email_1", kind: "sent" });
    expect(String(query.mock.calls[0][0])).toContain("from emails");
    expect(query.mock.calls[0][1]).toEqual(["tenant_1", "email_1"]);
    expect(email).toEqual({
      subject: "Hello",
      from: "Ada <ada@example.com>",
      to: ["you@example.net"],
      created_at: "2026-07-01T00:00:00.000Z",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await loadSharedEmail({ query }, { tenant_id: "tenant_1", email_id: "missing", kind: "received" })).toBeNull();
    expect(String(query.mock.calls[1][0])).toContain("from received_emails");
  });
});
