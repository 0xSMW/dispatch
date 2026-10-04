// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { framed } from "../../components/EmailFrame";
import { h, signIn } from "../../testing";
import { api, calls, list, renderAt } from "./harness";
import { byCategory, Library, libraryTab, recipeLinks, renderedOf, visibleTemplates, type DiscoveryTemplate } from "./Library";

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

function setup() {
  const fetch = api({
    "GET /template-library": list(entries),
    "GET /template-library/password-reset": { ...entries[0], rendered: { subject: "Reset your Acme password", html: "<p>Reset it here</p>", text: "Reset" } },
    // The older shape, before the rename to `rendered`.
    "GET /template-library/receipt": { ...entries[1], preview: { subject: "Your Acme receipt", html: "<p>Receipt body</p>", text: "Receipt" } },
    "POST /template-library/password-reset/install": { object: "template", id: "tpl_9" },
  });
  renderAt("/templates/library", [{ path: "/templates/library", element: h(Library) }]);
  return fetch;
}

describe("Library", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("groups cards by category with rendered thumbnails", async () => {
    setup();
    const auth = await screen.findByRole("region", { name: "Authentication" });
    expect(within(auth).getByRole("article", { name: "Password reset" })).toBeTruthy();
    expect(within(auth).getByText("Transactional")).toBeTruthy();
    const billing = screen.getByRole("region", { name: "Billing" });
    const card = within(billing).getByRole("article", { name: "Receipt" });
    await waitFor(() => expect(card.querySelector("iframe")?.getAttribute("srcdoc")).toBe(framed("<p>Receipt body</p>")));
  });

  it("previews a template with its variables and installs it", async () => {
    const fetch = setup();
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

    fireEvent.click(within(drawer).getByRole("button", { name: "Use template" }));
    const link = await within(drawer).findByRole("link", { name: "Open template" });
    expect(link.getAttribute("href")).toBe("/templates/tpl_9");
    expect(calls(fetch, "POST /template-library/password-reset/install")).toHaveLength(1);
  });

  it("shows when guidance, shipped recipes and the brand page", async () => {
    setup();
    const card = await screen.findByRole("article", { name: "Password reset" });
    expect(within(card).getByText("Send after a password reset request.")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Auth.js recipe" }).getAttribute("href")).toMatch(/templates\/authjs.md$/);
    expect(within(card).getByRole("link", { name: "Better Auth recipe" }).getAttribute("href")).toMatch(/templates\/better-auth.md$/);
    const receipt = screen.getByRole("article", { name: "Receipt" });
    expect(within(receipt).getByRole("link", { name: "Stripe recipe" }).getAttribute("href")).toMatch(/templates\/stripe.md$/);
    expect(screen.getByRole("link", { name: "Edit brand" }).getAttribute("href")).toBe("/settings/brand");
  });

  it("filters lifecycle emails by stage, including transactional dunning, without requesting presets", async () => {
    const lifecycle = [
      entry({ slug: "welcome", name: "Welcome", stage: "onboarding" }),
      entry({ slug: "payment-failed", name: "Payment failed", stage: "dunning", category: "billing" }),
      entry({ slug: "newsletter", name: "Newsletter", kind: "marketing" }),
    ];
    const fetch = api({
      "GET /template-library": list([...entries, ...lifecycle]),
      ...Object.fromEntries([...entries, ...lifecycle].map((item) => [`GET /template-library/${item.slug}`, { ...item, rendered: { html: "<p>Preview</p>" } }])),
    });
    renderAt("/templates/library?tab=lifecycle", [{ path: "/templates/library", element: h(Library) }]);
    expect(await screen.findByRole("article", { name: "Payment failed" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Password reset" })).toBeNull();
    expect(screen.getByRole("article", { name: "Newsletter" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "dunning" } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("article", { name: "Payment failed" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "retention" } });
    expect(screen.getByText("No matching templates")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Transactional" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByLabelText("Stage")).toBeNull();
    expect(calls(fetch, "GET /template-library/automations")).toHaveLength(0);
  });

  it("lets viewers browse previews but does not offer installation", async () => {
    signIn("sess_test", ["read"]);
    const fetch = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Password reset" }));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("Reset your Acme password")).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Use template" })).toBeNull();
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

  it("keeps manifest order within and across categories", () => {
    const groups = byCategory([entries[0]!, entries[1]!, entry({ slug: "otp", name: "Code" })]);
    expect(groups.map(([category, items]) => [category, items.map((item) => item.slug)])).toEqual([
      ["authentication", ["password-reset", "otp"]],
      ["billing", ["receipt"]],
    ]);
  });

  it("partitions every shipped template exactly once using stage and kind metadata", async () => {
    const { templates } = await import("../../../../../packages/templates/library.json");
    const items = templates as DiscoveryTemplate[];
    const transactional = visibleTemplates(items, "transactional");
    const lifecycle = visibleTemplates(items, "lifecycle");
    expect(transactional.length + lifecycle.length).toBe(items.length);
    expect(new Set([...transactional, ...lifecycle].map((item) => item.slug)).size).toBe(items.length);
    expect(transactional.every((item) => !item.stage && item.kind === "transactional")).toBe(true);
    expect(libraryTab(items.find((item) => item.slug === "payment-failed")!)).toBe("lifecycle");
    expect(visibleTemplates(items, "lifecycle", "dunning").map((item) => item.slug)).toEqual(
      items.filter((item) => item.stage === "dunning").map((item) => item.slug),
    );
    expect(items.every((item) => Boolean(item.when?.trim()))).toBe(true);
  });

  it("links only billing and authentication to existing public recipes", () => {
    expect(recipeLinks("billing").map((item) => item.label)).toEqual(["Stripe recipe"]);
    expect(recipeLinks("authentication").map((item) => item.label)).toEqual(["Auth.js recipe", "Better Auth recipe"]);
    expect(recipeLinks("onboarding")).toEqual([]);
  });
});
