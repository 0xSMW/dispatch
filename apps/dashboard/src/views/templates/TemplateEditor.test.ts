// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { template } from "./fixtures";
import { api, calls, list, renderAt } from "./harness";
import { declare, patchBody, publishWarnings, TemplateEditor, testValues, toForm } from "./TemplateEditor";

function setup() {
  const fetch = api({
    "GET /templates/tpl_1": template(),
    "GET /brand": { object: "brand", product_name: "Acme" },
    "GET /templates/tpl_1/versions": list([]),
    "PATCH /templates/tpl_1": (_url: URL, init: RequestInit) => ({ body: { ...template(), ...JSON.parse(String(init.body)) } }),
    "POST /templates/tpl_1/publish": template({ has_unpublished_versions: false }),
    "POST /templates/tpl_1/render": { rendered: { subject: "Welcome, Ada", html: "<p>Hi Ada, your plan is Free.</p>", text: null } },
    "POST /emails": { id: "email_1" },
  });
  const router = renderAt("/templates/tpl_1/editor", [{ path: "/templates/:id/editor", element: h(TemplateEditor) }]);
  return { fetch, router };
}

async function editHtml(value: string) {
  const area = await screen.findByLabelText("HTML");
  fireEvent.change(area, { target: { value } });
  return area;
}

function preview() {
  const source = document.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  return new DOMParser().parseFromString(source, "text/html").body.innerHTML;
}

describe("TemplateEditor", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("fills the preview live and lists new variables as Required", async () => {
    setup();
    await editHtml("<p>{{{GREETING}}} {{{NAME}}} from {{{PRODUCT_NAME}}}</p>");
    expect(preview()).toBe("<p>[GREETING] [NAME] from Acme</p>");
    const table = screen.getByRole("heading", { name: "Variables" }).closest("section")!;
    const row = within(table).getByText("GREETING").closest("tr")!;
    expect(within(row).getByRole("button", { name: "Required" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(row).queryByLabelText("Fallback for GREETING")).toBeNull();
    expect(within(table).getByText(/PRODUCT_NAME/)).toBeTruthy();

    fireEvent.change(within(row).getByLabelText("Sample value for GREETING"), { target: { value: "Hello" } });
    expect(preview()).toBe("<p>Hello [NAME] from Acme</p>");
  });

  it("saves changed fields and the declared variables on Cmd+S", async () => {
    const { fetch } = setup();
    await editHtml("<p>{{{NAME}}} {{{CITY}}}</p>");
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(1));
    expect(calls(fetch, "PATCH /templates/tpl_1")[0]!.body).toEqual({
      html: "<p>{{{NAME}}} {{{CITY}}}</p>",
      variables: [
        { key: "NAME", type: "string", fallback_value: null },
        { key: "CITY", type: "string", fallback_value: null },
        { key: "PLAN", type: "string", fallback_value: "Free" },
      ],
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("autosaves after a pause in typing", async () => {
    const { fetch } = setup();
    fireEvent.change(await screen.findByLabelText("Subject"), { target: { value: "Hello {{{NAME}}}" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await waitFor(() => expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(1), { timeout: 3000 });
    expect(calls(fetch, "PATCH /templates/tpl_1")[0]!.body).toEqual({ subject: "Hello {{{NAME}}}" });
  });

  it("does not send a refused form again until it is edited", async () => {
    const fetch = api({
      "GET /templates/tpl_1": template(),
      "GET /brand": { object: "brand", product_name: "Acme" },
      "PATCH /templates/tpl_1": () => ({ status: 400, body: { name: "validation_error", statusCode: 400, message: "from is not a valid address" } }),
    });
    renderAt("/templates/tpl_1/editor", [{ path: "/templates/:id/editor", element: h(TemplateEditor) }]);
    fireEvent.change(await screen.findByLabelText("From"), { target: { value: "Acme <hello@" } });
    await screen.findByText(/Not saved: from is not a valid address/, undefined, { timeout: 3000 });
    // Two more autosave periods pass with no edit. The same form is not sent again.
    await new Promise((resolve) => setTimeout(resolve, 3300));
    expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(1);
    // An edit arms the timer again.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "Acme <hello@acme" } });
    await waitFor(() => expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(2), { timeout: 3000 });
  }, 12_000);

  it("types the values a test send starts with", () => {
    const variables = [
      { key: "NAME", type: "string" as const, fallback_value: null },
      { key: "PLAN", type: "string" as const, fallback_value: "Free" },
      { key: "COUNT", type: "number" as const, fallback_value: null },
      { key: "SEATS", type: "number" as const, fallback_value: 5 },
      { key: "ITEMS", type: "list" as const, fallback_value: null },
    ];
    // No samples: stand-ins for what has no fallback, and nothing for what has one.
    expect(testValues(variables)).toEqual({ NAME: "[NAME]", COUNT: 1, ITEMS: [] });
    expect(testValues(variables, { NAME: "Ada", COUNT: "3", SEATS: "9", ITEMS: '[{"description":"Pro"}]', PLAN: "" })).toEqual({
      NAME: "Ada",
      COUNT: 3,
      SEATS: 9,
      ITEMS: [{ description: "Pro" }],
    });
    // Contact fields and the unsubscribe link the template uses get sample values.
    const found = [
      { key: "contact.first_name", type: "string" as const, inline: true },
      { key: "DISPATCH_UNSUBSCRIBE_URL", type: "string" as const, inline: false },
      { key: "PRODUCT_NAME", type: "string" as const, inline: false },
    ];
    expect(testValues([], {}, found)).toEqual({
      contact: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
      DISPATCH_UNSUBSCRIBE_URL: "https://example.com/unsubscribe",
    });
  });

  it("does not declare a name the API refuses, and warns about it", () => {
    const form = { subject: "", from: "a@b.co", reply_to: "", html: "<p>{{first-name}} {{{NAME}}} {{{constructor}}}</p>", text: "", variables: [] };
    expect(patchBody({ html: form.html }, form, []).variables).toEqual([{ key: "NAME", type: "string", fallback_value: null }]);
    expect(publishWarnings(form).join(" ")).toContain("first-name, constructor are not valid variable names");
    expect(publishWarnings({ ...form, html: "{{{#if NAME}}}x" }).join(" ")).toContain("{{{#if NAME}}} is never closed");
  });

  it("lists warnings before publishing, then publishes", async () => {
    const { fetch } = setup();
    await screen.findByLabelText("HTML");
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/NAME has no fallback/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(calls(fetch, "POST /templates/tpl_1/publish")).toHaveLength(1));
    expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(0);
  });

  it("saves, then renders the test send on the server from the draft", async () => {
    const { fetch } = setup();
    await editHtml("<p>Hello {{{NAME}}}, your plan is {{{PLAN}}}.</p>");
    fireEvent.click(screen.getByRole("button", { name: "Test email" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/^To/), { target: { value: "ada@example.com" } });
    fireEvent.change(dialog.getByLabelText(/^Variables/), { target: { value: '{"NAME": "Ada"}' } });
    fireEvent.click(dialog.getByRole("button", { name: /^Send test/ }));
    await waitFor(() => expect(calls(fetch, "POST /emails")).toHaveLength(1));
    expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(1);
    expect(calls(fetch, "POST /templates/tpl_1/render")[0]!.body).toEqual({ variables: { NAME: "Ada" }, draft: true });
    expect(calls(fetch, "POST /emails")[0]!.body).toEqual({
      from: "Acme <hello@acme.test>",
      to: ["ada@example.com"],
      subject: "[TEST] Welcome, Ada",
      html: "<p>Hi Ada, your plan is Free.</p>",
    });
  });

  it("asks before leaving with unsaved changes", async () => {
    const { router } = setup();
    await editHtml("<p>changed</p>");
    fireEvent.click(screen.getByRole("link", { name: "Templates" }));
    expect(await screen.findByText("Leave without saving?")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/templates/tpl_1/editor");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/templates/tpl_1"));
  });
});

describe("TemplateEditor helpers", () => {
  it("declares used keys, keeps configured unused ones, and drops unused defaults", () => {
    const declared = declare(
      [
        { key: "OLD", type: "string", fallback_value: null },
        { key: "KEPT", type: "string", fallback_value: "x" },
        { key: "NAME", type: "number", fallback_value: 3 },
      ],
      [
        { key: "NAME", type: "string", inline: false },
        { key: "PRODUCT_NAME", type: "string", inline: false },
        { key: "ITEMS", type: "list", inline: false },
      ],
    );
    expect(declared).toEqual([
      { key: "NAME", type: "number", fallback_value: 3 },
      { key: "ITEMS", type: "list", fallback_value: null },
      { key: "KEPT", type: "string", fallback_value: "x" },
    ]);
  });

  it("turns form changes into a PATCH body and clears emptied fields with null", () => {
    const form = toForm(template());
    const sent = declare(form.variables, [{ key: "NAME", type: "string", inline: false }, { key: "PLAN", type: "string", inline: false }]);
    expect(patchBody({ html: "" }, { ...form, html: "" }, sent)).toEqual({ html: null });
    expect(patchBody({ html: "", subject: "Hi" }, { ...form, html: "", subject: "Hi" }, sent)).toEqual({
      html: null,
      subject: "Hi",
      variables: [{ key: "PLAN", type: "string", fallback_value: "Free" }],
    });
    expect(patchBody({ reply_to: "a@x.test, b@x.test" }, { ...form, reply_to: "a@x.test, b@x.test" }, sent)).toEqual({ reply_to: ["a@x.test", "b@x.test"] });
    expect(patchBody({ subject: " " }, { ...form, subject: " " }, sent)).toEqual({ subject: null });
    expect(patchBody({ from: "" }, { ...form, from: "" }, sent)).toEqual({ from: null });
    expect(patchBody({ reply_to: "" }, { ...form, reply_to: "" }, sent)).toEqual({ reply_to: null });
  });

  it("sends a number fallback as a number", () => {
    const form = { ...toForm(template()), html: "{{{COUNT}}}", subject: "Hi", variables: [{ key: "COUNT", type: "number" as const, fallback_value: "5" }] };
    expect(patchBody({ html: form.html }, form, []).variables).toEqual([{ key: "COUNT", type: "number", fallback_value: 5 }]);
  });

  it("warns about required variables and missing defaults", () => {
    const warnings = publishWarnings({ subject: "", from: "", reply_to: "", html: "{{{A}}} {{{B|x}}}", text: "", variables: [] });
    expect(warnings).toEqual(["A has no fallback. Sends that leave it out fail.", "No subject. Every send must pass one.", "No From address. Every send must pass one."]);
  });
});
