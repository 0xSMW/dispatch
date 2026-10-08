// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, h, mockFetch, type Reply } from "../../testing";
import type { Confirmation } from "../../types";
import { ConfirmPage } from "./ConfirmPage";

const page: Confirmation = {
  object: "confirmation", form_name: "Confirm your subscription", confirmed: false,
  brand: {
    product_name: "Acme", logo_url: null, primary_color: "#ff0055",
    background_color: "#ffffff", text_color: "#18181b",
  },
};

function show(url = "/confirm/tok%2Fen", strict = false) {
  const tree = h(MemoryRouter, { initialEntries: [url] }, h(Routes, null,
    h(Route, { path: "/confirm/:token?", element: h(ConfirmPage) })));
  return render(strict ? h(StrictMode, null, tree) : tree);
}

function navigation() {
  const original = window;
  const assign = vi.fn();
  vi.stubGlobal("window", new Proxy(original, {
    get(target, key) {
      return key === "location"
        ? { origin: original.location.origin, assign }
        : Reflect.get(target, key, target);
    },
  }));
  return assign;
}

describe("ConfirmPage", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("loads branding without a session and never posts on mount or rerender", async () => {
    const fetch = mockFetch(() => ({ body: page }));
    const view = show("/confirm/tok%2Fen?redirect_url=https://untrusted.example", true);
    expect(document.querySelector("[aria-busy=true]")).toBeTruthy();
    await screen.findByRole("button", { name: "Confirm subscription" });
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Confirm your subscription" })).toBeTruthy();
    expect(callAt(fetch).url).toBe("http://localhost:3100/confirm/tok%2Fen");
    for (const [, init] of fetch.mock.calls) {
      expect(init?.method).not.toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
    }
    expect((document.querySelector(".publicPage") as HTMLElement).style.backgroundColor).toBe("");
    const calls = fetch.mock.calls.length;
    view.rerender(h(StrictMode, null, h(MemoryRouter, null, h(Routes, null,
      h(Route, { path: "/confirm/:token?", element: h(ConfirmPage) })))));
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("requires deliberate consent, guards repeated submits while busy, and finishes locally for null", async () => {
    const assign = navigation();
    let finish!: (reply: Reply) => void;
    const fetch = mockFetch((_url, init) => init.method === "POST"
      ? new Promise<Reply>((resolve) => { finish = resolve; })
      : { body: page });
    show("/confirm/token?redirect_url=https://untrusted.example");
    const button = await screen.findByRole("button", { name: "Confirm subscription" });
    const form = button.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Confirming…")).toBeTruthy();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const call = callAt(fetch, -1);
    expect(call.url).toBe("http://localhost:3100/confirm/token");
    expect(new Headers(call.init.headers).get("authorization")).toBeNull();
    finish({ body: { object: "confirmation", confirmed: true, redirect_url: null } });
    await screen.findByText("Your subscription to Acme is confirmed.");
    expect(assign).not.toHaveBeenCalled();
    fireEvent.submit(form);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows previously confirmed links without posting or redirecting", async () => {
    const assign = navigation();
    const fetch = mockFetch(() => ({ body: { ...page, confirmed: true } }));
    show();
    await screen.findByText("Your subscription to Acme is confirmed.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it("handles missing links and GET failures", async () => {
    const fetch = mockFetch(() => ({ status: 404, body: { message: "Unknown link" } }));
    show();
    await screen.findByText("This link is unavailable");
    cleanup();
    show("/confirm");
    expect(screen.getByText("This link is unavailable")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    cleanup();
    mockFetch(() => ({ status: 500, body: { message: "Try later" } }));
    show();
    await screen.findByText("Unable to load confirmation");
    expect(screen.getByText("We couldn't load your confirmation. Please try again.")).toBeTruthy();
  });

  it("shows confirmation errors inline and permits a deliberate retry", async () => {
    let attempts = 0;
    mockFetch((_url, init) => init.method !== "POST" ? { body: page } : ++attempts === 1
      ? { status: 500, body: { message: "Please retry" } }
      : { body: { object: "confirmation", confirmed: true, redirect_url: null } });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm subscription" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("We couldn't confirm your subscription. Please try again."));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Your subscription to Acme is confirmed.");
    expect(attempts).toBe(2);
  });

  it("retries a failed load inside the same card", async () => {
    let attempts = 0;
    mockFetch(() => ++attempts === 1 ? { status: 500, body: {} } : { body: page });
    show();
    const card = document.querySelector(".confirmCard");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Confirm subscription" });
    expect(document.querySelector(".confirmCard")).toBe(card);
  });

  it("treats a link that expires during submission as unavailable", async () => {
    mockFetch((_url, init) => init.method === "POST" ? { status: 404, body: {} } : { body: page });
    show();
    const card = document.querySelector(".confirmCard");
    fireEvent.click(await screen.findByRole("button", { name: "Confirm subscription" }));
    await screen.findByText("This link is unavailable");
    expect(document.querySelector(".confirmCard")).toBe(card);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([
    ["https://configured.example/thanks?source=form", true],
    ["http://configured.example/thanks", false],
    ["https://user:password@configured.example/thanks", false],
    ["https://user@configured.example/thanks", false],
    ["//configured.example/thanks", false],
    ["/thanks", false],
    ["javascript:alert(1)", false],
    ["not a URL", false],
  ])("redirects only for a returned HTTPS credential-free URL: %s", async (url, allowed) => {
    const assign = navigation();
    mockFetch((_url, init) => ({ body: init.method === "POST"
      ? { object: "confirmation", confirmed: true, redirect_url: url } : page }));
    show("/confirm/token?redirect_url=https://untrusted.example");
    fireEvent.click(await screen.findByRole("button", { name: "Confirm subscription" }));
    await screen.findByText("Your subscription to Acme is confirmed.");
    expect(assign).not.toHaveBeenCalled();
    if (allowed) await waitFor(() => expect(assign).toHaveBeenCalledWith(url));
    else expect(assign).not.toHaveBeenCalled();
  });

  it("ignores an old confirmation response after navigating to another token", async () => {
    const assign = navigation();
    let finish!: (reply: Reply) => void;
    const fetch = mockFetch((_url, init) => init.method === "POST"
      ? new Promise<Reply>((resolve) => { finish = resolve; })
      : { body: page });
    function Switch() {
      const navigate = useNavigate();
      return h("button", { onClick: () => navigate("/confirm/new") }, "Another link");
    }
    render(h(MemoryRouter, { initialEntries: ["/confirm/old"] }, h(Switch), h(Routes, null,
      h(Route, { path: "/confirm/:token", element: h(ConfirmPage) }))));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm subscription" }));
    fireEvent.click(screen.getByRole("button", { name: "Another link" }));
    await screen.findByRole("button", { name: "Confirm subscription" });
    finish({ body: { object: "confirmation", confirmed: true, redirect_url: "https://configured.example/thanks" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByText("Your subscription to Acme is confirmed.")).toBeNull();
  });
});
