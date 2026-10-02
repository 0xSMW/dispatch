import { Command, Option } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

// The old --default flag took subscribed or unsubscribed.
const old = { subscribed: "opt_in", unsubscribed: "opt_out" } as const;

export const create = new Command("create")
  .description("Create a topic contacts can opt in to or out of")
  .argument("[name]", "Topic name")
  .option("--name <name>", "Topic name (same as the positional argument)")
  .option("--key <key>", "Stable key, such as product-updates")
  .option("--description <text>", "Shown on the preference page")
  .addOption(new Option("--default-subscription <mode>", "Whether contacts start opted in").choices(["opt_in", "opt_out"] as const))
  .addOption(new Option("--visibility <visibility>", "Show on the preference page").choices(["public", "private"] as const))
  .addOption(
    new Option("--default <status>", "Old flag: subscribed or unsubscribed").choices(["subscribed", "unsubscribed"] as const).hideHelp(),
  )
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"topic","id":"..."}',
      codes: ["missing_flags", "create_error"],
      examples: ['dispatch topics create --name "Product updates" --default-subscription opt_in'],
    }),
  )
  .action(async (name, options, command) => {
    await runCreate(command, {
      prepare: (globals) => promptMissing({ name: name ?? options.name }, [{ key: "name", flag: "--name", label: "Topic name" }], globals),
      call: (api, input) =>
        api.topics.create({
          name: input.name,
          ...compact({
            key: options.key,
            description: options.description,
            visibility: options.visibility,
            defaultSubscription: options.defaultSubscription ?? (options.default ? old[options.default] : undefined),
          }),
        }),
      done: (topic: { id: string }) => `Created topic ${topic.id}`,
    });
  });
