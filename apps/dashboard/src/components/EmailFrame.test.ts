// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { h } from "../testing";
import { EmailFrame, framed, withHead } from "./EmailFrame";

describe("EmailFrame", () => {
  afterEach(cleanup);

  it("renders untrusted HTML only inside a fully sandboxed iframe", () => {
    const html = '<p>Hi</p><script>parent.alert(1)</script>';
    const { container } = render(h(EmailFrame, { html }));
    const frame = container.querySelector("iframe")!;

    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toBe(`<meta name="referrer" content="no-referrer">${html}`);
    expect(frame.getAttribute("title")).toBe("Email preview");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps the doctype first and blocks remote loads for mail from outside", () => {
    expect(withHead("<!doctype html><html><head><title>x</title></head><body></body></html>", "<meta a>")).toBe(
      "<!doctype html><html><head><meta a><title>x</title></head><body></body></html>",
    );
    expect(withHead("<!DOCTYPE html><p>Hi</p>", "<meta a>")).toBe("<!DOCTYPE html><meta a><p>Hi</p>");
    expect(framed("<p>Hi</p>", "block")).toContain("img-src data: cid:;");
    expect(framed("<p>Hi</p>", "block")).not.toContain("https:");
    expect(framed("<p>Hi</p>", "allow")).toContain("img-src data: cid: http: https:;");
    expect(framed("<p>Hi</p>")).not.toContain("Content-Security-Policy");
  });

  it("narrows for the phone preview", () => {
    const { container } = render(h(EmailFrame, { html: "<p>Hi</p>", width: "phone" }));
    expect(container.querySelector("iframe")!.className).toBe("emailFrame phone");
  });
});
