import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard, type Flags } from "../../../lib/actions.js";
import { requireClient, unwrap, type Api } from "../../../lib/client.js";
import { CliError } from "../../../lib/errors.js";
import { helpText } from "../../../lib/help.js";
import { status } from "../../../lib/output.js";
import { timing } from "../../../lib/retry.js";
import { safe } from "../../../lib/safe.js";
import { jsonMode } from "../../../lib/tty.js";
import type { Received } from "./list.js";

export type Poller = { api: Api; interval: number; globals: Flags; stopped: () => boolean };

const seenLimit = 1000;

// Poll for new received emails. The first page is the baseline; later arrivals print.
export async function poll({ api, interval, globals, stopped }: Poller) {
  const seen = new Set<string>();
  let first = true;
  let failures = 0;
  let newest: string | undefined;
  while (!stopped()) {
    try {
      const page = await unwrap<{ data: Received[]; has_more?: boolean }>(api.emails.receiving.list({ limit: 100 }));
      failures = 0;
      let arrivals = [...page.data].reverse();
      // A whole page of new mail means more arrived than one page holds. Walk forward from the
      // last one seen instead.
      if (!first && newest && page.has_more && page.data.length > 0 && page.data.every((email) => !seen.has(email.id))) {
        arrivals = [];
        let cursor = newest;
        for (let more = true; more; ) {
          const next = await unwrap<{ data: Received[]; has_more?: boolean }>(api.emails.receiving.list({ limit: 100, before: cursor }));
          arrivals.push(...[...next.data].reverse());
          if (next.data.length) cursor = next.data[0]!.id;
          more = Boolean(next.has_more) && next.data.length > 0;
        }
      }
      if (page.data.length) newest = page.data[0]!.id;
      for (const email of arrivals) {
        if (seen.has(email.id)) continue;
        seen.add(email.id);
        if (first) continue;
        if (jsonMode(globals)) console.log(JSON.stringify(email));
        else {
          const time = new Date(email.created_at ?? Date.now()).toLocaleTimeString();
          console.log(
            `${pc.dim(time)}  ${safe(email.from)} → ${safe([email.to].flat().join(", "))}  ${safe(email.subject)}  ${pc.dim(safe(email.id))}`,
          );
        }
      }
      first = false;
      while (seen.size > seenLimit) seen.delete(seen.values().next().value!);
    } catch (error) {
      failures += 1;
      if (failures >= 5) throw error;
      status(pc.yellow(`Request failed (${failures}/5): ${safe((error as Error).message)}`), globals);
    }
    if (!stopped()) await timing.sleep(interval * 1000);
  }
}

export const listen = new Command("listen")
  .description("Watch for new received emails")
  .option("--interval <seconds>", "Seconds between polls, minimum 2", "5")
  .addHelpText(
    "after",
    helpText({
      output: "One line per new email on a terminal. One JSON object per line (NDJSON) when piped.",
      codes: ["invalid_interval", "listen_error"],
      examples: ["dispatch emails receiving listen", "dispatch emails receiving listen --interval 10 | jq .subject"],
    }),
  )
  .action(async (options, command) => {
    await guard(command, "listen_error", async (globals) => {
      const interval = Number(options.interval);
      if (!Number.isFinite(interval) || interval < 2) {
        throw new CliError("invalid_interval", "--interval must be a number of seconds, 2 or more");
      }
      const api = requireClient(globals);
      let stop = false;
      process.once("SIGINT", () => {
        stop = true;
        process.exit(130);
      });
      status(pc.dim(`Watching for received emails every ${interval}s. Press Ctrl+C to stop.`), globals);
      await poll({ api, interval, globals, stopped: () => stop });
    });
  });
