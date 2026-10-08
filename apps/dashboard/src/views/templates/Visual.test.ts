import { changeControl, controlValue } from "../../testingControls";
// @vitest-environment jsdom
// HTML with placeholders goes through @react-email/editor and
// comes back with every placeholder intact, or the guard keeps the user in Code mode.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { LeaveGuard, Source, type Flush } from "./editor";
import { template } from "./fixtures";
import { tokens, unsafePaste } from "./guard";
import { api, calls, list, renderAt } from "./harness";
import { TemplateEditor } from "./TemplateEditor";
import Visual from "./Visual";
import type { Editor as TipTap } from "./placeholders";
import type { Variable } from "./render";

type Editor = { commands: { focus: (at: "end") => boolean; insertContent: (value: string) => boolean } };

// jsdom has no layout. ProseMirror and the package's bubble menu measure the selection, so they get empty boxes.
beforeAll(() => {
  const box = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => box as DOMRect;
  document.elementFromPoint = () => null;
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

/** The TipTap editor behind the visual canvas. TipTap puts it on its root element. */
async function editor(): Promise<Editor> {
  const root = await waitFor(() => {
    const element = document.querySelector(".visualCanvas:not(.checking) .tiptap");
    if (!element) throw new Error("The visual editor is not ready.");
    return element as Element & { editor: Editor };
  });
  return root.editor;
}

/** Types at the end of the document, the way a user would. */
async function type(value: string) {
  const current = await editor();
  act(() => {
    current.commands.focus("end");
    current.commands.insertContent(value);
  });
}

/**
 * Loads `html` into the visual editor, makes one edit, and returns what the editor wrote, or the reason
 * it refused. Hand-written HTML only opens as a conversion the user agreed to, so `convert` is on
 * unless a test turns it off.
 */
async function roundTrip(html: string, convert = true) {
  const onHtml = vi.fn();
  const onReject = vi.fn();
  render(h(Visual, { html, convert, onHtml, onReject }));
  await waitFor(() => expect(onReject.mock.calls.length + (document.querySelector(".visualCanvas:not(.checking) .tiptap") ? 1 : 0)).toBe(1), {
    timeout: 3000,
  });
  if (onReject.mock.calls.length > 0) return { rejected: String(onReject.mock.calls[0]![0]), convertible: Boolean(onReject.mock.calls[0]![1]), html: null };
  await type(" Edited");
  await waitFor(() => expect(onHtml).toHaveBeenCalled());
  return { rejected: null, convertible: false, html: String(onHtml.mock.calls.at(-1)![0]) };
}

describe("round trip through @react-email/editor", () => {
  const kept: Record<string, string> = {
    "a placeholder": "<p>Hi {{{FIRST_NAME}}}, welcome.</p>",
    "a placeholder with a fallback": "<p>Hi {{{FIRST_NAME|there}}},</p>",
    "an if block inside a paragraph": "<p>Hello {{{#if VIP}}}gold member{{{/if}}}</p>",
    "an if block around paragraphs": "<p>Intro</p>{{{#if VIP}}}<p>Members only</p>{{{/if}}}<p>Outro</p>",
    "an unless block": "<p>{{{#unless PAID}}}Your invoice is due.{{{/unless}}}</p>",
    "an each block around paragraphs": "<p>{{{#each ITEMS}}}</p><p>{{{name}}}: {{{price}}}</p><p>{{{/each}}}</p>",
    "a placeholder as the whole href (react-email issue 3247)": '<p><a href="{{{URL}}}">Open</a></p>',
    "a placeholder inside an href query": '<p><a href="https://acme.test/track?id={{{ID}}}&amp;ref=mail">Track</a></p>',
    "a placeholder with a URL fallback in an href": '<p><a href="{{{URL|https://acme.test}}}">Open</a></p>',
    "the unsubscribe placeholder in an href": '<p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>',
    "a placeholder as an image src": '<p>Logo</p><img src="{{{LOGO_URL}}}" alt="Logo">',
  };

  for (const [name, html] of Object.entries(kept)) {
    it(`keeps ${name}`, async () => {
      const out = await roundTrip(html);
      expect(out.rejected).toBeNull();
      expect(out.html).toContain("Edited");
      for (const token of tokens(html)) expect(tokens(out.html)).toContain(token);
      expect(tokens(out.html)).toEqual(tokens(html));
    });
  }

  it("writes the href placeholder back verbatim", async () => {
    const out = await roundTrip('<p><a href="{{{URL}}}">Open</a></p>');
    expect(out.html).toContain('href="{{{URL}}}"');
  });

  it("refuses a loop between list items", async () => {
    const out = await roundTrip("<ul>{{{#each ITEMS}}}<li>{{{name}}}</li>{{{/each}}}</ul>");
    expect(out.rejected).toBe("{{{#each ITEMS}}} sits between list items or table rows, which visual mode cannot keep.");
  });

  it("refuses a library template, which keeps placeholders in style attributes", async () => {
    const library = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/templates/library.json"), "utf8")) as {
      templates: Array<{ slug: string; html: string }>;
    };
    const welcome = library.templates.find((item) => item.slug === "welcome")!;
    const out = await roundTrip(welcome.html);
    expect(out.rejected).toMatch(/^Visual mode would change placeholders \d+, such as \{\{\{/);
  });

  it("writes nothing until the user edits", async () => {
    const onHtml = vi.fn();
    render(h(Visual, { html: "<p>Hi {{{NAME}}}</p>", convert: true, onHtml, onReject: vi.fn() }));
    await editor();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onHtml).not.toHaveBeenCalled();
  });
});

describe("what visual mode opens", () => {
  const count = (html: string | null, tag: string) => (html ?? "").split(`<${tag}`).length - 1;

  it("refuses hand-written HTML until the user agrees to a conversion", async () => {
    const out = await roundTrip('<center><font color="#ff0000">Hi {{{NAME}}}</font></center>', false);
    expect(out.rejected).toMatch(/^Visual mode would rebuild this HTML in its own layout/);
    // Nothing would be lost but formatting, so the page may offer to convert.
    expect(out.convertible).toBe(true);
  });

  it("opens its own output with no conversion, and a second visit adds nothing to it", async () => {
    const first = await roundTrip("<p>Hi {{{NAME}}}</p>");
    cleanup();
    const second = await roundTrip(first.html!, false);
    expect(second.rejected).toBeNull();
    cleanup();
    const third = await roundTrip(second.html!, false);
    expect(third.rejected).toBeNull();
    // Each visit used to wrap the email in one more container table.
    expect([count(first.html, "table"), count(second.html, "table"), count(third.html, "table")]).toEqual([2, 2, 2]);
    expect(tokens(third.html)).toEqual(["{{{NAME}}}"]);
    expect(third.html).toContain("Edited Edited Edited");
  });

  it("opens an empty template", async () => {
    const out = await roundTrip("", false);
    expect(out.rejected).toBeNull();
    expect(out.html).toContain("Edited");
  });

  it("refuses text that would come back as a live placeholder", async () => {
    const out = await roundTrip("<p>Type &#123;&#123;&#123;NAME&#125;&#125;&#125; to personalize</p>");
    expect(out.rejected).toBe("Visual mode would turn text into the placeholder {{{NAME}}}.");
    expect(out.convertible).toBe(false);
  });

  it("keeps the selection when an image file is pasted, and writes nothing", async () => {
    const onHtml = vi.fn();
    render(h(Visual, { html: '<p>Keep this sentence.</p><img src="{{{LOGO_URL}}}" alt="Logo">', convert: true, onHtml, onReject: vi.fn() }));
    const current = (await editor()) as Editor & { commands: { selectAll: () => boolean }; getHTML: () => string };
    const before = current.getHTML();
    act(() => void current.commands.selectAll());
    const file = new File(["png"], "photo.png", { type: "image/png" });
    const target = document.querySelector(".tiptap")!;
    // fireEvent returns false when the event's default was prevented.
    expect(fireEvent.paste(target, { clipboardData: { files: [file], getData: () => "" } })).toBe(false);
    expect(fireEvent.drop(target, { dataTransfer: { files: [file], getData: () => "" } })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(current.getHTML()).toBe(before);
    expect(onHtml).not.toHaveBeenCalled();
  });

  it("refuses pasted HTML that carries a data image or a script link", async () => {
    render(h(Visual, { html: "", onHtml: vi.fn(), onReject: vi.fn() }));
    await editor();
    const target = document.querySelector(".tiptap")!;
    const current = (await editor()) as Editor & { getHTML: () => string };
    const before = current.getHTML();
    const paste = (markup: string) => fireEvent.paste(target, { clipboardData: { files: [], getData: (type: string) => (type === "text/html" ? markup : "") } });
    paste('<p>Hi</p><img src="data:image/png;base64,AAAA">');
    paste('<p><a href="javascript:alert(1)">x</a></p>');
    expect(current.getHTML()).toBe(before);
    expect(unsafePaste('<p><a href="https://acme.test">ok</a> and <img src="https://acme.test/a.png"></p>')).toBe(false);
  });

  for (const eventType of ["paste", "drop"] as const) {
    it(`rejects raw native ${eventType} markup hidden in a fallback without changing the document or selection`, async () => {
      const onHtml = vi.fn();
      render(h(Visual, { html: "<p>Keep this sentence.</p>", convert: true, onHtml, onReject: vi.fn() }));
      const current = (await editor()) as TipTap;
      act(() => void current.commands.setTextSelection({ from: 2, to: 7 }));
      const before = current.state.doc.toJSON();
      const selection = current.state.selection.toJSON();
      const target = document.querySelector(".tiptap")!;
      const markups = [
        '<span style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:red">Overlay</span>',
        '<a href="java&#x73;cript:alert(1)">Link</a>',
        '<img src="data:image/png;base64,AAAA">',
        '<img src="blob:https://acme.test/image">',
        "<script>alert(1)</script>",
        "<iframe src='/frame'></iframe>",
        "<form>Form</form>",
      ];
      for (const markup of markups) {
        const html = `<p>{{{name|${markup}}}}</p>`;
        const event = new Event(eventType, { bubbles: true, cancelable: true });
        Object.defineProperty(event, eventType === "paste" ? "clipboardData" : "dataTransfer", {
          value: { files: [], types: ["text/html", "text/plain"], getData: (type: string) => type === "text/html" ? html : type === "text/plain" ? "{{{name|Text}}}" : "" },
        });
        expect(fireEvent(target, event), markup).toBe(false);
        expect(current.state.doc.toJSON(), markup).toEqual(before);
        expect(current.state.selection.toJSON(), markup).toEqual(selection);
        expect(target.querySelector("span[style*='position'], a, img, script, iframe, form"), markup).toBeNull();
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(onHtml).not.toHaveBeenCalled();
    });
  }

  it("accepts safe native HTML and plain-text paste", async () => {
    const onHtml = vi.fn();
    render(h(Visual, { html: "<p>Start.</p>", convert: true, onHtml, onReject: vi.fn() }));
    const current = await editor();
    const target = document.querySelector(".tiptap")!;
    const paste = (html: string, text: string) => {
      act(() => void current.commands.focus("end"));
      return fireEvent.paste(target, {
        clipboardData: { files: [], types: html ? ["text/html", "text/plain"] : ["text/plain"], getData: (type: string) => type === "text/html" ? html : type === "text/plain" ? text : "" },
      });
    };
    paste('<p>Safe &amp; <strong>ordinary</strong> <a href="https://acme.test">link</a></p>', "Safe & ordinary link");
    expect(target.textContent).toContain("Safe & ordinary link");
    expect(target.querySelector("strong")?.textContent).toBe("ordinary");
    expect(target.querySelector("a")?.getAttribute("href")).toBe("https://acme.test");
    paste("", 'Plain <span>literal</span> & "quoted"');
    expect(target.textContent).toContain('Plain <span>literal</span> & "quoted"');
    expect(target.querySelector("span")).toBeNull();
    await waitFor(() => expect(onHtml).toHaveBeenCalled());
  });

  it("writes nothing from a read-only editor, whatever its menus let through", async () => {
    const onHtml = vi.fn();
    render(h(Visual, { html: "<p>Sent already</p>", convert: true, editable: false, onHtml, onReject: vi.fn() }));
    await type(" changed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onHtml).not.toHaveBeenCalled();
  });
});

/** Source with its HTML in state, like the editors keep it in the draft. */
function Harness({ initial, onHtml }: { initial: string; onHtml?: (value: string) => void }) {
  const [html, setHtml] = useState(initial);
  return h(Source, {
    html,
    text: "",
    onHtml: (value: string) => {
      setHtml(value);
      onHtml?.(value);
    },
    onText: () => undefined,
  });
}

describe("Source mode switch", () => {
  it("starts in Code and switches to Visual and back", async () => {
    const onHtml = vi.fn();
    render(h(Harness, { initial: "", onHtml }));
    expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("HTML")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Visual" }));
    expect(screen.getByRole("button", { name: "Visual" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("HTML")).toBeNull();
    await type("Hi {{{NAME}}} there");
    await waitFor(() => expect(onHtml).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    const area = (await screen.findByLabelText("HTML")) as HTMLTextAreaElement;
    expect(area.value).toContain("Hi {{{NAME}}} there");
  });

  it("hands over the last edit before Code takes over, so typing in Code is not overwritten", async () => {
    render(h(Harness, { initial: "" }));
    fireEvent.click(screen.getByRole("button", { name: "Visual" }));
    await type("From visual");
    // Straight away, inside the quarter second the editor waits before it writes.
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    const area = (await screen.findByLabelText("HTML")) as HTMLTextAreaElement;
    expect(area.value).toContain("From visual");
    changeControl(area, { target: { value: "<p>Typed in code</p>" } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((screen.getByLabelText("HTML") as HTMLTextAreaElement).value).toBe("<p>Typed in code</p>");
  });

  it("tells the page an edit is waiting until the draft has it", async () => {
    const flushRef: { current: Flush | null } = { current: null };
    const onHtml = vi.fn();
    function Page() {
      const [html, setHtml] = useState("");
      const write = (value: string) => {
        setHtml(value);
        onHtml(value);
      };
      return h(Source, { html, text: "", onHtml: write, onText: () => undefined, flushRef });
    }
    render(h(Page));
    expect(flushRef.current!.waiting()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Visual" }));
    await type("Not saved yet");
    // Inside the quarter second: the draft has heard nothing, so it does not read as dirty.
    expect(onHtml).not.toHaveBeenCalled();
    expect(flushRef.current!.waiting()).toBe(true);
    await act(() => flushRef.current!());
    expect(onHtml).toHaveBeenCalled();
    expect(flushRef.current!.waiting()).toBe(false);
  });

  it("stops a leave while an edit is waiting, though the draft is clean", async () => {
    let waiting = true;
    const page = h("div", null, h(Link, { to: "/elsewhere" }, "Away"), h(LeaveGuard, { when: false, pending: () => waiting }));
    const router = renderAt("/here", [{ path: "/here", element: page }]);
    fireEvent.click(screen.getByRole("link", { name: "Away" }));
    expect(await screen.findByText("Leave without saving?")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/here");
    fireEvent.click(screen.getByRole("button", { name: /^Stay/ }));

    waiting = false;
    fireEvent.click(screen.getByRole("link", { name: "Away" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"));
  });

  it("offers to convert hand-written HTML, and opens it only after the user confirms", async () => {
    const onHtml = vi.fn();
    render(h(Harness, { initial: "<p>Hi {{{NAME}}}</p>", onHtml }));
    fireEvent.click(screen.getByRole("button", { name: "Visual" }));
    expect(await screen.findByText(/Visual mode would rebuild this HTML in its own layout/, undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByLabelText("HTML")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Convert to visual" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Every placeholder, link, and image is kept");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Convert/ }));
    await type(" there");
    await waitFor(() => expect(onHtml).toHaveBeenCalled());
    expect(tokens(String(onHtml.mock.calls.at(-1)![0]))).toEqual(["{{{NAME}}}"]);
  });

  it("does not offer visual mode for a read-only broadcast", () => {
    render(h(Source, { html: "<p>Sent</p>", text: "", onHtml: () => undefined, onText: () => undefined, disabled: true }));
    expect(screen.queryByRole("button", { name: "Visual" })).toBeNull();
    expect((screen.getByLabelText("HTML") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("will not load HTML that could cover the dashboard or carry a script link", () => {
    for (const [html, reason] of [
      ['<div style="position:fixed;top:0;left:0;z-index:99999">Session expired</div>', /places content over the page/],
      ['<p><a href="java\nscript:alert(1)">x</a></p>', /does not open the link javascript:alert/],
      ['<p><img src="data:image/png;base64,AAAA"></p>', /holds an image as data/],
    ] as const) {
      render(h(Harness, { initial: html }));
      fireEvent.click(screen.getByRole("button", { name: "Visual" }));
      expect(screen.getByText(reason)).toBeTruthy();
      expect(screen.getByLabelText("HTML")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Convert to visual" })).toBeNull();
      cleanup();
    }
  });

  it("keeps the user in Code and says why when the round trip would lose a placeholder", async () => {
    // The library templates link their logo like this. The editor's image block cannot carry a link.
    const html = '<p>Hi</p><a href="{{{PRODUCT_URL}}}"><img src="{{{LOGO_URL}}}" alt="Logo"></a>';
    render(h(Harness, { initial: html }));
    fireEvent.click(screen.getByRole("button", { name: "Visual" }));
    expect(await screen.findByText("Visual mode would change the placeholder {{{PRODUCT_URL}}}.", undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("HTML") as HTMLTextAreaElement).value).toBe(html);
    // A placeholder would be lost, so no conversion is offered.
    expect(screen.queryByRole("button", { name: "Convert to visual" })).toBeNull();
  });

  it("refuses a loop between list items without loading the editor", () => {
    render(h(Harness, { initial: "<ul>{{{#each ITEMS}}}<li>{{{name}}}</li>{{{/each}}}</ul>" }));
    fireEvent.click(screen.getByRole("button", { name: "Visual" }));
    expect(screen.getByText("{{{#each ITEMS}}} sits between list items or table rows, which visual mode cannot keep.")).toBeTruthy();
    expect(screen.getByLabelText("HTML")).toBeTruthy();
  });

  it("hides the switch on the plain text tab", async () => {
    render(h(Harness, { initial: "<p>Hi</p>" }));
    fireEvent.click(screen.getByRole("tab", { name: "Plain text" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Visual" })).toBeNull());
  });
});

describe("TemplateEditor in Visual mode", () => {
  beforeEach(() => signIn());

  it("puts a visual edit into the draft's HTML, the preview, and the autosave", async () => {
    const fetch = api({
      "GET /templates/tpl_1": template(),
      "GET /brand": { object: "brand", product_name: "Acme" },
      "GET /templates/tpl_1/versions": list([]),
      "PATCH /templates/tpl_1": (_url: URL, init: RequestInit) => ({ body: { ...template(), ...JSON.parse(String(init.body)) } }),
    });
    renderAt("/templates/tpl_1/editor", [{ path: "/templates/:id/editor", element: h(TemplateEditor) }]);
    // The fixture's HTML was written by hand, so visual mode asks before it rebuilds it.
    fireEvent.click(await screen.findByRole("button", { name: "Visual" }));
    fireEvent.click(await screen.findByRole("button", { name: "Convert to visual" }, { timeout: 3000 }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Convert/ }));
    await type(" Thanks.");

    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    const srcdoc = document.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Thanks.");

    await waitFor(() => expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(1), { timeout: 4000 });
    const body = calls(fetch, "PATCH /templates/tpl_1")[0]!.body as { html: string };
    expect(body.html).toContain("Thanks.");
    expect(tokens(body.html)).toEqual(["{{{NAME}}}", "{{{PLAN}}}"]);
  });
});

describe("Visual placeholder controls", () => {
  async function select(key: string, occurrence = 0) {
    const current = await editor() as TipTap;
    let position = -1;
    current.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const index = node.text!.indexOf(key);
      if (index >= 0 && occurrence-- === 0) position = pos + index + 1;
    });
    expect(position).toBeGreaterThan(0);
    act(() => {
      (document.querySelector(".tiptap") as HTMLElement).focus();
      current.commands.setTextSelection(position);
    });
    return current;
  }
  function setup(html: string, variables: Variable[] = []) {
    const onHtml = vi.fn();
    const changed = vi.fn();
    function Page() {
      const [values, setValues] = useState(variables);
      const [fallbacks] = useState({ current: new Map<string, string | number>() });
      return h(Visual, {
        html, convert: true, onHtml, onReject: vi.fn(),
        placeholders: { variables: values, fallbacks, onChange: (key, change) => {
          changed(key, change);
          setValues((current) => current.map((item) => item.key === key ? { ...item, ...change } : item));
        } },
      });
    }
    render(h(Page));
    return { onHtml, changed };
  }
  it("opens the shared controls without editing HTML and round-trips a saved fallback", async () => {
    const { onHtml, changed } = setup("<p>Hi {{{NAME}}}.</p>", [{ key: "NAME", type: "string", fallback_value: "Ada" }]);
    await select("NAME");
    const panel = within(screen.getByRole("complementary", { name: "Placeholder controls" }));
    expect((panel.getByLabelText("Name") as HTMLInputElement).value).toBe("NAME");
    expect((panel.getByLabelText("List item") as HTMLInputElement).value).toBe("Not a list item");
    fireEvent.click(panel.getByRole("button", { name: "Required" }));
    expect(changed).toHaveBeenLastCalledWith("NAME", { fallback_value: null });
    fireEvent.click(panel.getByRole("button", { name: "Optional" }));
    expect(changed).toHaveBeenLastCalledWith("NAME", { fallback_value: "Ada" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onHtml).not.toHaveBeenCalled();
  });
  it("renames only the selected token, preserving its inline fallback, marks and duplicate", async () => {
    const { onHtml } = setup("<p>Hi <strong>{{{NAME|there}}}</strong> and {{{NAME}}}.</p>");
    await select("NAME");
    const panel = within(screen.getByRole("complementary", { name: "Placeholder controls" }));
    changeControl(panel.getByLabelText("Name"), { target: { value: "FIRST" } });
    fireEvent.blur(panel.getByLabelText("Name"));
    await waitFor(() => expect(onHtml).toHaveBeenCalled());
    const html = String(onHtml.mock.calls.at(-1)![0]);
    expect(tokens(html)).toEqual(["{{{FIRST|there}}}", "{{{NAME}}}"]);
    expect(html).toContain("<strong>{{{FIRST|there}}}</strong>");
  });
  it("keeps the inspector usable when browser selection moves on blur into its controls", async () => {
    setup("<p>Hi {{{NAME}}}.</p>", [{ key: "NAME", type: "string", fallback_value: "Ada" }]);
    const current = await select("NAME");
    const panel = within(screen.getByRole("complementary", { name: "Placeholder controls" }));
    const required = panel.getByRole("button", { name: "Required" });
    // Native focus blurs ProseMirror before React's focus capture runs on the panel.
    act(() => (panel.getByLabelText("Fallback for NAME") as HTMLElement).focus());
    act(() => void current.commands.setTextSelection(2));
    fireEvent.click(required);
    expect(panel.getByRole("button", { name: "Optional" })).toBeTruthy();
    fireEvent.click(panel.getByRole("button", { name: "Optional" }));
    expect((panel.getByLabelText("Fallback for NAME") as HTMLInputElement).value).toBe("Ada");
    fireEvent.focus(document.querySelector(".tiptap")!);
    act(() => void current.commands.setTextSelection(3));
    expect(screen.queryByRole("complementary", { name: "Placeholder controls" })).toBeNull();
  });
  it("keeps lists Required, exposes list-item scope and edits an item fallback without declaring it", async () => {
    const { onHtml, changed } = setup("<p>{{{#each ITEMS}}}</p><p>{{{name|Widget}}}</p><p>{{{/each}}}</p>", [{ key: "ITEMS", type: "list", fallback_value: null }]);
    await select("ITEMS");
    let panel = within(screen.getByRole("complementary", { name: "Placeholder controls" }));
    expect((panel.getByRole("button", { name: "Required" }) as HTMLButtonElement).disabled).toBe(true);
    expect(panel.queryByRole("button", { name: "Optional" })).toBeNull();
    await select("name");
    panel = within(screen.getByRole("complementary", { name: "Placeholder controls" }));
    expect((panel.getByLabelText("List item") as HTMLInputElement).value).toBe("Item in ITEMS");
    changeControl(panel.getByLabelText("Fallback for name"), { target: { value: "Product" } });
    await waitFor(() => expect(onHtml).toHaveBeenCalled());
    expect(tokens(String(onHtml.mock.calls.at(-1)![0]))).toEqual(["{{{#each ITEMS}}}", "{{{name|Product}}}", "{{{/each}}}"]);
    expect(changed).not.toHaveBeenCalled();
  });
  it("restores a hidden item fallback after dismissing and reselecting the inspector", async () => {
    const { onHtml, changed } = setup("<p>Intro</p><p>{{{#each ITEMS}}}</p><p>{{{name|Widget}}}</p><p>{{{/each}}}</p>");
    const current = await select("name");
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "Required" }));
    expect(current.state.doc.textContent).toContain("{{{name}}}");
    await waitFor(() => expect(String(onHtml.mock.calls.at(-1)?.[0])).toContain("{{{name}}}"));
    act(() => void current.commands.setTextSelection(1));
    expect(screen.queryByRole("complementary")).toBeNull();
    await select("name");
    const panel = within(screen.getByRole("complementary"));
    fireEvent.click(panel.getByRole("button", { name: "Optional" }));
    expect((panel.getByLabelText("Fallback for name") as HTMLInputElement).value).toBe("Widget");
    expect((panel.getByLabelText("List item") as HTMLInputElement).value).toBe("Item in ITEMS");
    await waitFor(() => expect(String(onHtml.mock.calls.at(-1)?.[0])).toContain("{{{name|Widget}}}"));
    expect(changed).not.toHaveBeenCalled();
  });
  it("keeps same-name item occurrences independent through nearby edits and renaming", async () => {
    setup("<p>Intro</p><p>{{{#each ITEMS}}}</p><p>{{{name|First}}}</p><p>{{{name|Second}}}</p><p>{{{/each}}}</p>");
    const current = await select("name", 0);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "Required" }));
    await select("name", 1);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "Required" }));
    act(() => {
      current.commands.setTextSelection(1);
      current.commands.insertContent("Nearby & ");
    });
    expect(screen.queryByRole("complementary")).toBeNull();
    await select("name", 0);
    let panel = within(screen.getByRole("complementary"));
    changeControl(panel.getByLabelText("Name"), { target: { value: "description" } });
    fireEvent.blur(panel.getByLabelText("Name"));
    act(() => void current.commands.setTextSelection(1));
    await select("description");
    panel = within(screen.getByRole("complementary"));
    fireEvent.click(panel.getByRole("button", { name: "Optional" }));
    expect((panel.getByLabelText("Fallback for description") as HTMLInputElement).value).toBe("First");
    await select("name");
    panel = within(screen.getByRole("complementary"));
    fireEvent.click(panel.getByRole("button", { name: "Optional" }));
    expect((panel.getByLabelText("Fallback for name") as HTMLInputElement).value).toBe("Second");
    expect(current.state.doc.textContent).toContain("{{{description|First}}}{{{name|Second}}}");
  });
  it("does not give a deleted occurrence's hidden fallback to a new token at that position", async () => {
    setup("<p>{{{#each ITEMS}}}</p><p>{{{name|Old}}}</p><p>{{{/each}}}</p>");
    const current = await select("name");
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "Required" }));
    let from = 0;
    current.state.doc.descendants((node, pos) => {
      if (node.text === "{{{name}}}") from = pos;
    });
    act(() => {
      current.view.dispatch(current.state.tr.replaceWith(from, from + "{{{name}}}".length, current.schema.text("{{{name}}}")));
    });
    await select("name");
    const panel = within(screen.getByRole("complementary"));
    fireEvent.click(panel.getByRole("button", { name: "Optional" }));
    expect((panel.getByLabelText("Fallback for name") as HTMLInputElement).value).toBe("");
  });
  it("clears hidden item defaults when the document is replaced", async () => {
    const controls = { variables: [], fallbacks: { current: new Map<string, string | number>() }, onChange: vi.fn() };
    const props = { convert: true, onHtml: vi.fn(), onReject: vi.fn(), placeholders: controls };
    const page = render(h(Visual, { ...props, html: "<p>{{{#each ITEMS}}}</p><p>{{{name|Old}}}</p><p>{{{/each}}}</p>" }));
    await select("name");
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "Required" }));
    page.rerender(h(Visual, { ...props, html: "<p>Replacement</p><p>{{{#each ITEMS}}}</p><p>{{{name}}}</p><p>{{{/each}}}</p>" }));
    await waitFor(() => expect(document.querySelector(".visualCanvas:not(.checking) .tiptap")?.textContent).toContain("Replacement"));
    await select("name");
    const panel = within(screen.getByRole("complementary"));
    fireEvent.click(panel.getByRole("button", { name: "Optional" }));
    expect((panel.getByLabelText("Fallback for name") as HTMLInputElement).value).toBe("");
  });
  it("saves sensitive inspector defaults literally and reloads them without interpreting markup", async () => {
    const { onHtml } = setup("<p>{{{#each ITEMS}}}</p><p>{{{name|Widget}}}</p><p>{{{/each}}}</p>");
    await select("name");
    const fallback = `R&D "<em>plain</em>" &amp; &#39;`;
    changeControl(within(screen.getByRole("complementary")).getByLabelText("Fallback for name"), { target: { value: fallback } });
    await waitFor(() => expect(onHtml).toHaveBeenCalled());
    const saved = String(onHtml.mock.calls.at(-1)![0]);
    expect(saved).toContain(`{{{name|${fallback}}}}`);
    expect(document.querySelector(".tiptap em")).toBeNull();
    cleanup();
    // No conversion is needed for the actual saved HTML. Ordinary edits still work.
    const write = vi.fn();
    render(h(Visual, { html: saved, onHtml: write, onReject: vi.fn() }));
    await type(" Ordinary & <safe>");
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(String(write.mock.calls.at(-1)![0])).toContain(`{{{name|${fallback}}}}`);
    expect(String(write.mock.calls.at(-1)![0])).toMatch(/Ordinary\s+&amp;\s+&lt;safe&gt;/);
    expect(document.querySelector(".tiptap em")).toBeNull();
  });
  it("renames a list whose name is each without changing the block command", async () => {
    const { onHtml } = setup("<p>{{{#each each}}}</p><p>{{{name}}}</p><p>{{{/each}}}</p>", [{ key: "each", type: "list", fallback_value: null }]);
    const current = await editor() as TipTap;
    let position = -1;
    current.state.doc.descendants((node, pos) => {
      if (node.text?.includes("#each each")) position = pos + node.text.indexOf("#each each") + 7;
    });
    act(() => {
      (document.querySelector(".tiptap") as HTMLElement).focus();
      current.commands.setTextSelection(position);
    });
    const input = within(screen.getByRole("complementary", { name: "Placeholder controls" })).getByLabelText("Name");
    changeControl(input, { target: { value: "ITEMS" } });
    fireEvent.blur(input);
    await waitFor(() => expect(onHtml).toHaveBeenCalled());
    expect(tokens(String(onHtml.mock.calls.at(-1)![0]))).toEqual(["{{{#each ITEMS}}}", "{{{name}}}", "{{{/each}}}"]);
  });
  it("clears the panel outside a token and never treats text split by markup as a placeholder", async () => {
    setup("<p>Hi {{{NAME}}} and {{{FI<strong>RST</strong>}}}.</p>");
    const current = await select("NAME");
    expect(screen.getByRole("complementary", { name: "Placeholder controls" })).toBeTruthy();
    act(() => void current.commands.setTextSelection(2));
    expect(screen.queryByRole("complementary", { name: "Placeholder controls" })).toBeNull();
    await select("RST");
    expect(screen.queryByRole("complementary", { name: "Placeholder controls" })).toBeNull();
  });
});
