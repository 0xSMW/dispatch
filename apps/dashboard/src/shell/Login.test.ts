// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, h, mockFetch } from "../testing";
import { Login } from "./Login";
import { SessionProvider, sessionKey } from "./session";

function open() {
  render(
    h(
      MemoryRouter,
      { initialEntries: ["/login"] },
      h(SessionProvider, null, h(Routes, null, h(Route, { path: "/login", element: h(Login) }), h(Route, { path: "/emails", element: h("p", null, "Emails") }))),
    ),
  );
}

describe("Login", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("signs in with email and password and opens the dashboard", async () => {
    const fetch = mockFetch(() => ({
      body: { object: "session", id: "sess_1", token: "sess_secret", user: { email: "ada@example.com", role: "Viewer", permissions: ["read"] } },
    }));
    open();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Emails");
    expect(JSON.parse(String(callAt(fetch).init.body))).toEqual({ email: "ada@example.com", password: "correct horse battery" });
    expect(JSON.parse(sessionStorage.getItem(sessionKey)!).user.permissions).toEqual(["read"]);
  });

  it("shows the API's message for a wrong password", async () => {
    mockFetch(() => ({ status: 401, body: { name: "invalid_credentials", statusCode: 401, message: "Invalid email or password" } }));
    open();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password");
  });

  it("asks for the API URL only when the build does not set one", async () => {
    open();
    expect(screen.getByLabelText("API URL")).toBeTruthy();
    cleanup();
    vi.stubEnv("VITE_API_URL", "http://localhost:3100");
    open();
    await waitFor(() => expect(screen.getByLabelText("Email")).toBeTruthy());
    expect(screen.queryByLabelText("API URL")).toBeNull();
  });
});
