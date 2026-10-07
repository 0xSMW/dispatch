// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextFields } from "../../lib/rules";
import { h, mockFetch, signIn, wrapper, type Reply } from "../../testing";
import type { Rule } from "../automations/graph";
import { SegmentFilter, segmentRuleIssue } from "./SegmentFilter";
import { bodyOf, calls, list, stubApi } from "./stub";

const emailRule: Rule = { type: "rule", field: "contact.email", operator: "contains", value: "@example.com" };
const opened: Rule = { type: "rule", field: "email.opened", operator: "eq", value: false };
const sources = {
  "GET /contact-properties": list([{ id: "prop_plan", key: "plan", type: "string" }]),
  "GET /topics": list([{ id: "topic_news", name: "News" }]),
  "GET /segments": list([{ id: "seg_static", name: "VIP", type: "static" }, { id: "seg_dynamic", name: "Live", type: "dynamic" }]),
  "GET /automations": list([{ id: "auto_1", name: "Welcome" }]),
  "GET /broadcasts": list([{ id: "br_1", name: "Launch" }]),
};
function Harness({ initial = emailRule, disabled = false }: { initial?: Rule; disabled?: boolean }) {
  const [rule, setRule] = useState(initial);
  return h(SegmentFilter, { rule, onChange: setRule, disabled });
}

describe("SegmentFilter", () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("previews the exact controlled rule, caps samples at ten, and excludes event choices", async () => {
    const fetch = stubApi({
      ...sources, "POST /segments/preview": { count: 42, sample: Array.from({ length: 12 }, (_, index) => ({ id: `c_${index}`, email: `${index}@example.com` })) },
    });
    signIn();
    render(h(Harness), { wrapper });
    await screen.findByText("42 matching contacts");
    expect(bodyOf(fetch, "POST /segments/preview")).toEqual({ rule: emailRule });
    expect(within(screen.getByRole("region", { name: "Filter preview" })).getAllByRole("link")).toHaveLength(10);
    expect(screen.queryByText("Event")).toBeNull();
    expect(calls(fetch)).toContain("GET /contact-properties?limit=100");
  });

  it("debounces edits and ignores old in-flight preview results and results after unmount", async () => {
    const pending: Array<{ resolve: (reply: Reply) => void; rule: Rule }> = [];
    const fetch = mockFetch((raw, init) => {
      const path = new URL(raw).pathname;
      if (path === "/segments/preview") return new Promise<Reply>((resolve) => pending.push({ resolve, rule: JSON.parse(String(init.body)).rule }));
      return { body: sources[`GET ${path}` as keyof typeof sources] };
    });
    signIn();
    const view = render(h(Harness), { wrapper });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "first" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "latest" } });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]!.rule).toEqual({ ...emailRule, value: "latest" });
    await act(async () => pending[1]!.resolve({ body: { count: 2, sample: [] } }));
    await screen.findByText("2 matching contacts");
    await act(async () => pending[0]!.resolve({ body: { count: 99, sample: [] } }));
    expect(screen.queryByText("99 matching contacts")).toBeNull();
    expect(calls(fetch).filter((call) => call === "POST /segments/preview")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "unmounted" } });
    await waitFor(() => expect(pending).toHaveLength(3));
    view.unmount();
    await act(async () => pending[2]!.resolve({ body: { count: 100, sample: [] } }));
    expect(screen.queryByText("100 matching contacts")).toBeNull();
  });

  it("loads later automation and broadcast pages and emits one scope plus a duration", async () => {
    const fetch = stubApi({
      ...sources,
      "GET /automations": (url: URL) => url.searchParams.has("after") ? list([{ id: "auto_2", name: "Later automation" }]) : list([{ id: "auto_1", name: "Welcome" }], true),
      "GET /broadcasts": (url: URL) => url.searchParams.has("after") ? list([{ id: "br_2", name: "Later broadcast" }]) : list([{ id: "br_1", name: "Launch" }], true),
      "POST /segments/preview": { count: 0, sample: [] },
    });
    signIn();
    render(h(Harness, { initial: opened }), { wrapper });
    await screen.findByText("0 matching contacts");
    fireEvent.change(screen.getByLabelText("Email scope"), { target: { value: "automation" } });
    fireEvent.change(screen.getByLabelText("Automation"), { target: { value: "auto_2" } });
    fireEvent.change(screen.getByLabelText("Window"), { target: { value: "30 days" } });
    await waitFor(() => expect(bodyOf(fetch, "POST /segments/preview")).toEqual({ rule: { ...opened, scope: { automation_id: "auto_2" }, window: "30 days" } }));
    fireEvent.change(screen.getByLabelText("Email scope"), { target: { value: "broadcast" } });
    fireEvent.change(screen.getByLabelText("Broadcast"), { target: { value: "br_2" } });
    await waitFor(() => expect(bodyOf(fetch, "POST /segments/preview")).toEqual({ rule: { ...opened, scope: { broadcast_id: "br_2" }, window: "30 days" } }));
    expect(calls(fetch)).toContain("GET /automations?limit=100&after=auto_1");
    expect(calls(fetch)).toContain("GET /broadcasts?limit=100&after=br_1");
    fireEvent.change(screen.getByLabelText("Email scope"), { target: { value: "any" } });
    fireEvent.change(screen.getByLabelText("Window"), { target: { value: "" } });
    await waitFor(() => expect(bodyOf(fetch, "POST /segments/preview")).toEqual({ rule: opened }));
  });

  it("keeps supplied edits through live choice loading and permits disabled read previews", async () => {
    const onChange = vi.fn();
    stubApi({ ...sources, "POST /segments/preview": { count: 3, sample: [] } });
    signIn("viewer", ["read"]);
    render(h(SegmentFilter, { rule: { ...emailRule, value: "saved draft" }, onChange, disabled: true }), { wrapper });
    await screen.findByText("3 matching contacts");
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("saved draft");
    expect((screen.getByLabelText("Value") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "not allowed" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows errors without previewing an unavailable source or silently changing unknown fields", async () => {
    const fetch = stubApi({ ...sources });
    signIn();
    const onChange = vi.fn();
    render(h(SegmentFilter, { rule: { ...emailRule, field: "event.plan" }, onChange }), { wrapper });
    await screen.findByText("Choose a declared contact field.");
    expect(onChange).not.toHaveBeenCalled();
    expect(calls(fetch)).not.toContain("POST /segments/preview");
  });
});

describe("segmentRuleIssue", () => {
  const fields = contextFields({ topics: [{ value: "t", label: "News" }], segments: [{ value: "s", label: "VIP" }] }).filter((field) => !field.path.startsWith("event."));
  const scopes = { automations: [{ value: "a", label: "Welcome" }], broadcasts: [{ value: "b", label: "Launch" }] };
  it("enforces five total levels and twenty total leaves across groups", () => {
    let rule: Rule = emailRule;
    for (let index = 0; index < 4; index++) rule = { type: "and", rules: [rule] };
    expect(segmentRuleIssue(rule, fields, scopes)).toBeNull();
    expect(segmentRuleIssue({ type: "and", rules: [rule] }, fields, scopes)).toMatch(/five/);
    expect(segmentRuleIssue({ type: "and", rules: Array.from({ length: 21 }, () => ({ ...emailRule })) }, fields, scopes)).toMatch(/twenty/);
  });
  it("refuses unsupported facts, scopes, windows, dynamic memberships and wrong contact values", () => {
    for (const rule of [
      { ...opened, field: "email.received" }, { ...opened, value: "true" }, { ...opened, operator: "contains" },
      { ...opened, window: "0 days" }, { ...opened, window: "Infinity days" }, { ...opened, scope: { automation_id: "" } },
      { ...opened, scope: { automation_id: "a", broadcast_id: "b" } }, { ...opened, scope: { automation_id: "deleted" } },
      { ...emailRule, scope: { automation_id: "a" } }, { ...emailRule, window: "7 days" }, { ...emailRule, value: null },
      { ...emailRule, field: "contact.segments", operator: "contains", value: "dynamic" },
    ]) expect(segmentRuleIssue(rule as Rule, fields, scopes)).toBeTruthy();
    expect(segmentRuleIssue({ ...opened, scope: { automation_id: "a" }, window: "30 days" }, fields, scopes)).toBeNull();
  });
});
