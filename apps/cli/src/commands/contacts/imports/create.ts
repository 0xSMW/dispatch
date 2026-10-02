import { basename } from "node:path";
import { Command, Option } from "@commander-js/extra-typings";
import { runCreate } from "../../../lib/actions.js";
import { read } from "../../../lib/files.js";
import { helpText } from "../../../lib/help.js";
import { collect, compact, jsonFlag, many } from "../../../lib/json.js";
import { promptMissing } from "../../../lib/prompts.js";

export const create = new Command("create")
  .description("Import contacts from a CSV file")
  .option("--file <path>", "CSV file, or - for stdin")
  .option("--column-map <json>", 'Map fields to CSV columns, such as {"email":{"column":"E-mail"}}')
  .addOption(new Option("--on-conflict <mode>", "What to do with existing contacts").choices(["upsert", "skip"] as const))
  .option("--segment-id <id>", "Add every imported contact to this segment. Repeatable", collect)
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"contact_import","id":"...","status":"queued"}',
      codes: ["missing_flags", "file_error", "create_error"],
      examples: ["dispatch contacts imports create --file contacts.csv --segment-id seg_123"],
    }),
  )
  .action(async (options, command) => {
    await runCreate(command, {
      loading: "Uploading...",
      prepare: async (globals) => {
        const { file } = await promptMissing({ file: options.file }, [{ key: "file", flag: "--file", label: "CSV file" }], globals);
        return { file: await read(file), filename: file === "-" ? "contacts.csv" : basename(file) };
      },
      call: (api, input) =>
        api.contacts.imports.create({
          ...input,
          ...compact({
            columnMap: jsonFlag<Record<string, unknown>>(options.columnMap, "--column-map"),
            onConflict: options.onConflict,
            segments: many(options.segmentId)?.map((id) => ({ id })),
          }),
        }),
      done: (job: { id: string }) => `Started import ${job.id}`,
    });
  });
