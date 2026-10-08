// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, signIn, wrapper } from "../../testing";
import { contextFields } from "../../lib/rules";
import type { Goal } from "../../types";
import type { Rule } from "../automations/graph";
import { Goals, goalDraftIssue, goalRuleIssue } from "./Goals";

const goal: Goal = { object: "goal", id: "goal_1", name: "Paid", target: { event: "paid" }, eligibility: null, window_days: 30, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
const fields = contextFields({ properties: [{ key: "amount", type: "number" }], topics: [{ value: "topic_1", label: "News" }] });
const scalar: Rule = { type: "rule", field: "contact.amount", operator: "gte", value: 10 };
const set: Rule = { type: "rule", field: "contact.topics", operator: "contains", value: "topic_1" };

function api() {
  let rows = [goal];
  return mockFetch((raw, init) => {
    const path = new URL(raw).pathname;
    const method = init.method ?? "GET";
    if (path === "/goals" && method === "POST") {
      const created = { ...goal, id: "goal_2", ...JSON.parse(String(init.body)) };
      rows = [...rows, created];
      return { body: created };
    }
    if (path === "/goals/goal_1" && method === "PATCH") {
      rows = rows.map((row) => row.id === goal.id ? { ...row, ...JSON.parse(String(init.body)) } : row);
      return { body: rows[0] };
    }
    if (path === "/goals/goal_1" && method === "DELETE") {
      rows = rows.filter((row) => row.id !== goal.id);
      return { body: { object: "goal", id: goal.id, deleted: true } };
    }
    return { body: { object: "list", data: path === "/goals" ? rows : path === "/contact-properties" ? [{ id: "property_1", key: "amount", type: "number" }] : [], has_more: false } };
  });
}

describe("Goal validation", () => {
  it("accepts current sets only for eligibility, and uses declared scalar types", () => {
    expect(goalRuleIssue(scalar, fields, true)).toBeNull();
    expect(goalRuleIssue({ ...scalar, value: "10" }, fields, true)).toMatch(/number/);
    expect(goalRuleIssue(set, fields)).toBeNull();
    expect(goalRuleIssue(set, fields, true)).toMatch(/scalars only/);
    expect(goalRuleIssue({ ...set, value: "deleted" }, fields)).toMatch(/live topic/);
    for (const field of ["event.amount", "email.opened", "contact.unknown"]) {
      expect(goalRuleIssue({ type: "rule", field, operator: "eq", value: true }, fields, true)).toMatch(/declared contact/);
    }
  });

  it("allows the shared ten levels and more than twenty conditions, not segment limits", () => {
    let rule: Rule = scalar;
    for (let i = 1; i < 10; i++) rule = { type: "and", rules: [rule] };
    expect(goalRuleIssue(rule, fields, true)).toBeNull();
    expect(goalRuleIssue({ type: "and", rules: [rule] }, fields, true)).toMatch(/ten levels/);
    expect(goalRuleIssue({ type: "and", rules: Array.from({ length: 21 }, () => ({ ...scalar })) }, fields, true)).toBeNull();
  });

  it("requires a name, real event, and integer window in 1–365", () => {
    const draft = { name: "Paid", target: { event: "paid" }, eligibility: null, window_days: 30 };
    expect(goalDraftIssue(draft, fields)).toBeNull();
    expect(goalDraftIssue({ ...draft, name: " " }, fields)).toMatch(/name/);
    expect(goalDraftIssue({ ...draft, target: { event: "@system" } }, fields)).toMatch(/real event/);
    for (const window_days of [0, 366, 1.5, NaN]) expect(goalDraftIssue({ ...draft, window_days }, fields)).toMatch(/whole conversion window/);
  });
});

describe("Goals", () => {
  beforeEach(() => signIn());
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

  it("can create an event goal for all contacts when unrelated choices fail", async () => {
    mockFetch((raw) => new URL(raw).pathname === "/goals" ? { body: { object: "list", data: [goal], has_more: false } } : { status: 500, body: { message: "Unavailable" } });
    render(h(Goals), { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Create goal" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Activation" } });
    fireEvent.change(dialog.getByLabelText("Event name"), { target: { value: "activated" } });
    await screen.findByRole("button", { name: "Retry choices" });
    expect((dialog.getByRole("button", { name: /^Create/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("creates with the default window, edits via PATCH, and deletes with confirmation", async () => {
    const fetch = api();
    render(h(Goals), { wrapper });
    await screen.findByText("Paid");
    fireEvent.click(screen.getByRole("button", { name: "Create goal" }));
    let dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: " Trial " } });
    fireEvent.change(dialog.getByLabelText("Event name"), { target: { value: " trial_started " } });
    await waitFor(() => expect((dialog.getByRole("button", { name: /^Create/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(dialog.getByRole("button", { name: /^Create/ }));
    await screen.findByText("Trial");
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ name: "Trial", target: { event: "trial_started" }, eligibility: null, window_days: 30 });

    fireEvent.click(screen.getByText("Paid"));
    dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Purchased" } });
    await waitFor(() => expect((dialog.getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(dialog.getByRole("button", { name: /^Save/ }));
    await screen.findByText("Purchased");
    expect(fetch.mock.calls.some(([url, init]) => new URL(String(url)).pathname === "/goals/goal_1" && init?.method === "PATCH")).toBe(true);

    const row = screen.getByText("Purchased").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Actions/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Confirmation phrase"), { target: { value: "Purchased" } });
    fireEvent.click(dialog.getByRole("button", { name: /^Delete goal/ }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Purchased")).toBeNull());
  });

  it("opens viewer details read-only and exposes no mutation controls", async () => {
    signIn("sess_view", ["read"]);
    const fetch = api();
    render(h(Goals), { wrapper });
    fireEvent.click(await screen.findByText("Paid"));
    const dialog = within(screen.getByRole("dialog"));
    expect((dialog.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Create goal" })).toBeNull();
    expect(dialog.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("uses the shared typed rule editor, rejects unsupported targets and saves numeric scalars", async () => {
    const fetch = api();
    render(h(Goals), { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Create goal" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Big purchase" } });
    fireEvent.change(dialog.getByLabelText("Target").closest(".dropdown")!.querySelector("select")!, { target: { value: "rule" } });
    await dialog.findByText(/recorded contact scalars|A rule target counts/);
    expect(dialog.getByLabelText("Operator")).toBeTruthy();
    expect((dialog.getByRole("button", { name: /^Create/ }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((dialog.getByLabelText("Choose field") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(dialog.getByLabelText("Field"), { target: { value: "event.amount" } });
    expect((dialog.getByRole("button", { name: /^Create/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change((dialog.getByLabelText("Choose field").closest(".dropdown")?.querySelector("select") ?? dialog.getByLabelText("Choose field")), { target: { value: "contact.amount" } });
    fireEvent.change(dialog.getByLabelText("Operator").closest(".dropdown")!.querySelector("select")!, { target: { value: "gte" } });
    fireEvent.change(dialog.getByLabelText("Value"), { target: { value: "10" } });
    await waitFor(() => expect((dialog.getByRole("button", { name: /^Create/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(dialog.getByRole("button", { name: /^Create/ }));
    await screen.findByText("Big purchase");
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body)).target).toEqual({ rule: { type: "rule", field: "contact.amount", operator: "gte", value: 10 } });
  });
});
