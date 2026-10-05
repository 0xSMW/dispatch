function htmlValue(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function jsValue(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Public, credential-free examples. Keep the API deployment's optional path prefix. */
export function formSnippets({ publicUrl, key, properties }: {
  publicUrl: string;
  key: string;
  properties: readonly string[];
}): { html: string; fetch: string } {
  const base = new URL(publicUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("Use an HTTP or HTTPS API URL without credentials.");
  }
  base.search = "";
  base.hash = "";
  const encodedKey = encodeURIComponent(key).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const endpoint = `${base.toString().replace(/\/+$/, "")}/forms/${encodedKey}`;
  const keys = [...new Set(properties)];
  const propertyInputs = keys.map((property) =>
    `  <label>${htmlValue(property)} <input name="${htmlValue(`properties.${property}`)}" type="text"></label>`);

  return {
    html: [
      `<form action="${htmlValue(endpoint)}" method="post" accept-charset="UTF-8">`,
      '  <label>Email <input name="email" type="email" autocomplete="email" required></label>',
      '  <label>First name <input name="first_name" type="text" autocomplete="given-name"></label>',
      '  <label>Last name <input name="last_name" type="text" autocomplete="family-name"></label>',
      ...propertyInputs,
      '  <div hidden aria-hidden="true">',
      '    <label>Leave blank <input name="website" type="text" tabindex="-1" autocomplete="off"></label>',
      "  </div>",
      '  <button type="submit">Subscribe</button>',
      "</form>",
    ].join("\n"),
    fetch: [
      "// Run in a browser on one of this form's allowed origins. No API key is needed.",
      'async function subscribe({ email, first_name = "", last_name = "", website = "", properties = {} }) {',
      `  const allowedProperties = ${jsValue(keys)};`,
      "  const selectedProperties = Object.fromEntries(",
      "    allowedProperties.filter((key) => Object.hasOwn(properties, key)).map((key) => [key, properties[key]])",
      "  );",
      `  const response = await fetch(${jsValue(endpoint)}, {`,
      '    method: "POST",',
      '    credentials: "omit",',
      '    headers: { "Content-Type": "application/json" },',
      "    body: JSON.stringify({ email, first_name, last_name, website, properties: selectedProperties }),",
      "  });",
      "  const result = await response.json();",
      '  if (!response.ok) throw new Error(result.message || "Could not submit the form.");',
      "  return result;",
      "}",
      "",
      "// Example (inside an async event handler):",
      '// const result = await subscribe({ email: "contact@example.com" });',
      "// Optional properties use their declared JSON types (string, number, boolean, or ISO date).",
      "// Show result.message to the visitor.",
    ].join("\n"),
  };
}
