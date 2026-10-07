// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blocked, blocks, loss, pick, sameMarkup, stranded, tokens, unsafePaste, unwrap } from "./guard";

describe("tokens", () => {
  it("lists placeholders, fallbacks, and block tags in source order", () => {
    const html = '<p>{{{#if VIP}}}Hi {{{NAME|there}}}{{{/if}}}</p><a href="https://x.test/?a={{{ID}}}&amp;b=1">{{plain}}</a>';
    expect(tokens(html)).toEqual(["{{{#if VIP}}}", "{{{NAME|there}}}", "{{{/if}}}", "{{{ID}}}", "{{plain}}"]);
    expect(blocks(html)).toEqual(["{{{#if VIP}}}", "{{{/if}}}"]);
  });

  it("reads an escaped ampersand in a fallback as the same token", () => {
    expect(tokens('<a href="{{{URL|https://x.test/?a=1&amp;b=2}}}">')).toEqual(tokens("{{{URL|https://x.test/?a=1&b=2}}}"));
  });
  it("does not decode literal entity-looking defaults in text", () => {
    expect(tokens("<p>{{{NAME|&amp; &#39;}}}</p>")).toEqual(["{{{NAME|&amp; &#39;}}}"]);
    expect(loss("<p>{{{NAME|R&D}}}</p>", "<p>{{{NAME|R&amp;D}}}</p>")).toMatch(/change the placeholder/);
  });
});

describe("loss", () => {
  const wrap = (body: string) => `<!doctype html><html><head><style>li::marker{color:#c4c4c4}</style></head><body><table><tr><td>${body}</td></tr></table></body></html>`;

  // This is the check a conversion has to pass: nothing the API fills, and no link or image, is
  // lost. It says nothing about formatting, which is why opening hand-written HTML takes a
  // conversion the user confirms (see Visual.test.ts).
  it("passes when every token, link, and image is kept inside new markup", () => {
    const before = '<p>Hi {{{NAME|there}}}</p><p>{{{#if VIP}}}Gold{{{/if}}}</p><a href="{{{URL}}}">Go</a><img src="{{{LOGO}}}">';
    const after = wrap('<p style="margin:0">Hi {{{NAME|there}}}</p><p>{{{#if VIP}}}Gold{{{/if}}}</p><p><a href="{{{URL}}}" target="_blank">Go</a></p><img src="{{{LOGO}}}" style="display:block">');
    expect(loss(before, after)).toBeNull();
  });

  it("names a placeholder that would be lost", () => {
    expect(loss('<td style="color:{{{BRAND_COLOR}}}">{{{NAME}}}</td>', wrap("<p>{{{NAME}}}</p>"))).toBe(
      "Visual mode would change the placeholder {{{BRAND_COLOR}}}.",
    );
  });

  it("counts repeats, so one of two copies going missing is caught", () => {
    expect(loss("<p>{{{NAME}}} and {{{NAME}}}</p>", wrap("<p>{{{NAME}}}</p>"))).toBe("Visual mode would change the placeholder {{{NAME}}}.");
  });

  it("catches a block tag split across lines", () => {
    expect(loss("<p>{{{#if PRODUCT_URL}}}a{{{/if}}}</p>", wrap("<p>{{{#if\n    PRODUCT_URL}}}a{{{/if}}}</p>"))).toBe(
      "Visual mode would change the placeholder {{{#if PRODUCT_URL}}}.",
    );
  });

  it("reports several lost placeholders by count", () => {
    expect(loss("<p>{{{A}}}{{{B}}}</p>", wrap("<p></p>"))).toBe("Visual mode would change placeholders 2, such as {{{A}}}.");
  });

  it("catches reordered block tags", () => {
    expect(loss("{{{#if A}}}{{{#if B}}}x{{{/if}}}{{{/if}}}", wrap("{{{#if B}}}{{{#if A}}}x{{{/if}}}{{{/if}}}"))).toBe(
      "Visual mode would reorder the block tags.",
    );
  });

  it("catches a dropped link, image, or style block", () => {
    expect(loss('<a href="https://acme.test">Docs</a>', wrap("<p>Docs</p>"))).toBe("Visual mode would drop the link https://acme.test.");
    expect(loss('<img src="https://acme.test/logo.png">', wrap("<p></p>"))).toBe("Visual mode would drop the image https://acme.test/logo.png.");
    expect(loss("<style>p{color:red}</style><p>Hi</p>", wrap("<p>Hi</p>"))).toBe("Visual mode would drop the <style> block.");
  });
});

describe("stranded", () => {
  it("finds a loop tag between list items", () => {
    const html = "<ul>{{{#each ITEMS}}}<li>{{{name}}}</li>{{{/each}}}</ul>";
    expect(stranded(html)).toBe("{{{#each ITEMS}}}");
    expect(blocked(html)).toBe("{{{#each ITEMS}}} sits between list items or table rows, which visual mode cannot keep.");
  });

  it("finds a loop tag between table rows, through a run of tags", () => {
    expect(stranded("<table><tbody><tr><td>Head</td></tr>\n  {{{#each ROWS}}}{{{#if name}}}\n<tr><td>{{{name}}}</td></tr>{{{/if}}}{{{/each}}}</tbody></table>")).toBe(
      "{{{#each ROWS}}}",
    );
    expect(stranded("<table><tr>{{{#if A}}}<td>a</td>{{{/if}}}</tr></table>")).toBe("{{{#if A}}}");
  });

  it("allows block tags inside a cell, a list item, or between paragraphs", () => {
    expect(stranded("<table><tr><td>{{{#if A}}}<p>a</p>{{{/if}}}</td></tr></table>")).toBeNull();
    expect(stranded("<ul><li>{{{#if A}}}a{{{/if}}}</li></ul>")).toBeNull();
    expect(stranded("<p>a</p>{{{#each ITEMS}}}<p>{{{name}}}</p>{{{/each}}}")).toBeNull();
  });
});

describe("pick", () => {
  it("stores the formatted HTML when it keeps every token", () => {
    expect(pick({ html: "<p>\n  {{{#if A}}}a{{{/if}}}\n</p>", unformattedHtml: "<p>{{{#if A}}}a{{{/if}}}</p>" })).toBe("<p>\n  {{{#if A}}}a{{{/if}}}\n</p>");
  });

  it("falls back to the unformatted HTML when the formatter split a tag", () => {
    expect(pick({ html: "<p>{{{#if\n  A}}}a{{{/if}}}</p>", unformattedHtml: "<p>{{{#if A}}}a{{{/if}}}</p>" })).toBe("<p>{{{#if A}}}a{{{/if}}}</p>");
  });

  it("catches a placeholder that moves out of its loop, though every count is the same", () => {
    const before = "<p>{{{#each ITEMS}}}</p><p>{{{name}}}: {{{price}}}</p><p>{{{/each}}}</p>";
    const after = "<p>{{{#each ITEMS}}}{{{/each}}}</p><p>{{{name}}}: {{{price}}}</p>";
    expect(loss(before, after)).toBe("Visual mode would move placeholders in or out of their blocks.");
  });

  it("catches text that comes back as a live placeholder", () => {
    expect(loss("<p>Type &#123;&#123;&#123;NAME&#125;&#125;&#125; here</p>", "<p>Type {{{NAME}}} here</p>")).toBe(
      "Visual mode would turn text into the placeholder {{{NAME}}}.",
    );
  });

  it("finds a loop tag between table rows through a comment, a caption, or a column group", () => {
    const loop = "{{{#each ITEMS}}}<tr><td>{{{name}}}</td></tr>{{{/each}}}";
    expect(stranded(`<table><tbody><!-- items -->${loop}<!-- end --></tbody></table>`)).toBe("{{{#each ITEMS}}}");
    expect(stranded(`<table><caption>Items</caption>${loop}</table>`)).toBe("{{{#each ITEMS}}}");
    expect(stranded(`<table><colgroup><col></colgroup>${loop}</table>`)).toBe("{{{#each ITEMS}}}");
  });

  it("refuses, before the editor loads, HTML that could cover the dashboard or run a link", () => {
    expect(blocked('<div style="position: fixed; top:0">x</div>')).toMatch(/over the page/);
    expect(blocked('<p style="color:red;z-index:9">x</p>')).toMatch(/over the page/);
    expect(blocked('<a href=" JaVaScRiPt:alert(1)">x</a>')).toMatch(/does not open the link/);
    expect(blocked('<a href="&#106;avascript:alert(1)">x</a>')).toMatch(/does not open the link/);
    expect(blocked('<a href="data:text/html,<script>1</script>">x</a>')).toMatch(/does not open the link/);
    expect(blocked('<img src="data:image/png;base64,AAAA">')).toMatch(/image as data/);
    expect(blocked("<p>x</p><script>alert(1)</script>")).toMatch(/script, frame, or form/);
    // The links a real email has are fine.
    for (const href of ["https://acme.test/a?b=1", "http://acme.test", "mailto:{{{SUPPORT_EMAIL}}}", "tel:+15550100", "{{{ACTION_URL}}}", "#top", ""]) {
      expect(blocked(`<p style="color:red;position:relative"><a href="${href}">x</a></p>`), href).toBeNull();
    }
    expect(unsafePaste('<img src="blob:https://x.test/1">')).toBe(true);
    expect(unsafePaste("<p>plain</p>")).toBe(false);
  });
  it("treats inline defaults as literal text without hiding unsafe adjacent markup", () => {
    const raw = `{{{NAME|<script>alert("no")</script><em>R&D &amp;</em>}}}`;
    expect(blocked(`<p>${raw}</p>`)).toBeNull();
    expect(loss(`<p>${raw}</p>`, `<p>${raw}</p>`)).toBeNull();
    expect(blocked(`<p>${raw}</p><script>alert(1)</script>`)).toMatch(/script, frame, or form/);
    expect(blocked(`<p>${raw}</p><a href="java&#x73;cript:alert(1)">x</a>`)).toMatch(/does not open the link/);
    expect(blocked(`<p>${raw}</p><div style="position:fixed">x</div>`)).toMatch(/over the page/);
  });

  it("checks raw clipboard HTML while shielding defaults on the saved-document path", () => {
    for (const markup of [
      '<span style="position:fixed;z-index:99999">Overlay</span>',
      '<a href="javascript:alert(1)">Link</a>',
      '<img src="data:image/png;base64,AAAA">',
      "<script>alert(1)</script>",
    ]) {
      const html = `<p>{{{NAME|${markup}}}}</p>`;
      expect(blocked(html)).toBeNull();
      expect(unsafePaste(html)).toBe(true);
    }
    expect(unsafePaste('<p>R&amp;D &lt;span&gt;literal&lt;/span&gt; &amp;amp;</p>')).toBe(false);
  });

  it("finds the editor's own container, and nothing in hand-written HTML", () => {
    const inner = '<table align="center" role="presentation" style="max-width:600px;width:100%"><tbody><tr><td><p>Hi</p></td></tr></tbody></table>';
    const own = `<html><head></head><body><!--$--><table role="presentation" width="100%"><tbody><tr><td style="font-size:1em">${inner}</td></tr></tbody></table><!--/$--></body></html>`;
    expect(unwrap(own)).toBe(inner);
    expect(unwrap("<p>Hi</p>")).toBeNull();
    expect(unwrap("<table><tbody><tr><td><p>Hi</p></td></tr></tbody></table>")).toBeNull();
    // Extra content beside the container means someone edited it by hand.
    expect(unwrap(own.replace("<!--/$-->", "<p>added</p><!--/$-->"))).toBeNull();
  });

  it("treats the formatter's line breaks as no change, and a changed attribute as one", () => {
    expect(sameMarkup("<p>\n  Hi\n</p>\n<br />", "<p>Hi</p><br/>")).toBe(true);
    expect(sameMarkup('<td width="300">a</td>', "<td>a</td>")).toBe(false);
    expect(sameMarkup('<p style="color:red">a</p>', "<p>a</p>")).toBe(false);
  });
});
