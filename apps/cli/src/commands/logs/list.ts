import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pageOptions } from "../../lib/pagination.js";

type Log = { id: string; method: string; endpoint: string; response_status: number; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List API request logs")
  .option("--status <code>", "Only this response status, such as 422")
  .option("--user-agent <text>", "Only requests from this user agent")
  .option("--api-key-id <id>", "Only requests made with this key")
  .option("--from <time>", "Start of the time range")
  .option("--to <time>", "End of the time range")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":true,"data":[{"id":"...","method":"POST","endpoint":"/emails","response_status":200}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch logs", "dispatch logs list --status 422 --limit 50"],
    }),
  )
  .action(async (options, command) => {
    await runList<Log>(command, {
      call: (api, page) =>
        api.logs.list({
          ...page,
          ...compact({
            status: options.status,
            user_agent: options.userAgent,
            api_key_id: options.apiKeyId,
            from: options.from,
            to: options.to,
          }),
        }),
      columns: ["Method", "Endpoint", "Status", "At", "ID"],
      row: (log) => [log.method, log.endpoint, log.response_status, log.created_at, log.id],
      empty: "(no logs)",
    });
  });
