import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { CliError } from "./errors.js";
import { read, readBytes } from "./files.js";
import { jsonFlag } from "./json.js";

export type Spec = { path: string; cid?: string; type?: string; filename?: string };
export type Attachment = { filename: string; content: string; contentType?: string; contentId?: string };

const keys = new Set(["cid", "type", "filename"]);

// "path;cid=logo;type=image/png;filename=logo.png"
// Options are split off only where "key=" follows the semicolon, so a path such as
// "report;v2.pdf" stays whole.
export function parseSpec(value: string): Spec {
  const [path, ...parts] = value.split(/;(?=\s*[A-Za-z]+\s*=)/);
  if (!path?.trim()) throw new CliError("invalid_attachment", `Attachment spec has no path: "${value}"`);
  const spec: Spec = { path: path.trim() };
  for (const part of parts) {
    const at = part.indexOf("=");
    const key = part.slice(0, at).trim();
    if (at <= 0 || !keys.has(key)) {
      throw new CliError("invalid_attachment", `Unknown attachment option "${part}". Use cid=, type=, or filename=`);
    }
    spec[key as "cid" | "type" | "filename"] = part.slice(at + 1).trim();
  }
  return spec;
}

export const maxAttachmentBytes = 40 * 1024 * 1024;

export async function load(spec: Spec, fallbackType?: string): Promise<Attachment> {
  if (spec.path !== "-") {
    const size = await stat(spec.path).then((info) => info.size, () => 0);
    if (size > maxAttachmentBytes) throw new CliError("invalid_attachment", `${spec.path} is over the 40 MB limit`);
  }
  const content = (await readBytes(spec.path)).toString("base64");
  const type = spec.type ?? fallbackType;
  return {
    filename: spec.filename ?? (spec.path === "-" ? "attachment" : basename(spec.path)),
    content,
    ...(type ? { contentType: type } : {}),
    ...(spec.cid ? { contentId: spec.cid } : {}),
  };
}

// --attachment specs plus an optional --attachments-file holding a JSON array.
export async function attachments(specs: string[] | undefined, file?: string, fallbackType?: string) {
  const loaded = await Promise.all((specs ?? []).map((value) => load(parseSpec(value), fallbackType)));
  if (file) {
    const listed = jsonFlag<unknown>(await read(file), "--attachments-file");
    if (!Array.isArray(listed)) throw new CliError("invalid_attachment", "--attachments-file must hold a JSON array");
    loaded.push(...(listed as Attachment[]));
  }
  return loaded.length ? loaded : undefined;
}
