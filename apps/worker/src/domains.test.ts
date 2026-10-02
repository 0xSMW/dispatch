import { describe, expect, it, vi } from "vitest";
import { dnsRecords } from "@dispatchmail/provider-ses";
import { verifyDueDomains } from "./domains.js";

describe("verifyDueDomains", () => {
  it("verifies a pending domain when SES and DNS agree, and waits a minute before polling again", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const records = dnsRecords({ name: "example.com", region: "us-east-1", tokens: ["aaa"] });
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("from domains")) {
          return { rows: [{ id: "domain_1", tenant_id: "tenant_1", name: "example.com", region: "us-east-1", status: "pending", records, sending: "enabled", receiving: "disabled", verify_started_at: new Date().toISOString() }] };
        }
        if (sql.includes("insert into email_events")) {
          return { rows: [{ id: "event_1", tenant_id: params[1], request_id: params[2], email_id: null, type: params[5], data: {} }] };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    const state = { last: 0 };
    const deps = {
      now: 70_000,
      read: async () => ({ dkimStatus: "SUCCESS" }),
      resolvers: {
        resolveCname: async (host: string) => (host.startsWith("aaa.") ? ["aaa.dkim.amazonses.com"] : ["links.localhost"]),
        resolveMx: async () => [{ exchange: "feedback-smtp.us-east-1.amazonses.com", priority: 10 }],
        resolveTxt: async (host: string) => host.startsWith("_dmarc") ? [["v=DMARC1; p=none;"]] : [["v=spf1 include:amazonses.com ~all"]],
        resolveNs: async () => ["ns-1.awsdns-01.org"]
      }
    };
    await expect(verifyDueDomains(db, deps, state)).resolves.toBe(1);
    const update = queries.find((query) => query.sql.includes("update domains"));
    expect(update?.params[2]).toBe("verified");
    // The DNS host is saved on the same pass, for the dashboard's domain page.
    expect(update?.sql).toContain("dns_provider = coalesce($5, dns_provider)");
    expect(update?.params[4]).toBe("Route 53");
    const saved = JSON.parse(String(update?.params[3])) as Array<{ record: string; status: string }>;
    expect(saved.find((record) => record.record === "DKIM")?.status).toBe("verified");
    expect(saved.find((record) => record.record === "DMARC")?.status).toBe("verified");
    expect(queries.some((query) => query.params.includes("domain.updated"))).toBe(true);
    await expect(verifyDueDomains(db, { ...deps, now: 80_000 }, state)).resolves.toBe(0);
  });

  it("skips a domain whose identity cannot be read and still verifies the next one", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const row = (id: string, name: string) => ({
      id,
      tenant_id: "tenant_1",
      name,
      region: "us-east-1",
      status: "pending",
      records: dnsRecords({ name, region: "us-east-1", tokens: ["aaa"] }),
      sending: "enabled",
      receiving: "disabled",
      verify_started_at: new Date().toISOString()
    });
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("from domains")) return { rows: [row("domain_1", "gone.com"), row("domain_2", "example.com")] };
        if (sql.includes("insert into email_events")) {
          return { rows: [{ id: "event_1", tenant_id: params[1], request_id: params[2], email_id: null, type: params[5], data: {} }] };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    const errors: string[] = [];
    const changed = await verifyDueDomains(db, {
      now: 70_000,
      read: async (name) => {
        if (name === "gone.com") throw new Error("NotFoundException");
        return { dkimStatus: "SUCCESS" };
      },
      resolvers: { resolveCname: async () => [], resolveMx: async () => [], resolveTxt: async () => [] },
      onError: (domain) => errors.push(domain.name)
    }, { last: 0 });
    expect(changed).toBe(1);
    expect(errors).toEqual(["gone.com"]);
    expect(queries[0].sql).toContain("order by checked_at asc nulls first");
    expect(queries[0].params).toEqual([50]);
    const verified = queries.find((query) => query.sql.includes("set status") && query.params[1] === "domain_2");
    expect(verified?.params[2]).toBe("verified");
    expect(queries.some((query) => query.sql.includes("set checked_at") && query.params[1] === "domain_1")).toBe(true);
  });
});
