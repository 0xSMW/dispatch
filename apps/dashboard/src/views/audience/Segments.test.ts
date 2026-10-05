// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, signIn, wrapper } from "../../testing";
import { Segments } from "./Segments";
import { bodyOf, calls, list, show, Status, stubApi } from "./stub";

const vip = { object: "segment", id: "seg_vip", name: "VIP", type: "static", rule: null, contacts: 1200, created_at: "2026-09-01T00:00:00.000Z", updated_at: "" };
const rule = { type: "rule", field: "contact.email", operator: "contains", value: "@example.com" };
const dynamic = { ...vip, id: "seg_live", name: "Live", type: "dynamic", rule, contacts: null };
const choices = {
  "GET /contact-properties": list([]), "GET /topics": list([]),
  "GET /automations": list([]), "GET /broadcasts": list([]),
  "POST /segments/preview": { count: 5, sample: [] },
};

function api() {
  return stubApi({
    "GET /segments": list([vip]),
    "GET /segments/seg_vip": vip,
    "POST /segments": vip,
    "PATCH /segments/seg_vip": { ...vip, name: "Top" },
    "DELETE /segments/seg_vip": { object: "segment", id: "seg_vip", deleted: true },
    "GET /segments/seg_vip/contacts": list([
      { object: "contact", id: "member_1", contact_id: "contact_ada", email: "ada@example.com", first_name: "Ada", last_name: null, created_at: "" },
    ]),
    "POST /segments/seg_vip/contacts": { object: "contact", id: "member_2" },
    "DELETE /segments/seg_vip/contacts/contact_ada": { object: "contact", id: "contact_ada", deleted: true },
  });
}

function rowAction(action: string) {
  const row = screen.getByText("VIP").closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: action }));
}

describe("Segments", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists segments with their contact counts", async () => {
    const fetch = api();
    show(h(Segments), "/audience/segments");
    await screen.findByText("VIP");
    expect(screen.getByText("Static lists and live filters")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeTruthy();
    expect(calls(fetch)).toContain("GET /segments?limit=40");
    expect(screen.getByText("1,200")).toBeTruthy();
  });

  it("renames and deletes a segment", async () => {
    const fetch = api();
    show(h(Segments), "/audience/segments");
    await screen.findByText("VIP");
    rowAction("Rename");
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Top" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "PATCH /segments/seg_vip")).toEqual({ name: "Top" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    rowAction("Delete");
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Confirmation phrase"), { target: { value: "VIP" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /segments/seg_vip"));
  });

  it("opens the member list, adds by email, and removes a member", async () => {
    const fetch = api();
    show(h(Segments), "/audience/segments");
    fireEvent.click(await screen.findByText("VIP"));
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByText("ada@example.com");
    expect(calls(fetch)).toContain("GET /segments/seg_vip/contacts?limit=20");
    fireEvent.change(within(drawer).getByLabelText("Email"), { target: { value: "bob@example.com" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add contact" }));
    await waitFor(() => expect(bodyOf(fetch, "POST /segments/seg_vip/contacts")).toEqual({ email: "bob@example.com" }));
    fireEvent.click(within(drawer).getByLabelText("Remove ada@example.com"));
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /segments/seg_vip/contacts/contact_ada"));
  });

  it("creates static lists without writing type and live filters with their exact rule", async () => {
    const fetch = stubApi({ ...choices, "GET /segments": list([]), "POST /segments": vip });
    show(h(Segments), "/audience/segments");
    fireEvent.click(screen.getByRole("button", { name: "Create segment" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "List" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "POST /segments")).toEqual({ name: "List" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create segment" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Filtered" } });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "dynamic" } });
    await waitFor(() => expect((within(dialog).getByLabelText("Choose field") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(within(dialog).getByLabelText("Choose field"), { target: { value: "contact.email" } });
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "@example.com" } });
    await screen.findByText("5 matching contacts");
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "POST /segments")).toEqual({ name: "Filtered", rule: { ...rule, operator: "eq" } }));
  });

  it("gets numeric detail counts and never exposes manual membership on a dynamic row", async () => {
    const fetch = stubApi({ ...choices, "GET /segments": list([dynamic]), "GET /segments/seg_live": { ...dynamic, contacts: 7 }, "GET /segments/seg_live/contacts": list([]) });
    show(h(Segments), "/audience/segments");
    fireEvent.click(await screen.findByRole("button", { name: "View count" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Filter · 7 contacts");
    expect(within(dialog).queryByRole("button", { name: "Add contact" })).toBeNull();
    expect(within(dialog).queryByLabelText("Email")).toBeNull();
    expect(calls(fetch)).toContain("GET /segments/seg_live");
  });

  it("edits a dynamic filter without fetching over a user's changed draft", async () => {
    const fetch = stubApi({ ...choices, "GET /segments": list([dynamic]), "GET /segments/seg_live": { ...dynamic, contacts: 5 }, "PATCH /segments/seg_live": dynamic });
    show(h(Segments), "/audience/segments");
    fireEvent.click(within((await screen.findByText("Live")).closest("tr")!).getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit segment" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Edited" } });
    await screen.findByText("5 matching contacts");
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "new" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "PATCH /segments/seg_live")).toEqual({ name: "Edited", description: "", rule: { ...rule, value: "new" } }));
  });

  it("requires counted explicit conversion, removes existing members first, then patches the rule", async () => {
    let removed = false;
    const fetch = stubApi({
      ...choices, "GET /segments": list([{ ...vip, contacts: 1 }]),
      "GET /segments/seg_vip": () => ({ ...vip, contacts: removed ? 0 : 1 }),
      "GET /segments/seg_vip/contacts": list([{ id: "member_1", contact_id: "c_1" }]),
      "DELETE /segments/seg_vip/contacts/c_1": () => { removed = true; return { deleted: true }; },
      "PATCH /segments/seg_vip": dynamic,
    });
    show(h(Segments), "/audience/segments");
    await screen.findByText("VIP");
    rowAction("Edit");
    const dialog = await screen.findByRole("dialog", { name: "Edit segment" });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "dynamic" } });
    await waitFor(() => expect((within(dialog).getByLabelText("Choose field") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(within(dialog).getByLabelText("Choose field"), { target: { value: "contact.email" } });
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "@example.com" } });
    await screen.findByText("5 matching contacts");
    fireEvent.submit(dialog.querySelector("form")!);
    const confirm = await screen.findByRole("dialog", { name: "Convert segment" });
    expect(within(confirm).getByText(/Remove all 1 existing list members/)).toBeTruthy();
    expect(calls(fetch)).not.toContain("DELETE /segments/seg_vip/contacts/c_1");
    expect(calls(fetch)).not.toContain("PATCH /segments/seg_vip");
    fireEvent.change(within(confirm).getByLabelText("Confirmation phrase"), { target: { value: "Remove 1 contacts" } });
    fireEvent.submit(confirm.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("PATCH /segments/seg_vip"));
    expect(calls(fetch).indexOf("DELETE /segments/seg_vip/contacts/c_1")).toBeLessThan(calls(fetch).indexOf("PATCH /segments/seg_vip"));
    expect(bodyOf(fetch, "PATCH /segments/seg_vip")).toEqual({ name: "VIP", description: "", rule: { ...rule, operator: "eq" } });
  });

  it("converts dynamic filters to empty static lists using explicit null and no member deletes", async () => {
    const fetch = stubApi({ ...choices, "GET /segments": list([dynamic]), "GET /segments/seg_live": { ...dynamic, contacts: 5 }, "PATCH /segments/seg_live": { ...dynamic, type: "static", rule: null, contacts: 0 } });
    show(h(Segments), "/audience/segments");
    fireEvent.click(within((await screen.findByText("Live")).closest("tr")!).getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit segment" });
    fireEvent.change(within(dialog).getAllByLabelText("Type")[0]!, { target: { value: "static" } });
    fireEvent.submit(dialog.querySelector("form")!);
    const confirm = await screen.findByRole("dialog", { name: "Convert segment" });
    expect(within(confirm).getByText(/5 matching contacts to an empty static list/)).toBeTruthy();
    fireEvent.change(within(confirm).getByLabelText("Confirmation phrase"), { target: { value: "Convert Live" } });
    fireEvent.submit(confirm.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "PATCH /segments/seg_live")).toEqual({ name: "Live", description: "", rule: null }));
    expect(calls(fetch).some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("lets viewers read filters and preview but not create, edit, convert or mutate members", async () => {
    const fetch = stubApi({ ...choices, "GET /segments": list([dynamic]), "GET /segments/seg_live": { ...dynamic, contacts: 5 } });
    signIn("viewer", ["read"]);
    render(h(Segments), { wrapper });
    const row = (await screen.findByText("Live")).closest("tr")!;
    expect(screen.queryByRole("button", { name: "Create segment" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "View filter" }));
    const dialog = await screen.findByRole("dialog", { name: "View segment" });
    await screen.findByText("5 matching contacts");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(calls(fetch).filter((call) => /^(POST|PATCH|DELETE)/.test(call))).toEqual(["POST /segments/preview"]);
  });

  it("keeps ordinary static edits static by omitting rule", async () => {
    const fetch = stubApi({ "GET /segments": list([vip]), "GET /segments/seg_vip": vip, "PATCH /segments/seg_vip": vip });
    show(h(Segments), "/audience/segments");
    await screen.findByText("VIP");
    rowAction("Edit");
    const dialog = await screen.findByRole("dialog", { name: "Edit segment" });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Saved description" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "PATCH /segments/seg_vip")).toEqual({ name: "VIP", description: "Saved description" }));
  });

  it("does not patch a conversion when explicit member removal fails", async () => {
    const fetch = stubApi({
      ...choices, "GET /segments": list([{ ...vip, contacts: 1 }]), "GET /segments/seg_vip": { ...vip, contacts: 1 },
      "GET /segments/seg_vip/contacts": list([{ id: "member_1", contact_id: "c_1" }]),
      "DELETE /segments/seg_vip/contacts/c_1": new Status(409, { name: "conflict", message: "Membership conflict" }),
    });
    show(h(Segments), "/audience/segments");
    await screen.findByText("VIP");
    rowAction("Edit");
    const dialog = await screen.findByRole("dialog", { name: "Edit segment" });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "dynamic" } });
    await waitFor(() => expect((within(dialog).getByLabelText("Choose field") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(within(dialog).getByLabelText("Choose field"), { target: { value: "contact.email" } });
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "@example.com" } });
    await screen.findByText("5 matching contacts");
    fireEvent.submit(dialog.querySelector("form")!);
    const confirm = await screen.findByRole("dialog", { name: "Convert segment" });
    fireEvent.change(within(confirm).getByLabelText("Confirmation phrase"), { target: { value: "Remove 1 contacts" } });
    fireEvent.submit(confirm.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /segments/seg_vip/contacts/c_1"));
    await waitFor(() => expect((within(confirm).getByRole("button", { name: /Confirm conversion/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(calls(fetch)).not.toContain("PATCH /segments/seg_vip");
    expect(screen.getByRole("dialog", { name: "Edit segment" })).toBeTruthy();
  });
});
