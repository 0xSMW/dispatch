import { Command, Option } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { CliError } from "../../lib/errors.js";
import { compact } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

export function fallback(value: string | undefined, type: string | undefined) {
  if (value === undefined) return undefined;
  if (type === "boolean") {
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
    throw new CliError("invalid_flag", "--fallback-value must be true or false for a boolean property");
  }
  if (type !== "number") return value;
  // NaN would be sent as null, which clears the fallback without saying so.
  const number = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(number)) throw new CliError("invalid_flag", `--fallback-value must be a number for a number property, got "${value}"`);
  return number;
}

export const create = new Command("create")
  .description("Define a custom contact property")
  .option("--key <key>", "Property key, such as plan")
  .addOption(new Option("--type <type>", "Value type").choices(["string", "number", "boolean", "date"] as const).default("string" as const))
  .option("--fallback-value <value>", "Value used when a contact has none")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"contact_property","id":"..."}',
      codes: ["missing_flags", "invalid_flag", "create_error", "validation_error"],
      examples: [
        "dispatch contact-properties create --key plan --fallback-value free",
        "dispatch contact-properties create --key activated --type boolean --fallback-value false",
        "dispatch contact-properties create --key last_active_at --type date --fallback-value 2026-10-01",
      ],
    }),
  )
  .action(async (options, command) => {
    await runCreate(command, {
      prepare: (globals) => promptMissing({ key: options.key }, [{ key: "key", flag: "--key", label: "Property key" }], globals),
      call: (api, input) =>
        api.contactProperties.create({
          key: input.key,
          type: options.type,
          ...compact({ fallbackValue: fallback(options.fallbackValue, options.type) }),
        }),
      done: (property: { id: string }) => `Created contact property ${property.id}`,
    });
  });
