import type { EmailEditorRef } from "@react-email/editor";

export type Editor = NonNullable<EmailEditorRef["editor"]>;
export type Placeholder = {
  from: number;
  to: number;
  raw: string;
  key: string;
  kind: "value" | "each" | "if" | "unless";
  list: string | null;
  inline: string | null;
};

/** Match only contiguous text tokens. Joining formatted text could invent a live placeholder. */
export function selectedPlaceholder(editor: Editor, range: { from: number; to: number } = editor.state.selection): Placeholder | null {
  const { from, to } = range;
  const stack: Array<{ kind: string; key: string }> = [];
  let selected: Placeholder | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || selected) return;
    for (const match of (node.text ?? "").matchAll(/\{\{\{\s*(?:(#(?:each|if|unless))\s+([A-Za-z0-9_.]+)|(\/(?:each|if|unless))|([A-Za-z0-9_.]+)\s*(?:\|([^}]*))?)\s*\}\}\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
      const start = pos + match.index!;
      const end = start + match[0].length;
      if (match[3]) {
        stack.pop();
        continue;
      }
      const key = match[2] ?? match[4] ?? match[6]!;
      const kind = match[1]?.slice(1) as Placeholder["kind"] | undefined;
      if (from >= start && to <= end) {
        selected = {
          from: start, to: end, raw: match[0], key, kind: kind ?? "value",
          list: [...stack].reverse().find((item) => item.kind === "each")?.key ?? null,
          inline: match[5] ?? null,
        };
        return;
      }
      if (kind) stack.push({ kind, key });
    }
  });
  return selected;
}

/** Change just this token, keeping its marks, whitespace, and existing inline fallback. */
export function renamePlaceholder(editor: Editor, token: Placeholder, key: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) return false;
  const prefix = token.raw.match(token.kind === "value" ? /^\{\{\{?\s*/ : /^\{\{\{\s*#(?:each|if|unless)\s+/)?.[0];
  if (!prefix) return false;
  const index = prefix.length;
  return replacePlaceholder(editor, token, token.raw.slice(0, index) + key + token.raw.slice(index + token.key.length));
}

export function inlineFallback(editor: Editor, token: Placeholder, fallback: string | null) {
  if (token.kind !== "value" || !token.raw.startsWith("{{{") || fallback?.includes("}")) return false;
  const keyEnd = token.raw.indexOf(token.key) + token.key.length;
  // Changing an inline fallback is deliberate; preserve the rest of the selected token.
  return replacePlaceholder(editor, token, token.raw.slice(0, keyEnd) + (fallback === null ? "" : `|${fallback}`) + "}}}");
}

function replacePlaceholder(editor: Editor, token: Placeholder, raw: string) {
  if (!editor.isEditable || editor.state.doc.textBetween(token.from, token.to, "", "\ufffc") !== token.raw) return false;
  const marks = editor.state.doc.nodeAt(token.from)?.marks ?? [];
  return editor.chain().command(({ tr }) => {
    tr.replaceWith(token.from, token.to, editor.state.schema.text(raw, marks));
    return true;
  }).setTextSelection(token.from + 2).run();
}
