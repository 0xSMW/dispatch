// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../testing";
import { ConfirmPhrase } from "./ConfirmPhrase";

function setup(onConfirm = vi.fn(async () => undefined)) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    h(ConfirmPhrase, {
      title: "Delete domain",
      body: "Gone for good.",
      phrase: "example.com",
      action: "Delete domain",
      onConfirm,
      onClose,
      onDone,
    }),
  );
  const input = screen.getByLabelText("Confirmation phrase");
  const button = screen.getByRole("button", { name: /Delete domain/ });
  return { input, button, onConfirm, onClose, onDone };
}

describe("ConfirmPhrase", () => {
  afterEach(cleanup);

  it("stays disabled until the typed text matches the phrase exactly", () => {
    const { input, button } = setup();
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "example" } });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "Example.com" } });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "example.com" } });
    expect(button).toHaveProperty("disabled", false);
  });

  it("does not confirm on submit while the phrase does not match", () => {
    const { input, onConfirm } = setup();
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.submit(input.closest("form")!);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms, then calls onDone and onClose", async () => {
    const { input, button, onConfirm, onClose, onDone } = setup();
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows the phrase in a copyable chip", () => {
    setup();
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});
