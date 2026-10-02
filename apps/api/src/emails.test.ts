import { describe, expect, it } from "vitest";
import { emailWhere } from "./emails.js";

describe("email list filters", () => {
  it("returns no clause when nothing is filtered", () => {
    expect(emailWhere({})).toEqual({ where: undefined, params: [] });
  });

  it("numbers parameters from $2 and maps Resend status names", () => {
    const filters = emailWhere({ status: "canceled", from: "2026-09-01", to: "2026-09-30T23:59:59Z", api_key_id: "key_1" });
    expect(filters.where).toBe(
      "e.status = any($2::text[]) and e.created_at >= $3 and e.created_at <= $4 and e.api_key_id = $5",
    );
    expect(filters.params).toEqual([["cancelled"], "2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.000Z", "key_1"]);
    expect(emailWhere({ status: "sent" }).params).toEqual([["sent", "submitted"]]);
  });

  it("searches subject and recipients with one escaped pattern", () => {
    const filters = emailWhere({ q: " 50%_off " });
    expect(filters.params).toEqual(["%50\\%\\_off%"]);
    expect(filters.where).toContain("e.subject ilike $2");
    expect(filters.where).toContain("rq.email ilike $2");
  });

  it("rejects a date it cannot parse", () => {
    expect(() => emailWhere({ from: "yesterday-ish" })).toThrow("from must be a date");
  });
});
