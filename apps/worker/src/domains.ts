import { emit, type Queryable } from "@dispatchmail/db";
import { checkRecords, dnsProvider, planDomainUpdate, type DnsRecord, type Resolvers } from "@dispatchmail/provider-ses";

export type PendingDomain = {
  id: string;
  tenant_id: string;
  name: string;
  region: string;
  status: string;
  records: DnsRecord[];
  sending: string;
  receiving: string;
  verify_started_at: string | null;
};

export async function verifyDueDomains(
  db: Queryable,
  deps: {
    now?: number;
    read: (name: string, region: string) => Promise<{ dkimStatus: string }>;
    resolvers: Resolvers;
    minIntervalMs?: number;
    limit?: number;
    onError?: (domain: PendingDomain, error: unknown) => void;
  },
  state: { last: number }
) {
  const now = deps.now ?? Date.now();
  if (now - state.last < (deps.minIntervalMs ?? 60_000)) return 0;
  state.last = now;
  // Oldest check first, so a domain that keeps failing cannot hold the rest back.
  const domains = await db.query<PendingDomain>(
    `select id, tenant_id, name, region, status, records, sending, receiving, verify_started_at
     from domains
     where deleted_at is null and status in ('pending', 'temporary_failure')
     order by checked_at asc nulls first, id
     limit $1`,
    [deps.limit ?? 50]
  );
  let changed = 0;
  for (const domain of domains.rows) {
    try {
      const identity = await deps.read(domain.name, domain.region);
      const checks = await checkRecords(domain.records ?? [], deps.resolvers);
      const receivingVerified = domain.receiving !== "enabled" || checks.some((check) => check.record === "Receiving MX" && check.status === "ok");
      const plan = planDomainUpdate({
        records: domain.records ?? [],
        checks,
        dkimStatus: identity.dkimStatus,
        sendingEnabled: domain.sending !== "disabled",
        receivingEnabled: domain.receiving === "enabled",
        receivingVerified,
        verifyStartedAt: domain.verify_started_at,
        now
      });
      // Written on every pass: record statuses change before the domain status does, and
      // checked_at moves the domain to the back of the queue.
      // The DNS host is read on the way, for the dashboard. A failed lookup keeps the last answer.
      const host = await dnsProvider(domain.name, deps.resolvers);
      await db.query(
        "update domains set status = $3, records = $4, dns_provider = coalesce($5, dns_provider), checked_at = now() where tenant_id = $1 and id = $2",
        [domain.tenant_id, domain.id, plan.status, JSON.stringify(plan.records), host]
      );
      if (plan.status === domain.status) continue;
      await emit(db, {
        tenantId: domain.tenant_id,
        requestId: `verify_${domain.id}_${plan.status}`,
        type: "domain.updated",
        resourceId: domain.id,
        data: { id: domain.id, status: plan.status }
      });
      changed += 1;
    } catch (error) {
      // A missing identity or a throttled call skips this domain and leaves the others to run.
      deps.onError?.(domain, error);
      await db
        .query("update domains set checked_at = now() where tenant_id = $1 and id = $2", [domain.tenant_id, domain.id])
        .catch(() => undefined);
    }
  }
  return changed;
}
