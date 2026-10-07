// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { template } from "./fixtures";
import { api, calls, renderAt } from "./harness";
import { TemplateEditor } from "./TemplateEditor";
import { Requirement } from "./Variables";
import type { Variable } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("Requirement", () => {
  for (const fallback of ["Free", "", 0, 7]) {
    it(`round-trips ${JSON.stringify(fallback)} without losing its value or type`, () => {
      const changed = vi.fn();
      function Control() {
        const [variable, set] = useState<Variable>({ key: "VALUE", type: typeof fallback === "number" ? "number" : "string", fallback_value: fallback });
        return h(Requirement, { variable, onChange: (value) => {
          changed(value);
          set({ ...variable, fallback_value: value });
        } });
      }
      render(h(Control));
      expect(screen.getByLabelText("Fallback for VALUE")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Required" }));
      expect(screen.queryByLabelText("Fallback for VALUE")).toBeNull();
      expect(changed).toHaveBeenLastCalledWith(null);
      fireEvent.click(screen.getByRole("button", { name: "Optional" }));
      expect(changed).toHaveBeenLastCalledWith(fallback);
      expect((screen.getByLabelText("Fallback for VALUE") as HTMLInputElement).value).toBe(String(fallback));
    });
  }

  it("keeps lists fixed Required with no Optional or fallback field", () => {
    render(h(Requirement, { variable: { key: "ITEMS", type: "list", fallback_value: null }, onChange: vi.fn() }));
    expect((screen.getByRole("button", { name: "Required" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Optional" })).toBeNull();
    expect(screen.queryByLabelText("Fallback for ITEMS")).toBeNull();
  });
});

describe("Variable table saves", () => {
  beforeEach(() => signIn());
  const variables: Variable[] = [
    { key: "NAME", type: "string", fallback_value: null },
    { key: "PLAN", type: "string", fallback_value: "Free" },
    { key: "COUNT", type: "number", fallback_value: 0 },
    { key: "EMPTY", type: "string", fallback_value: "" },
    { key: "ITEMS", type: "list", fallback_value: null },
  ];
  function setup(html = "<p>{{{NAME}}} {{{PLAN}}} {{{COUNT}}} {{{EMPTY}}}</p><p>{{{#each ITEMS}}}{{{name}}}{{{/each}}}</p>") {
    const row = template({
      subject: "Welcome",
      html,
      variables,
    });
    const fetch = api({
      "GET /templates/tpl_1": row,
      "GET /brand": { object: "brand" },
      "PATCH /templates/tpl_1": (_url: URL, init: RequestInit) => ({ body: { ...row, ...JSON.parse(String(init.body)) } }),
    });
    renderAt("/templates/tpl_1/editor", [{ path: "/templates/:id/editor", element: h(TemplateEditor) }]);
    return fetch;
  }
  it("saves nothing after string, empty-string and number Required/Optional round-trips", async () => {
    const fetch = setup();
    await screen.findByLabelText("HTML");
    for (const key of ["PLAN", "COUNT", "EMPTY"]) {
      const control = within(screen.getByRole("group", { name: `Requirement for ${key}` }));
      fireEvent.click(control.getByRole("button", { name: "Required" }));
      fireEvent.click(control.getByRole("button", { name: "Optional" }));
    }
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(0);
  });
  it("sends Required as null, retains order and coerces an edited number fallback", async () => {
    const fetch = setup();
    await screen.findByLabelText("HTML");
    fireEvent.click(within(screen.getByRole("group", { name: "Requirement for PLAN" })).getByRole("button", { name: "Required" }));
    fireEvent.change(screen.getByLabelText("Fallback for COUNT"), { target: { value: "12" } });
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(1));
    expect(calls(fetch, "PATCH /templates/tpl_1")[0]!.body).toEqual({
      variables: variables.map((item) => item.key === "PLAN" ? { ...item, fallback_value: null } : item.key === "COUNT" ? { ...item, fallback_value: 12 } : item),
    });
  });
  it("clears the fallback when changing an Optional scalar to a list", async () => {
    setup();
    await screen.findByLabelText("HTML");
    fireEvent.change(screen.getByLabelText("Type of PLAN"), { target: { value: "list" } });
    const control = within(screen.getByRole("group", { name: "Requirement for PLAN" }));
    expect((control.getByRole("button", { name: "Required" }) as HTMLButtonElement).disabled).toBe(true);
    expect(control.queryByRole("button", { name: "Optional" })).toBeNull();
    expect(screen.queryByLabelText("Fallback for PLAN")).toBeNull();
  });
  it("keeps a configured unused variable visible and saved when made Required", async () => {
    const fetch = setup("<p>{{{NAME}}} {{{COUNT}}} {{{EMPTY}}}</p><p>{{{#each ITEMS}}}{{{name}}}{{{/each}}}</p>");
    await screen.findByLabelText("HTML");
    fireEvent.click(within(screen.getByRole("group", { name: "Requirement for PLAN" })).getByRole("button", { name: "Required" }));
    expect(screen.getByRole("group", { name: "Requirement for PLAN" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls(fetch, "PATCH /templates/tpl_1")).toHaveLength(1));
    expect((calls(fetch, "PATCH /templates/tpl_1")[0]!.body as { variables: Variable[] }).variables).toContainEqual({ key: "PLAN", type: "string", fallback_value: null });
    fireEvent.click(within(screen.getByRole("group", { name: "Requirement for PLAN" })).getByRole("button", { name: "Optional" }));
    expect((screen.getByLabelText("Fallback for PLAN") as HTMLInputElement).value).toBe("Free");
  });
  it("shows controls but disables all persisted changes for a viewer", async () => {
    signIn("sess_viewer", ["read"]);
    setup();
    await screen.findByLabelText("HTML");
    expect(screen.getAllByRole("button", { name: "Optional", pressed: true })).toHaveLength(3);
    for (const key of ["PLAN", "COUNT", "EMPTY"]) {
      const control = within(screen.getByRole("group", { name: `Requirement for ${key}` }));
      expect((control.getByRole("button", { name: "Required" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText(`Fallback for ${key}`) as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "Visual" })).toBeNull();
  });
});
