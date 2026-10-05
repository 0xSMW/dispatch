// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageHeader } from "../components/PageHeader";
import { curl, go, llmsLinks, python, referenceFor, sdk } from "../lib/reference";
import { apiUrl, h, signIn } from "../testing";
import { ApiReference } from "./ApiReference";
import { SessionProvider } from "./session";
import { Shell } from "./Shell";

function open(path = "/domains/domain_9") {
  render(h(MemoryRouter, { initialEntries: [path] }, h(ApiReference, { apiUrl, onClose: vi.fn() })));
  return screen.getByRole("dialog");
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("ApiReference", () => {
  it("shows all five tabs and the current page's real resource in every language", () => {
    const drawer = open();
    for (const name of ["cURL", "TypeScript", "Python", "Go", "Agent"]) {
      expect(within(drawer).getByRole("tab", { name })).toBeTruthy();
    }
    const region = () => within(drawer).getByRole("region", { name: "POST /domains/domain_9/verify" });
    expect(region().textContent).toContain(`${apiUrl}/domains/domain_9/verify`);
    fireEvent.click(within(drawer).getByRole("tab", { name: "TypeScript" }));
    expect(region().textContent).toContain('dispatch.domains.verify("domain_9")');
    fireEvent.click(within(drawer).getByRole("tab", { name: "Python" }));
    expect(region().textContent).toContain('client.verify_domain("domain_9")');
    fireEvent.click(within(drawer).getByRole("tab", { name: "Go" }));
    expect(region().textContent).toContain('client.VerifyDomain("domain_9")');
  });

  it("copies the canonical prompt rather than snippets or session credentials", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText }, platform: "MacIntel" });
    const drawer = open("/templates/library");
    fireEvent.click(within(drawer).getByRole("tab", { name: "Agent" }));
    const prompt = referenceFor("/templates/library")!.prompt;
    expect(within(drawer).getByRole("region", { name: "Agent prompt" }).textContent).toContain(prompt);
    expect(within(drawer).queryByRole("region", { name: "GET /template-library" })).toBeNull();
    fireEvent.click(within(drawer).getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(prompt));
    expect(prompt).not.toContain("sess_test");
    expect(prompt).toContain("Newsletter welcome requires a live tenant topic at installation");
  });

  it("shows an explicit cURL fallback when a flat SDK cannot render the draft", () => {
    const drawer = open("/templates/tpl_9/editor");
    for (const name of ["Python", "Go"]) {
      fireEvent.click(within(drawer).getByRole("tab", { name }));
      const region = within(drawer).getByRole("region", { name: "POST /templates/tpl_9/render" });
      expect(region.textContent).toContain(`The ${name} SDK does not support this call with these options yet. Use cURL.`);
      expect(region.textContent).toContain('"draft":true');
      expect(region.textContent).not.toContain("client.RenderTemplate");
      expect(region.textContent).not.toContain("client.render_template");
    }
  });

  it("links only generated public llms outputs and preserves safe external-link attributes", () => {
    const drawer = open();
    const links = llmsLinks();
    if (!links.length) expect(within(drawer).queryByRole("navigation", { name: "Agent documentation" })).toBeNull();
    for (const link of links) {
      const target = within(drawer).getByRole("link", { name: link.label });
      expect(target.getAttribute("href")).toBe(link.href);
      expect(target.getAttribute("rel")).toBe("noopener noreferrer");
      expect(target.getAttribute("target")).toBe("_blank");
    }
  });

  it("keeps the unknown-page empty state", () => {
    const drawer = open("/unknown");
    expect(within(drawer).getByText("No API calls are listed for this page.")).toBeTruthy();
    expect(within(drawer).queryByRole("tablist")).toBeNull();
  });

  it.each([["full"], ["read"]])("opens and copies all five Forms tabs from the header and A with permissions %j", async (permission) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText }, platform: "MacIntel" });
    vi.stubGlobal("fetch", fetch);
    signIn("sess_reference_test", [permission]);
    render(h(MemoryRouter, { initialEntries: ["/audience/forms"] },
      h(SessionProvider, null,
        h(Routes, null, h(Route, { element: h(Shell) },
          h(Route, { path: "*", element: h("div", null,
            h(PageHeader, { title: "Signup forms" }),
            h("input", { "aria-label": "Page field" }),
          ) }),
        )),
      ),
    ));
    fireEvent.keyDown(screen.getByLabelText("Page field"), { key: "a" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "API" }));
    let drawer = screen.getByRole("dialog", { name: "Signup forms" });
    const reference = referenceFor("/audience/forms")!;
    const create = reference.calls.find(call => call.method === "POST")!;
    for (const [name, snippet] of [
      ["cURL", curl(create, apiUrl)], ["TypeScript", sdk(create, apiUrl)],
      ["Python", python(create, apiUrl)], ["Go", go(create, apiUrl)],
    ]) {
      fireEvent.click(within(drawer).getByRole("tab", { name: name! }));
      const region = within(drawer).getByRole("region", { name: "POST /forms" });
      expect(region.querySelector("code")!.textContent).toBe(snippet);
      writeText.mockClear();
      fireEvent.click(within(region).getByRole("button", { name: /^(Copy code|Copied)$/ }));
      await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(snippet));
    }
    fireEvent.click(within(drawer).getByRole("tab", { name: "Agent" }));
    writeText.mockClear();
    fireEvent.click(within(drawer).getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(reference.prompt));
    expect(writeText.mock.calls[0]![0]).not.toContain("sess_reference_test");
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document.body, { key: "a" });
    drawer = screen.getByRole("dialog", { name: "Signup forms" });
    expect(within(drawer).getByRole("tab", { name: "cURL" }).getAttribute("aria-selected")).toBe("true");
  });
});
