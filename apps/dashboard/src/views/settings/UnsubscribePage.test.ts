// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { bodyOf, calls, list, show, stubApi } from "../audience/stub";
import { UnsubscribePage } from "./UnsubscribePage";

describe("UnsubscribePage", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("previews the preference page with the brand and public topics", async () => {
    const fetch = stubApi({
      "GET /brand": { object: "brand", product_name: "Acme", logo_url: "https://acme.com/logo.png", color: "#123456", text_color: "#ffffff" },
      "GET /topics": list([
        { id: "t1", name: "News", description: "Monthly.", visibility: "public", default_subscription: "opt_out" },
        { id: "t2", name: "Staff", description: null, visibility: "private", default_subscription: "opt_in" },
      ]),
    });
    show(h(UnsubscribePage), "/settings/unsubscribe-page");
    const preview = screen.getByRole("complementary", { name: "Preference page preview" });
    expect(await within(preview).findByRole("img", { name: "Acme" })).toBeTruthy();
    expect(calls(fetch)).toEqual(expect.arrayContaining(["GET /brand", "GET /topics?limit=100"]));
    expect(within(preview).getByText("News")).toBeTruthy();
    expect(within(preview).queryByText("Staff")).toBeNull();
    expect((within(preview).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(within(preview).getByRole("heading", { level: 2, name: "Do you want to unsubscribe?" })).toBeTruthy();
  });

  it("saves a custom title and description, previews them as typed, and clears one with null", async () => {
    const fetch = stubApi({
      "GET /brand": { object: "brand", product_name: "Acme", color: "#123456", text_color: "#ffffff", unsubscribe_title: "Leaving so soon?" },
      "GET /topics": list([{ id: "t1", name: "News", description: null, visibility: "public", default_subscription: "opt_in" }]),
      "PATCH /brand": { object: "brand", product_name: "Acme", color: "#123456", text_color: "#ffffff", unsubscribe_description: "Pick what you want." },
    });
    show(h(UnsubscribePage), "/settings/unsubscribe-page");
    const preview = screen.getByRole("complementary", { name: "Preference page preview" });
    expect(await within(preview).findByRole("heading", { level: 2, name: "Leaving so soon?" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Pick what you want." } });
    expect(within(preview).getByText("Pick what you want.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } });
    // An empty title shows the default again.
    expect(within(preview).getByRole("heading", { level: 2, name: "Do you want to unsubscribe?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(bodyOf(fetch, "PATCH /brand")).toEqual({ unsubscribe_title: null, unsubscribe_description: "Pick what you want." }));
  });
});
