import { changeControl, controlValue } from "../../testingControls";
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

function api(activity?: unknown[]) {
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
    "GET /contacts/contact_ada/activity": list(activity ?? [
      { object: "contact_activity", id: "ev_1", type: "email.delivered", resource_id: "email_1", label: "Welcome", email_id: "email_1", created_at: "2026-09-02T00:00:00.000Z" },
      { object: "contact_activity", id: "sc_1", type: "segment.added", resource_id: "seg_vip", label: "VIP", email_id: null, created_at: "2026-09-01T00:00:00.000Z" },
      { object: "contact_activity", id: "run_1:started", type: "automation.run.started", resource_id: "run_1", label: "Onboarding", email_id: null, automation_id: "automation_1", run_id: "run_1", created_at: "2026-09-01T00:00:00.000Z" },
      { object: "contact_activity", id: "fired_1", type: "event.fired", resource_id: "fired_1", label: "user.joined", email_id: null, created_at: "2026-09-01T00:00:00.000Z" },
      ...["done", "failed", "stopped"].map((state) => ({
        object: "contact_activity",
        id: `run_${state}:completed`,
        type: "automation.run.completed",
        resource_id: `run_${state}`,
        label: state,
        email_id: null,
        automation_id: "automation_1",
        run_id: `run_${state}`,
        created_at: "2026-09-02T00:00:00.000Z",
      })),
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
    expect(screen.getByText("Subscribed")).toBeTruthy();
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

  it.each(["done", "failed", "stopped"])("shows a completed %s run with its state label and run link", async (state) => {
    api();
    open();
    const link = await screen.findByRole("link", { name: state });
    expect(link.getAttribute("href")).toBe(`/automations/automation_1/editor?tab=runs&run=run_${state}`);
    expect(within(link.closest("tr")!).getByText("Automation run ended")).toBeTruthy();
  });

  it.each([
    ["completed", "done", "Reached the end"],
    ["exit", "done", "Exit step"],
    ["filter", "done", "Filter did not match"],
    ["stopped", "stopped", "Automation stopped"],
    ["stranded", "stopped", "Waiting step removed or changed"],
  ])("explains stored %s beside the unchanged %s state and run link", async (exit_reason, state, explanation) => {
    api([{
      object: "contact_activity", id: "run_1:completed", type: "automation.run.completed",
      resource_id: "run_1", label: state, email_id: null, automation_id: "automation_1",
      run_id: "run_1", exit_reason, created_at: "2026-09-02T00:00:00.000Z",
    }]);
    open();
    const link = await screen.findByRole("link", { name: state });
    expect(link.getAttribute("href")).toBe("/automations/automation_1/editor?tab=runs&run=run_1");
    expect(within(link.closest("tr")!).getByText(`· ${explanation}`)).toBeTruthy();
    expect(link.textContent).toBe(state);
  });

  it.each([
    ["automation.run.completed", "done", undefined],
    ["automation.run.completed", "failed", null],
    ["automation.run.completed", "stopped", null],
    ["automation.run.started", "Onboarding", "exit"],
    ["event.fired", "user.joined", "exit"],
  ])("adds no explanation for legacy/null/nonterminal %s (%s, %s)", async (type, label, exit_reason) => {
    api([{
      object: "contact_activity", id: "run_1", type, resource_id: "run_1", label,
      email_id: null, automation_id: "automation_1", run_id: "run_1",
      ...(exit_reason === undefined ? {} : { exit_reason }), created_at: "2026-09-02T00:00:00.000Z",
    }]);
    open();
    const link = await screen.findByRole("link", { name: label! });
    const cells = within(link.closest("tr")!).getAllByRole("cell");
    expect(cells[1].textContent).toBe(label);
    expect(link.getAttribute("href")).toBe("/automations/automation_1/editor?tab=runs&run=run_1");
  });

  it("saves properties, sending cleared values as null", async () => {
    const fetch = api();
    open();
    // Definitions load after the contact and can reorder the property controls.
    await screen.findByLabelText("plan");
    const seats = screen.getByLabelText("seats") as HTMLInputElement;
    changeControl(seats, { target: { value: "8" } });
    changeControl(screen.getByLabelText("legacy"), { target: { value: "" } });
    changeControl(screen.getByLabelText("Last name"), { target: { value: "Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls(fetch)).toContain("PATCH /contacts/contact_ada"));
    expect(bodyOf(fetch, "PATCH /contacts/contact_ada")).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      properties: { seats: 8, legacy: null },
    });
  });

  it("edits boolean/date values with typed controls and prevents malformed ISO writes", async () => {
    const typed = { ...ada, properties: { active: { value: true, type: "boolean" }, renewed: { value: "2026-10-04", type: "date" }, topics: { value: false, type: "boolean" } } };
    const fetch = stubApi({
      "GET /contacts/contact_ada": typed,
      "PATCH /contacts/contact_ada": typed,
      "GET /contact-properties": list([
        { key: "active", type: "boolean", fallback_value: false },
        { key: "renewed", type: "date", fallback_value: null },
        { key: "topics", type: "boolean", fallback_value: false },
      ]),
      "GET /contacts/contact_ada/segments": list([]), "GET /segments": list([]),
      "GET /contacts/contact_ada/topics": list([]), "GET /topics": list([]),
      "GET /contacts/contact_ada/activity": list([]),
    });
    open();
    await screen.findByLabelText("active");
    changeControl(screen.getByLabelText("active"), { target: { value: "false" } });
    changeControl(screen.getByLabelText("topics"), { target: { value: "true" } });
    changeControl(screen.getByLabelText("renewed format"), { target: { value: "text" } });
    changeControl(screen.getByLabelText("renewed"), { target: { value: "2026-02-30" } });
    expect(screen.getByRole("button", { name: /^Save/ })).toHaveProperty("disabled", true);
    fireEvent.submit(screen.getByLabelText("renewed").closest("form")!);
    expect(calls(fetch).some((call) => call.startsWith("PATCH"))).toBe(false);
    const date = "2026-10-05T12:34:56+05:30";
    changeControl(screen.getByLabelText("renewed"), { target: { value: date } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(bodyOf(fetch, "PATCH /contacts/contact_ada")).toEqual({
      first_name: "Ada", last_name: null, properties: { active: false, topics: true, renewed: date },
    }));
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
    const select = await within(segments).findByRole("combobox", { name: "Segment" });
    await waitFor(() => expect(select.parentElement!.textContent).toContain("Beta"));
    changeControl(select, { target: { value: "seg_beta" } });
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
  it("preserves false, ISO strings and null for cleared boolean/date properties", () => {
    expect(propertyPatch({ first_name: "", last_name: "", "property:b": "false", "property:d": "2026-10-04T12:34:56+05:30", "property:clear": "" }, { b: "boolean", d: "date", clear: "date" }, { "property:clear": "2026-10-03" })).toEqual({
      first_name: null, last_name: null, properties: { b: false, d: "2026-10-04T12:34:56+05:30", clear: null },
    });
  });
});
