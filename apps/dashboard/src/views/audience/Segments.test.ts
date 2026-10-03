// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { Segments } from "./Segments";
import { bodyOf, calls, list, show, stubApi } from "./stub";

const vip = { object: "segment", id: "seg_vip", name: "VIP", contacts: 1200, created_at: "2026-09-01T00:00:00.000Z", updated_at: "" };

function api() {
  return stubApi({
    "GET /segments": list([vip]),
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
    expect(screen.getByText("Static lists")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Type" })).toBeNull();
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
});
