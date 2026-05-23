import "dotenv/config";

const apiUrl = process.env.API_URL ?? "http://localhost:3100";
const apiKey = process.env.DISPATCH_API_KEY ?? "sk_local_dispatch_dev_key_change_before_deploy";
const count = numberArg("--count", 50);
const concurrency = numberArg("--concurrency", 10);
const useIdempotency = !process.argv.includes("--no-idempotency");

let next = 0;
const latencies: number[] = [];
const errors: string[] = [];
const statuses = new Map<number, number>();

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const durationMs = Math.round(performance.now() - started);

latencies.sort((a, b) => a - b);
const result = {
  count,
  ok: latencies.length,
  errors: errors.length,
  duration_ms: durationMs,
  rps: Number((latencies.length / (durationMs / 1000)).toFixed(2)),
  idempotency: useIdempotency,
  statuses: Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left - right)),
  p50_ms: percentile(50),
  p90_ms: percentile(90),
  p95_ms: percentile(95),
  p99_ms: percentile(99),
  max_ms: latencies.at(-1) ?? 0
};

console.log(JSON.stringify(result, null, 2));
if (errors.length) {
  console.error(errors.slice(0, 5).join("\n"));
  process.exitCode = 1;
}

async function worker() {
  while (next < count) {
    const index = next++;
    const started = performance.now();
    try {
      const response = await fetch(`${apiUrl}/v1/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(useIdempotency ? { "idempotency-key": `load-${Date.now()}-${index}` } : {})
        },
        body: JSON.stringify({
          from: "hello@example.com",
          to: `load-${index}@example.com`,
          subject: `Dispatch load ${index}`,
          text: "Local load test."
        })
      });
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      await response.json();
      latencies.push(Math.round(performance.now() - started));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

function percentile(value: number) {
  if (latencies.length === 0) return 0;
  const index = Math.min(latencies.length - 1, Math.ceil((value / 100) * latencies.length) - 1);
  return latencies[index];
}

function numberArg(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
