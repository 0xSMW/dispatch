// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, signIn, wrapper } from "../../testing";
import { Onboarding } from "../../shell/Onboarding";
import { calls, list, show, stubApi } from "../audience/stub";
import { Setup } from "./Setup";

describe("Setup", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows the three steps with their state and visible optional steps", async () => {
    const fetch = stubApi({
      "GET /setup": {
        object: "setup",
        tenant: { id: "tenant_1", name: "Acme" },
        domain: { id: "dom_1", name: "acme.com", status: "verified" },
        api_key: { id: "key_1", name: "Default", prefix: "sk_abc", scope: "full" },
        user: { id: "user_1", email: "ada@acme.com", name: "Ada" },
      },
      "GET /emails": list([]),
      "POST /emails": { id: "email_1" },
    });
    show(h(Setup), "/setup");
    await screen.findByText("acme.com verified");
    expect(calls(fetch)).toEqual(expect.arrayContaining(["GET /setup", "GET /emails?limit=1"]));
    expect(screen.getByText("Verify a domain").closest("li")?.className).toBe("done");
    expect(screen.getByText("Send an email").closest("li")?.className).toBe("");
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("Verify a domain").closest("ol")?.children).toHaveLength(3);
    const optional = screen.getByText("Lifecycle email (optional)").closest("section")!;
    expect(optional.closest("details")).toBeNull();
    expect(within(optional).getByRole("link", { name: "Set your brand" }).getAttribute("href")).toBe("/settings/brand");
    expect(within(optional).getByRole("link", { name: "Send your first event" }).getAttribute("href")).toBe("/events");
    expect(within(optional).getByRole("link", { name: "Choose a template" }).getAttribute("href")).toBe("/templates/library");
    expect(within(optional).getByText("Choose a ready-made template, then configure your automation. Review it before enabling it.")).toBeTruthy();
    expect(within(optional).queryByText(/when it ships/)).toBeNull();

    expect(screen.queryByRole("button", { name: "Send a test email" })).toBeNull();
    expect(calls(fetch).some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("keeps the required banner complete regardless of the untouched optional block", async () => {
    const fetch = stubApi({
      "GET /setup": { domain: { name: "acme.com", status: "verified" }, api_key: { prefix: "sk_test" } },
      "GET /emails": list([{ id: "email_1" }]),
    });
    signIn();
    render(h("div", null, h(Setup), h(Onboarding)), { wrapper });
    await screen.findByText("acme.com verified");
    await waitFor(() => expect(screen.getByText("Send an email").closest("li")?.className).toBe("done"));
    expect(screen.getByText("Verify a domain").closest("ol")?.children).toHaveLength(3);
    expect(screen.queryByText(/Finish setting up Dispatch/)).toBeNull();
    expect(screen.getByText("Lifecycle email (optional)").closest("details")).toBeNull();
    expect(calls(fetch).every((call) => call.startsWith("GET /setup") || call.startsWith("GET /emails"))).toBe(true);
  });

  it("does not offer optional write actions or test sending to a viewer", async () => {
    const fetch = stubApi({ "GET /setup": {}, "GET /emails": list([]) });
    signIn("sess_test", ["read"]);
    render(h(Setup), { wrapper });
    await waitFor(() => expect(calls(fetch)).toContain("GET /setup"));
    expect(screen.queryByRole("button", { name: "Send a test email" })).toBeNull();
    const optional = screen.getByText("Lifecycle email (optional)").closest("section")!;
    expect(optional.closest("details")).toBeNull();
    expect(within(optional).queryAllByRole("link")).toHaveLength(0);
    expect(within(optional).getByText(/Ask a team member with full access/)).toBeTruthy();
    expect(screen.getByText("Verify a domain").closest("ol")?.children).toHaveLength(3);
    expect(calls(fetch).some((call) => call.startsWith("POST"))).toBe(false);
  });
});
