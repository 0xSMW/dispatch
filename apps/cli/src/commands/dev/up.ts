import { Command } from "@commander-js/extra-typings";
import { guard } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { run } from "./run.js";

export const up = new Command("up")
  .description("Start the local Docker services (Postgres, Redis, Mailpit)")
  .addHelpText("after", helpText({ output: "docker compose output.", codes: ["dev_error"], examples: ["dispatch dev up"] }))
  .action(async (_options, command) => {
    await guard(command, "dev_error", () => run("docker", ["compose", "up", "-d"]));
  });
