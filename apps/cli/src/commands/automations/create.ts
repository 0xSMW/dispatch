import { Command, Option } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { CliError } from "../../lib/errors.js";
import { read } from "../../lib/files.js";
import { helpText } from "../../lib/help.js";
import { compact, jsonFlag } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

type Definition = { name?: string; trigger?: string; steps?: unknown[]; connections?: unknown[]; status?: string };

export const create = new Command("create")
  .description("Create an automation from flags or a JSON definition")
  .argument("[name]", "Automation name")
  .option("--name <name>", "Automation name (same as the positional argument)")
  .option("--trigger <event>", "Event name that starts a run")
  .option("--steps <json>", "Steps as a JSON array")
  .option("--connections <json>", "Connections between steps as a JSON array")
  .option("--file <path>", "Whole definition as JSON, or - for stdin. Flags override its fields")
  .addOption(new Option("--status <status>", "Start enabled or disabled").choices(["enabled", "disabled"] as const))
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"automation","id":"..."}',
      codes: ["missing_flags", "invalid_json", "create_error", "validation_error"],
      examples: [
        'dispatch automations create Onboarding --trigger user.created --steps \'[{"type":"send_email","template":"welcome"}]\'',
        "dispatch automations create --file onboarding.json",
      ],
    }),
  )
  .action(async (name, options, command) => {
    await runCreate(command, {
      prepare: async (globals) => {
        const file = options.file ? (jsonFlag<Definition>(await read(options.file), "--file") ?? {}) : {};
        const definition: Definition = {
          ...file,
          ...compact({
            name: name ?? options.name,
            trigger: options.trigger,
            steps: jsonFlag<unknown[]>(options.steps, "--steps"),
            connections: jsonFlag<unknown[]>(options.connections, "--connections"),
            status: options.status,
          }),
        };
        const asked = await promptMissing({ name: definition.name }, [{ key: "name", flag: "--name", label: "Automation name" }], globals);
        if (!Array.isArray(definition.steps)) throw new CliError("missing_flags", "Missing required flags: --steps or --file");
        return { ...definition, name: asked.name };
      },
      call: (api, definition) => api.automations.create(definition),
      done: (automation: { id: string }) => `Created automation ${automation.id}`,
    });
  });
