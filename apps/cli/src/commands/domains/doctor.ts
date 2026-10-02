import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { unwrap } from "../../lib/client.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { renderTable } from "../../lib/table.js";

type Check = { name?: string; type?: string; status?: string; ok?: boolean; message?: string; detail?: string };

export const doctor = new Command("doctor")
  .description("Check a domain's DNS readiness (defaults to the first domain)")
  .argument("[id]", "Domain ID")
  .addHelpText(
    "after",
    helpText({
      output: "The domain's readiness checks as JSON.",
      codes: ["not_found", "fetch_error"],
      examples: ["dispatch domains doctor", "dispatch domains doctor domain_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runGet(command, {
      call: async (api) => {
        const target = id ?? (await unwrap(api.domains.list({ limit: 1 }))).data[0]?.id;
        if (!target) throw new CliError("not_found", "No domain found");
        return api.domains.doctor(target);
      },
      human: (report: { checks?: Check[] } & Record<string, unknown>) => {
        const checks = report.checks ?? [];
        if (!checks.length) return console.log(JSON.stringify(report, null, 2));
        console.log(
          renderTable(
            ["Check", "Status", "Detail"],
            checks.map((check) => [
              check.name ?? check.type,
              check.status ?? (check.ok ? "pass" : "fail"),
              check.message ?? check.detail ?? "",
            ]),
          ),
        );
      },
    });
  });
