// @vitest-environment jsdom
import { EmailEditor, type EmailEditorRef } from "@react-email/editor";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { unsafePaste } from "./guard";
import { inlineFallback, selectedPlaceholder } from "./placeholders";
import { loadVisualHtml, prepareVisualHtml, serializeVisual } from "./serialization";

type Editor = NonNullable<EmailEditorRef["editor"]>;

// Run the real server implementation without pulling core source outside the
// dashboard's rootDir into its browser typecheck.
const { renderTemplate } = await vi.importActual<{
  renderTemplate: (fields: { html: string }, values: Record<string, unknown>) => { html?: string };
}>("@dispatchmail/core");

beforeAll(() => {
  const box = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => box as DOMRect;
  document.elementFromPoint = () => null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(html: string, exact = true) {
  let editor: Editor | null = null;
  const content = exact ? prepareVisualHtml(html) : { html: loadVisualHtml(html), restore: (_editor: Editor) => {} };
  render(h(EmailEditor, {
    content: content.html,
    onReady: (ref: EmailEditorRef) => {
      if (ref.editor) content.restore(ref.editor);
      editor = ref.editor;
    },
    onUploadImage: async () => { throw new Error("No image uploads in this test."); },
  }));
  await waitFor(() => expect(editor).not.toBeNull());
  return editor! as Editor;
}

function insert(editor: Editor, text: string) {
  act(() => {
    editor.commands.focus("end");
    editor.commands.insertContent({ type: "text", text });
  });
}

function text(editor: Editor) {
  return editor.state.doc.textContent;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

describe("raw inline defaults at the visual boundary", () => {
  const defaults = [
    "R&D",
    `He said "yes" & it's fine`,
    "<em>not emphasis</em>",
    "&amp; and &#39; and &lt;em&gt;",
    `R&D "<em>plain</em>" &amp; &#39;`,
    "</p><script>alert('no')</script><p>",
    "DISPATCHTOKEN0END",
    "one\n  two",
    "  padded  ",
    "\tR&D\r\n&amp;",
    "",
    "0",
  ];

  for (const fallback of defaults) {
    it(`preserves ${JSON.stringify(fallback)} through load, actual compose, reload and edit`, async () => {
      const raw = `{{{NAME|${fallback}}}}`;
      const editor = await open(`<p>Before &amp; <strong>${raw}</strong> after &lt;safe&gt;.</p>`);
      expect(text(editor)).toBe(`Before & ${raw} after <safe>.`);
      expect(editor.view.dom.querySelector("em, script")).toBeNull();
      const state = editor.state;
      const updates = vi.fn();
      editor.on("update", updates);
      const saved = await serializeVisual(editor);
      expect(editor.state).toBe(state);
      expect(updates).not.toHaveBeenCalled();
      for (const html of [saved.stored, saved.plain, saved.formatted]) {
        // Inspect the actual saved HTML, not guard.tokens(), which decodes entities.
        expect(html).toContain(raw);
        expect(html).toContain("Before &amp;");
        expect(html).toMatch(/after\s+&lt;safe&gt;\./);
        const delivered = renderTemplate({ html }, {}).html!;
        expect(delivered).toContain(escapeHtml(fallback));
        expect(delivered).not.toContain(raw);
        const doc = new DOMParser().parseFromString(delivered, "text/html");
        expect(doc.body.textContent?.replace(/\s+/g, " ")).toContain(`Before & ${fallback} after <safe>.`.replace(/\s+/g, " "));
        expect(doc.querySelector("em, script")).toBeNull();
      }
      cleanup();
      const reloaded = await open(saved.stored);
      expect(text(reloaded)).toBe(`Before & ${raw} after <safe>.`);
      expect(reloaded.view.dom.querySelector("em, script")).toBeNull();
      insert(reloaded, " Edited & <safe>");
      const edited = await serializeVisual(reloaded);
      expect(edited.stored).toContain(raw);
      expect(edited.stored).toMatch(/Edited\s+&amp;\s+&lt;safe&gt;/);
      expect(renderTemplate({ html: edited.stored }, {}).html).toContain(escapeHtml(fallback));
      cleanup();
      const again = await open(edited.stored);
      expect(text(again)).toBe(`Before & ${raw} after <safe>. Edited & <safe>`);
      expect(again.view.dom.querySelector("em, script")).toBeNull();
      expect((edited.stored.match(/<table\b/g) ?? []).length).toBe((saved.stored.match(/<table\b/g) ?? []).length);
    });
  }

  it("supports the string-only loader for sensitive characters", async () => {
    const raw = `{{{NAME|R&D "<em>plain</em>" &amp; &#39;}}}`;
    const editor = await open(`<p>${raw}</p>`, false);
    expect(text(editor)).toBe(raw);
    expect(editor.view.dom.querySelector("em")).toBeNull();
    const saved = await serializeVisual(editor);
    expect(saved.stored).toContain(raw);
    expect(renderTemplate({ html: saved.stored }, {}).html).toContain("R&amp;D &quot;&lt;em&gt;plain&lt;/em&gt;&quot; &amp;amp; &amp;#39;");
  });

  it("restores exact defaults once without an update event or history entry", async () => {
    const raw = `{{{NAME|\tR&D\n  <em>&amp;</em>}}}`;
    const loaded = prepareVisualHtml(`<p><strong>${raw}</strong> and {{{NAME|  second  }}}</p>`);
    let editor: Editor | null = null;
    const updates = vi.fn();
    render(h(EmailEditor, {
      content: loaded.html,
      onUpdate: updates,
      onReady: (ref: EmailEditorRef) => {
        if (ref.editor) loaded.restore(ref.editor);
        editor = ref.editor;
      },
    }));
    await waitFor(() => expect(editor).not.toBeNull());
    const current = editor! as Editor;
    expect(text(current)).toBe(`${raw} and {{{NAME|  second  }}}`);
    expect(current.view.dom.querySelector("strong")?.textContent).toBe(raw);
    expect(updates).not.toHaveBeenCalled();
    const state = current.state;
    act(() => loaded.restore(current));
    expect(current.state).toBe(state);
    // The package installs undo, but does not expose its command augmentation.
    const commands = current.commands as typeof current.commands & { undo: () => boolean };
    act(() => expect(commands.undo()).toBe(false));
    expect(text(current)).toBe(`${raw} and {{{NAME|  second  }}}`);
  });

  it("does not replace a user's concurrent edit while composing", async () => {
    const editor = await open("<p>{{{NAME|R&D &amp;}}}</p>");
    const writing = serializeVisual(editor);
    insert(editor, " Concurrent edit");
    const saved = await writing;
    expect(saved.stored).toContain("{{{NAME|R&D &amp;}}}");
    expect(saved.stored).not.toContain("Concurrent edit");
    expect(text(editor)).toBe("{{{NAME|R&D &amp;}}} Concurrent edit");
  });

  it("serializes an inspector edit as raw text without changing a duplicate or its marks", async () => {
    const editor = await open("<p><strong>{{{NAME|first}}}</strong> and {{{NAME|second}}}</p>");
    let pos = 0;
    editor.state.doc.descendants((node, at) => {
      if (node.isText && node.text?.startsWith("{{{NAME|first}}}")) pos = at + 2;
    });
    const token = selectedPlaceholder(editor, { from: pos, to: pos })!;
    const fallback = `R&D "<em>plain</em>" &amp; &#39;`;
    act(() => expect(inlineFallback(editor, token, fallback)).toBe(true));
    expect(text(editor)).toBe(`{{{NAME|${fallback}}}} and {{{NAME|second}}}`);
    expect(editor.view.dom.querySelector("strong")?.textContent).toBe(`{{{NAME|${fallback}}}}`);
    expect(editor.view.dom.querySelector("em")).toBeNull();
    const saved = await serializeVisual(editor);
    expect(saved.stored).toContain(`{{{NAME|${fallback}}}}`);
    expect(saved.stored).toContain("{{{NAME|second}}}");
    const delivered = renderTemplate({ html: saved.stored }, {}).html!;
    expect(delivered).toContain(escapeHtml(fallback));
    expect(new DOMParser().parseFromString(delivered, "text/html").body.textContent?.replace(/\s+/g, " ")).toContain(`${fallback} and second`);
    cleanup();
    const reloaded = await open(saved.stored);
    expect(text(reloaded)).toBe(`{{{NAME|${fallback}}}} and {{{NAME|second}}}`);
    expect(reloaded.view.dom.querySelector("strong")?.textContent).toBe(`{{{NAME|${fallback}}}}`);
    expect(reloaded.view.dom.querySelector("em")).toBeNull();
  });

  it("does not invent a contiguous token across formatting boundaries", async () => {
    const editor = await open("<p>{{{NAME|<strong>R&amp;D</strong>}}}</p>");
    // The source token really includes the markup literally; protect it before parsing.
    expect(text(editor)).toBe("{{{NAME|<strong>R&amp;D</strong>}}}");
    expect(editor.view.dom.querySelector("strong")).toBeNull();
    act(() => editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "text", text: "{{{NAME|" },
        { type: "text", text: "R&D", marks: [{ type: "bold" }] },
        { type: "text", text: "}}}" },
      ] }],
    }));
    const saved = await serializeVisual(editor);
    expect(saved.stored).not.toContain("{{{NAME|R&D}}}");
    expect(saved.stored).toContain("R&amp;D");
  });

  it("keeps normal text and attributes escaped, without decoding entity-looking defaults", async () => {
    const editor = await open(
      `<p>Ordinary &amp;amp; &amp; &lt;em&gt; and {{{NAME|&amp; &#39;}}} ` +
      `<a href="https://example.test/?a=1&amp;b=&quot;two&quot;" title="&lt;safe&gt;">Link</a></p>` +
      `<img src="https://example.test/image?a=1&amp;b=2" alt="&quot;&lt;safe&gt;&amp; &#39;">`,
    );
    const saved = await serializeVisual(editor);
    expect(saved.stored).toContain("Ordinary &amp;amp; &amp; &lt;em&gt;");
    expect(saved.stored).toContain("{{{NAME|&amp; &#39;}}}");
    expect(saved.plain).toContain('href="https://example.test/?a=1&amp;b=&quot;two&quot;"');
    expect(saved.stored).toContain(`href='https://example.test/?a=1&amp;b="two"'`);
    expect(saved.stored).toContain('src="https://example.test/image?a=1&amp;b=2"');
    const doc = new DOMParser().parseFromString(renderTemplate({ html: saved.stored }, {}).html!, "text/html");
    expect(doc.body.textContent?.replace(/\s+/g, " ")).toContain("Ordinary &amp; & <em> and &amp; &#39;");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe('https://example.test/?a=1&b="two"');
    expect(doc.querySelector("img")?.getAttribute("alt")).toBe(`"<safe>& '`);
    expect(doc.querySelector("em")).toBeNull();
  });

  it("leaves attribute placeholders on the existing escaped attribute path", async () => {
    const editor = await open(
      `<p><a href="{{{URL|https://example.test/?a=1&amp;b=2}}}">Open</a> ` +
      `{{{NAME|R&D}}}</p>`,
    );
    const saved = await serializeVisual(editor);
    expect(saved.stored).toContain('href="{{{URL|https://example.test/?a=1&amp;b=2}}}"');
    expect(saved.stored).toContain("{{{NAME|R&D}}}");
    expect(saved.stored).not.toContain('href="{{{URL|https://example.test/?a=1&b=2}}}"');
  });

  it("keeps encoded attributes visible to the existing safety guard", () => {
    const safe = '<p>{{{NAME|<em>R&D</em>}}} <a href="https://example.test/?a=1&amp;b=2">Open</a></p>';
    expect(unsafePaste(loadVisualHtml(safe))).toBe(false);
    const unsafe = '<p>{{{NAME|R&D}}} <a href="java&#x73;cript:alert(1)">Open</a></p>';
    expect(loadVisualHtml(unsafe)).toContain('href="java&#x73;cript:alert(1)"');
    expect(unsafePaste(loadVisualHtml(unsafe))).toBe(true);
  });

  it("preserves required, empty and numeric server semantics", async () => {
    const editor = await open("<p>{{{REQUIRED}}}|{{{EMPTY|}}}|{{{COUNT|0}}}|{{legacy}}</p>");
    const saved = await serializeVisual(editor);
    expect(saved.stored).toContain("{{{REQUIRED}}}|{{{EMPTY|}}}|{{{COUNT|0}}}|{{legacy}}");
    expect(() => renderTemplate({ html: saved.stored }, { legacy: "old" })).toThrow("Missing template variable: REQUIRED");
    for (const value of [null, ""]) {
      const delivered = renderTemplate({ html: saved.stored }, { REQUIRED: "yes", EMPTY: value, COUNT: value, legacy: "old" }).html!;
      expect(new DOMParser().parseFromString(delivered, "text/html").body.textContent).toContain("yes||0|old");
    }
    const delivered = renderTemplate({ html: saved.stored }, { REQUIRED: 0, EMPTY: 0, COUNT: 7, legacy: "old" }).html!;
    expect(new DOMParser().parseFromString(delivered, "text/html").body.textContent).toContain("0|0|7|old");
  });

  it("keeps conditional and each blocks, including literal item defaults", async () => {
    const raw = "{{{name|<em>R&D &amp;</em>}}}";
    const editor = await open(`<p>{{{#if SHOW}}}{{{#each ITEMS}}}${raw} {{{quantity|0}}};{{{/each}}}{{{/if}}}</p>`);
    const saved = await serializeVisual(editor);
    expect(saved.stored).toContain(raw);
    expect(saved.stored).toContain("{{{#if SHOW}}}");
    expect(saved.stored).toContain("{{{#each ITEMS}}}");
    const delivered = renderTemplate({ html: saved.stored }, { SHOW: true, ITEMS: [{ quantity: 2 }, { name: "", quantity: 0 }] }).html!;
    expect(delivered).toMatch(/&lt;em&gt;R&amp;D &amp;amp;&lt;\/em&gt;\s+2;\s+0;/);
    expect(new DOMParser().parseFromString(delivered, "text/html").querySelector("em")).toBeNull();
  });

  it("never shields comments, attributes, style or script bodies", () => {
    const source = `<!-- {{{COMMENT|<em>&amp;</em>}}} -->` +
      `<style>.x { --value: "{{{STYLE|&amp;}}}"; }</style>` +
      `<script>const x = "{{{SCRIPT|&amp;}}}";</script>` +
      `<p data-value="{{{ATTRIBUTE|&amp;}}}">{{{TEXT|<em>&amp;</em>}}}</p>`;
    const loaded = loadVisualHtml(source);
    expect(loaded).toContain(`<!-- {{{COMMENT|<em>&amp;</em>}}} -->`);
    expect(loaded).toContain(`--value: "{{{STYLE|&amp;}}}"`);
    expect(loaded).toContain(`const x = "{{{SCRIPT|&amp;}}}"`);
    expect(loaded).toContain(`data-value="{{{ATTRIBUTE|&amp;}}}"`);
    expect(loaded).toContain("{{{TEXT|&lt;em&gt;&amp;amp;&lt;/em&gt;}}}");
  });
});
