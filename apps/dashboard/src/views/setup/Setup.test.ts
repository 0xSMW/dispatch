// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { bodyOf, calls, list, show, stubApi } from "../audience/stub";
import { Setup } from "./Setup";

describe("Setup", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows the three steps with their state and sends a test email", async () => {
    const fetch = stubApi({
      "GET /setup": {
        object: "setup",
        tenant: { id: "tenant_1", name: "Acme" },
        domain: { id: "dom_1", name: "acme.com", status: "verified" },
        api_key: { id: "key_1", name: "Default", prefix: "sk_abc", scope: "full" },
        user: { id: "user_1", email: "ada@acme.com", name: "Ada" },
      },
      "GET /emails": list([]),
      "POST /emails": { id: "email_1" },
    });
    show(h(Setup), "/setup");
    await screen.findByText("acme.com verified");
    expect(calls(fetch)).toEqual(expect.arrayContaining(["GET /setup", "GET /emails?limit=1"]));
    expect(screen.getByText("Verify a domain").closest("li")?.className).toBe("done");
    expect(screen.getByText("Send an email").closest("li")?.className).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Send a test email" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("From") as HTMLInputElement).value).toBe("hello@acme.com");
    expect((within(dialog).getByLabelText("To") as HTMLInputElement).value).toBe("ada@acme.com");
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("POST /emails"));
    expect(bodyOf(fetch, "POST /emails")).toEqual({
      from: "hello@acme.com",
      to: "ada@acme.com",
      subject: "Dispatch test",
      text: "Sent from the Dispatch dashboard.",
    });
  });
});
