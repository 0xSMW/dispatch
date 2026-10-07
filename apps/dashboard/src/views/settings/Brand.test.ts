// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { themeDefaults } from "@dispatchmail/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { framed } from "../../components/EmailFrame";
import { h, signIn, wrapper } from "../../testing";
import { bodyOf, calls, list, show, stubApi } from "../audience/stub";
import { Brand, brandErrors, brandPatch } from "./Brand";

const saved = {
  object: "brand",
  product_name: "Acme",
  logo_url: "https://acme.com/logo.png",
  color: "#1f7a4d",
  support_email: "help@acme.com",
  ...themeDefaults,
  button_text_color: "#ffffff",
  unsubscribe_title: "Keep in touch",
};

function api(overrides = {}) {
  return stubApi({
    "GET /brand": saved,
    "PATCH /brand": (_url: URL, init: RequestInit) => ({ ...saved, ...JSON.parse(String(init.body)), button_text_color: "#000000" }),
    "POST /brand/update-library": {
      updated: [{ id: "tpl_welcome", name: "Welcome", slug: "welcome" }],
      skipped: [{ id: "tpl_receipt", name: "Receipt", slug: "receipt", reason: "Latest version has been edited." }, { id: "tpl_reset", name: "Reset password", slug: "password-reset" }],
    },
    "GET /template-library": list([{ slug: "receipt", name: "Receipt" }, { slug: "welcome", name: "Welcome" }]),
    "GET /template-library/welcome": { slug: "welcome", name: "Welcome", rendered: { subject: "Hi", html: "<p>Welcome to Acme</p>", text: "" } },
    ...overrides,
  });
}

describe("Brand", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("loads the brand and previews the welcome template", async () => {
    const fetch = api();
    show(h(Brand), "/settings/brand");
    expect(((await screen.findByLabelText("Product name")) as HTMLInputElement).value).toBe("Acme");
    expect((screen.getByLabelText("Brand color") as HTMLInputElement).value).toBe("#1f7a4d");
    await waitFor(() => expect(calls(fetch)).toContain("GET /template-library/welcome"));
    const frame = await screen.findByTitle("Email preview");
    expect(frame.getAttribute("srcdoc")).toBe(framed("<p>Welcome to Acme</p>"));
    expect(screen.getByText(/Text on this color is white/)).toBeTruthy();
  });

  it("sends only changed fields, clears the logo with null, and refreshes the preview", async () => {
    const fetch = api();
    show(h(Brand), "/settings/brand");
    await screen.findByLabelText("Product name");
    fireEvent.change(screen.getByLabelText("Brand color"), { target: { value: "#facc15" } });
    expect(screen.getByText(/Text on this color is black/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Logo URL"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls(fetch)).toContain("PATCH /brand"));
    expect(bodyOf(fetch, "PATCH /brand")).toEqual({ color: "#facc15", logo_url: null, company_name: "Acme Inc." });
    await waitFor(() => expect(calls(fetch).filter((call) => call === "GET /template-library/welcome")).toHaveLength(2));
  });

  it("blocks saving invalid values", async () => {
    api();
    show(h(Brand), "/settings/brand");
    await screen.findByLabelText("Product name");
    fireEvent.change(screen.getByLabelText("Product URL"), { target: { value: "http://acme.com" } });
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "" } });
    expect(screen.getByText("Use an https:// URL.")).toBeTruthy();
    expect(screen.getByText("This cannot be cleared once set.")).toBeTruthy();
    const form = screen.getByLabelText("Product name").closest("form")!;
    expect(within(form).getByRole("button", { name: /^Save/ })).toHaveProperty("disabled", true);
  });

  it("previews non-default draft tokens locally and sends numeric tokens in the patch", async () => {
    const fetch = api();
    show(h(Brand), "/settings/brand");
    await screen.findByLabelText("Product name");
    await screen.findByTitle("Email preview");
    for (const [label, value] of [
      ["Text color", "#123456"], ["Background color", "#e0eeee"], ["Surface color", "#fafafa"],
      ["Border color", "#aabbcc"], ["Font size", "18"], ["Radius", "0"],
      ["Font family", "Georgia, 'Times New Roman', serif"], ["Button style", "outline"],
    ]) fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    const preview = screen.getByLabelText("Live email preview");
    expect(preview.style.background).toBe("rgb(224, 238, 238)");
    expect(preview.style.color).toBe("rgb(18, 52, 86)");
    expect(preview.style.fontFamily).toContain("Georgia");
    expect(preview.style.fontSize).toBe("18px");
    const card = within(preview).getByRole("heading", { name: "Welcome aboard" }).parentElement!;
    expect(card.style.borderRadius).toBe("0px");
    expect(card.style.border).toBe("1px solid rgb(170, 187, 204)");
    expect(card.style.background).toBe("rgb(250, 250, 250)");
    expect(within(preview).getByText("Get started").style.color).toBe("rgb(31, 122, 77)");
    expect(within(preview).getByText("Get started").style.background).toBe("rgb(250, 250, 250)");
    expect(calls(fetch).filter((call) => call === "GET /template-library/welcome")).toHaveLength(1);
    expect(calls(fetch)).not.toContain("POST /brand/update-library");
    expect(screen.getByRole("button", { name: "Update library templates" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls(fetch)).toContain("PATCH /brand"));
    expect(bodyOf(fetch, "PATCH /brand")).toEqual({
      text_color: "#123456", background_color: "#e0eeee", surface_color: "#fafafa", border_color: "#aabbcc",
      font_size: 18, radius: 0, font_family: "Georgia, 'Times New Roman', serif", button_style: "outline",
    });
    await waitFor(() => expect(calls(fetch).filter((call) => call === "GET /template-library/welcome")).toHaveLength(2));
    expect(calls(fetch)).not.toContain("POST /brand/update-library");
  });

  it("refuses poor body and outline contrast, out-of-range numbers, and unsafe preview values", async () => {
    const fetch = api();
    show(h(Brand), "/settings/brand");
    await screen.findByLabelText("Product name");
    fireEvent.change(screen.getByLabelText("Text color"), { target: { value: "#eeeeee" } });
    expect(screen.getByText(/Text must reach 4.5:1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Save/ })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Text color"), { target: { value: saved.text_color } });
    fireEvent.change(screen.getByLabelText("Brand color"), { target: { value: "#facc15" } });
    fireEvent.change(screen.getByLabelText("Button style"), { target: { value: "outline" } });
    expect(screen.getByText(/Button text must reach 4.5:1/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Button style"), { target: { value: "filled" } });
    fireEvent.change(screen.getByLabelText("Font size"), { target: { value: "19" } });
    fireEvent.change(screen.getByLabelText("Radius"), { target: { value: "17" } });
    fireEvent.change(screen.getByLabelText("Surface color"), { target: { value: "url(https://evil.example)" } });
    expect(screen.getByLabelText("Font size").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Radius").getAttribute("aria-invalid")).toBe("true");
    const preview = screen.getByLabelText("Live email preview");
    expect(preview.style.fontSize).toBe("16px");
    expect(preview.innerHTML).not.toContain("evil.example");
    fireEvent.submit(screen.getByLabelText("Product name").closest("form")!);
    expect(calls(fetch)).not.toContain("PATCH /brand");
    expect(screen.getByRole("button", { name: "Update library templates" })).toHaveProperty("disabled", true);
  });

  it("updates installed templates only on explicit action and lists skipped reasons", async () => {
    const fetch = api();
    show(h(Brand), "/settings/brand");
    await screen.findByLabelText("Product name");
    await screen.findByTitle("Email preview");
    expect(calls(fetch)).not.toContain("POST /brand/update-library");
    fireEvent.click(screen.getByRole("button", { name: "Update library templates" }));
    expect(await screen.findByText("1 templates updated; 2 skipped.")).toBeTruthy();
    const skipped = screen.getByRole("list", { name: "Skipped templates" });
    expect(within(skipped).getByText("Receipt (receipt): Latest version has been edited.")).toBeTruthy();
    expect(within(skipped).getByText("Reset password (password-reset): Not eligible for a library update.")).toBeTruthy();
    await waitFor(() => expect(calls(fetch).filter((call) => call === "GET /template-library/welcome")).toHaveLength(2));
    expect(calls(fetch)).not.toContain("PATCH /brand");
  });

  it("lets viewers inspect tokens and both previews without write actions", async () => {
    const fetch = api();
    signIn("sess_viewer", ["read"]);
    render(h(Brand), { wrapper });
    await screen.findByLabelText("Product name");
    await screen.findByTitle("Email preview");
    expect(screen.getByLabelText("Text color").closest("fieldset")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Font family").closest("fieldset")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Live email preview")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update library templates" })).toBeNull();
    fireEvent.submit(screen.getByLabelText("Product name").closest("form")!);
    expect(calls(fetch).some((call) => call.startsWith("PATCH ") || call.startsWith("POST "))).toBe(false);
  });
});

describe("brandPatch and brandErrors", () => {
  const empty = {
    product_name: "",
    product_url: "",
    logo_url: "",
    color: "",
    support_email: "",
    support_url: "",
    privacy_url: "",
    company_name: "",
    company_address: "",
  };

  it("skips unchanged and empty non-nullable fields", () => {
    expect(brandPatch({ ...empty, support_url: "", company_address: " 1 Main St " }, { ...empty, support_url: "https://x.co" })).toEqual({
      support_url: null,
      company_address: "1 Main St",
    });
  });

  it("clears the privacy link with null and wants https for it", () => {
    expect(brandPatch({ ...empty, privacy_url: "" }, { ...empty, privacy_url: "https://x.co/privacy" })).toEqual({ privacy_url: null });
    expect(brandErrors({ ...empty, privacy_url: "http://x.co/privacy" }, empty)).toEqual({ privacy_url: "Use an https:// URL." });
  });

  it("checks colors and emails", () => {
    expect(brandErrors({ ...empty, color: "#fff", support_email: "nope" }, empty)).toEqual({
      color: "Use a six-digit hex color, such as #1f7a4d.",
      support_email: "Enter an email address.",
    });
  });

  it("validates shared schema limits, allowed fonts, and both body surfaces", () => {
    for (const values of [{ font_size: "13" }, { font_size: "16.5" }, { radius: "-1" }, { font_family: "Comic Sans" }, { button_style: "gradient" }, { product_name: "x".repeat(121) }]) {
      expect(Object.keys(brandErrors({ ...empty, ...values }, empty))).not.toHaveLength(0);
    }
    expect(brandErrors({ ...empty, text_color: "#18181b", surface_color: "#18181b" }, empty).theme).toMatch(/4.5:1/);
    expect(brandErrors({ ...empty, text_color: "#18181b", background_color: "#18181b" }, empty).theme).toMatch(/4.5:1/);
    expect(brandErrors({ ...empty, text_color: "#ffffff", background_color: "#18181b", surface_color: "#18181b" }, empty)).toEqual({});
    expect(brandErrors({ ...empty, text_color: "#18181b", color: "#facc15", button_style: "outline" }, empty).theme).toMatch(/Button text/);
    expect(brandPatch({ ...empty, radius: "0", font_size: "18" }, { ...empty, radius: "8", font_size: "16" })).toEqual({ radius: 0, font_size: 18 });
  });
});
