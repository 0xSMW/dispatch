import { Command, Option } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pageOptions } from "../../lib/pagination.js";

type Automation = {
  id: string;
  name: string;
  status?: string;
  enabled?: boolean;
  trigger?: string | null;
  trigger_config?: { type?: string; event_name?: string; field?: string; from?: unknown; to?: unknown; topic_id?: string; segment_id?: string };
  created_at: string;
};

function triggerLabel(item: Automation): string {
  const config = item.trigger_config;
  switch (config?.type) {
    case "contact_created": return "Contact added";
    case "contact_updated": {
      if (!config.field) return "Contact changes: any change";
      const values = [
        ...("from" in config ? [`from ${JSON.stringify(config.from)}`] : []),
        ...("to" in config ? [`to ${JSON.stringify(config.to)}`] : []),
      ];
      return `Contact changes: ${config.field}${values.length ? ` ${values.join(" ")}` : ""}`;
    }
    case "topic_subscribed": return `Subscribed to topic: ${config.topic_id}`;
    case "segment_added": return `Added to segment: ${config.segment_id}`;
    default: return config?.event_name ?? item.trigger ?? "";
  }
}

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List automations")
  .addOption(new Option("--status <status>", "Only automations in this state").choices(["enabled", "paused", "disabled"] as const))
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Onboarding","status":"enabled"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch automations", "dispatch automations list --status enabled", "dispatch automations list --status paused"],
    }),
  )
  .action(async (options, command) => {
    await runList<Automation>(command, {
      call: (api, page) => api.automations.list({ ...page, ...compact({ status: options.status }) }),
      columns: ["Name", "Status", "Trigger", "Created", "ID"],
      row: (item) => [item.name, item.status ?? (item.enabled ? "enabled" : "disabled"), triggerLabel(item), item.created_at, item.id],
      empty: "(no automations)",
    });
  });
