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
    "GET /template-library": list([]),
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
    expect(within(card).getByText("Published · Pending").className).toBe("cardStatus");
    expect(within(card).getByTitle("Unpublished changes")).toBeTruthy();
    expect(within(card).getByText("welcome").className).toContain("cardSlug");
    expect(card.querySelector(".badge")).toBeNull();
    expect(card.querySelector(".thumb")?.textContent).toContain("your plan is Free");
    expect(card.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("article", { name: "Reset password" })).toBeTruthy();
    expect(calls(fetch, "GET /templates")[0]!.url.searchParams.get("limit")).toBe("100");
    expect(screen.queryByRole("navigation", { name: "Learn more" })).toBeNull();
  });

  it("shows both collections and refreshes account templates after installation", async () => {
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
    renderAt("/templates?status=published&q=welcome", [{ path: "/templates", element: h(Templates) }]);
    const readyMade = screen.getByRole("region", { name: "Ready-made templates" });
    fireEvent.click(await within(readyMade).findByRole("button", { name: "Receipt" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use template" }));
    const own = screen.getByRole("region", { name: "Your templates" });
    expect(await within(own).findByRole("article", { name: "Receipt" })).toBeTruthy();
    expect(calls(fetch, "GET /templates")).toHaveLength(2);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("link", { name: "Browse library" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Create template" })).toHaveLength(1);
  });

  it("keeps creation and ready-made templates visible when the account has no templates", async () => {
    api({ "GET /templates": list([]), "GET /template-library": list([]), "GET /brand": { object: "brand" } });
    renderAt("/templates", [{ path: "/templates", element: h(Templates) }]);
    expect(await screen.findByText("No templates yet")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ready-made templates" })).toBeTruthy();
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
