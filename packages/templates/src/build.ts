import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ReactNode } from "react";
import type { EmailVariable } from "../emails/_theme";
import type { Library, LibraryTemplate } from "./types";

process.env.NODE_ENV = "production";

const order = [
  "password-reset",
  "verify-email",
  "one-time-code",
  "magic-link",
  "invitation",
  "welcome",
  "security-notice",
  "new-sign-in",
  "receipt",
  "invoice",
  "payment-failed",
  "trial-ending",
  "order-confirmation",
  "shipping-update",
  "notification",
  "newsletter",
];

const names: Record<string, string> = {
  "password-reset": "Password reset",
  "verify-email": "Verify email",
  "one-time-code": "One-time code",
  "magic-link": "Magic link",
  invitation: "Invitation",
  welcome: "Welcome",
  "security-notice": "Security notice",
  "new-sign-in": "New sign-in",
  receipt: "Receipt",
  invoice: "Invoice",
  "payment-failed": "Payment failed",
  "trial-ending": "Trial ending",
  "order-confirmation": "Order confirmation",
  "shipping-update": "Shipping update",
  notification: "Notification",
  newsletter: "Newsletter",
};

const brand = {
  productName: "{{{PRODUCT_NAME}}}",
  productUrl: "{{{PRODUCT_URL}}}",
  logoUrl: "{{{LOGO_URL}}}",
  color: "{{{BRAND_COLOR}}}",
  textColor: "{{{BRAND_TEXT_COLOR}}}",
  supportEmail: "{{{SUPPORT_EMAIL}}}",
  supportUrl: "{{{SUPPORT_URL}}}",
  privacyUrl: "{{{PRIVACY_URL}}}",
  companyName: "{{{COMPANY_NAME}}}",
  companyAddress: "{{{COMPANY_ADDRESS}}}",
  year: "{{{CURRENT_YEAR}}}",
  unsubscribeUrl: "{{{UNSUBSCRIBE_URL}}}",
};

type RenderModule = {
  render: (node: unknown, options?: { pretty?: boolean }) => Promise<string> | string;
  toPlainText: (html: string) => string | Promise<string>;
};

type TemplateComponent = {
  (props: Record<string, unknown>): ReactNode;
  Preview: string;
  PreviewProps?: Record<string, unknown>;
  Subject: string;
  Category: string;
  Track: boolean;
  Description: string;
  Variables: EmailVariable[];
};

async function load(): Promise<RenderModule> {
  for (const name of ["react-email", "@react-email/render"]) {
    try {
      const mod = (await import(name)) as Partial<RenderModule>;
      if (typeof mod.render === "function" && typeof mod.toPlainText === "function") return mod as RenderModule;
    } catch {
      continue;
    }
  }
  throw new Error("Could not load render() from react-email or @react-email/render");
}

function placeholderProps(variables: EmailVariable[], listPlaceholder: (key: string, fields: string[]) => unknown) {
  const props: Record<string, unknown> = {};
  for (const variable of variables) {
    props[variable.prop] =
      variable.type === "list" ? listPlaceholder(variable.key, variable.fields ?? []) : `{{{${variable.key}}}}`;
  }
  return props;
}

function sampleFor(variables: EmailVariable[], previewProps: Record<string, unknown> | undefined) {
  const sample: Record<string, unknown> = {};
  for (const variable of variables) {
    if (previewProps && Object.prototype.hasOwnProperty.call(previewProps, variable.prop)) {
      sample[variable.key] = previewProps[variable.prop];
    }
  }
  return sample;
}

async function main() {
  const { createElement } = await import("react");
  const { listPlaceholder } = await import("../emails/_components/Each");
  const { render, toPlainText } = await load();
  const emailsDir = fileURLToPath(new URL("../emails/", import.meta.url));
  const files = new Set(
    readdirSync(emailsDir).filter((name) => name.endsWith(".tsx") && !name.startsWith("_")).map((name) => name.replace(/\.tsx$/, ""))
  );
  const missing = order.filter((slug) => !files.has(slug));
  const extra = [...files].filter((slug) => !order.includes(slug));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Template files do not match the catalog. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`);
  }

  const templates: LibraryTemplate[] = [];
  for (const slug of order) {
    const imported = (await import(pathToFileURL(join(emailsDir, `${slug}.tsx`)).href)) as { default: TemplateComponent };
    const component = imported.default;
    const variables = component.Variables;
    const props = placeholderProps(variables, listPlaceholder);
    const html = String(await render(createElement(component, { ...props, brand }), { pretty: false }));
    const text = String(await toPlainText(html));
    const previewHtml = String(
      await render(
        createElement(component, { ...props, ...component.PreviewProps, brand }),
        { pretty: false }
      )
    );
    templates.push({
      slug,
      name: names[slug] ?? slug,
      category: component.Category,
      kind: component.Category === "marketing" ? "marketing" : "transactional",
      track: component.Track,
      subject: component.Subject,
      description: component.Description,
      preview: component.Preview,
      variables: variables.map((variable) => ({
        key: variable.key,
        type: variable.type,
        fallback_value: variable.fallback_value === undefined ? null : variable.fallback_value,
        ...(variable.type === "list" ? { fields: variable.fields ?? [] } : {}),
      })),
      sample: sampleFor(variables, component.PreviewProps),
      html,
      text,
      preview_html: previewHtml,
    });
  }

  const library: Library = { version: "1.0.0", templates };
  // LIBRARY_OUT lets the freshness test build to a temporary file and compare.
  const target = process.env.LIBRARY_OUT ?? fileURLToPath(new URL("../library.json", import.meta.url));
  writeFileSync(target, `${JSON.stringify(library, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
