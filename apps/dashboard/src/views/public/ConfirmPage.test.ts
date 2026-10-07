// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, h, mockFetch, type Reply } from "../../testing";
import type { Confirmation } from "../../types";
import { ConfirmPage } from "./ConfirmPage";

const page: Confirmation = {
  object: "confirmation", form_name: "Product news", confirmed: false,
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

  describe.each([
    ["#ffffff", "#ff0055", "#ffffff", "#000000"],
    ["#18181b", "#facc15", "#000000", "#ffffff"],
  ])("page text on %s stays independent of button branding", (background, primary, foreground, text) => {
    const branded: Confirmation = {
      ...page,
      brand: { ...page.brand, background_color: background, primary_color: primary, text_color: foreground },
    };

    function expectColors() {
      const root = document.querySelector<HTMLElement>(".publicPage")!;
      const card = document.querySelector<HTMLFormElement>(".publicCard")!;
      expect(root.style.getPropertyValue("--surface")).toBe(background);
      expect(root.style.getPropertyValue("--text")).toBe(text);
      expect(root.style.getPropertyValue("--text-muted")).toBe(text);
      expect(card.style.getPropertyValue("--brand")).toBe(primary);
      expect(card.style.getPropertyValue("--brand-text")).toBe(foreground);
    }

    it("keeps ready, busy and done copy readable without changing deliberate confirmation", async () => {
      let finish!: (reply: Reply) => void;
      const fetch = mockFetch((_url, init) => init.method === "POST"
        ? new Promise<Reply>((resolve) => { finish = resolve; })
        : { body: branded });
      show();
      const button = await screen.findByRole("button", { name: "Confirm" });
      expect(screen.getByText("Acme")).toBeTruthy();
      expect(screen.getByText("Confirm your subscription.")).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(callAt(fetch).init.method).not.toBe("POST");
      expectColors();

      fireEvent.click(button);
      expect(screen.getByRole("status").textContent).toBe("Confirming…");
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expectColors();
      fireEvent.submit(button.closest("form")!);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

      finish({ body: { object: "confirmation", confirmed: true, redirect_url: null } });
      await screen.findByText("Thank you! Your subscription is confirmed.");
      expect(screen.queryByRole("button")).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
      expectColors();
    });

    it("keeps already-confirmed copy readable without posting or redirecting", async () => {
      const assign = navigation();
      const fetch = mockFetch(() => ({ body: { ...branded, confirmed: true } }));
      show();
      await screen.findByText("Thank you! Your subscription is confirmed.");
      expect(screen.queryByRole("button")).toBeNull();
      expectColors();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(callAt(fetch).init.method).not.toBe("POST");
      expect(assign).not.toHaveBeenCalled();
    });
  });

  it("loads branding without a session and never posts on mount or rerender", async () => {
    const fetch = mockFetch(() => ({ body: page }));
    const view = show("/confirm/tok%2Fen?redirect_url=https://untrusted.example", true);
    expect(document.querySelector("[aria-busy=true]")).toBeTruthy();
    await screen.findByRole("button", { name: "Confirm" });
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Product news" })).toBeTruthy();
    expect(callAt(fetch).url).toBe("http://localhost:3100/confirm/tok%2Fen");
    for (const [, init] of fetch.mock.calls) {
      expect(init?.method).not.toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
    }
    expect((document.querySelector(".publicPage") as HTMLElement).style.backgroundColor).toBe("rgb(255, 255, 255)");
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
    const button = await screen.findByRole("button", { name: "Confirm" });
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
    await screen.findByText("Thank you! Your subscription is confirmed.");
    expect(assign).not.toHaveBeenCalled();
    fireEvent.submit(form);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows previously confirmed links without posting or redirecting", async () => {
    const assign = navigation();
    const fetch = mockFetch(() => ({ body: { ...page, confirmed: true } }));
    show();
    await screen.findByText("Thank you! Your subscription is confirmed.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it("handles missing links and GET failures", async () => {
    const fetch = mockFetch(() => ({ status: 404, body: { message: "Unknown link" } }));
    show();
    await screen.findByText("This link is not valid");
    cleanup();
    show("/confirm");
    expect(screen.getByText("This link is not valid")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    cleanup();
    mockFetch(() => ({ status: 500, body: { message: "Try later" } }));
    show();
    await screen.findByText("Something went wrong");
    expect(screen.getByText("Try later Try again in a moment.")).toBeTruthy();
  });

  it("shows confirmation errors inline and permits a deliberate retry", async () => {
    let attempts = 0;
    mockFetch((_url, init) => init.method !== "POST" ? { body: page } : ++attempts === 1
      ? { status: 500, body: { message: "Please retry" } }
      : { body: { object: "confirmation", confirmed: true, redirect_url: null } });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Please retry"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Thank you! Your subscription is confirmed.");
    expect(attempts).toBe(2);
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
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await screen.findByText("Thank you! Your subscription is confirmed.");
    expect(assign.mock.calls).toEqual(allowed ? [[url]] : []);
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
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "Another link" }));
    await screen.findByRole("button", { name: "Confirm" });
    finish({ body: { object: "confirmation", confirmed: true, redirect_url: "https://configured.example/thanks" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByText("Thank you! Your subscription is confirmed.")).toBeNull();
  });
});
