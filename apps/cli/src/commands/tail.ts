import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard, type Flags } from "../lib/actions.js";
import { requireClient, unwrap, type Api } from "../lib/client.js";
import { CliError } from "../lib/errors.js";
import { helpText } from "../lib/help.js";
import { status } from "../lib/output.js";
import { timing } from "../lib/retry.js";
import { safe } from "../lib/safe.js";
import { jsonMode } from "../lib/tty.js";

type Email = { id: string; to?: string[] | string; subject?: string; last_event?: string; created_at?: string };

const terminal = new Set(["delivered", "bounced", "complained", "failed", "canceled", "suppressed"]);
const watchLimit = 25;
// Single lookups per poll for watched emails that are no longer on the newest page.
const lookups = 3;
const seenLimit = 1000;

export type TailState = { newest?: string; watching: Map<string, string>; seen?: Set<string> };

function print(email: Email, globals: Flags) {
  if (jsonMode(globals)) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        id: email.id,
        last_event: email.last_event,
        subject: email.subject,
        to: email.to,
      }),
    );
    return;
  }
  const time = pc.dim(new Date().toLocaleTimeString());
  console.log(
    `${time}  ${pc.bold(safe(email.last_event ?? "").padEnd(10))} ${safe([email.to ?? []].flat().join(", "))}  ${safe(email.subject)}  ${pc.dim(safe(email.id))}`,
  );
}

// One poll is one list call in the usual case. The tenant has one rate limit for all its keys,
// so a tail that asked about each watched email on its own would use up the limit the
// application needs for sending.
//
// The newest page shows both new emails and the current status of recent ones. An email that
// committed late, behind a newer one, is still on that page and is caught by its ID. Only a
// watched email that has fallen off the page costs a lookup, and at most three per poll.
export async function step(api: Api, state: TailState, globals: Flags) {
  const first = !state.seen;
  const seen = (state.seen ??= new Set<string>());
  const page = await unwrap<{ data: Email[]; has_more: boolean }>(api.emails.list({ limit: 100 }));
  // On the first poll the newest ten are shown and the rest are only remembered.
  const unseen = page.data.filter((email) => !seen.has(email.id));
  const fresh = (first ? unseen.slice(0, 10) : unseen).reverse();
  for (const email of page.data) seen.add(email.id);

  // A whole page of new mail means there is more behind it. Walk forward from the last cursor.
  if (!first && state.newest && unseen.length === page.data.length && page.data.length > 0 && page.has_more) {
    fresh.length = 0;
    let cursor = state.newest;
    let more = true;
    while (more) {
      const next = await unwrap<{ data: Email[]; has_more: boolean }>(api.emails.list({ limit: 100, before: cursor }));
      fresh.push(...[...next.data].reverse());
      for (const email of next.data) seen.add(email.id);
      if (next.data.length) cursor = next.data[0]!.id;
      more = next.has_more && next.data.length > 0;
    }
  }

  for (const email of fresh) {
    print(email, globals);
    state.watching.set(email.id, email.last_event ?? "");
  }
  if (page.data.length) state.newest = page.data[0]!.id;

  const current = new Map(page.data.map((email) => [email.id, email]));
  const shown = new Set(fresh.map((email) => email.id));
  const offPage: string[] = [];
  for (const [id, last] of [...state.watching]) {
    if (shown.has(id)) continue;
    const email = current.get(id);
    if (!email) {
      offPage.push(id);
    } else if (email.last_event !== last) {
      print(email, globals);
      state.watching.set(id, email.last_event ?? "");
    }
  }
  for (const id of offPage.slice(0, lookups)) {
    const last = state.watching.get(id);
    const email = await unwrap<Email>(api.emails.get(id));
    // Moved to the back, so the next poll looks up the ones that waited.
    state.watching.delete(id);
    state.watching.set(id, email.last_event ?? "");
    if (email.last_event !== last) print(email, globals);
  }
  for (const [id, last] of state.watching) if (terminal.has(last)) state.watching.delete(id);
  while (state.watching.size > watchLimit) state.watching.delete(state.watching.keys().next().value!);
  while (seen.size > seenLimit) seen.delete(seen.values().next().value!);
}

export const tail = new Command("tail")
  .description("Stream new emails and their status changes (Dispatch only)")
  .option("--interval <seconds>", "Seconds between polls, 1 at least", "2")
  .addHelpText(
    "after",
    helpText({
      output: "One line per change on a terminal. NDJSON when piped.",
      codes: ["invalid_interval", "tail_error"],
      examples: ["dispatch tail", "dispatch tail --json | jq .last_event"],
    }),
  )
  .action(async (options, command) => {
    await guard(command, "tail_error", async (globals) => {
      const interval = Number(options.interval);
      if (!Number.isFinite(interval) || interval < 1)
        throw new CliError("invalid_interval", "--interval must be 1 second or more");
      const api = requireClient(globals);
      const state: TailState = { watching: new Map<string, string>() };
      process.once("SIGINT", () => process.exit(130));
      status(pc.dim("Tailing emails. Press Ctrl+C to stop."), globals);
      // One failed poll is not the end: wait longer and try again. Five in a row is.
      let failures = 0;
      for (;;) {
        try {
          await step(api, state, globals);
          failures = 0;
        } catch (error) {
          failures += 1;
          if (failures >= 5) throw error;
          status(pc.dim(`Poll failed (${safe(error instanceof Error ? error.message : String(error))}). Retrying.`), globals);
        }
        await timing.sleep(Math.min(interval * 2 ** failures, 30) * 1000);
      }
    });
  });
