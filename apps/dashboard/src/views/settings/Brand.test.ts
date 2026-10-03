// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { framed } from "../../components/EmailFrame";
import { h } from "../../testing";
import { bodyOf, calls, list, show, stubApi } from "../audience/stub";
import { Brand, brandErrors, brandPatch } from "./Brand";

const saved = {
  object: "brand",
  product_name: "Acme",
  logo_url: "https://acme.com/logo.png",
  color: "#1f7a4d",
  support_email: "help@acme.com",
  text_color: "#ffffff",
};

function api() {
  return stubApi({
    "GET /brand": saved,
    "PATCH /brand": (_url: URL, init: RequestInit) => ({ ...saved, ...JSON.parse(String(init.body)), text_color: "#000000" }),
    "GET /template-library": list([{ slug: "receipt", name: "Receipt" }, { slug: "welcome", name: "Welcome" }]),
    "GET /template-library/welcome": { slug: "welcome", name: "Welcome", rendered: { subject: "Hi", html: "<p>Welcome to Acme</p>", text: "" } },
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
});
