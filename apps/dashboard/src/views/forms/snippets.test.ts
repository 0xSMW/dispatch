// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { formSnippets } from "./snippets";

describe("formSnippets", () => {
  it("uses the API prefix and encodes exactly one key segment in both examples", () => {
    const snippets = formSnippets({
      publicUrl: "https://api.example.com/v1///?ignore=yes#ignored",
      key: "signup /?&\"'()!*",
      properties: [],
    });
    const endpoint = "https://api.example.com/v1/forms/signup%20%2F%3F%26%22%27%28%29%21%2A";
    const doc = new DOMParser().parseFromString(snippets.html, "text/html");
    expect(doc.querySelector("form")?.getAttribute("action")).toBe(endpoint);
    expect(doc.querySelector("form")?.getAttribute("method")).toBe("post");
    expect(snippets.fetch).toContain(`fetch("${endpoint}"`);
    expect(snippets.fetch).toContain('credentials: "omit"');
    expect(snippets.fetch).not.toMatch(/authorization|Bearer|sess_/i);
  });

  it("escapes HTML labels and attribute values, deduplicates fields, and supplies an empty honeypot", () => {
    const property = 'company"><script>alert("x")</script>&\'';
    const snippets = formSnippets({ publicUrl: "https://api.example.com", key: "key", properties: [property, property] });
    const doc = new DOMParser().parseFromString(snippets.html, "text/html");
    expect(doc.querySelectorAll("script")).toHaveLength(0);
    const inputs = [...doc.querySelectorAll("input")];
    expect(inputs.map((input) => input.name)).toEqual(["email", "first_name", "last_name", `properties.${property}`, "website"]);
    expect(inputs.find((input) => input.name === "website")?.value).toBe("");
    expect(inputs.find((input) => input.name === "website")?.tabIndex).toBe(-1);
    expect(doc.querySelector("[hidden]")).toBeTruthy();
    expect(doc.querySelector('input[name="email"]')?.hasAttribute("required")).toBe(true);
    expect(snippets.fetch).not.toContain("<script>");
  });

  it("runs the fetch example with nested, allowlisted properties and no credentials", async () => {
    const snippets = formSnippets({ publicUrl: "https://api.example.com", key: "signup", properties: ["company", "age", "member"] });
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => ({ object: "form_submission", message: "Thank you. Check your email if confirmation is needed." }),
    }));
    const subscribe = new Function("fetch", `${snippets.fetch}\nreturn subscribe;`)(request);
    const result = await subscribe({
      email: "ada@example.com", first_name: "Ada", properties: { company: "Acme", age: 42, member: true, private: "drop" },
    });
    expect(result).toEqual({ object: "form_submission", message: "Thank you. Check your email if confirmation is needed." });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/forms/signup");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      email: "ada@example.com", first_name: "Ada", last_name: "", website: "",
      properties: { company: "Acme", age: 42, member: true },
    });
  });

  it("allows omitted properties and exposes a rejected submission error", async () => {
    const snippets = formSnippets({ publicUrl: "http://localhost:3100/", key: "key", properties: ["company"] });
    const request = vi.fn(async () => ({ ok: false, json: async () => ({ message: "Origin not allowed." }) }));
    const subscribe = new Function("fetch", `${snippets.fetch}\nreturn subscribe;`)(request);
    await expect(subscribe({ email: "ada@example.com" })).rejects.toThrow("Origin not allowed.");
    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).properties).toEqual({});
  });

  it.each(["javascript:alert(1)", "ftp://example.com", "https://user:password@example.com"])(
    "rejects unsafe or credential-bearing API URL %s", (publicUrl) => {
      expect(() => formSnippets({ publicUrl, key: "key", properties: [] })).toThrow();
    },
  );
});
