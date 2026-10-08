// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { templates } from "../../../../../packages/templates/library.json";
import { framed } from "../../components/EmailFrame";
import { h } from "../../testing";
import { coverOf, excerpt } from "./cover";
import { Preview, Thumb } from "./editor";
import { brandValues, fill, normalizeVariables } from "./render";

afterEach(cleanup);

function libraryHtml(slug: string) {
  const template = templates.find((item) => item.slug === slug)!;
  return fill({ html: template.preview_html }, {
    ...brandValues({ object: "brand", product_name: "Acme", product_url: "https://acme.test", support_url: "https://acme.test/support" }),
    ...template.sample,
  }, normalizeVariables(template.variables)).html;
}

describe("email covers", () => {
  it("extracts the actual brand, heading, lead and action from library HTML", () => {
    const cover = coverOf(libraryHtml("password-reset"));
    expect(cover?.brand).toBe("Acme");
    expect(cover?.heading).toBe("Reset your password");
    expect(cover?.lead).toBe("Hi Ada, use this link to reset your Acme password.");
    expect(cover?.action).toBe("Reset password");
    expect(cover?.lead).not.toContain("Choose a new password");
    const { container } = render(h(Thumb, { html: libraryHtml("password-reset") }));
    expect(container.textContent).not.toContain("Support");
  });

  it("uses a sign-in code or billing rows when those distinguish the email", () => {
    const code = render(h(Thumb, { html: libraryHtml("one-time-code") }));
    expect(code.container.querySelector(".thumbCode")?.textContent).toBe("482913");
    code.unmount();
    const receipt = render(h(Thumb, { html: libraryHtml("receipt") }));
    expect(receipt.container.querySelectorAll(".thumbDetails > div")).toHaveLength(2);
    expect(receipt.container.querySelector(".thumbHeading")?.textContent).toBe("Receipt");
    expect(receipt.container.querySelector("iframe")).toBeNull();
  });

  it("handles every shipped template with meaningful copy", () => {
    for (const template of templates) {
      const cover = coverOf(libraryHtml(template.slug));
      expect(cover?.brand, template.slug).toBe("Acme");
      expect(cover?.heading, template.slug).toBeTruthy();
      expect(cover?.lead, template.slug).toBeTruthy();
      expect(cover?.heading, template.slug).not.toContain("{{{");
      expect(cover?.lead, template.slug).not.toContain("{{{");
    }
  });

  it("renders copy as text and never mounts email markup or external assets", () => {
    const html = `<style>body{background:red}</style><script>window.injected = true</script>
      <div style="display:none">Hidden preview</div><p hidden>Hidden footer</p>
      <img src="https://tracking.test/pixel" alt="Acme" onerror="alert(1)">
      <h1>&lt;img src=x onerror=alert(1)&gt;</h1><p>Hello &amp; welcome</p>
      <a class="dm-button" href="javascript:alert(1)">Start &lt;script&gt;</a>
      <iframe src="https://tracking.test"></iframe>`;
    const { container } = render(h(Thumb, { html }));
    expect(container.querySelectorAll("iframe, script, style, img, a")).toHaveLength(0);
    expect(container.querySelector(".thumbHeading")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(container.querySelector(".thumbLead")?.textContent).toBe("Hello & welcome");
    expect(container.querySelector(".thumbAction")?.textContent).toBe("Start <script>");
    expect(container.textContent).not.toContain("Hidden");
  });

  it("handles plain and empty email bodies, and distinguishes loading", () => {
    expect(coverOf("<p>First paragraph</p><p>Second paragraph</p>")).toMatchObject({ heading: "First paragraph", lead: "Second paragraph" });
    expect(coverOf("Just plain text")).toMatchObject({ heading: "Just plain text" });
    expect(coverOf("<style>p{color:red}</style>")).toBeNull();
    const { container, rerender } = render(h(Thumb, { html: undefined }));
    expect(container.querySelector(".thumbLoading")).toBeTruthy();
    rerender(h(Thumb, { html: null }));
    expect(container.querySelector(".thumbEmpty")?.textContent).toBe("No content");
  });

  it("bounds long tenant copy without cutting words when possible", () => {
    expect(excerpt("Reset your account password now", 20)).toBe("Reset your account…");
    const { container } = render(h(Thumb, { html: `<p>${"Brand".repeat(30)}</p><h1>${"Heading ".repeat(100)}</h1><p>${"Lead ".repeat(100)}</p><a class="dm-button">${"Action ".repeat(100)}</a>` }));
    expect(container.querySelector(".thumbBrand")!.textContent!.length).toBeLessThanOrEqual(32);
    expect(container.querySelector(".thumbHeading")!.textContent!.length).toBeLessThanOrEqual(62);
    expect(container.querySelector(".thumbLead")!.textContent!.length).toBeLessThanOrEqual(106);
    expect(container.querySelector(".thumbAction")!.textContent!.length).toBeLessThanOrEqual(32);
  });

  it("keeps the full preview sandboxed and preserves the original email", () => {
    const html = libraryHtml("newsletter");
    const { container } = render(h(Preview, { html }));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("srcdoc")).toBe(framed(html));
    expect(frame.getAttribute("sandbox")).toBe("");
  });
});
