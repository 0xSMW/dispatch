// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn, type Reply } from "../../testing";
import type { Integration } from "../../types";
import { bodyOf, calls, list, show, Status, stubApi } from "../audience/stub";
import { Integrations } from "./Integrations";

const row: Integration = {
  object: "integration", id: "int_1", name: "Billing", provider: "stripe", slug: "stripe",
  settings: { map_plan: false }, has_restricted_key: true, last_received_at: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};
const created = { ...row, token: "once_token", url: "https://dispatch.test/inbound/once_token" };
const routes = () => ({
  "GET /integrations": list([row]),
  "GET /integrations/int_1": row,
  "GET /integrations/int_1/deliveries": list([]),
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Integrations", () => {
  it("lists integrations with eight setup tiles and links to existing sending routes and pinned recipes", async () => {
    const fetch = stubApi(routes());
    show(h(Integrations), "/settings/integrations");
    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(calls(fetch)).toEqual(["GET /integrations?limit=40"]);
    expect(screen.getByRole("link", { name: "Outgoing webhooks" }).getAttribute("href")).toBe("/webhooks");
    expect(screen.getAllByRole("link", { name: "SMTP" }).every((link) => link.getAttribute("href") === "/settings/smtp")).toBe(true);
    expect(screen.getByRole("link", { name: "Auth.js recipe" }).getAttribute("href")).toMatch(/templates\/authjs.md$/);
    expect(screen.getByRole("link", { name: "Better Auth recipe" }).getAttribute("href")).toMatch(/templates\/better-auth.md$/);
    for (const [provider, label] of [["stripe", "Stripe"], ["clerk", "Clerk"], ["supabase", "Supabase"], ["webhook", "Standard Webhooks"]]) {
      expect(screen.getByRole("heading", { name: label })).toBeTruthy();
      expect(screen.getByRole("button", { name: `Connect ${label}` })).toBeTruthy();
      expect(screen.getByRole("link", { name: `${label} setup guide` }).getAttribute("href")).toMatch(new RegExp(`templates/${provider}.md#receiver-setup$`));
    }
    for (const label of ["Outgoing webhooks", "SMTP", "Auth.js", "Better Auth"]) {
      expect(screen.getByRole("heading", { name: label })).toBeTruthy();
    }
  });

  it.each([
    ["stripe", "Stripe", { map_plan: false }],
    ["clerk", "Clerk", { delete_contact: false }],
    ["supabase", "Supabase", { secret_header: "x-webhook-secret" }],
    ["webhook", "Standard Webhooks", {}],
  ])("opens %s setup tiles with provider-specific fields and a working create payload", async (provider, label, settings) => {
    const fetch = stubApi({ "GET /integrations": list([]), "POST /integrations": { ...created, provider } });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(screen.getByRole("button", { name: `Connect ${label}` }));
    expect(screen.getByLabelText("Provider")).toHaveProperty("value", provider);
    expect(screen.getByRole("link", { name: "Open provider setup guide" }).getAttribute("href")).toMatch(new RegExp(`templates/${provider}.md#receiver-setup$`));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New integration" } });
    fireEvent.change(screen.getByLabelText(provider === "supabase" ? "Shared secret" : "Signing secret"), { target: { value: "synthetic-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /Create integration/ }));
    expect(await screen.findByText(created.url)).toBeTruthy();
    expect(bodyOf(fetch, "POST /integrations")).toEqual({
      name: "New integration", provider, secret: "synthetic-secret", settings,
      ...(provider === "webhook" ? { slug: "webhook" } : {}),
    });
  });

  it("allows viewer GET inspection and last20 history without write controls or leaked extra fields", async () => {
    const fetch = stubApi({
      ...routes(), "GET /integrations/int_1": { ...row, secret: "hidden_secret", url: "hidden_url", token: "hidden_token" },
      "GET /integrations/int_1/deliveries": (url: URL) => {
        expect(url.searchParams.get("limit")).toBe("20");
        return list([{
          id: "del_1", status: "failed", event_name: "stripe.invoice.payment_failed", contact_id: "con_1", created_at: row.created_at,
          error: "raw_secret_exception", body: { secret: "body_secret" }, token: "delivery_token",
        }]);
      },
    });
    signIn("sess_viewer", ["read"]);
    render(h(MemoryRouter, { initialEntries: ["/settings/integrations"] }, h(SessionProvider, null, h(Integrations))));
    fireEvent.click(await screen.findByRole("button", { name: "View Billing" }));
    expect(await screen.findByText("Delivery failed")).toBeTruthy();
    expect(screen.getByText("Last 20 deliveries")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View contact" }).getAttribute("href")).toBe("/audience/contacts/con_1");
    expect(screen.queryByRole("button", { name: "Add integration" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull();
    for (const label of ["Stripe", "Clerk", "Supabase", "Standard Webhooks"]) {
      expect(screen.getByRole("link", { name: `${label} setup guide` })).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: "Open provider setup guide" }).getAttribute("href")).toMatch(/templates\/stripe.md#receiver-setup$/);
    for (const action of ["Edit Billing", "Rotate Billing", "Delete Billing"]) expect(screen.queryByRole("button", { name: action })).toBeNull();
    for (const secret of ["hidden_secret", "hidden_url", "hidden_token", "raw_secret_exception", "body_secret", "delivery_token"]) {
      expect(document.body.textContent).not.toContain(secret);
    }
    expect(calls(fetch).every((call) => call.startsWith("GET "))).toBe(true);
  });

  it("shows delivery contact links without inventing a contact for unmatched attempts", async () => {
    const fetch = stubApi({
      ...routes(), "GET /integrations/int_1/deliveries": list([
        { id: "del_1", status: "processed", event_name: "stripe.invoice.paid", contact_id: "con_1", error: null, created_at: row.created_at },
        { id: "del_2", status: "ignored", event_name: null, contact_id: null, error: "no_contact", created_at: row.created_at },
      ]),
    });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(await screen.findByRole("button", { name: "View Billing" }));
    const contact = await screen.findByRole("link", { name: "View contact" });
    expect(contact.getAttribute("href")).toBe("/audience/contacts/con_1");
    expect(screen.getAllByRole("link", { name: "View contact" })).toHaveLength(1);
    expect(screen.getByText("No matching contact")).toBeTruthy();
    fireEvent.click(contact);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(fetch).every((call) => call.startsWith("GET "))).toBe(true);
  });

  it("creates and shows URL and token once, then clears them on dismissal", async () => {
    const fetch = stubApi({ "GET /integrations": list([]), "POST /integrations": created });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(screen.getByRole("button", { name: "Add integration" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Billing" } });
    fireEvent.change(screen.getByLabelText("Signing secret"), { target: { value: "whsec_test" } });
    fireEvent.click(screen.getByRole("button", { name: /Create integration/ }));
    expect(await screen.findByText(created.url)).toBeTruthy();
    expect(bodyOf(fetch, "POST /integrations")).toEqual({ name: "Billing", provider: "stripe", secret: "whsec_test", settings: { map_plan: false } });
    expect(sessionStorage.getItem("dispatch.session")).not.toContain("once_token");
    expect(localStorage.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(created.url)).toBeNull();
    expect(screen.queryByText(created.token)).toBeNull();
  });

  it("clears the one-time display when navigation changes even if the page remains mounted", async () => {
    stubApi({ ...routes(), "POST /integrations/int_1/rotate": created });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(await screen.findByRole("button", { name: "Rotate Billing" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "ROTATE" } });
    fireEvent.click(screen.getByRole("button", { name: /Rotate URL/ }));
    expect(await screen.findByText(created.url)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("link", { name: "SMTP" })[0]!);
    await waitFor(() => expect(screen.queryByText(created.url)).toBeNull());
    expect(screen.queryByText(created.token)).toBeNull();
  });

  it("edits settings without sending unchanged secret and removes the restricted key explicitly", async () => {
    const fetch = stubApi({ ...routes(), "PATCH /integrations/int_1": row });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Billing" }));
    expect((screen.getByLabelText("Signing secret") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Restricted Stripe key") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("switch", { name: /Store plan on contacts/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Remove restricted key" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(calls(fetch)).toContain("PATCH /integrations/int_1"));
    expect(bodyOf(fetch, "PATCH /integrations/int_1")).toEqual({ name: "Billing", settings: { map_plan: true, stripe_restricted_key: null } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not reveal a late create response after dismissing the form", async () => {
    let complete!: (response: Reply) => void;
    const pending = new Promise<Reply>((resolve) => { complete = resolve; });
    const fetch = mockFetch((_url, init) => init.method === "POST" ? pending : { body: list([]) });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(screen.getByRole("button", { name: "Add integration" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Billing" } });
    fireEvent.change(screen.getByLabelText("Signing secret"), { target: { value: "whsec_test" } });
    fireEvent.click(screen.getByRole("button", { name: /Create integration/ }));
    await waitFor(() => expect(calls(fetch)).toContain("POST /integrations"));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await act(async () => { complete({ body: created }); await pending; });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(created.token);
    expect(document.body.textContent).not.toContain(created.url);
  });

  it.each(["dismissal", "navigation"])("does not reveal a late rotate response after %s", async (action) => {
    let complete!: (response: Reply) => void;
    const pending = new Promise<Reply>((resolve) => { complete = resolve; });
    const fetch = mockFetch((_url, init) => init.method === "POST" ? pending : { body: list([row]) });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(await screen.findByRole("button", { name: "Rotate Billing" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "ROTATE" } });
    fireEvent.click(screen.getByRole("button", { name: /Rotate URL/ }));
    await waitFor(() => expect(calls(fetch)).toContain("POST /integrations/int_1/rotate"));
    if (action === "dismissal") fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    else fireEvent.click(screen.getAllByRole("link", { name: "SMTP" })[0]!);
    await act(async () => { complete({ body: created }); await pending; });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(created.token);
    expect(document.body.textContent).not.toContain(created.url);
  });

  it("requires confirmation to rotate and reveals only the new credentials", async () => {
    const fetch = stubApi({ ...routes(), "POST /integrations/int_1/rotate": created });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(await screen.findByRole("button", { name: "Rotate Billing" }));
    expect((screen.getByRole("button", { name: /Rotate URL/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/old receiver URL will stop working immediately/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "ROTATE" } });
    fireEvent.click(screen.getByRole("button", { name: /Rotate URL/ }));
    expect(await screen.findByText(created.url)).toBeTruthy();
    expect(calls(fetch)).toContain("POST /integrations/int_1/rotate");
    expect(calls(fetch).some((call) => call.includes("/token") || call.includes("/secret"))).toBe(false);
  });

  it("deletes with confirmation and reloads the list", async () => {
    let removed = false;
    const fetch = stubApi({
      ...routes(), "GET /integrations": () => list(removed ? [] : [row]),
      "DELETE /integrations/int_1": () => { removed = true; return { id: row.id, deleted: true }; },
    });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(await screen.findByRole("button", { name: "Delete Billing" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: /Delete integration/ }));
    expect(await screen.findByText("No integrations")).toBeTruthy();
    expect(calls(fetch)).toContain("DELETE /integrations/int_1");
    expect(calls(fetch).filter((call) => call === "GET /integrations?limit=40")).toHaveLength(2);
  });

  it("shows fixed save errors rather than echoing provider credentials", async () => {
    stubApi({ ...routes(), "PATCH /integrations/int_1": new Status(400, { message: "whsec_leaked rk_leaked" }) });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Billing" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Integration could not be saved. Check the configuration and try again.");
    expect(document.body.textContent).not.toContain("whsec_leaked");
  });

  it("caps the displayed delivery history at 20 and supports refresh", async () => {
    const fetch = stubApi({
      ...routes(), "GET /integrations/int_1/deliveries": list(Array.from({ length: 25 }, (_, index) => ({
        id: `del_${index}`, status: "processed", event_name: "stripe.invoice.paid", error: null, created_at: row.created_at,
      }))),
    });
    show(h(Integrations), "/settings/integrations");
    fireEvent.click(await screen.findByRole("button", { name: "View Billing" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByText("processed")).toHaveLength(20));
    fireEvent.click(screen.getByRole("button", { name: "Refresh deliveries" }));
    await waitFor(() => expect(calls(fetch).filter((call) => call === "GET /integrations/int_1/deliveries?limit=20")).toHaveLength(2));
  });
});
