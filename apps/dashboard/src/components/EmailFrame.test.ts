// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { h } from "../testing";
import { EmailFrame, framed } from "./EmailFrame";

describe("EmailFrame", () => {
  afterEach(cleanup);

  it("renders untrusted HTML only inside a fully sandboxed iframe", () => {
    const html = '<p>Hi</p><script>parent.alert(1)</script>';
    const { container } = render(h(EmailFrame, { html }));
    const frame = container.querySelector("iframe")!;

    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toBe(framed(html));
    expect(frame.getAttribute("title")).toBe("Email preview");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(container.querySelector("script")).toBeNull();
  });

  it.each([
    '<!-- <head> --><img src="https://tracker.example/pixel">',
    '<!-- <head><img src="https://tracker.example/pixel">',
    '<head data-broken="<head>"><img src="https://tracker.example/pixel">',
    '<!doctype html><html><head></head><body><img src="https://tracker.example/pixel"></body></html>',
    '<head></head><head><img src="https://tracker.example/pixel"></head>',
    '<HTML><HeAd><img src="https://tracker.example/pixel"></HeAd></HTML>',
    '<img src="https://tracker.example/pixel"><head>',
    '</body></html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><img src="https://tracker.example/pixel">',
    "<style>/* <head> */ body { background: url(https://tracker.example/css); }</style>",
    '<script>"<head>"</script><img src="https://tracker.example/pixel">',
  ])("parses the trusted policy before hostile document markup: %s", (html) => {
    const source = framed(html, "block");
    const document = new DOMParser().parseFromString(source, "text/html");
    const head = document.head;
    expect(document.doctype?.name).toBe("html");
    expect(head.children).toHaveLength(2);
    expect(head.children[0].getAttribute("name")).toBe("referrer");
    expect(head.children[0].getAttribute("content")).toBe("no-referrer");
    const csp = head.children[1];
    expect(csp.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(csp.getAttribute("content")).toBe(
      "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:",
    );
    // The literal prefix also verifies parser order for speculative resource loading.
    expect(source.indexOf(html)).toBe(
      source.indexOf("</head><body>") + "</head><body>".length,
    );
    expect(source.indexOf("Content-Security-Policy")).toBeLessThan(
      source.indexOf(html),
    );
  });

  it("limits network permissions to images when explicitly allowed", () => {
    const directives = (remote: "block" | "allow") => {
      const document = new DOMParser().parseFromString(
        framed("<p>Hi</p>", remote),
        "text/html",
      );
      const content = document.head
        .querySelector('[http-equiv="Content-Security-Policy"]')!
        .getAttribute("content")!;
      return Object.fromEntries(
        content.split(";").map((part) => {
          const [name, ...sources] = part.trim().split(/\s+/);
          return [name, sources];
        }),
      );
    };
    const blocked = directives("block");
    expect(blocked["default-src"]).toEqual(["'none'"]);
    expect(blocked["img-src"]).toEqual(["data:", "cid:"]);
    expect(blocked["style-src"]).toEqual(["'unsafe-inline'"]);
    expect(blocked["font-src"]).toEqual(["data:"]);
    const allowed = directives("allow");
    expect(allowed).toEqual({
      ...blocked,
      "img-src": ["data:", "cid:", "http:", "https:"],
    });
    expect(framed("<p>Hi</p>")).not.toContain("Content-Security-Policy");
  });

  it("narrows for the phone preview", () => {
    const { container } = render(h(EmailFrame, { html: "<p>Hi</p>", width: "phone" }));
    expect(container.querySelector("iframe")!.className).toBe("emailFrame phone");
  });
});


it("clips thumbnails without relaxing the email sandbox or changing full previews", () => {
  const html = "<p>Preview</p>";
  expect(framed(html, "block", true)).toContain("overflow:hidden!important");
  expect(framed(html, "block", true)).toContain("default-src 'none'");
  expect(framed(html, "block")).not.toContain("overflow:hidden!important");
});
