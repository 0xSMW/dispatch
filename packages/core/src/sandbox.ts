// Reserved domains and tenant additions are matched at label boundaries, never as substrings.
export function sandboxAddress(address: string, domains: readonly string[] = []): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!address.includes("@") || !domain) return false;
  return ["example.com", "example.net", "example.org", "test", "example", "invalid", ...domains]
    .some((value) => {
      const target = value.trim().toLowerCase().replace(/\.$/, "");
      return target !== "" && (domain === target || domain.endsWith(`.${target}`));
    });
}
