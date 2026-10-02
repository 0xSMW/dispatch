import "@dispatchmail/core/env";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { requireSecret } from "@dispatchmail/core";
import { connect } from "./index.js";
import type { LibraryInstallEntry } from "./templates.js";
import { createTenant } from "./tenants.js";

// Creates a tenant with its first user, who signs in to the dashboard with the email and
// password given here, and a full-access key:
//
//   pnpm db:bootstrap -- --name "Acme" --email you@acme.com --password "a long private password"
//
// Run `pnpm db:migrate` first. The key is printed once and is not stored in the clear. The
// password is stored only as a hash and is never printed.
const { values } = parseArgs({
  options: { name: { type: "string" }, email: { type: "string" }, password: { type: "string" }, "user-name": { type: "string" } },
  allowPositionals: true,
});
if (!values.name || !values.email || !values.password) {
  console.error('Usage: pnpm db:bootstrap -- --name "Acme" --email you@acme.com --password "12 to 200 characters" [--user-name "Ada"]');
  process.exit(1);
}

const db = connect();
try {
  const library = JSON.parse(await readFile(new URL("../../templates/library.json", import.meta.url), "utf8")) as {
    version?: string;
    templates: LibraryInstallEntry[];
  };
  const created = await createTenant(db, {
    name: values.name,
    email: values.email,
    password: values.password,
    userName: values["user-name"],
    pepper: requireSecret("API_KEY_PEPPER"),
    library,
  });
  console.log(`tenant ${created.tenant_id}`);
  console.log(`user ${created.email}`);
  console.log(`DISPATCH_API_KEY=${created.api_key}`);
  console.log("Store the key now. It is not shown again.");
} finally {
  await db.end();
}
