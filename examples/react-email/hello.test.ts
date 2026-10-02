import { createElement } from "react";
import { render } from "react-email";
import { describe, expect, it } from "vitest";
import Hello from "./emails/hello.js";

describe("hello example", () => {
  it("renders the name and the action url", async () => {
    const html = await render(
      createElement(Hello, { name: "Ada", actionUrl: "https://example.com/start" })
    );
    expect(html).toContain("Ada");
    expect(html).toContain("https://example.com/start");
    expect(Hello.Variables.map((variable) => variable.key)).toEqual(["RECIPIENT_NAME", "ACTION_URL"]);
    expect(Hello.Subject).toBe("Welcome, {{{RECIPIENT_NAME}}}");
  });
});
