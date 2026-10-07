import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate, themeContext } from "@dispatchmail/core";
import { describe, expect, it } from "vitest";
import { themePairs } from "../emails/_theme";
import library from "../library.json";
import { checkLibrary } from "./check";

type Entry = (typeof library.templates)[number];

const entry = (slug: string) => structuredClone(library.templates.find((item) => item.slug === slug)!) as Entry;
const failures = (changed: Entry, pairs = themePairs) => checkLibrary({ templates: [changed] }, pairs);

it("accepts the template library", () => {
  expect(checkLibrary(library, themePairs)).toEqual([]);
});

it("matches the committed library.json to a fresh build", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-library-"));
  const out = join(dir, "library.json");
  try {
    execFileSync("pnpm", ["exec", "tsx", "src/build.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, NODE_ENV: "production", LIBRARY_OUT: out },
      stdio: "pipe",
    });
    const committed = readFileSync(fileURLToPath(new URL("../library.json", import.meta.url)), "utf8");
    expect(readFileSync(out, "utf8") === committed, "library.json is stale: run pnpm --filter @dispatchmail/templates build").toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

describe("sample renders", () => {
  it.each(library.templates.map((item) => [item.slug, item] as const))("%s matches its snapshot", (_slug, item) => {
    const brand = {
      PRODUCT_NAME: "Acme",
      PRODUCT_URL: "https://acme.example",
      LOGO_URL: "",
      BRAND_COLOR: "#18181b",
      BRAND_TEXT_COLOR: "#ffffff",
      ...themeContext({ color: "#18181b" }),
      SUPPORT_EMAIL: "support@acme.example",
      SUPPORT_URL: "https://acme.example/support",
      PRIVACY_URL: "https://acme.example/privacy",
      COMPANY_NAME: "Acme, Inc.",
      COMPANY_ADDRESS: "1 Main Street, Springfield",
      CURRENT_YEAR: "2026",
      UNSUBSCRIBE_URL: "https://acme.example/unsubscribe/token",
    };
    const rendered = renderTemplate(
      { subject: item.subject, html: item.html, text: item.text, variables: item.variables },
      item.sample as Record<string, unknown>,
      brand,
    );
    expect({ subject: rendered.subject, text: rendered.text }).toMatchSnapshot();
    expect(rendered.html).not.toContain("{{{");
  });
});

describe("each check can fail", () => {
  it("1: html over the size limit", () => {
    const changed = entry("welcome");
    changed.html += `<!--${"x".repeat(80_000)}-->`;
    expect(failures(changed).some((line) => line.includes("check 1:"))).toBe(true);
  });

  it("2: html tag without lang", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace(/<html[^>]*>/, "<html>");
    expect(failures(changed).some((line) => line.includes("check 2:"))).toBe(true);
  });

  it("3: a table with no presentation role", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace("</body>", "<table><tr><td>x</td></tr></table></body>");
    expect(failures(changed).some((line) => line.includes("check 3:"))).toBe(true);
  });

  it("4: an image with no alt text", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace("</body>", '<img src="https://example.com/a.png"></body>');
    expect(failures(changed).some((line) => line.includes("check 4:"))).toBe(true);
  });

  it("5: a second h1", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace("</body>", "<h1>Again</h1></body>");
    expect(failures(changed).some((line) => line.includes("check 5:"))).toBe(true);
  });

  it("7: no color-scheme meta tag", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace(/<meta name="color-scheme"[^>]*>/, "");
    expect(failures(changed).some((line) => line.includes("check 7:"))).toBe(true);
  });

  it("8: a link color that cannot be read on the dark card", () => {
    const pairs = [...themePairs, { name: "link", light: { foreground: "#18181b", background: "#ffffff" }, dark: { foreground: "#18181b", background: "#18181b" } }];
    expect(failures(entry("welcome"), pairs)).toContain("theme check 8: link dark contrast is 1.00");
  });

  it("9: a required placeholder missing from the text part", () => {
    const changed = entry("password-reset");
    changed.text = changed.text.replaceAll("{{{ACTION_URL}}}", "");
    expect(failures(changed).some((line) => line.includes("check 9:"))).toBe(true);
  });

  it("10: a placeholder nobody declared", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace("</body>", "{{{MYSTERY}}}</body>");
    expect(failures(changed).some((line) => line.includes("check 10: MYSTERY"))).toBe(true);
  });

  it("11 and 12: braces the renderer cannot fill", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace("</body>", "{{{ not a key }}}</body>");
    const found = failures(changed);
    expect(found).toContain("welcome check 11: html still contains {{{");
    expect(found).toContain("welcome check 12: sample html still contains {{{");
  });

  it("6: a preview that is too short", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace(changed.preview, "Hi");
    changed.preview = "Hi";
    expect(failures(changed).some((line) => line.includes("check 6:"))).toBe(true);
  });

  it("13: a script tag", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace("</body>", "<script>1</script></body>");
    expect(failures(changed).some((line) => line.includes("check 13:"))).toBe(true);
  });

  it("14: a link whose address is not printed", () => {
    const changed = entry("welcome");
    changed.html = changed.html.replace("</body>", '<a href="https://hidden.example/x">here</a></body>');
    expect(failures(changed).some((line) => line.includes("check 14:"))).toBe(true);
  });

  it("15: an authentication template with tracking on", () => {
    const changed = entry("welcome");
    changed.track = true;
    expect(failures(changed)).toContain("welcome check 15: an authentication template must set track to false");
  });

  it("16: a marketing template with no unsubscribe link", () => {
    const changed = entry("newsletter");
    changed.html = changed.html.replaceAll("{{{UNSUBSCRIBE_URL}}}", "https://example.com/u");
    expect(failures(changed).some((line) => line.includes("check 16:"))).toBe(true);
  });
});
