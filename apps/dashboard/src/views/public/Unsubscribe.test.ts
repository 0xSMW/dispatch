// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, h, mockFetch } from "../../testing";
import type { Preferences } from "../../types";
import { previewBrand, textColor } from "./Preferences";
import { Unsubscribe } from "./Unsubscribe";

const page: Preferences = {
  object: "unsubscribe",
  email: "ada@example.com",
  unsubscribed: false,
  topics: [
    {
      id: "topic_news",
      name: "Product news",
      description: "Launches and updates.",
      subscription: "opt_in",
    },
    {
      id: "topic_tips",
      name: "Tips",
      description: null,
      subscription: "opt_out",
    },
  ],
  brand: {
    product_name: "Acme",
    logo_url: null,
    color: "#ff0055",
    text_color: "#ffffff",
  },
};

function show(url = "/unsubscribe?token=tok%2Fen") {
  return render(
    h(
      MemoryRouter,
      { initialEntries: [url] },
      h(
        Routes,
        null,
        h(Route, { path: "/unsubscribe", element: h(Unsubscribe) }),
      ),
    ),
  );
}

describe("Unsubscribe", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("loads the preferences for the token without a session and shows brand, address, and topics", async () => {
    const fetch = mockFetch(() => ({ body: page }));
    show();
    await screen.findByText("Email preferences");
    expect(screen.getByRole("heading", { name: "Email preferences" }).closest(".preferencePage")).toBeTruthy();
    expect(callAt(fetch).url).toBe(
      "http://localhost:3100/unsubscribe/tok%2Fen",
    );
    expect(
      new Headers(callAt(fetch).init.headers).get("authorization"),
    ).toBeNull();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Launches and updates.")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
  });

  it("saves per-topic choices", async () => {
    const fetch = mockFetch(() => ({ body: page }));
    show();
    await screen.findByText("Product news");
    fireEvent.click(screen.getByLabelText(/Tips/));
    fireEvent.click(screen.getByLabelText(/Product news/));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await screen.findByText("Your email preferences were updated.");
    const call = callAt(fetch, -1);
    expect(call.url).toBe("http://localhost:3100/unsubscribe/tok%2Fen");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({
      topics: [
        { id: "topic_news", subscription: "opt_out" },
        { id: "topic_tips", subscription: "opt_in" },
      ],
    });
  });

  it("unsubscribes from everything in one click", async () => {
    const fetch = mockFetch((_url, init) => ({
      body: init.method === "POST" ? { ...page, unsubscribed: true } : page,
    }));
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Unsubscribe from all" }),
    );
    await screen.findByText("You have been unsubscribed.");
    expect(JSON.parse(String(callAt(fetch, -1).init.body))).toEqual({
      unsubscribe_all: true,
    });
  });

  it("shows a plain state for a missing or unknown token", async () => {
    const fetch = mockFetch(() => ({
      status: 404,
      body: { name: "not_found", message: "Unsubscribe link not found" },
    }));
    show();
    await screen.findByText("This link is not valid");
    expect(screen.getByRole("heading", { name: "This link is not valid" }).closest(".preferencePage")).toBeTruthy();
    cleanup();
    show("/unsubscribe");
    expect(screen.getByText("This link is not valid")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shows an error inline when saving fails", async () => {
    mockFetch((_url, init) =>
      init.method === "POST"
        ? {
            status: 404,
            body: { name: "not_found", message: "Topic not found" },
          }
        : { body: page },
    );
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Save preferences" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Topic not found"),
    );
  });
});

describe("textColor", () => {
  it("picks the text color with more contrast, like the API", () => {
    expect(textColor("#000000")).toBe("#ffffff");
    expect(textColor("#ffffff")).toBe("#000000");
    expect(textColor("#18181b")).toBe("#ffffff");
    expect(textColor("#facc15")).toBe("#000000");
  });
});

describe("previewBrand", () => {
  it("uses button contrast rather than the email body color", () => {
    expect(
      previewBrand({ color: "#18181b", text_color: "#18181b" }).text_color,
    ).toBe("#ffffff");
    expect(
      previewBrand({ color: "#ffffff", text_color: "#ffffff" }).text_color,
    ).toBe("#000000");
    expect(
      previewBrand({ color: "#18181b", button_text_color: "#eeeeee" })
        .text_color,
    ).toBe("#ffffff");
  });
});
