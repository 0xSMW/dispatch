import { Command, Option } from "@commander-js/extra-typings";
import pc from "picocolors";
import { runCreate } from "../../lib/actions.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { promptMissing } from "../../lib/prompts.js";

const permissions: Record<string, "full_access" | "sending_access"> = {
  full_access: "full_access",
  full: "full_access",
  sending_access: "sending_access",
  send: "sending_access",
};

export function permission(value: string | undefined) {
  if (value === undefined) return undefined;
  const mapped = permissions[value];
  if (!mapped) throw new CliError("invalid_permission", "--permission must be full_access or sending_access");
  return mapped;
}

export const create = new Command("create")
  .description("Create an API key. The token is shown once")
  .argument("[name]", "Key name")
  .option("--name <name>", "Key name (same as the positional argument)")
  .option("--permission <permission>", "full_access or sending_access", "full_access")
  .addOption(new Option("--scope <scope>", "Old name for --permission: full or send").hideHelp())
  .option("--domain-id <id>", "Limit a sending_access key to one domain")
  .addHelpText(
    "after",
    helpText({
      output: '{"id":"...","token":"sk_..."}',
      codes: ["missing_flags", "invalid_permission", "create_error"],
      examples: [
        "dispatch api-keys create --name Production",
        "dispatch api-keys create --name Web --permission sending_access --domain-id domain_123",
      ],
    }),
  )
  .action(async (name, options, command) => {
    await runCreate(command, {
      prepare: (globals) => promptMissing({ name: name ?? options.name }, [{ key: "name", flag: "--name", label: "Key name" }], globals),
      call: (api, input) =>
        api.apiKeys.create({ name: input.name, permission: permission(options.scope ?? options.permission), domainId: options.domainId }),
      done: (key: { id: string; token: string }) => `Created API key ${key.id}`,
      human: (key) => {
        console.log(`\n  ${pc.bold(key.token)}\n`);
        console.log(pc.dim("Copy it now. It will not be shown again."));
      },
    });
  });
