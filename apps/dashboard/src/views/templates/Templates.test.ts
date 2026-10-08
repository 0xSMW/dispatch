// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { template } from "./fixtures";
import { api, calls, list, renderAt } from "./harness";
import { createBody, Templates } from "./Templates";
import { Library } from "./Library";

const rows = [template(), template({ id: "tpl_2", name: "Reset password", alias: "password-reset", status: "draft", published_at: null })];

function setup(path = "/templates") {
  const fetch = api({
    "GET /templates": list(rows),
    "GET /template-library": list([]),
    "GET /brand": { object: "brand", product_name: "Acme" },
    "POST /templates": { ...template({ id: "tpl_new", name: "Launch" }) },
    "POST /templates/tpl_1/duplicate": template({ id: "tpl_copy", name: "Welcome (Copy)" }),
  });
  const router = renderAt(path, [
    { path: "/templates", element: h(Templates) },
    { path: "/templates/library", element: h(Library) },
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
    expect(within(card).getByText("Published · Pending").className).toBe("cardStatus");
    expect(within(card).getByTitle("Unpublished changes")).toBeTruthy();
    expect(within(card).getByText("welcome").className).toContain("cardSlug");
    expect(card.querySelector(".badge")).toBeNull();
    expect(card.querySelector(".thumb")?.textContent).toContain("your plan is Free");
    expect(card.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("article", { name: "Reset password" })).toBeTruthy();
    expect(calls(fetch, "GET /templates")[0]!.url.searchParams.get("limit")).toBe("100");
    expect(screen.queryByRole("navigation", { name: "Learn more" })).toBeNull();
    expect(calls(fetch, "GET /template-library")).toHaveLength(0);
  });

  it("browses on demand and returns to the collection with the added template highlighted", async () => {
    const preset = {
      slug: "receipt", name: "Receipt", category: "billing", kind: "transactional",
      description: "After a payment.", variables: [], sample: {},
    };
    let installed = false;
    const fetch = api({
      "GET /templates": () => ({ body: list(installed ? [...rows, template({ id: "tpl_receipt", name: "Receipt" })] : rows) }),
      "GET /brand": { object: "brand", product_name: "Acme" },
      "GET /template-library": list([preset]),
      "GET /template-library/receipt": { ...preset, rendered: { html: "<p>Receipt</p>" } },
      "POST /template-library/receipt/install": () => {
        installed = true;
        return { body: { object: "template", id: "tpl_receipt" } };
      },
    });
    const router = renderAt("/templates?status=published&q=welcome", [
      { path: "/templates", element: h(Templates) },
      { path: "/templates/library", element: h(Library) },
    ]);
    await screen.findByRole("article", { name: "Welcome" });
    expect(calls(fetch, "GET /template-library")).toHaveLength(0);
    fireEvent.click(screen.getByRole("link", { name: "Browse templates" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/templates/library"));
    fireEvent.click(await screen.findByRole("button", { name: "Receipt" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add to templates" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/templates"));
    expect(router.state.location.search).toBe("?added=tpl_receipt");
    const own = await screen.findByRole("region", { name: "Your templates" });
    expect((await within(own).findByRole("article", { name: "Receipt" })).className).toContain("isAdded");
    expect(calls(fetch, "GET /templates")).toHaveLength(2);
    expect(calls(fetch, "GET /templates")[1]!.url.searchParams.has("q")).toBe(false);
    expect(calls(fetch, "GET /templates")[1]!.url.searchParams.has("status")).toBe(false);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Ready-made templates" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Create template" })).toHaveLength(1);
  });

  it("offers creation and browsing without loading the library when the collection is empty", async () => {
    const fetch = api({ "GET /templates": list([]), "GET /brand": { object: "brand" } });
    renderAt("/templates", [{ path: "/templates", element: h(Templates) }]);
    expect(await screen.findByText("No templates yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse templates" }).getAttribute("href")).toBe("/templates/library");
    expect(calls(fetch, "GET /template-library")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Create template" })).toHaveLength(1);
  });

  it("sends search and status from the URL to the server", async () => {
    const { fetch } = setup("/templates?status=draft&q=reset");
    await screen.findByRole("article", { name: "Reset password" });
    const url = calls(fetch, "GET /templates")[0]!.url;
    expect(url.searchParams.get("status")).toBe("draft");
    expect(url.searchParams.get("q")).toBe("reset");
  });

  it("says nothing matched when a filtered list is empty", async () => {
    api({ "GET /template-library": list([]), "GET /templates": list([]), "GET /brand": { object: "brand" } });
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
