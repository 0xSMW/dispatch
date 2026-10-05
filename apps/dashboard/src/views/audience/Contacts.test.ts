// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import type { Contact } from "../../types";
import { contactBody, Contacts } from "./Contacts";
import { bodyOf, calls, list, show, stubApi } from "./stub";

const ada: Contact = {
  object: "contact",
  id: "contact_ada",
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
  unsubscribed: false,
  properties: { plan: { value: "pro", type: "string" } },
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};
const bob: Contact = { ...ada, id: "contact_bob", email: "bob@example.com", first_name: null, last_name: null, unsubscribed: true, properties: {} };

function api(extra: Record<string, unknown> = {}) {
  return stubApi({
    "GET /contacts": list([ada, bob], true),
    "GET /contacts/stats": { object: "contact_stats", all: 1200, subscribed: 1100, unsubscribed: 100 },
    "GET /segments": list([{ object: "segment", id: "seg_vip", name: "VIP", created_at: "", updated_at: "" }]),
    "GET /topics": list([]),
    "GET /contact-properties": list([{ object: "contact_property", id: "prop_1", key: "seats", type: "number", fallback_value: null }]),
    "DELETE /contacts/contact_ada": { object: "contact", contact: "contact_ada", deleted: true },
    "DELETE /contacts/contact_bob": { object: "contact", contact: "contact_bob", deleted: true },
    "POST /contacts": ada,
    "POST /contacts/contact_ada/segments/seg_vip": { object: "segment", id: "seg_vip" },
    "POST /contacts/contact_bob/segments/seg_vip": { object: "segment", id: "seg_vip" },
    ...extra,
  });
}

describe("Contacts", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("loads the first page, the stats, and the segments, and renders rows", async () => {
    const fetch = api();
    show(h(Contacts), "/audience");
    await screen.findByText("ada@example.com");
    expect(screen.getByRole("link", { name: "Suppressions" }).getAttribute("href")).toBe("/emails/suppressions");
    expect(calls(fetch)).toEqual(
      expect.arrayContaining(["GET /contacts?limit=40", "GET /contacts/stats", "GET /segments?limit=100"]),
    );
    expect(screen.getByText("1,200")).toBeTruthy();
    expect(screen.getByText("1,100")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("unsubscribed")).toBeTruthy();
    expect(screen.getByRole("option", { name: "VIP" })).toBeTruthy();
    const learn = within(screen.getByRole("navigation", { name: "Learn more" }));
    expect(learn.getByRole("link", { name: "Properties" }).getAttribute("href")).toContain("audience.md#properties");
    expect(learn.getByRole("link", { name: "Segments" }).getAttribute("href")).toContain("audience.md#segments");
    expect(learn.getByRole("link", { name: "Topics" }).getAttribute("href")).toContain("audience.md#topics");
  });

  it("offers an add-contact action in the unfiltered empty state", async () => {
    api({ "GET /contacts": list([]) });
    show(h(Contacts), "/audience");
    fireEvent.click(await screen.findByRole("button", { name: "Add your first contact" }));
    expect(screen.getByRole("dialog", { name: "Add contact" })).toBeTruthy();
  });

  it("shows each contact's segments, three at most, with a count for the rest", async () => {
    const names = ["VIP", "Beta", "Trials", "Churned", "Staff"];
    api({
      "GET /contacts": list([
        { ...ada, segments: names.map((name, index) => ({ id: `seg_${index}`, name })) },
        { ...bob, segments: [] },
      ]),
    });
    show(h(Contacts), "/audience");
    const row = (await screen.findByText("ada@example.com")).closest("tr")!;
    expect(screen.getByRole("columnheader", { name: "Segments" })).toBeTruthy();
    expect(within(row).getByText("Beta")).toBeTruthy();
    expect(within(row).queryByText("Churned")).toBeNull();
    expect(within(row).getByText("+2")).toBeTruthy();
  });

  it("sends the segment filter from the URL", async () => {
    const fetch = api();
    show(h(Contacts), "/audience?segment_id=seg_vip");
    await screen.findByText("ada@example.com");
    expect(calls(fetch)).toContain("GET /contacts?segment_id=seg_vip&limit=40");
  });

  it("searches on the server and filters by subscription", async () => {
    const fetch = api();
    show(h(Contacts), "/audience?q=lovelace&subscribed=false");
    await screen.findByText("ada@example.com");
    expect(calls(fetch)).toContain("GET /contacts?q=lovelace&subscribed=false&limit=40");
    expect((screen.getByLabelText("Subscription") as HTMLSelectElement).value).toBe("false");
    expect(screen.getByRole("searchbox", { name: "Search by email or name" })).toBeTruthy();
  });

  it("writes the subscription filter to the request", async () => {
    const fetch = api();
    show(h(Contacts), "/audience");
    await screen.findByText("ada@example.com");
    fireEvent.change(screen.getByLabelText("Subscription"), { target: { value: "true" } });
    await waitFor(() => expect(calls(fetch)).toContain("GET /contacts?subscribed=true&limit=40"));
  });

  it("says when nothing matches the filters", async () => {
    api({ "GET /contacts": list([]) });
    show(h(Contacts), "/audience?q=nobody");
    expect(await screen.findByText("No contacts found")).toBeTruthy();
  });

  it("adds a contact with typed properties", async () => {
    const fetch = api();
    show(h(Contacts), "/audience");
    await screen.findByText("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("First name"), { target: { value: "New" } });
    fireEvent.change(await within(dialog).findByLabelText("seats"), { target: { value: "5" } });
    fireEvent.click(within(dialog).getByLabelText("VIP"));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("POST /contacts"));
    expect(bodyOf(fetch, "POST /contacts")).toEqual({
      email: "new@example.com",
      first_name: "New",
      properties: { seats: 5 },
      segments: [{ id: "seg_vip" }],
    });
  });

  it("adds the selected contacts to the chosen segments, one request per pair", async () => {
    const fetch = api();
    show(h(Contacts), "/audience");
    await screen.findByText("ada@example.com");
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Bulk actions" })).getByRole("button", { name: "Add to segments" }));
    const dialog = await screen.findByRole("dialog", { name: "Add 2 contacts to segments" });
    fireEvent.click(within(dialog).getByLabelText("VIP"));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() =>
      expect(calls(fetch)).toEqual(expect.arrayContaining(["POST /contacts/contact_ada/segments/seg_vip", "POST /contacts/contact_bob/segments/seg_vip"])),
    );
  });

  it("deletes the selected contacts after the typed phrase", async () => {
    const fetch = api();
    show(h(Contacts), "/audience");
    await screen.findByText("ada@example.com");
    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Bulk actions" })).getByRole("button", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Confirmation phrase"), { target: { value: "DELETE 2 CONTACTS" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toEqual(expect.arrayContaining(["DELETE /contacts/contact_ada", "DELETE /contacts/contact_bob"])));
  });
});

describe("contactBody", () => {
  it("leaves out empty fields and opts checked topics in", () => {
    expect(
      contactBody({ email: " a@b.co ", first_name: "", last_name: "" }, { seats: "", tier: "gold" }, [
        { key: "seats", type: "number" },
        { key: "tier", type: "string" },
      ], [], ["topic_news"]),
    ).toEqual({ email: "a@b.co", properties: { tier: "gold" }, topics: [{ id: "topic_news", subscription: "opt_in" }] });
  });
});
