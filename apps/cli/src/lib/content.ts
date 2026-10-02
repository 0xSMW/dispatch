import { Command } from "@commander-js/extra-typings";
import { CliError } from "./errors.js";
import { read } from "./files.js";
import { jsonFlag } from "./json.js";
import { placeholderProps } from "./push.js";
import { loadFile, renderFile, type TemplateSource } from "./react.js";

export type ContentFlags = {
  html?: string;
  htmlFile?: string;
  text?: string;
  textFile?: string;
  reactEmail?: string;
  props?: string;
};

export type Content = { html?: string; text?: string; subject?: string; variables?: TemplateSource[]; track?: boolean };

// HTML and text from flags, files, or a React Email component.
// `stored` is for a template that is saved and filled later: without --props the component is
// rendered with a {{{KEY}}} placeholder for each declared variable, the way `templates push`
// does it. A one-off send renders with real values from --props or PreviewProps.
export async function content(flags: ContentFlags, options: { stored?: boolean } = {}): Promise<Content> {
  if (flags.html && flags.htmlFile) throw new CliError("invalid_flags", "Use --html or --html-file, not both");
  if (flags.text && flags.textFile) throw new CliError("invalid_flags", "Use --text or --text-file, not both");
  if (flags.reactEmail && (flags.html || flags.htmlFile)) {
    throw new CliError("invalid_flags", "Use --react-email or --html, not both");
  }
  if (flags.props && !flags.reactEmail) throw new CliError("invalid_flags", "--props needs --react-email");
  const out: Content = {};
  if (flags.reactEmail && options.stored && !flags.props) {
    const loaded = await loadFile(flags.reactEmail);
    out.html = await loaded.render(placeholderProps(loaded.variables, loaded.brand));
    out.subject = loaded.subject;
    out.variables = loaded.variables;
    out.track = loaded.track;
  } else if (flags.reactEmail) {
    const rendered = await renderFile(flags.reactEmail, jsonFlag<Record<string, unknown>>(flags.props, "--props"));
    out.html = rendered.html;
    out.subject = rendered.subject;
    out.variables = rendered.variables;
  }
  if (flags.html) out.html = flags.html;
  if (flags.htmlFile) out.html = await read(flags.htmlFile);
  if (flags.text) out.text = flags.text;
  if (flags.textFile) out.text = await read(flags.textFile);
  return out;
}

// A command with the body flags shared by every command that takes one.
// A factory rather than a generic wrapper: wrapping a typed chain makes tsc crawl.
export function contentCommand(name: string) {
  return new Command(name)
    .option("--html <html>", "HTML body")
    .option("--html-file <path>", "Read the HTML body from a file, or - for stdin")
    .option("--text <text>", "Plain-text body")
    .option("--text-file <path>", "Read the plain-text body from a file, or - for stdin")
    .option("--react-email <file>", "Render a React Email .tsx file to HTML")
    .option("--props <json>", "Props for --react-email, as JSON");
}
