import { Command, Option } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { collect, compact, csv, many } from "../../lib/json.js";

export const metrics = new Command("metrics")
  .description("Show sending metrics over time")
  .option("--start-date <date>", "Start of the range, such as 2026-09-01")
  .option("--end-date <date>", "End of the range")
  .option("--timezone <tz>", "IANA time zone for bucketing, such as Europe/Berlin")
  .addOption(new Option("--granularity <unit>", "Bucket size").choices(["hourly", "daily", "weekly", "monthly"] as const))
  .option("--metrics <names>", "Comma-separated metric names, such as sent,delivered,bounced")
  .option("--dimensions <names>", "Comma-separated dimensions to group by")
  .option("--domain-id <id>", "Only this domain. Repeatable", collect)
  .option("--email-id <id>", "Only this email. Repeatable", collect)
  .option("--broadcast-id <id>", "Only this broadcast. Repeatable", collect)
  .addHelpText(
    "after",
    helpText({
      output: "The metrics response from GET /emails/metrics, as JSON.",
      codes: ["fetch_error", "validation_error"],
      examples: ["dispatch emails metrics --start-date 2026-09-01 --granularity daily --metrics sent,delivered"],
    }),
  )
  .action(async (options, command) => {
    await runGet(command, {
      call: (api) =>
        api.emails.metrics(
          compact({
            startDate: options.startDate,
            endDate: options.endDate,
            timezone: options.timezone,
            granularity: options.granularity,
            metrics: csv(options.metrics),
            dimensions: csv(options.dimensions),
            domainId: many(options.domainId),
            emailId: many(options.emailId),
            broadcastId: many(options.broadcastId),
          }),
        ),
      human: (data) => console.log(JSON.stringify(data, null, 2)),
    });
  });
