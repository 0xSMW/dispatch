// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automations } from "../../../../../packages/templates/library.json";
import { h, signIn } from "../../testing";
import type { AutomationInstallation, AutomationPreset, Domain } from "../../types";
import { api, calls, list, renderAt } from "../templates/harness";
import { Presets, presetTree, senderMatches, stages, verifiedSenders } from "./Presets";

// jsdom has no layout engine; these allow React Flow to mount, not measure/zoom/pan.
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class DOMMatrixReadOnly { m22 = 1; }

const presets = automations as AutomationPreset[];
const newsletter = presets.find((row) => row.slug === "newsletter-welcome")!;
const onboarding = presets.find((row) => row.slug === "onboarding-drip")!;
const domains = [
  { id: "domain_1", name: "acme.com", status: "verified", capabilities: { sending: "enabled", receiving: "disabled" } },
  { id: "domain_2", name: "pending.com", status: "pending", capabilities: { sending: "enabled", receiving: "disabled" } },
  { id: "domain_3", name: "disabled.com", status: "verified", capabilities: { sending: "disabled", receiving: "disabled" } },
] as Domain[];
const result = {
  automation: { id: "automation_installed", name: "Installed welcome", status: "disabled" },
  templates: { created: [], reused: [{ id: "tpl_1", slug: "welcome" }] },
  events: [], properties: [],
  next_steps: ["Review the automation and its emails", "Enable the automation"],
} as unknown as AutomationInstallation;

function setup(extra: Record<string, unknown> = {}, stage = "") {
  const fetch = api({
    "GET /template-library/automations": list(presets),
    ...Object.fromEntries(presets.map((row) => [`GET /template-library/automations/${row.slug}`, row])),
    "GET /domains": list(domains),
    "GET /topics": list([{ id: "topic_1", name: "Product news" }]),
    ...Object.fromEntries(presets.map((row) => [`POST /template-library/automations/${row.slug}/install`, result])),
    ...extra,
  });
  const blank = vi.fn();
  const router = renderAt("/automations", [
    { path: "/automations", element: h(Presets, { stage, onBlank: blank }) },
    { path: "/automations/:id/editor", element: h("p", null, "Installed editor") },
  ]);
  return { fetch, blank, router };
}

async function preview(preset: AutomationPreset) {
  fireEvent.click(await screen.findByRole("button", { name: preset.name }));
  const drawer = screen.getByRole("dialog", { name: preset.name });
  await within(drawer).findByRole("button", { name: "Install as automation" });
  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Install as automation" })).toHaveProperty("disabled", false));
  return drawer;
}

async function installation(preset: AutomationPreset) {
  const drawer = await preview(preset);
  fireEvent.click(within(drawer).getByRole("button", { name: "Install as automation" }));
  await screen.findByRole("option", { name: "acme.com" });
  const dialog = screen.getByRole("dialog", { name: `Install ${preset.name}` });
  fireEvent.change(within(dialog).getByLabelText("Verified sender domain"), { target: { value: "acme.com" } });
  fireEvent.change(within(dialog).getByLabelText("From"), { target: { value: "Acme <hello@ACME.com>" } });
  return within(dialog);
}

describe("Presets", () => {
  beforeEach(() => {
    signIn();
    vi.stubGlobal("ResizeObserver", ResizeObserver);
    vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnly);
  });
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

  it("shows all six real stage cards and Blank without ID cursor paging", async () => {
    const { fetch, blank } = setup();
    await screen.findByRole("button", { name: newsletter.name });
    for (const stage of stages) expect(screen.getByRole("region", { name: stage.label })).toBeTruthy();
    for (const preset of presets) expect(screen.getByRole("button", { name: preset.name })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start blank" }));
    expect(blank).toHaveBeenCalledOnce();
    expect(calls(fetch, "GET /template-library/automations").map((call) => call.url.search)).toEqual([""]);
  });

  it("filters stage cards without changing the preset endpoint", async () => {
    const { fetch } = setup({}, "dunning");
    await screen.findByRole("button", { name: presets.find((row) => row.stage === "dunning")!.name });
    expect(screen.queryByRole("button", { name: newsletter.name })).toBeNull();
    expect(calls(fetch, "GET /template-library/automations")).toHaveLength(1);
  });

  it("renders the real read-only graph without add/edit actions", async () => {
    setup();
    const drawer = await preview(newsletter);
    expect(drawer.querySelector(".canvasView")).toBeTruthy();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Step welcome" }));
    const panel = within(drawer).getByRole("region", { name: "Step welcome settings" });
    expect(within(panel).getAllByRole("textbox").every((field) => (field as HTMLInputElement).disabled)).toBe(true);
    expect(within(drawer).queryByRole("button", { name: /Add a step|Delete step/ })).toBeNull();
  });

  it("requires a live newsletter topic and posts exact snake_case options, then navigates to review", async () => {
    const { fetch, router } = setup();
    const dialog = await installation(newsletter);
    const submit = dialog.getByRole("button", { name: /Install disabled/ });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(submit);
    expect(calls(fetch, `POST /template-library/automations/${newsletter.slug}/install`)).toEqual([]);
    await dialog.findByRole("option", { name: "Product news" });
    fireEvent.change(dialog.getByLabelText("Topic"), { target: { value: "topic_1" } });
    fireEvent.click(submit);
    await dialog.findByText("Installed disabled: Installed welcome");
    expect(calls(fetch, `POST /template-library/automations/${newsletter.slug}/install`)[0]!.body).toEqual({
      from: "Acme <hello@ACME.com>", topic_id: "topic_1",
    });
    for (const step of result.next_steps) expect(dialog.getByText(step)).toBeTruthy();
    expect(dialog.queryByRole("button", { name: /Install disabled/ })).toBeNull();
    fireEvent.click(dialog.getByRole("link", { name: "Review automation" }));
    await screen.findByText("Installed editor");
    expect(router.state.location.pathname).toBe("/automations/automation_installed/editor");
  });

  it("allows optional topics on other presets and renders server missing-topic guidance unchanged", async () => {
    const { fetch } = setup({
      [`POST /template-library/automations/${onboarding.slug}/install`]: {
        ...result, next_steps: ["Choose a topic for marketing steps", ...result.next_steps],
      },
    });
    const dialog = await installation(onboarding);
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Custom onboarding" } });
    fireEvent.click(dialog.getByRole("button", { name: /Install disabled/ }));
    await dialog.findByText("Choose a topic for marketing steps");
    expect(calls(fetch, `POST /template-library/automations/${onboarding.slug}/install`)[0]!.body).toEqual({
      name: "Custom onboarding", from: "Acme <hello@ACME.com>",
    });
  });

  it("shows server conflicts and keeps the dialog available for correction", async () => {
    const { fetch } = setup({
      [`POST /template-library/automations/${onboarding.slug}/install`]: () => ({
        status: 409, body: { name: "conflict", message: "Automation name already exists", statusCode: 409 },
      }),
    });
    const dialog = await installation(onboarding);
    fireEvent.click(dialog.getByRole("button", { name: /Install disabled/ }));
    expect(await dialog.findByRole("alert")).toHaveProperty("textContent", "Automation name already exists");
    expect(calls(fetch, `POST /template-library/automations/${onboarding.slug}/install`)).toHaveLength(1);
    expect(dialog.queryByRole("link", { name: "Review automation" })).toBeNull();
  });

  it("offers only verified sending domains and blocks foreign From addresses", async () => {
    const { fetch } = setup();
    const dialog = await installation(onboarding);
    expect(dialog.queryByRole("option", { name: "pending.com" })).toBeNull();
    expect(dialog.queryByRole("option", { name: "disabled.com" })).toBeNull();
    fireEvent.change(dialog.getByLabelText("From"), { target: { value: "hello@foreign.com" } });
    expect(dialog.getByRole("button", { name: /Install disabled/ })).toHaveProperty("disabled", true);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("lets viewers browse and preview but never open a submitting dialog or POST", async () => {
    signIn("viewer", ["read"]);
    const { fetch } = setup();
    fireEvent.click(await screen.findByRole("button", { name: newsletter.name }));
    const drawer = screen.getByRole("dialog", { name: newsletter.name });
    await waitFor(() => expect(drawer.querySelector(".canvasView")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Install as automation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start blank" })).toBeNull();
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(calls(fetch, "GET /domains")).toHaveLength(0);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("renders listing failures with retry rather than an install flow", async () => {
    setup({ "GET /template-library/automations": () => ({ status: 500, body: { message: "Library unavailable" } }) });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not loadLibrary unavailableTry again");
    expect(screen.queryByRole("button", { name: "Install as automation" })).toBeNull();
  });
});

describe("sender guidance", () => {
  it("previews all six frozen graphs without mutating shared terminal exits or executable graphs", () => {
    const before = JSON.stringify(presets);
    for (const preset of presets) expect(presetTree(preset).problem, preset.slug).toBeNull();
    expect(JSON.stringify(presets)).toBe(before);
    const tree = presetTree(newsletter).tree;
    const condition = tree.steps.find((step) => step.type === "condition")!;
    expect(condition.branches?.condition_met?.map((step) => step.type)).toEqual(["send_email", "exit"]);
    expect(condition.branches?.condition_not_met?.map((step) => step.type)).toEqual(["send_email", "exit"]);
  });
  it("accepts display names and case-insensitive domain matching without CR/LF", () => {
    expect(verifiedSenders(domains).map((row) => row.id)).toEqual(["domain_1"]);
    expect(senderMatches("Acme <hello@ACME.com>", "acme.com")).toBe(true);
    expect(senderMatches("hello@acme.com", "acme.com")).toBe(true);
    expect(senderMatches("hello@acme.com\nBcc: victim@example.com", "acme.com")).toBe(false);
    expect(senderMatches("hello@other.com", "acme.com")).toBe(false);
  });
});
