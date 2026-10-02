import { describe, expect, it } from "vitest";
import { broadcastWhere, contactWhere, domainWhere, receivedWhere, runWhere, suppressionWhere, templateWhere } from "./filters.js";

describe("list filters", () => {
  it("numbers parameters from $2 and escapes like wildcards", () => {
    expect(templateWhere({})).toEqual({ where: undefined, params: [] });
    expect(templateWhere({ q: "50%_off", status: "draft" })).toEqual({
      where: "(t.name ilike $2 or t.alias ilike $2) and t.published_version_id is null",
      params: ["%50\\%\\_off%"],
    });
    expect(templateWhere({ status: "published" }).where).toBe("t.published_version_id is not null");
    expect(() => templateWhere({ status: "live" })).toThrow(/draft or published/);
  });

  it("maps the broadcast statuses the API shows to the stored states", () => {
    expect(broadcastWhere({ status: "queued,canceled", segment_id: "segment_1" })).toEqual({
      where: "status = any($2::text[]) and segment_id = $3",
      params: [["sending", "paused", "cancelled"], "segment_1"],
    });
    expect(() => broadcastWhere({ status: "sending" })).toThrow(/status must be one of/);
  });

  it("filters contacts by segment, text, and subscription", () => {
    const built = contactWhere({ segment_id: "segment_1", q: "ada", subscribed: "false" });
    expect(built.params).toEqual(["segment_1", "%ada%"]);
    expect(built.where).toContain("sc.segment_id = $2");
    expect(built.where).toContain("email ilike $3 or first_name ilike $3 or last_name ilike $3");
    expect(built.where).toContain("unsubscribed_at is not null");
    expect(contactWhere({ subscribed: "true" }).where).toBe("unsubscribed_at is null");
    expect(() => contactWhere({ subscribed: "maybe" })).toThrow(/true or false/);
  });

  it("filters domains, received emails, and suppressions", () => {
    expect(domainWhere({ q: "acme", status: "verified,pending", region: "eu-west-1" })).toEqual({
      where: "name ilike $2 and status = any($3::text[]) and region = $4",
      params: ["%acme%", ["verified", "pending"], "eu-west-1"],
    });
    expect(receivedWhere({ q: "invoice", from: "2026-10-01" })).toEqual({
      where:
        "(m.subject ilike $2 or m.from_email ilike $2 or exists (select 1 from received_recipients r where r.received_email_id = m.id and r.email ilike $2)) and m.created_at >= $3",
      params: ["%invoice%", "2026-10-01T00:00:00.000Z"],
    });
    expect(suppressionWhere({})).toEqual({ where: "removed_at is null", params: [] });
    // A bare end date covers that whole day. A timestamp is taken as given.
    expect(suppressionWhere({ origin: "bounce", q: "bob@", to: "2026-10-02" })).toEqual({
      where: "removed_at is null and origin = $2 and email ilike $3 and created_at < $4",
      params: ["bounce", "%bob@%", "2026-10-03T00:00:00.000Z"],
    });
    expect(suppressionWhere({ to: "2026-10-02T12:00:00Z" })).toEqual({
      where: "removed_at is null and created_at <= $2",
      params: ["2026-10-02T12:00:00.000Z"],
    });
  });

  it("puts run date bounds after the automation id and the states", () => {
    expect(runWhere(null, {})).toEqual({ where: "r.automation_id = $2", params: [] });
    const dated = runWhere(["failed"], { start_date: "2026-10-01", end_date: "2026-10-02T00:00:00Z" });
    expect(dated.where).toBe("r.automation_id = $2 and r.state = any($3) and r.created_at >= $4 and r.created_at <= $5");
    expect(runWhere(null, { end_date: "2026-10-02" })).toEqual({
      where: "r.automation_id = $2 and r.created_at < $3",
      params: ["2026-10-03T00:00:00.000Z"],
    });
    expect(dated.params).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
    expect(runWhere(null, { start_date: "2026-10-01" }).where).toBe("r.automation_id = $2 and r.created_at >= $3");
    expect(() => runWhere(null, { start_date: "soon" })).toThrow(/start_date must be a date/);
  });
});
