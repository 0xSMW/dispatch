// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, h, mockFetch, signIn, wrapper } from "../testing";
import { ChangePassword, passwordError } from "./ChangePassword";

describe("ChangePassword", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("checks the length the API checks", () => {
    expect(passwordError("")).toBeNull();
    expect(passwordError("x".repeat(11))).toMatch(/at least 12/);
    expect(passwordError("x".repeat(12))).toBeNull();
    expect(passwordError("x".repeat(201))).toMatch(/at most 200/);
  });

  it("sends the current and new password to POST /me/password and closes", async () => {
    signIn();
    const fetch = mockFetch(() => ({ body: { object: "user", id: "user_1", email: "ada@example.com" } }));
    const onClose = vi.fn();
    render(h(wrapper, null, h(ChangePassword, { onClose })));
    const submit = screen.getByRole("button", { name: /Change password/ }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "the old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a brand new password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a brand new passwor" } });
    expect(screen.getByText("The passwords do not match.")).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a brand new password" } });
    fireEvent.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const { url, init } = callAt(fetch);
    expect(url).toBe("http://localhost:3100/me/password");
    expect(JSON.parse(String(init.body))).toEqual({ current_password: "the old password", password: "a brand new password" });
  });
});
