// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { framed } from "../../components/EmailFrame";
import { h, signIn } from "../../testing";
import { api, calls, list, renderAt } from "./harness";
import { Library, recipeLinks, renderedOf, type DiscoveryTemplate } from "./Library";

function entry(fields: Partial<DiscoveryTemplate>): DiscoveryTemplate {
  return {
    slug: "password-reset",
    name: "Password reset",
    category: "authentication",
    kind: "transactional",
    track: false,
    subject: "Reset your {{{PRODUCT_NAME}}} password",
    description: "Sent when someone asks to reset their password.",
    stage: null,
    when: "Send after a password reset request.",
    variables: [
      { key: "ACTION_URL", type: "string", fallback_value: null },
      { key: "EXPIRES_IN", type: "string", fallback_value: "1 hour" },
    ],
    sample: { ACTION_URL: "https://example.com/reset" },
    ...fields,
  };
}

const entries = [entry({}), entry({ slug: "receipt", name: "Receipt", category: "billing", description: "After a payment." })];

function setup(path = "/templates/library") {
  const fetch = api({
    "GET /template-library": list(entries),
    "GET /template-library/password-reset": { ...entries[0], rendered: { subject: "Reset your Acme password", html: "<p>Reset it here</p>", text: "Reset" } },
    // The older shape, before the rename to `rendered`.
    "GET /template-library/receipt": { ...entries[1], preview: { subject: "Your Acme receipt", html: "<p>Receipt body</p>", text: "Receipt" } },
    "POST /template-library/password-reset/install": { object: "template", id: "tpl_9" },
  });
  const router = renderAt(path, [
    { path: "/templates/library", element: h(Library) },
    { path: "/templates", element: h("p", null, "Your templates") },
  ]);
  return { fetch, router };
}

describe("Library", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows one flat grid with compact covers and unboxed name and slug", async () => {
    setup();
    await screen.findByRole("article", { name: "Password reset" });
    const card = screen.getByRole("article", { name: "Receipt" });
    await waitFor(() => expect(within(card).getByText("Receipt body")).toBeTruthy());
    expect(card.querySelector("iframe")).toBeNull();
    expect(within(card).getByText("receipt").className).toContain("cardSlug");
    expect(screen.queryByText("Ready to use")).toBeNull();
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Browse templates"]);
    expect(screen.getByRole("link", { name: "Templates" }).getAttribute("href")).toBe("/templates");
    expect(card.querySelector(".badge")).toBeNull();
  });

  it("previews a template with its variables and installs it", async () => {
    const { fetch, router } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Password reset" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Transactional")).toBeTruthy();
    expect(await within(drawer).findByText("Reset your Acme password")).toBeTruthy();
    expect(drawer.querySelector("iframe")?.getAttribute("srcdoc")).toBe(framed("<p>Reset it here</p>"));
    expect(within(drawer).getByText("ACTION_URL")).toBeTruthy();
    expect(within(drawer).getByText(/Required/)).toBeTruthy();
    expect(within(drawer).getByText("1 hour")).toBeTruthy();
    expect(within(drawer).getByText("Send after a password reset request.")).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "Edit brand" }).getAttribute("href")).toBe("/settings/brand");

    fireEvent.click(within(drawer).getByRole("button", { name: "Add to templates" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/templates"));
    expect(router.state.location.search).toBe("?added=tpl_9");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls(fetch, "POST /template-library/password-reset/install")).toHaveLength(1);
  });

  it("keeps guidance and recipes in the full preview, with concise grid metadata", async () => {
    setup();
    const card = await screen.findByRole("article", { name: "Password reset" });
    expect(within(card).queryByText("Send after a password reset request.")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Preview Password reset" }));
    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByText("Send after a password reset request.")).toBeTruthy();
    expect(drawer.getByRole("link", { name: "Auth.js recipe" }).getAttribute("href")).toMatch(/templates\/authjs.md$/);
    expect(drawer.getByRole("link", { name: "Better Auth recipe" }).getAttribute("href")).toMatch(/templates\/better-auth.md$/);
    expect(drawer.getByRole("link", { name: "Edit brand" }).getAttribute("href")).toBe("/settings/brand");
  });

  it("preserves manifest order without group headings", async () => {
    const lifecycle = [
      entry({ slug: "welcome", name: "Welcome", stage: "onboarding" }),
      entry({ slug: "payment-failed", name: "Payment failed", stage: "dunning", category: "billing" }),
      entry({ slug: "newsletter", name: "Newsletter", kind: "marketing" }),
    ];
    const fetch = api({
      "GET /template-library": list([...entries, ...lifecycle]),
      ...Object.fromEntries([...entries, ...lifecycle].map((item) => [`GET /template-library/${item.slug}`, { ...item, rendered: { html: "<p>Preview</p>" } }])),
    });
    renderAt("/templates/library", [{ path: "/templates/library", element: h(Library) }]);
    await screen.findByRole("article", { name: "Password reset" });
    expect(screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual([
      "Password reset", "Receipt", "Welcome", "Payment failed", "Newsletter",
    ]);
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByLabelText("Stage")).toBeNull();
    expect(calls(fetch, "GET /template-library/automations")).toHaveLength(0);
  });

  it("combines category and search filters and lets an empty result be cleared", async () => {
    const { router } = setup("/templates/library?category=billing&q=receipt");
    await screen.findByRole("article", { name: "Receipt" });
    expect(screen.queryByRole("article", { name: "Password reset" })).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Category" }));
    fireEvent.click(screen.getByRole("option", { name: "Authentication" }));
    expect(await screen.findByText("No templates match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await screen.findByRole("article", { name: "Password reset" });
    expect(screen.getByRole("article", { name: "Receipt" })).toBeTruthy();
    expect(router.state.location.search).toBe("");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "RESET" } });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Receipt" })).toBeNull());
    expect(screen.getByRole("article", { name: "Password reset" })).toBeTruthy();
  });

  it("shows a simple empty page when the library is empty", async () => {
    api({ "GET /template-library": list([]) });
    renderAt("/templates/library", [{ path: "/templates/library", element: h(Library) }]);
    expect(await screen.findByText("No library templates")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("link", { name: "Library" })).toBeNull();
  });

  it("lets viewers browse previews but does not offer installation", async () => {
    signIn("sess_test", ["read"]);
    const { fetch } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Password reset" }));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("Reset your Acme password")).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Add to templates" })).toBeNull();
    expect(calls(fetch, "POST /template-library/password-reset/install")).toHaveLength(0);
  });
});

describe("Library helpers", () => {
  it("reads `rendered`, then an object `preview`", () => {
    expect(renderedOf({ ...entries[0]!, rendered: { html: "a" } })).toEqual({ html: "a" });
    expect(renderedOf({ ...entries[0]!, preview: { html: "b" } })).toEqual({ html: "b" });
    expect(renderedOf({ ...entries[0]!, preview: "a text teaser" })).toBeNull();
    expect(renderedOf(null)).toBeNull();
  });

  it("links only billing and authentication to existing public recipes", () => {
    expect(recipeLinks("billing").map((item) => item.label)).toEqual(["Stripe recipe"]);
    expect(recipeLinks("authentication").map((item) => item.label)).toEqual(["Auth.js recipe", "Better Auth recipe"]);
    expect(recipeLinks("onboarding")).toEqual([]);
  });
});
