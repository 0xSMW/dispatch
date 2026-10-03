// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { framed } from "../../components/EmailFrame";
import { h, signIn } from "../../testing";
import type { LibraryTemplate } from "../../types";
import { api, calls, list, renderAt } from "./harness";
import { byCategory, Library, renderedOf } from "./Library";

function entry(fields: Partial<LibraryTemplate>): LibraryTemplate {
  return {
    slug: "password-reset",
    name: "Password reset",
    category: "authentication",
    kind: "transactional",
    track: false,
    subject: "Reset your {{{PRODUCT_NAME}}} password",
    description: "Sent when someone asks to reset their password.",
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
    const billing = screen.getByRole("region", { name: "Billing" });
    const card = within(billing).getByRole("article", { name: "Receipt" });
    await waitFor(() => expect(card.querySelector("iframe")?.getAttribute("srcdoc")).toBe(framed("<p>Receipt body</p>")));
  });

  it("previews a template with its variables and installs it", async () => {
    const fetch = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Password reset" }));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("Reset your Acme password")).toBeTruthy();
    expect(drawer.querySelector("iframe")?.getAttribute("srcdoc")).toBe(framed("<p>Reset it here</p>"));
    expect(within(drawer).getByText("ACTION_URL")).toBeTruthy();
    expect(within(drawer).getByText(/Required/)).toBeTruthy();
    expect(within(drawer).getByText("1 hour")).toBeTruthy();

    fireEvent.click(within(drawer).getByRole("button", { name: "Use template" }));
    const link = await within(drawer).findByRole("link", { name: "Open template" });
    expect(link.getAttribute("href")).toBe("/templates/tpl_9");
    expect(calls(fetch, "POST /template-library/password-reset/install")).toHaveLength(1);
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
});
