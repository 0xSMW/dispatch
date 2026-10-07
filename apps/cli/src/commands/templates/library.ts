import { Command } from "@commander-js/extra-typings";
import type { AutomationPreset, List } from "@dispatchmail/sdk";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { renderTable } from "../../lib/table.js";

type Entry = { slug: string; name?: string; category?: string; set?: number; description?: string };

export const library = new Command("library")
  .description("List default templates and automation presets (Dispatch only)")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"slug":"password-reset","name":"Password reset","category":"auth"}]}',
      codes: ["fetch_error"],
      examples: [
        "dispatch templates library",
        "dispatch templates library automations",
        "dispatch templates library automation onboarding-drip",
        "dispatch templates add password-reset",
      ],
    }),
  )
  .action(async (_options, command) => {
    await runGet(command, {
      call: (api) => api.templates.library.list(),
      human: (result: { data: Entry[] }) =>
        console.log(
          renderTable(
            ["Slug", "Name", "Category", "Description"],
            result.data.map((entry) => [entry.slug, entry.name ?? "", entry.category ?? "", entry.description ?? ""]),
          ),
        ),
    });
  })
  .addCommand(
    new Command("automations")
      .description("List automation presets")
      .addHelpText(
        "after",
        helpText({
          output: '{"object":"list","has_more":false,"data":[{"slug":"onboarding-drip","name":"Onboarding drip","stage":"onboarding"}]}',
          codes: ["fetch_error"],
          examples: ["dispatch templates library automations"],
        }),
      )
      .action(async (_options, command) => {
        await runGet(command, {
          call: (api) => api.templates.library.automations(),
          human: (result: List<AutomationPreset>) =>
            console.log(
              renderTable(
                ["Slug", "Name", "Stage", "Description", "When"],
                result.data.map((entry) => [entry.slug, entry.name, entry.stage, entry.description, entry.when]),
              ),
            ),
        });
      }),
  )
  .addCommand(
    new Command("automation")
      .description("Get an automation preset")
      .argument("<slug>", "Preset slug")
      .addHelpText(
        "after",
        helpText({
          output: '{"object":"automation_preset","slug":"onboarding-drip","name":"Onboarding drip","stage":"onboarding"}',
          codes: ["fetch_error", "not_found"],
          examples: ["dispatch templates library automation onboarding-drip"],
        }),
      )
      .action(async (slug, _options, command) => {
        await runGet(command, {
          call: (api) => api.templates.library.automation(slug),
        });
      }),
  );
