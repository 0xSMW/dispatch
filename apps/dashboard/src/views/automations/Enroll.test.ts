// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn, wrapper } from "../../testing";
import type { Automation, EnrollmentJob } from "../../types";
import { bodyOf, calls, list, Status, stubApi } from "../audience/stub";
import { Automations } from "./Automations";
import { canEnroll, Enroll, EnrollmentProgress } from "./Enroll";

const automation: Automation = { id: "auto_1", name: "Lifecycle", status: "enabled", trigger_config: { type: "contact_updated", field: "first_name", from: "Ada", to: "Grace" }, steps: [], created_at: "" };
const job: EnrollmentJob = { object: "automation_enrollment_job", id: "job_1", automation_id: "auto_1", segment_id: null, status: "queued", counts: { total: 10, processed: 2, enrolled: 1, skipped: 1, failed: 0 }, error: null, created_at: "", completed_at: null };
const path = "/automations/auto_1/enroll-jobs/job_1";
const segments = list([{ object: "segment", id: "seg_1", name: "VIP", created_at: "", updated_at: "" }]);

describe("Enrollment", () => {
  beforeEach(() => signIn());
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

  it("only allows enabled non-event automations, including legacy enabled records", () => {
    expect(canEnroll(automation)).toBe(true);
    expect(canEnroll({ ...automation, status: undefined, enabled: true })).toBe(true);
    expect(canEnroll({ ...automation, status: "disabled" })).toBe(false);
    expect(canEnroll({ ...automation, status: "paused", enabled: true })).toBe(false);
    expect(canEnroll({ ...automation, trigger_config: { type: "event", event_name: "purchase" } })).toBe(false);
  });

  it.each([["all", { all: true }], ["seg_1", { segment_id: "seg_1" }]])("posts the exact %s audience and shows the returned job", async (audience, body) => {
    const fetch = stubApi({ "GET /segments": segments, "POST /automations/auto_1/enroll": new Status(202, job), [`GET ${path}`]: job });
    const onJob = vi.fn();
    render(h(Enroll, { automation, onClose: vi.fn(), onJob }), { wrapper });
    expect(screen.getByRole("button", { name: /Enroll contacts/ })).toHaveProperty("disabled", true);
    await screen.findByRole("option", { name: "VIP" });
    expect(screen.getByText("This can send emails immediately.")).toBeTruthy();
    expect(screen.getByText(/ignores from\/to/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: audience } });
    fireEvent.click(screen.getByRole("button", { name: /Enroll contacts/ }));
    await screen.findByText("queued");
    expect(bodyOf(fetch, "POST /automations/auto_1/enroll")).toEqual(body);
    const sent = fetch.mock.calls.find(([url, init]) => String(url).endsWith("/enroll") && (init as RequestInit).method === "POST")!;
    expect(new Headers((sent[1] as RequestInit).headers).get("idempotency-key")).toMatch(new RegExp(`:${audience}$`));
    expect(onJob).toHaveBeenCalledWith("job_1");
    expect(screen.getByRole("link", { name: /Open this enrollment job/ }).getAttribute("href")).toBe("/automations/auto_1/editor?enroll_job=job_1");
  });

  it("polls, cancels between batches, preserves partial counts, and stops polling", async () => {
    let poll = 0;
    const fetch = stubApi({
      [`GET ${path}`]: () => ({ ...job, status: poll++ ? "in_progress" : "queued" }),
      [`DELETE ${path}`]: { ...job, status: "cancelled" },
    });
    render(h(EnrollmentProgress, { automationId: "auto_1", id: "job_1" }), { wrapper });
    await screen.findByText("queued");
    await screen.findByText("in progress", {}, { timeout: 3000 });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("20");
    fireEvent.click(screen.getByRole("button", { name: "Cancel enrollment" }));
    await screen.findByText("cancelled");
    expect(calls(fetch)).toContain(`DELETE ${path}`);
    expect(screen.queryByRole("button", { name: "Cancel enrollment" })).toBeNull();
    expect(screen.getByText(/not runs already enrolled/)).toBeTruthy();
    const count = fetch.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(fetch.mock.calls).toHaveLength(count);
  });

  it("shows start errors without pretending a job exists", async () => {
    stubApi({ "GET /segments": segments, "POST /automations/auto_1/enroll": new Status(409, { name: "conflict", message: "Automation is paused." }) });
    render(h(Enroll, { automation, onClose: vi.fn() }), { wrapper });
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: /Enroll contacts/ }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Automation is paused.");
    expect(screen.queryByText("Enrollment progress")).toBeNull();
  });

  it("shows cancellation and worker errors clearly", async () => {
    stubApi({ [`GET ${path}`]: job, [`DELETE ${path}`]: new Status(500, { name: "application_error", message: "Could not cancel." }) });
    render(h(EnrollmentProgress, { automationId: "auto_1", id: "job_1" }), { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel enrollment" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not cancel.");
    cleanup();
    stubApi({ [`GET ${path}`]: { ...job, status: "failed", error: "Worker failed." } });
    render(h(EnrollmentProgress, { automationId: "auto_1", id: "job_1" }), { wrapper });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Worker failed.");
    expect(screen.queryByRole("button", { name: "Cancel enrollment" })).toBeNull();
  });

  it("lets viewers inspect an existing job without audience, submit, or cancellation controls", async () => {
    signIn("sess_viewer", ["read"]);
    const fetch = stubApi({ "GET /segments": segments, [`GET ${path}`]: job });
    render(h(Enroll, { automation, jobId: "job_1", onClose: vi.fn() }), { wrapper });
    await screen.findByText("queued");
    expect(screen.queryByLabelText("Audience")).toBeNull();
    expect(screen.queryByRole("button", { name: /Enroll contacts|Cancel enrollment/ })).toBeNull();
    expect(calls(fetch).every((call) => call.startsWith("GET "))).toBe(true);
  });

  it("does not expose a new enrollment form to viewers", () => {
    signIn("sess_viewer", ["read"]);
    stubApi({ "GET /segments": segments });
    render(h(Enroll, { automation, onClose: vi.fn() }), { wrapper });
    expect(screen.queryByLabelText("Audience")).toBeNull();
    expect(screen.queryByRole("button", { name: /Enroll contacts/ })).toBeNull();
  });

  it("exposes the shared action from eligible list rows", async () => {
    stubApi({ "GET /automations": list([automation]), "GET /topics": list([]), "GET /segments": segments });
    render(h(Automations), { wrapper });
    await screen.findByText("Lifecycle");
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Enroll contacts" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByLabelText("Audience")).toBeTruthy();
  });

  it.each(["viewer", "event", "disabled", "paused"])("hides the list action for %s", async (kind) => {
    if (kind === "viewer") signIn("sess_viewer", ["read"]);
    const row = kind === "event" ? { ...automation, trigger_config: { type: "event", event_name: "purchase" } }
      : kind === "disabled" || kind === "paused" ? { ...automation, status: kind } : automation;
    stubApi({ "GET /automations": list([row]), "GET /topics": list([]), "GET /segments": segments });
    render(h(Automations), { wrapper });
    await screen.findByText("Lifecycle");
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findByRole("menuitem", { name: "Open builder" });
    expect(screen.queryByRole("menuitem", { name: "Enroll contacts" })).toBeNull();
  });
});
