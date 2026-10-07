import type { EmailEditorRef } from "@react-email/editor";
import { composeReactEmail } from "@react-email/editor/core";
import { pick, unwrap } from "./guard";
import { escapeHtml, inlinePattern, mapText } from "./inline";

type Editor = NonNullable<EmailEditorRef["editor"]>;
type Content = ReturnType<EmailEditorRef["getJSON"]>;

// The server captures an inline default literally, then escapes it at render time.
// Only text tokens cross this boundary; attributes retain the editor's escaping.
/** A per-operation namespace absent from the input, and only tokens we actually hid. */
function shield(source: string) {
  // A random namespace also avoids collisions with ordinary text that an HTML
  // parser reveals from numeric character references during unwrap.
  const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let prefix = `DT${nonce}X`;
  while (source.includes(prefix)) prefix += "X";
  const tokens = new Map<string, string>();
  return {
    hide: (text: string) =>
      text.replace(inlinePattern(), (raw) => {
        const marker = `${prefix}${tokens.size}END`;
        tokens.set(marker, raw);
        return marker;
      }),
    restore: (text: string, encode: (raw: string) => string = (raw) => raw) =>
      text.replace(new RegExp(`${prefix}\\d+END`, "g"), (marker) => {
        const raw = tokens.get(marker);
        return raw === undefined ? marker : encode(raw);
      }),
  };
}

/**
 * Content for EmailEditor. Shield before even unwrap parses HTML, then encode the
 * original token exactly once so the editor creates literal text nodes, not marks
 * or elements from a default. This is not entity decoding or a stored format.
 * Use prepareVisualHtml for exact whitespace as well as sensitive characters.
 */
export function loadVisualHtml(html: string): string {
  const tokens = shield(html);
  const protectedHtml = mapText(html, tokens.hide);
  return mapText(unwrap(protectedHtml) ?? protectedHtml, (text) => tokens.restore(text, escapeHtml));
}

/**
 * Exact initialization, including whitespace the editor's HTML parser otherwise
 * collapses. Give `html` to EmailEditor, then call `restore` first in onReady,
 * before attaching change/selection listeners or checking the round trip.
 * The shields exist only during parsing; they are never part of saved HTML.
 */
export function prepareVisualHtml(html: string): { html: string; restore: (editor: Editor) => void } {
  const tokens = shield(html);
  const protectedHtml = mapText(html, tokens.hide);
  return {
    html: unwrap(protectedHtml) ?? protectedHtml,
    restore(editor) {
      const replacements: Array<{ from: number; to: number; text: string; node: Editor["state"]["doc"] }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const restored = tokens.restore(node.text!);
        if (restored !== node.text) replacements.push({ from: pos, to: pos + node.nodeSize, text: restored, node });
      });
      if (!replacements.length) return;
      const tr = editor.state.tr;
      for (const replacement of replacements.reverse()) {
        tr.replaceWith(replacement.from, replacement.to, editor.schema.text(replacement.text, replacement.node.marks));
      }
      editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true));
    },
  };
}

/** Compose a snapshot without transactions, changing selection, or dirtying the editor. */
export async function serializeVisual(editor: Editor): Promise<{ stored: string; plain: string; formatted: string }> {
  const original = editor.getJSON();
  const tokens = shield(JSON.stringify(original));
  const hide = (node: Content): Content => ({
    ...node,
    ...(node.text === undefined ? {} : { text: tokens.hide(node.text) }),
    ...(node.content ? { content: node.content.map(hide) } : {}),
  });
  const content = hide(original);
  // The installed composer reads getJSON plus the real schema/extensions and theme.
  // Forward everything else to the live editor; never replace its document, even
  // temporarily, since composition is async and the user may keep typing.
  const snapshot = new Proxy(editor, {
    get(target, key) {
      if (key === "getJSON") return () => content;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const out = await composeReactEmail({ editor: snapshot });
  const restored = {
    html: mapText(out.html, (text) => tokens.restore(text)),
    unformattedHtml: mapText(out.unformattedHtml, (text) => tokens.restore(text)),
  };
  return { stored: pick(restored), plain: restored.unformattedHtml, formatted: restored.html };
}
