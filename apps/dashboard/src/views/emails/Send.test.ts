// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { Send } from "./Send";
import { api, requests, visit } from "./visit";

describe("Send", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("starts empty and posts the form to POST /emails", async () => {
    const fetch = api({ "POST /emails": { id: "email_9" } });
    visit(h(Send), "/emails/send");

    const from = screen.getAllByLabelText("From")[0] as HTMLInputElement;
    expect(from.value).toBe("");
    fireEvent.change(from, { target: { value: "Acme <hello@acme.test>" } });
    fireEvent.change(screen.getAllByLabelText("To")[0], { target: { value: "ada@example.com, bob@example.com" } });
    fireEvent.change(screen.getAllByLabelText("Subject")[0], { target: { value: "Test" } });
    fireEvent.change(screen.getAllByLabelText("Text")[0], { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));

    await waitFor(() => expect(requests(fetch, "POST", "/emails")).toHaveLength(1));
    expect(requests(fetch, "POST", "/emails")[0].body).toEqual({
      from: "Acme <hello@acme.test>",
      to: ["ada@example.com", "bob@example.com"],
      subject: "Test",
      text: "Hello",
    });
    expect((await screen.findByRole("link", { name: "email_9" })).getAttribute("href")).toBe("/emails/email_9");
  });
});
