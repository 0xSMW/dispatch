import { createHook, sleep } from "workflow";
import { resumeHook, start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";

const wakeToken = "dispatch:worker";

export async function processWork() {
  "use workflow";

  using wake = createHook<null>({ token: wakeToken });
  const conflict = await wake.getConflict();
  if (conflict) {
    // A concurrent start can race hook registration. Route that wake to the owning run.
    await notifyWorker();
    return;
  }
  const wakes = wake[Symbol.asyncIterator]();
  let incoming = wakes.next().then(() => true, () => false);
  // Bounded history keeps a long-running broadcast/import from accumulating one huge run.
  for (let pass = 0; pass < 128; pass += 1) {
    const result = await processBatch();
    if (!result.nextAt) {
      wake[Symbol.dispose]();
      // A writer may have resumed the hook between the last DB query and disposal. Recheck
      // after disposal: later writers start a fresh run, and earlier writers are found here.
      if (await pendingWork()) await continueWork();
      return;
    }
    const resumed = await Promise.race([
      sleep(new Date(result.nextAt)).then(() => false),
      incoming,
    ]);
    if (resumed) incoming = wakes.next().then(() => true, () => false);
  }
  wake[Symbol.dispose]();
  await continueWork();
}

async function processBatch() {
  "use step";
  const { runTick } = await import("../../../worker/src/runtime.js");
  return runTick();
}

async function continueWork() {
  "use step";
  const run = await start(processWork, []);
  return run.runId;
}

async function pendingWork() {
  "use step";
  const { nextWorkAt } = await import("../../../worker/src/runtime.js");
  const { connect } = await import("@dispatchmail/db");
  const db = connect();
  try {
    return Boolean(await nextWorkAt(db));
  } finally {
    await db.end();
  }
}

async function notifyWorker() {
  "use step";
  return wakeWorker();
}

// Call only after the transaction that queued/woke work commits. The caller must await this
// enqueue (or register it with Vercel waitUntil) so the function cannot freeze before it runs.
export async function wakeWorker() {
  try {
    const hook = await resumeHook(wakeToken, null);
    return hook.runId;
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
  const run = await start(processWork, []);
  return run.runId;
}
