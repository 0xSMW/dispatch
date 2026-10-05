/** Same bounded in-process TTL substrate as the API's domain cache. */
export class SegmentCounts {
  private values = new Map<string, { expires: number; count: number }>();

  async get(tenantId: string, segmentId: string, revision: string, load: () => Promise<number>, now = Date.now()) {
    const key = JSON.stringify([tenantId, segmentId, revision]);
    const cached = this.values.get(key);
    if (cached && cached.expires > now) return cached.count;
    const count = await load();
    if (this.values.size >= 1000) this.values.delete(this.values.keys().next().value!);
    this.values.set(key, { count, expires: now + 30_000 });
    return count;
  }

  invalidate(tenantId: string, segmentId: string) {
    for (const key of this.values.keys()) {
      const [tenant, segment] = JSON.parse(key) as string[];
      if (tenant === tenantId && segment === segmentId) this.values.delete(key);
    }
  }
}
