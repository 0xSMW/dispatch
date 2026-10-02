// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import type { Segment } from "../../types";
import { broadcast, segment, template, topic } from "../templates/fixtures";
import { api, calls, list, renderAt } from "../templates/harness";
import { BroadcastEditor, patchBody, reviewChecks, toForm } from "./BroadcastEditor";

const audience = { object: "broadcast_audience", total: 120, recipients: 112, unsubscribed: 5, suppressed: 3, opted_out: 0, no_first_name: 0, no_last_name: 0 };

function setup(row = broadcast()) {
  const fetch = api({
    "GET /broadcasts/broadcast_1": row,
    "GET /segments": list([segment]),
    "GET /topics": list([topic]),
    "GET /templates": list([template()]),
    "GET /brand": { object: "brand", product_name: "Acme" },
    "PATCH /broadcasts/broadcast_1": (_url: URL, init: RequestInit) => ({ body: { ...row, ...JSON.parse(String(init.body)) } }),
    "POST /links/check": { object: "list", has_more: false, data: [{ object: "link", url: "https://acme.test/new", ok: false, status: 404, message: "404 not found" }] },
    "POST /broadcasts/broadcast_1/send": { id: "broadcast_1" },
    "GET /broadcasts/broadcast_1/audience": audience,
  });
  const router = renderAt("/broadcasts/broadcast_1/editor", [
    { path: "/broadcasts/:id/editor", element: h(BroadcastEditor) },
    { path: "/broadcasts/:id", element: h("p", null, "Detail page") },
  ]);
  return { fetch, router };
}

function preview() {
  return document.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

describe("BroadcastEditor", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("previews for a sample contact and inserts personalization", async () => {
    const { fetch } = setup();
    await screen.findByLabelText("HTML");
    expect(preview()).toContain("<p>Hi Ada</p>");
    const area = screen.getByLabelText("HTML") as HTMLTextAreaElement;
    area.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe link" }));
    // The insert first lets the visual editor hand over a pending edit, so it lands a tick later.
    await waitFor(() => expect(area.value.startsWith('<a href="{{{DISPATCH_UNSUBSCRIBE_URL}}}">Unsubscribe</a>')).toBe(true));
    expect(preview()).toContain('<a href="https://example.com/unsubscribe">Unsubscribe</a>');

    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls(fetch, "PATCH /broadcasts/broadcast_1")).toHaveLength(1));
    expect(Object.keys(calls(fetch, "PATCH /broadcasts/broadcast_1")[0]!.body as object)).toEqual(["html"]);
  });

  it("reviews, checks links, and sends after the typed confirmation", async () => {
    const { fetch, router } = setup();
    await screen.findByLabelText("HTML");
    await screen.findByRole("option", { name: "Customers" });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(await dialog.findByText("Link 404 not found.")).toBeTruthy();
    expect(calls(fetch, "POST /links/check")[0]!.body).toEqual({ urls: ["https://acme.test/new"] });
    expect(await dialog.findByText("Sending to 112 contacts in Customers.")).toBeTruthy();
    expect(dialog.getByText("Skipped: 5 unsubscribed, 3 suppressed.")).toBeTruthy();
    expect(calls(fetch, "GET /broadcasts/broadcast_1/audience")).toHaveLength(1);
    expect(dialog.getByText("No unsubscribe link.")).toBeTruthy();
    expect(dialog.getByText("No topic selected.")).toBeTruthy();

    const send = dialog.getByRole("button", { name: /Send now/ });
    expect(send).toHaveProperty("disabled", true);
    fireEvent.change(dialog.getByLabelText("Confirmation phrase"), { target: { value: "SEND" } });
    expect(send).toHaveProperty("disabled", false);
    fireEvent.click(send);
    await waitFor(() => expect(router.state.location.pathname).toBe("/broadcasts/broadcast_1"));
    expect(calls(fetch, "POST /broadcasts/broadcast_1/send")[0]!.body).toEqual({});
  });

  it("sends a test with the API's own rendering of the saved draft", async () => {
    const fetch = api({
      "GET /broadcasts/broadcast_1": broadcast(),
      "GET /segments": list([segment]),
      "GET /topics": list([topic]),
      "GET /templates": list([template()]),
      "GET /brand": { object: "brand", product_name: "Acme" },
      "PATCH /broadcasts/broadcast_1": (_url: URL, init: RequestInit) => ({ body: { ...broadcast(), ...JSON.parse(String(init.body)) } }),
      "POST /broadcasts/broadcast_1/render": { object: "broadcast_render", rendered: { subject: "Hi Ada", html: "<p>Rendered by the server</p>", text: null } },
      "POST /emails": { id: "email_1" },
    });
    renderAt("/broadcasts/broadcast_1/editor", [{ path: "/broadcasts/:id/editor", element: h(BroadcastEditor) }]);
    fireEvent.change(await screen.findByLabelText("Subject"), { target: { value: "Hi {{{FIRST_NAME}}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Test email" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("To"), { target: { value: "me@acme.test" } });
    fireEvent.click(dialog.getByRole("button", { name: /Send test/ }));
    await waitFor(() => expect(calls(fetch, "POST /emails")).toHaveLength(1));

    // The unsaved subject is saved first, then the API renders it. The browser's own fill is not what goes out.
    const order = fetch.mock.calls.map((call) => `${(call[1]?.method ?? "GET").toUpperCase()} ${new URL(String(call[0])).pathname}`);
    expect(order.indexOf("PATCH /broadcasts/broadcast_1")).toBeLessThan(order.indexOf("POST /broadcasts/broadcast_1/render"));
    expect(calls(fetch, "POST /broadcasts/broadcast_1/render")[0]!.body).toMatchObject({ variables: { FIRST_NAME: "Ada" } });
    expect(calls(fetch, "POST /emails")[0]!.body).toMatchObject({ to: ["me@acme.test"], subject: "[TEST] Hi Ada", html: "<p>Rendered by the server</p>" });
  });

  it("saves the draft before counting the audience", async () => {
    const { fetch } = setup();
    await screen.findByRole("option", { name: "Customers" });
    fireEvent.change(await screen.findByLabelText("Topic"), { target: { value: "topic_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(await dialog.findByText("Sending to 112 contacts in Customers.")).toBeTruthy();
    expect(dialog.getByText("Skipped: 5 unsubscribed, 3 suppressed, 0 opted out of the topic.")).toBeTruthy();
    const order = fetch.mock.calls.map((call) => `${(call[1]?.method ?? "GET").toUpperCase()} ${new URL(String(call[0])).pathname}`);
    expect(order.indexOf("PATCH /broadcasts/broadcast_1")).toBeGreaterThan(-1);
    expect(order.indexOf("PATCH /broadcasts/broadcast_1")).toBeLessThan(order.indexOf("GET /broadcasts/broadcast_1/audience"));
    expect(calls(fetch, "PATCH /broadcasts/broadcast_1")[0]!.body).toEqual({ topic_id: "topic_1" });
  });

  it("schedules with the resolved time", async () => {
    const { fetch } = setup();
    await screen.findByLabelText("HTML");
    await screen.findByRole("option", { name: "Customers" });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("When"), { target: { value: "later" } });
    fireEvent.change(dialog.getByLabelText("Confirmation phrase"), { target: { value: "SEND" } });
    // A phrase is read in the browser, shown with its zone, and only then can it be scheduled.
    const before = Date.now();
    fireEvent.change(dialog.getByLabelText("Send at"), { target: { value: "in 2 hours" } });
    expect((dialog.getByRole("button", { name: /Schedule/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(await dialog.findByText(/^Sends .+ \(.+\)\.$/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: /Schedule/ }));
    await waitFor(() => expect(calls(fetch, "POST /broadcasts/broadcast_1/send")).toHaveLength(1));
    const sent = (calls(fetch, "POST /broadcasts/broadcast_1/send")[0]!.body as { scheduled_at: string }).scheduled_at;
    // The API gets the exact instant, never the phrase.
    expect(sent).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Math.abs(Date.parse(sent) - before - 2 * 60 * 60 * 1000)).toBeLessThan(60_000);
  });

  it("is read only once the broadcast has left draft", async () => {
    setup(broadcast({ status: "sent" }));
    expect(await screen.findByText(/Only drafts can be edited/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toHaveProperty("disabled", true);
    // The form is filled one render after the notice shows, so wait for the field.
    expect(((await screen.findByLabelText("HTML")) as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe("BroadcastEditor helpers", () => {
  it("turns cleared optional fields into null and refuses empty required ones", () => {
    expect(patchBody({ reply_to: "", topic_id: "", preview_text: "Soon" })).toEqual({ reply_to: null, topic_id: null, preview_text: "Soon" });
    expect(patchBody({ reply_to: "a@x.test, b@x.test" })).toEqual({ reply_to: ["a@x.test", "b@x.test"] });
    expect(() => patchBody({ name: " " })).toThrow("Name cannot be empty");
    expect(() => patchBody({ segment_id: "" })).toThrow("Segment cannot be empty");
  });

  it("blocks review on missing content and segment", () => {
    const form = { ...toForm(broadcast()), html: "", subject: "" };
    const checks = reviewChecks(form, null, null, "loading", null, 0);
    expect(checks.filter((item) => item.tone === "fail").map((item) => item.text)).toEqual([
      "Choose a segment to send to.",
      "Add a subject.",
      "Add HTML or plain text content.",
    ]);
  });

  it("passes when the content is complete", () => {
    const form = { ...toForm(broadcast()), html: '<a href="{{{DISPATCH_UNSUBSCRIBE_URL}}}">u</a>', topic_id: "topic_1" };
    const checks = reviewChecks(form, segment as Segment, topic as never, audience as never, [], 0);
    expect(checks.every((item) => item.tone === "ok")).toBe(true);
    expect(checks[0]).toMatchObject({ text: "Sending to 112 contacts in Customers.", detail: "Skipped: 5 unsubscribed, 3 suppressed, 0 opted out of the topic." });
  });

  it("warns when nobody would receive it or the count failed", () => {
    const form = toForm(broadcast());
    expect(reviewChecks(form, segment as Segment, null, { ...audience, recipients: 0 } as never, [], 0)[0]!.tone).toBe("warn");
    expect(reviewChecks(form, segment as Segment, null, "failed", [], 0)[0]).toEqual({ tone: "warn", text: "Could not count the contacts in Customers." });
  });

  it("warns about a contact field that no property defines, once the properties load", () => {
    const form = { ...toForm(broadcast()), subject: "Hi {{{contact.frist_name}}}", html: "<p>{{{contact.plan}}} {{{contact.email}}} {{{contact.first_name|there}}}</p>" };
    expect(reviewChecks(form, segment as Segment, null, audience as never, [], 0, null).some((item) => item.text.includes("not a contact field"))).toBe(false);
    const warnings = reviewChecks(form, segment as Segment, null, audience as never, [], 0, ["plan"]).filter((item) => item.text.includes("contact field"));
    expect(warnings).toEqual([
      { tone: "warn", text: "contact.frist_name is not a contact field, so every recipient will see a blank there.", detail: "Check the spelling, or add the property under Audience, Properties." },
    ]);
  });

  it("warns, without blocking, when recipients with no name would see a blank", () => {
    const named = { ...audience, no_first_name: 12, no_last_name: 1 };
    const form = { ...toForm(broadcast()), subject: "Hi {{{contact.first_name}}}", html: "<p>{{{contact.last_name}}}</p>" };
    const warnings = reviewChecks(form, segment as Segment, null, named as never, [], 0).filter((item) => item.text.includes("will see a blank"));
    expect(warnings).toEqual([
      { tone: "warn", text: "12 of 112 recipients have no first name. They will see a blank where it goes.", detail: "Add a fallback, such as {{{contact.first_name|there}}}." },
      { tone: "warn", text: "1 of 112 recipients has no last name. They will see a blank where it goes.", detail: "Add a fallback, or wrap it in {{{#if contact.last_name}}}…{{{/if}}}." },
    ]);
    // A placeholder guarded by an #if on the same field never prints a blank.
    const guarded = { ...form, subject: "Hi{{{#if contact.first_name}}} {{{FIRST_NAME}}}{{{/if}}}", html: "<p>Hi{{{#if contact.last_name}}} {{{contact.last_name}}}{{{/if}}}</p>" };
    expect(reviewChecks(guarded, segment as Segment, null, named as never, [], 0).some((item) => item.text.includes("will see a blank"))).toBe(false);
    // A fallback, or nobody without a name, means no warning.
    const fallback = { ...form, subject: "Hi {{{contact.first_name|there}}}", html: "<p>Hi</p>" };
    expect(reviewChecks(fallback, segment as Segment, null, named as never, [], 0).some((item) => item.text.includes("will see a blank"))).toBe(false);
    expect(reviewChecks(form, segment as Segment, null, audience as never, [], 0).some((item) => item.text.includes("will see a blank"))).toBe(false);
  });

  it("warns when the link check itself failed, and does not call the links fine", () => {
    const form = toForm(broadcast());
    const checks = reviewChecks(form, segment as Segment, null, audience as never, "failed", 3);
    expect(checks.some((item) => item.text.includes("links work"))).toBe(false);
    expect(checks.find((item) => item.text === "Could not check the 3 links.")?.tone).toBe("warn");
  });
});
