import { Command, Option } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { CliError } from "../../lib/errors.js";
import { read } from "../../lib/files.js";
import { helpText } from "../../lib/help.js";
import { compact, jsonFlag } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

type Definition = { name?: string; trigger?: string; steps?: unknown[]; connections?: unknown[]; status?: string; reentry?: "once" | "every_time" };

const triggerTypes = ["event", "contact_created", "contact_updated", "topic_subscribed", "segment_added"] as const;
type TriggerType = (typeof triggerTypes)[number];

function withTrigger(definition: Definition, options: { triggerType?: TriggerType; trigger?: string; topic?: string; segment?: string }): Definition {
  if (!options.triggerType && !options.topic && !options.segment) return definition;
  const type = options.triggerType ?? "event";
  if (options.trigger && type !== "event") throw new CliError("validation_error", "--trigger is only used with --trigger-type event");
  if (options.topic && type !== "topic_subscribed") throw new CliError("validation_error", "--topic requires --trigger-type topic_subscribed");
  if (options.segment && type !== "segment_added") throw new CliError("validation_error", "--segment requires --trigger-type segment_added");

  const steps = definition.steps as Array<Record<string, unknown>>;
  if (steps.some((step) => !step || typeof step !== "object" || Array.isArray(step))) {
    throw new CliError("validation_error", "Each step must be a JSON object");
  }
  const keyed = steps.length > 0 && steps.every((step) => "key" in step);
  if (!keyed && steps.some((step) => "key" in step)) {
    throw new CliError("validation_error", "Use either keyed graph steps or linear steps, not both");
  }
  const existing = steps.find((step) => step.type === "trigger")?.config as Record<string, unknown> | undefined;
  const eventName = options.trigger ?? definition.trigger ?? (existing?.event_name as string | undefined);
  const topicId = options.topic ?? (existing?.type === type ? existing.topic_id as string | undefined : undefined);
  const segmentId = options.segment ?? (existing?.type === type ? existing.segment_id as string | undefined : undefined);
  if (type === "event" && !eventName?.trim()) throw new CliError("missing_flags", "Missing required flag: --trigger");
  if (type === "topic_subscribed" && !topicId?.trim()) throw new CliError("missing_flags", "Missing required flag: --topic");
  if (type === "segment_added" && !segmentId?.trim()) throw new CliError("missing_flags", "Missing required flag: --segment");
  const config = type === "event" ? { type, event_name: eventName }
    : type === "topic_subscribed" ? { type, topic_id: topicId }
    : type === "segment_added" ? { type, segment_id: segmentId }
    : type === "contact_updated" && existing?.type === type ? { ...existing, type }
    : { type };

  const { trigger: _trigger, ...rest } = definition;
  if (keyed) {
    if (!steps.some((step) => step.type === "trigger")) {
      throw new CliError("validation_error", "Keyed graph steps need a trigger step to configure");
    }
    return { ...rest, steps: steps.map((step) => step.type === "trigger" ? { ...step, config } : step) };
  }
  const aliases: Record<string, string> = { update_contact: "contact_update", wait: "wait_for_event" };
  const graph = [
    { key: "trigger", type: "trigger", config },
    ...steps.map(({ type: stepType, ...fields }, index) => ({ key: `step_${index + 1}`, type: aliases[String(stepType)] ?? stepType, config: fields })),
  ];
  return {
    ...rest,
    steps: graph,
    connections: graph.slice(1).map((step, index) => ({ from: graph[index]!.key, to: step.key, type: "default" })),
  };
}

export const create = new Command("create")
  .description("Create an automation from flags or a JSON definition")
  .argument("[name]", "Automation name")
  .option("--name <name>", "Automation name (same as the positional argument)")
  .option("--trigger <event>", "Event name that starts a run")
  .addOption(new Option("--trigger-type <type>", "What starts a run (defaults to event)").choices(triggerTypes))
  .option("--topic <id>", "Topic ID for a topic_subscribed trigger")
  .option("--segment <id>", "Static segment ID for a segment_added trigger")
  .option("--steps <json>", "Steps as a JSON array")
  .option("--connections <json>", "Connections between steps as a JSON array")
  .option("--file <path>", "Whole definition as JSON, or - for stdin. Flags override its fields")
  .addOption(new Option("--status <status>", "Start enabled or disabled").choices(["enabled", "disabled"] as const))
  .addOption(new Option("--reentry <mode>", "Whether a contact can enter once or every time").choices(["once", "every_time"] as const))
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"automation","id":"..."}',
      codes: ["missing_flags", "invalid_json", "create_error", "validation_error"],
      examples: [
        'dispatch automations create Onboarding --trigger user.created --steps \'[{"type":"send_email","template":"welcome"}]\'',
        'dispatch automations create Welcome --trigger-type contact_created --steps \'[{"type":"delay","duration":"1 hour"}]\'',
        'dispatch automations create Newsletter --trigger-type topic_subscribed --topic topic_123 --file newsletter.json',
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
            reentry: options.reentry,
          }),
        };
        const asked = await promptMissing({ name: definition.name }, [{ key: "name", flag: "--name", label: "Automation name" }], globals);
        if (!Array.isArray(definition.steps)) throw new CliError("missing_flags", "Missing required flags: --steps or --file");
        return withTrigger({ ...definition, name: asked.name }, options);
      },
      call: (api, definition) => api.automations.create(definition),
      done: (automation: { id: string }) => `Created automation ${automation.id}`,
    });
  });
