// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, h, mockFetch, signIn, wrapper } from "../../testing";
import { General } from "./General";

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

describe("general settings", () => {
  it("loads defaults and saves the import choice and domain list", async () => {
    signIn();
    const fetch = mockFetch((_url, init) => ({
      body: init.method === "PATCH" ? JSON.parse(String(init.body)) : { import_trigger_automations: false, sandbox_domains: ["existing.test"] },
    }));
    render(h(General), { wrapper });
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(screen.getByLabelText("Additional sandbox domains")).toHaveProperty("value", "existing.test"));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Additional sandbox domains"), { target: { value: "demo.test\nqa.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(callAt(fetch, -1).init.body))).toEqual({ import_trigger_automations: true, sandbox_domains: ["demo.test", "qa.test"], confirmation_daily_limit: 500 });
  });

  it("does not offer a save action to a viewer", async () => {
    signIn("sess_test", ["read"]);
    mockFetch(() => ({ body: { import_trigger_automations: false, sandbox_domains: [] } }));
    render(h(General), { wrapper });
    await screen.findByRole("switch");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByLabelText("Additional sandbox domains").closest("fieldset")?.disabled).toBe(true);
  });
});
