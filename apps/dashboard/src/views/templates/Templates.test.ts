// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { template } from "./fixtures";
import { api, calls, list, renderAt } from "./harness";
import { createBody, Templates } from "./Templates";

const rows = [template(), template({ id: "tpl_2", name: "Reset password", alias: "password-reset", status: "draft", published_at: null })];

function setup(path = "/templates") {
  const fetch = api({
    "GET /templates": list(rows),
    "GET /brand": { object: "brand", product_name: "Acme" },
    "POST /templates": { ...template({ id: "tpl_new", name: "Launch" }) },
    "POST /templates/tpl_1/duplicate": template({ id: "tpl_copy", name: "Welcome (Copy)" }),
  });
  const router = renderAt(path, [
    { path: "/templates", element: h(Templates) },
    { path: "/templates/:id/editor", element: h("p", null, "Editor page") },
  ]);
  return { fetch, router };
}

describe("Templates", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows a card per template with alias, status, and a thumbnail", async () => {
    const { fetch } = setup();
    const card = await screen.findByRole("article", { name: "Welcome" });
    expect(within(card).getByText("welcome")).toBeTruthy();
    expect(within(card).getByText("published")).toBeTruthy();
    expect(within(card).getByText("Unpublished changes")).toBeTruthy();
    expect(card.querySelector("iframe")?.getAttribute("srcdoc")).toContain("your plan is Free");
    expect(screen.getByRole("article", { name: "Reset password" })).toBeTruthy();
    expect(calls(fetch, "GET /templates")[0]!.url.searchParams.get("limit")).toBe("100");
    const learn = within(screen.getByRole("navigation", { name: "Learn more" }));
    expect(learn.getByRole("link", { name: "Variables" }).getAttribute("href")).toContain("templates.md#variables");
    expect(learn.getByRole("link", { name: "Visual editor" }).getAttribute("href")).toContain("templates.md#visual-editor");
    expect(learn.getByRole("link", { name: "Brand" }).getAttribute("href")).toContain("templates.md#brand");
  });

  it("sends search and status from the URL to the server", async () => {
    const { fetch } = setup("/templates?status=draft&q=reset");
    await screen.findByRole("article", { name: "Reset password" });
    const url = calls(fetch, "GET /templates")[0]!.url;
    expect(url.searchParams.get("status")).toBe("draft");
    expect(url.searchParams.get("q")).toBe("reset");
  });

  it("says nothing matched when a filtered list is empty", async () => {
    api({ "GET /templates": list([]), "GET /brand": { object: "brand" } });
    renderAt("/templates?status=draft", [{ path: "/templates", element: h(Templates) }]);
    expect(await screen.findByText("No templates match")).toBeTruthy();
  });

  it("creates a draft and opens the editor", async () => {
    const { fetch, router } = setup();
    await screen.findByRole("article", { name: "Welcome" });
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/^Name/), { target: { value: "Launch" } });
    fireEvent.change(dialog.getByLabelText(/^Alias/), { target: { value: "launch" } });
    fireEvent.click(dialog.getByRole("button", { name: /^Create/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/templates/tpl_new/editor"));
    expect(calls(fetch, "POST /templates")[0]!.body).toEqual({ name: "Launch", alias: "launch" });
  });

  it("duplicates from the card menu", async () => {
    const { fetch } = setup();
    await screen.findByRole("article", { name: "Welcome" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Welcome" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(calls(fetch, "POST /templates/tpl_1/duplicate")).toHaveLength(1));
  });
});

describe("Templates helpers", () => {
  it("leaves empty alias and HTML out of the create body and never publishes", () => {
    expect(createBody({ name: " Launch ", alias: "", html: "" })).toEqual({ name: "Launch" });
  });
});
