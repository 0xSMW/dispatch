// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, h, mockFetch } from "../../testing";
import { Shared } from "./Shared";

function show(url: string) {
  return render(h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: "/shared", element: h(Shared) }))));
}

describe("Shared", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the email read-only in a sandboxed frame with its facts", async () => {
    const fetch = mockFetch(() => ({
      body: {
        subject: "Your receipt",
        from: "Acme <billing@acme.com>",
        to: ["ada@example.com", "bob@example.com"],
        created_at: "2026-09-30T12:00:00.000Z",
        html: "<p>Thanks</p><script>alert(1)</script>",
        text: "Thanks",
      },
    }));
    show("/shared?token=abc");
    await screen.findByText("Your receipt");
    expect(callAt(fetch).url).toBe("http://localhost:3100/shared/abc");
    expect(new Headers(callAt(fetch).init.headers).get("authorization")).toBeNull();
    expect(screen.getByText("Acme <billing@acme.com>")).toBeTruthy();
    expect(screen.getByText("ada@example.com, bob@example.com")).toBeTruthy();
    const frame = screen.getByTitle("Email preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("<p>Thanks</p>");
    expect(document.querySelector("script")).toBeNull();
  });

  it("falls back to the text body", async () => {
    mockFetch(() => ({
      body: { subject: "Plain", from: "a@b.co", to: [], created_at: "2026-09-30T12:00:00.000Z", html: null, text: "Line one" },
    }));
    show("/shared?token=abc");
    expect((await screen.findByText("Line one")).tagName).toBe("PRE");
  });

  it("says the link expired for an unknown token or none at all", async () => {
    const fetch = mockFetch(() => ({ status: 404, body: { name: "not_found", message: "Email not found" } }));
    show("/shared?token=old");
    await screen.findByText("This link has expired");
    cleanup();
    show("/shared");
    expect(screen.getByText("This link has expired")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
