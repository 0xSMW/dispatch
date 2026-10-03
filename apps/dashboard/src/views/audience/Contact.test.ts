// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import type { Contact as ContactRow } from "../../types";
import { Contact, propertyPatch } from "./Contact";
import { bodyOf, calls, list, show, stubApi } from "./stub";

const ada: ContactRow = {
  object: "contact",
  id: "contact_ada",
  email: "ada@example.com",
  first_name: "Ada",
  last_name: null,
  unsubscribed: false,
  properties: { seats: { value: 3, type: "number" }, legacy: { value: "x", type: "string" } },
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

function api() {
  return stubApi({
    "GET /contacts/contact_ada": ada,
    "PATCH /contacts/contact_ada": (_url: URL, init: RequestInit) => ({ ...ada, ...JSON.parse(String(init.body)), properties: ada.properties }),
    "GET /contact-properties": list([
      { object: "contact_property", id: "prop_seats", key: "seats", type: "number", fallback_value: 1 },
      { object: "contact_property", id: "prop_plan", key: "plan", type: "string", fallback_value: null },
    ]),
    "GET /contacts/contact_ada/segments": list([{ object: "segment", id: "seg_vip", name: "VIP", created_at: "" }]),
    "GET /segments": list([
      { object: "segment", id: "seg_vip", name: "VIP", created_at: "", updated_at: "" },
      { object: "segment", id: "seg_beta", name: "Beta", created_at: "", updated_at: "" },
    ]),
    "POST /contacts/contact_ada/segments/seg_beta": { object: "segment", id: "seg_beta", contact_id: "contact_ada" },
    "DELETE /contacts/contact_ada/segments/seg_vip": { object: "segment", id: "seg_vip", deleted: true },
    "GET /contacts/contact_ada/topics": list([{ id: "topic_news", name: "News", key: "news", subscription: "opt_out" }]),
    "PATCH /contacts/contact_ada/topics": list([{ id: "topic_news", name: "News", key: "news", subscription: "opt_in" }]),
    "GET /topics": list([
      { object: "topic", id: "topic_news", name: "News", key: "news", description: null, visibility: "public", default_subscription: "opt_in" },
      { object: "topic", id: "topic_tips", name: "Tips", key: "tips", description: null, visibility: "private", default_subscription: "opt_out" },
    ]),
    "GET /contacts/contact_ada/activity": list([
      { object: "contact_activity", id: "ev_1", type: "email.delivered", resource_id: "email_1", label: "Welcome", email_id: "email_1", created_at: "2026-09-02T00:00:00.000Z" },
      { object: "contact_activity", id: "sc_1", type: "segment.added", resource_id: "seg_vip", label: "VIP", email_id: null, created_at: "2026-09-01T00:00:00.000Z" },
      { object: "contact_activity", id: "run_1:started", type: "automation.run.started", resource_id: "run_1", label: "Onboarding", email_id: null, automation_id: "automation_1", run_id: "run_1", created_at: "2026-09-01T00:00:00.000Z" },
      { object: "contact_activity", id: "fired_1", type: "event.fired", resource_id: "fired_1", label: "user.joined", email_id: null, created_at: "2026-09-01T00:00:00.000Z" },
    ]),
  });
}

const open = () => show(h(Contact), "/audience/contacts/contact_ada", "/audience/contacts/:id");

describe("Contact", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows facts, segments, topics with their effective state, and activity", async () => {
    const fetch = api();
    open();
    await screen.findByRole("heading", { name: "ada@example.com" });
    // The panels mount once the contact has loaded, and each then makes its own request.
    await waitFor(() =>
      expect(calls(fetch)).toEqual(
        expect.arrayContaining([
          "GET /contacts/contact_ada",
          "GET /contacts/contact_ada/segments?limit=100",
          "GET /contacts/contact_ada/topics",
          "GET /contacts/contact_ada/activity?limit=20",
        ]),
      ),
    );
    expect(screen.getByText("subscribed")).toBeTruthy();
    expect(await screen.findByLabelText("Remove from VIP")).toBeTruthy();
    expect(await screen.findByText("Opted out")).toBeTruthy();
    expect(screen.getByText("Default: opt out")).toBeTruthy();
    expect(await screen.findByText("Added to segment")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Welcome" }).getAttribute("href")).toBe("/emails/email_1");
    expect(screen.getByRole("link", { name: "Onboarding" }).getAttribute("href")).toBe("/automations/automation_1/editor?tab=runs&run=run_1");
    expect(screen.getByText("Event received")).toBeTruthy();
    expect(((await screen.findByLabelText("seats")) as HTMLInputElement).value).toBe("3");
    expect(screen.getByText("Not a defined property.")).toBeTruthy();
  });

  it("saves properties, sending cleared values as null", async () => {
    const fetch = api();
    open();
    const seats = (await screen.findByLabelText("seats")) as HTMLInputElement;
    fireEvent.change(seats, { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("legacy"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls(fetch)).toContain("PATCH /contacts/contact_ada"));
    expect(bodyOf(fetch, "PATCH /contacts/contact_ada")).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      properties: { seats: 8, legacy: null },
    });
  });

  it("unsubscribes the contact", async () => {
    const fetch = api();
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(bodyOf(fetch, "PATCH /contacts/contact_ada")).toEqual({ unsubscribed: true }));
    expect(await screen.findByRole("button", { name: "Resubscribe" })).toBeTruthy();
  });

  it("adds and removes segments and changes a topic", async () => {
    const fetch = api();
    open();
    const segments = (await screen.findByText("Segments")).closest("section")!;
    const select = (await within(segments).findByRole("option", { name: "Beta" })).closest("select")!;
    fireEvent.change(select, { target: { value: "seg_beta" } });
    fireEvent.click(within(segments).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls(fetch)).toContain("POST /contacts/contact_ada/segments/seg_beta"));

    fireEvent.click(within(segments).getByLabelText("Remove from VIP"));
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /contacts/contact_ada/segments/seg_vip"));

    const topics = screen.getByText("Topics").closest("section")!;
    const news = within(topics).getByText("News").closest(".topicRow") as HTMLElement;
    fireEvent.click(within(news).getByRole("switch"));
    await waitFor(() =>
      expect(bodyOf(fetch, "PATCH /contacts/contact_ada/topics")).toEqual({ topics: [{ id: "topic_news", subscription: "opt_in" }] }),
    );
  });
});

describe("propertyPatch", () => {
  it("sends changed properties only, typed", () => {
    expect(
      propertyPatch(
        { first_name: " ", last_name: "L", "property:n": "4", "property:s": " hi ", "property:same": "1" },
        { n: "number", s: "string", same: "number" },
        { "property:n": "3", "property:same": "1" },
      ),
    ).toEqual({ first_name: null, last_name: "L", properties: { n: 4, s: "hi" } });
  });
});
