import { Command } from "@commander-js/extra-typings";
import { guard } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { run } from "./run.js";

export const seed = new Command("seed")
  .description("Create the tables, then a local tenant, dev key, domain, and the default templates")
  .addHelpText("after", helpText({ output: "pnpm db:migrate and pnpm db:seed output.", codes: ["dev_error"], examples: ["dispatch dev seed"] }))
  .action(async (_options, command) => {
    // The seed writes into tables the migration creates, so the migration runs first. It only
    // adds what is missing, so running it again is safe.
    await guard(command, "dev_error", async () => {
      await run("pnpm", ["-w", "run", "db:migrate"]);
      await run("pnpm", ["-w", "run", "db:seed"]);
    });
  });
