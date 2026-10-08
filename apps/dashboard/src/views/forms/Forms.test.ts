// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, signIn, wrapper } from "../../testing";
import { sessionKey } from "../../shell/session";
import type { Domain, Form } from "../../types";
import { bodyOf, calls, list, show, Status, stubApi } from "../audience/stub";
import { formBody, formDraft, formSenders, Forms } from "./Forms";

const form: Form = {
  object: "form", id: "form_1", name: "Newsletter", key: "newsletter",
  topic_ids: ["topic_news"], properties: ["company"], double_opt_in: true,
  from_email: "news@example.com", allowed_origins: ["https://www.example.com"], redirect_url: null,
  created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
};
const domain = { id: "domain_1", name: "example.com", status: "verified", capabilities: { sending: "enabled", receiving: "disabled" } } as Domain;
const choices = {
  "GET /topics": list([{ id: "topic_news", name: "News" }]),
  "GET /contact-properties": list([{ id: "property_1", key: "company", type: "string" }]),
  "GET /domains": list([
    domain,
    { ...domain, id: "domain_2", name: "pending.example", status: "pending" },
    { ...domain, id: "domain_3", name: "receiving.example", capabilities: { sending: "disabled", receiving: "enabled" } },
  ]),
};

function rowAction(action: string) {
  const row = screen.getByText("Newsletter").closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: action }));
}

async function openCreate() {
  fireEvent.click(screen.getByRole("button", { name: "Create form" }));
  const dialog = await screen.findByRole("dialog", { name: "Create form" });
  await waitFor(() => expect((within(dialog).getByLabelText("Name") as HTMLInputElement).disabled).toBe(false));
  return dialog;
}

function fillCreate(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: " Signup " } });
  fireEvent.click(within(dialog).getByLabelText("News"));
  fireEvent.click(within(dialog).getByLabelText("company"));
  fireEvent.change(within(dialog).getByLabelText("Sender").closest(".dropdown")!.querySelector("select")!, { target: { value: "no-reply@example.com" } });
  fireEvent.change(within(dialog).getByLabelText("Origin 1"), { target: { value: "https://www.example.com" } });
}

describe("Forms", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("explains missing setup and preserves the draft when prerequisites are refreshed", async () => {
    let ready = false;
    stubApi({ ...choices, "GET /forms": list([]), "GET /topics": () => list(ready ? [{ id: "topic_news", name: "News" }] : []), "GET /domains": () => list(ready ? [domain] : []) });
    show(h(Forms), "/audience/forms");
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Keep this draft" } });
    expect(within(dialog).getByRole("link", { name: "Create topic" }).getAttribute("target")).toBe("_blank");
    expect(within(dialog).getByRole("link", { name: "Verify sending domain" })).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: /^Create/ }) as HTMLButtonElement).disabled).toBe(true);
    ready = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh setup" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Refresh setup" })).toBeNull());
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Keep this draft");
  });

  it("creates with confirmation enabled and null redirect, then copies the returned public HTML", async () => {
    const fetch = stubApi({
      ...choices, "GET /forms": list([]),
      "POST /forms": { ...form, name: "Created signup", key: "created/key", properties: ["company"] },
    });
    const copy = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: copy } });
    show(h(Forms), "/audience/forms");
    const dialog = await openCreate();
    expect(within(dialog).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(Array.from(dialog.querySelectorAll("option")).map((option) => option.textContent)).toEqual([
      "Select a verified sender", "no-reply@example.com",
    ]);
    fillCreate(dialog);
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "POST /forms")).toEqual({
      name: "Signup", topic_ids: ["topic_news"], properties: ["company"], double_opt_in: true,
      from_email: "no-reply@example.com", allowed_origins: ["https://www.example.com"], redirect_url: null,
    }));
    const snippets = await screen.findByRole("dialog", { name: "Created signup" });
    expect(within(snippets).getByText(/http:\/\/localhost:3100\/forms\/created%2Fkey/)).toBeTruthy();
    fireEvent.click(within(snippets).getByRole("button", { name: "Copy HTML snippet" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining('name="website"')));
    expect(calls(fetch).filter((call) => call.startsWith("GET /forms"))).toHaveLength(2);
    expect(calls(fetch)).not.toContain("GET /senders");
  });

  it("gets fresh details before edit, retains a verified current sender, and clears redirect on PATCH", async () => {
    const fetch = stubApi({
      ...choices, "GET /forms": list([form]),
      "GET /forms/form_1": { ...form, name: "Fresh", double_opt_in: false, redirect_url: "https://www.example.com/thanks" },
      "PATCH /forms/form_1": { ...form, name: "Edited", double_opt_in: false },
    });
    show(h(Forms), "/audience/forms");
    await screen.findByText("Newsletter");
    rowAction("Edit");
    await screen.findByDisplayValue("Fresh");
    const dialog = await screen.findByRole("dialog", { name: "Edit form" });
    await waitFor(() => expect((within(dialog).getByLabelText("Name") as HTMLInputElement).disabled).toBe(false));
    expect(within(dialog).getByLabelText("Sender").textContent).toContain("news@example.com (current sender)");
    expect(within(dialog).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Edited" } });
    fireEvent.change(within(dialog).getByLabelText("Redirect URL"), { target: { value: "" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "PATCH /forms/form_1")).toEqual({
      name: "Edited", topic_ids: ["topic_news"], properties: ["company"], double_opt_in: false,
      from_email: "news@example.com", allowed_origins: ["https://www.example.com"], redirect_url: null,
    }));
    await screen.findByRole("dialog", { name: "Edited" });
    expect(calls(fetch)).toContain("GET /forms/form_1");
  });

  it("validates required topics, exact origins, and HTTPS redirect without making a write", async () => {
    const fetch = stubApi({ ...choices, "GET /forms": list([]) });
    show(h(Forms), "/audience/forms");
    const dialog = await openCreate();
    fillCreate(dialog);
    fireEvent.click(within(dialog).getByLabelText("News"));
    fireEvent.change(within(dialog).getByLabelText("Origin 1"), { target: { value: "https://www.example.com/path" } });
    fireEvent.change(within(dialog).getByLabelText("Redirect URL"), { target: { value: "http://www.example.com/thanks" } });
    fireEvent.submit(dialog.querySelector("form")!);
    expect(within(dialog).getByText("Choose 1–100 topics.")).toBeTruthy();
    expect(within(dialog).getByText("Use 1–50 exact HTTP or HTTPS origins, without paths.")).toBeTruthy();
    expect(within(dialog).getByText("Use an HTTPS URL without credentials.")).toBeTruthy();
    expect(calls(fetch).some((call) => call.startsWith("POST "))).toBe(false);
  });

  it("keeps the controlled draft and shows server issues after a failed create", async () => {
    const fetch = stubApi({
      ...choices, "GET /forms": list([]),
      "POST /forms": new Status(400, { name: "invalid_parameter", message: "Please fix the form.", issues: [{ path: "from_email", message: "Sender is no longer verified." }] }),
    });
    show(h(Forms), "/audience/forms");
    const dialog = await openCreate();
    fillCreate(dialog);
    fireEvent.submit(dialog.querySelector("form")!);
    await within(dialog).findByText("Please fix the form.");
    expect(within(dialog).getByText("Sender is no longer verified.")).toBeTruthy();
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe(" Signup ");
    expect(calls(fetch).filter((call) => call === "POST /forms")).toHaveLength(1);
  });

  it("blocks saves if resource loading fails and exposes retry", async () => {
    const fetch = stubApi({ ...choices, "GET /forms": list([]), "GET /domains": new Status(503, { message: "Unavailable" }) });
    show(h(Forms), "/audience/forms");
    fireEvent.click(screen.getByRole("button", { name: "Create form" }));
    const dialog = await screen.findByRole("dialog", { name: "Create form" });
    await within(dialog).findByText("Could not load domains: Unavailable");
    expect((within(dialog).getByRole("button", { name: /^Create/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry domains" }));
    await waitFor(() => expect(calls(fetch).filter((call) => call.startsWith("GET /domains"))).toHaveLength(2));
    expect(calls(fetch).some((call) => call.startsWith("POST "))).toBe(false);
  });

  it("requires the exact form name before deleting and reloads the list", async () => {
    const fetch = stubApi({ "GET /forms": list([form]), "DELETE /forms/form_1": { object: "form", id: form.id, deleted: true } });
    show(h(Forms), "/audience/forms");
    await screen.findByText("Newsletter");
    rowAction("Delete");
    const dialog = await screen.findByRole("dialog", { name: "Delete form" });
    fireEvent.submit(dialog.querySelector("form")!);
    expect(calls(fetch)).not.toContain("DELETE /forms/form_1");
    fireEvent.change(within(dialog).getByLabelText("Confirmation phrase"), { target: { value: "Newsletter" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /forms/form_1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(fetch).filter((call) => call.startsWith("GET /forms"))).toHaveLength(2);
  });

  it("gives viewers read-only snippets from the session API deployment, not dashboard origin", async () => {
    const fetch = stubApi({ "GET /deployment/forms": list([form]) });
    signIn("sess_private", ["read"]);
    const session = JSON.parse(sessionStorage.getItem(sessionKey)!);
    session.apiUrl = "http://localhost:3100/deployment";
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
    render(h(Forms), { wrapper });
    await screen.findByText("Newsletter");
    expect(screen.queryByRole("button", { name: "Create form" })).toBeNull();
    fireEvent.click(within(screen.getByText("Newsletter").closest("tr")!).getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "View snippets" }));
    const dialog = await screen.findByRole("dialog", { name: "Newsletter" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Fetch" }));
    const snippet = dialog.querySelector("code")!.textContent!;
    expect(snippet).toContain("http://localhost:3100/deployment/forms/newsletter");
    expect(snippet).not.toContain("sess_private");
    expect(calls(fetch)).toEqual(["GET /deployment/forms?limit=40"]);
  });

  it("returns defensive drafts, uses null for empty redirect, and only offers verified sending domains", () => {
    const draft = formDraft(form);
    expect(formDraft().double_opt_in).toBe(true);
    expect(draft.topic_ids).not.toBe(form.topic_ids);
    expect(draft.properties).not.toBe(form.properties);
    expect(draft.allowed_origins).not.toBe(form.allowed_origins);
    expect(formBody({ ...draft, redirect_url: "  " }).redirect_url).toBeNull();
    expect(formSenders([domain], "news@EXAMPLE.COM")).toEqual([
      { value: "no-reply@example.com", label: "no-reply@example.com" },
      { value: "news@EXAMPLE.COM", label: "news@EXAMPLE.COM (current sender)" },
    ]);
    expect(formSenders([domain], "news@unverified.example")).toHaveLength(1);
    expect(formSenders([{ ...domain, capabilities: { sending: "disabled", receiving: "enabled" } }], form.from_email)).toEqual([]);
  });
});
