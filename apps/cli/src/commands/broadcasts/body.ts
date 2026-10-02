import { Option } from "@commander-js/extra-typings";
import { content, contentCommand, type ContentFlags } from "../../lib/content.js";
import { collect, compact, jsonFlag, many, pairs } from "../../lib/json.js";

export function broadcastCommand(name: string) {
  return contentCommand(name)
    .option("--name <name>", "Internal name")
    .option("--from <address>", "Sender")
    .option("--subject <subject>", "Subject line")
    .option("--reply-to <address>", "Reply-To address. Repeatable", collect)
    .option("--preview-text <text>", "Inbox preview text")
    .option("--segment-id <id>", "Send to this segment")
    .option("--topic-id <id>", "Respect subscriptions to this topic")
    .addOption(new Option("--segment <id>", "Old name for --segment-id").hideHelp())
    .addOption(new Option("--topic <id>", "Old name for --topic-id").hideHelp())
    .option("--template <id-or-alias>", "Use a published template as the body")
    .option("--var <key=value>", "Template variable. Repeatable", collect)
    .addOption(new Option("--variables <json>", "Template variables as JSON").hideHelp());
}

type Flags = ContentFlags & {
  name?: string;
  from?: string;
  subject?: string;
  replyTo?: string[];
  previewText?: string;
  segmentId?: string;
  topicId?: string;
  segment?: string;
  topic?: string;
  template?: string;
  var?: string[];
  variables?: string;
};

export async function broadcastBody(flags: Flags) {
  // A broadcast is filled in per contact, so a component given without --props keeps a
  // placeholder for each variable. Rendering it with its preview props would send the sample
  // values, such as "Hi Ada", to every recipient.
  const body = await content(flags, { stored: true });
  const variables = { ...jsonFlag<Record<string, unknown>>(flags.variables, "--variables"), ...pairs(flags.var, "--var") };
  return compact({
    name: flags.name,
    from: flags.from,
    subject: flags.subject ?? body.subject,
    replyTo: many(flags.replyTo),
    previewText: flags.previewText,
    html: body.html,
    text: body.text,
    template: flags.template,
    variables: Object.keys(variables).length ? variables : undefined,
    segmentId: flags.segmentId ?? flags.segment,
    topicId: flags.topicId ?? flags.topic,
  });
}
