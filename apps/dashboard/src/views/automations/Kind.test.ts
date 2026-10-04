// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn } from "../../testing";
import type { SendKind } from "../../types";
import { Canvas } from "./Canvas";
import { StepList, type StepActions, type StepOptions } from "./Steps";
import { stepIssues, toGraph, updateNode, type Node, type Tree } from "./graph";

const initial: Node = { key: "send", type: "send_email", config: { kind: "transactional", template: { id: "receipt", variables: { plan: "pro" } }, variable_mapping: { name: "contact.first_name" } } };

function Builder({ canvas = false, disabled = false, fallback = false, run = false }: {
  canvas?: boolean; disabled?: boolean; fallback?: boolean; run?: boolean;
}) {
  const [tree, setTree] = useState<Tree>({ trigger: "trigger", event: "signup", steps: [initial] });
  const options: StepOptions = {
    templates: [
      { value: "receipt", label: "Receipt", kind: "transactional" },
      { value: "news", label: "Newsletter", kind: fallback ? undefined : "marketing" as SendKind },
    ],
    events: [], segments: [], topics: [{ value: "news_topic", label: "News" }],
  };
  const actions: StepActions = {
    insert: () => undefined, remove: () => undefined, move: () => undefined, waitBranches: () => undefined,
    change: (key, change) => setTree((current) => updateNode(current, key, change)),
  };
  const results = run ? new Map([["send", { type: "send_email", status: "completed" }]]) : undefined;
  const props = { actions: disabled ? undefined : actions, disabled, options, run: results };
  return h("div", null,
    canvas ? h(Canvas, { tree, ...props }) : h(StepList, { nodes: tree.steps, ...props }),
    h("output", { "data-testid": "config" }, JSON.stringify(toGraph(tree).steps[1]!.config)),
  );
}
const config = () => JSON.parse(screen.getByTestId("config").textContent!);

async function open(canvas = false, props: Parameters<typeof Builder>[0] = {}) {
  render(h(SessionProvider, null, h(Builder, { ...props, canvas })));
  if (canvas) fireEvent.click(await screen.findByRole("button", { name: "Step send" }));
  return within(screen.getByRole(canvas ? "region" : "article", { name: canvas ? "Step send settings" : "Step send" }));
}

beforeEach(() => {
  signIn();
  mockFetch(() => ({ body: { id: "news", html: "<p>News</p>", text: "{{DISPATCH_UNSUBSCRIBE_URL}}" } }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

describe("send kind in the shared builder", () => {
  it.each([false, true])("switches kinds in canvas=%s, removes the topic, and preserves all other send settings", async (canvas) => {
    const panel = await open(canvas);
    expect(panel.getByRole("radio", { name: "Transactional" })).toHaveProperty("checked", true);
    expect(panel.queryByLabelText("Topic")).toBeNull();
    expect(panel.getByText(/Always sent, regardless/)).toBeTruthy();
    fireEvent.click(panel.getByRole("radio", { name: "Marketing" }));
    expect(config().kind).toBe("marketing");
    expect(stepIssues({ ...initial, config: config() })).toEqual({});
    fireEvent.change(panel.getByLabelText("Topic"), { target: { value: "news_topic" } });
    fireEvent.click(panel.getByRole("radio", { name: "Transactional" }));
    expect(config()).not.toHaveProperty("topic_id");
    expect(config()).toMatchObject(initial.config);
  });

  it.each([false, true])("forces Marketing and explains disabled Transactional for a Marketing template in canvas=%s", async (canvas) => {
    const panel = await open(canvas);
    fireEvent.change(panel.getByLabelText("Template"), { target: { value: "news" } });
    expect(config().kind).toBe("marketing");
    expect(panel.getByRole("radio", { name: "Transactional" })).toHaveProperty("disabled", true);
    expect(panel.getByRole("radio", { name: "Marketing" })).toHaveProperty("checked", true);
    expect(panel.getByText(/Transactional is unavailable/)).toBeTruthy();
    expect(config().template.variables).toEqual({ plan: "pro" });
    fireEvent.change(panel.getByLabelText("Template"), { target: { value: "receipt" } });
    expect(panel.getByRole("radio", { name: "Transactional" })).toHaveProperty("disabled", false);
    expect(config().kind).toBe("marketing"); // Transactional templates can still be used for Marketing.
  });

  it.each([false, true])("loads detail content when list metadata is unavailable in canvas=%s", async (canvas) => {
    const panel = await open(canvas, { fallback: true });
    fireEvent.change(panel.getByLabelText("Template"), { target: { value: "news" } });
    await waitFor(() => expect(config().kind).toBe("marketing"));
    expect(panel.getByRole("radio", { name: "Transactional" })).toHaveProperty("disabled", true);
    expect(panel.getByText(/unsubscribe placeholder/)).toBeTruthy();
  });

  it.each([false, true])("keeps kind controls read-only in canvas=%s", async (canvas) => {
    const panel = await open(canvas, { disabled: true });
    for (const control of panel.getAllByRole("radio")) expect(control).toHaveProperty("disabled", true);
    expect(config().kind).toBe("transactional");
  });

  it.each([false, true])("shows kind and send semantics in the run summary in canvas=%s", async (canvas) => {
    const panel = await open(canvas, { run: true });
    expect(panel.getByText(/Transactional · Template receipt/)).toBeTruthy();
    expect(panel.getByText(/Always sent, regardless/)).toBeTruthy();
    if (canvas) expect(within(screen.getByRole("button", { name: "Step send" })).getByText("Transactional")).toBeTruthy();
    else expect(panel.getByText("Transactional")).toBeTruthy();
  });
});
