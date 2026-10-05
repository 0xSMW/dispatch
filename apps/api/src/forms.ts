import { ApiError, brandContext, formHoneypot, formSchema, formSubmissionSchema, formSuccess, formUpdateSchema, type FormRecord } from "@dispatchmail/core";
import {
  acceptEmail, confirmForm, confirmationState, createForm, deleteForm, formColumns, getForm, getFormByKey,
  installLibraryMissing, loadBrand, paginate, presentForm, propertyDefinitions, readConfirmationToken,
  retryTx, submitForm, type Db, type FormSubmission, type PagingParams, type Queryable,
} from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { libraryEntry, loadLibrary } from "./library.js";

const publicConfig = { public: true, cors: false };
export function formOrigin(form: Pick<FormRecord, "allowed_origins">, origin: string | undefined) {
  return Boolean(origin && form.allowed_origins.includes(origin));
}
export function honeypot(body: unknown) {
  return Boolean(body && typeof body === "object" && (body as Record<string, unknown>)[formHoneypot]);
}
export async function formSubmission(client: Queryable, form: FormRecord, body: unknown, encoded: boolean): Promise<FormSubmission> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("validation_error", 400, "Invalid form submission");
  const fields = body as Record<string, unknown>;
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (fields.properties !== undefined) {
    if (!fields.properties || typeof fields.properties !== "object" || Array.isArray(fields.properties))
      throw new ApiError("validation_error", 400, "Properties must be an object");
    Object.assign(properties, fields.properties);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("properties.")) properties[key.slice(11)] = value;
    else if (!["email", "first_name", "last_name", "properties", formHoneypot].includes(key))
      throw new ApiError("validation_error", 400, "Only configured form fields are allowed");
  }
  if (Object.keys(properties).some((key) => !form.properties.includes(key)))
    throw new ApiError("validation_error", 400, "Only configured properties are allowed");
  if (encoded) {
    const definitions = await propertyDefinitions(client, form.tenant_id);
    for (const [key, value] of Object.entries(properties)) {
      const type = definitions.find((definition) => definition.key === key)?.type;
      if (value === "" && type !== "string") { delete properties[key]; continue; }
      if (type === "number" && typeof value === "string" && value.trim()) properties[key] = Number(value);
      if (type === "boolean" && (value === "true" || value === "false")) properties[key] = value === "true";
    }
  }
  return { ...formSubmissionSchema.parse(fields), properties };
}

export function registerForms(app: FastifyInstance, deps: {
  db: Db; paging: (request: FastifyRequest) => PagingParams; secret: string; appUrl: string; publicUrl: string;
}) {
  const { db, paging, secret, appUrl, publicUrl } = deps;
  app.get("/forms", async (request) => {
    const page = await paginate<FormRecord>(db, { table: "forms", tenantId: request.auth!.tenant_id, select: formColumns }, paging(request));
    return { ...page, data: page.data.map(presentForm) };
  });
  app.post("/forms", async (request) =>
    presentForm(await retryTx(db, (client) => createForm(client, request.auth!.tenant_id, formSchema.parse(request.body)))));
  app.get("/forms/:id", async (request) => presentForm(await getForm(db, request.auth!.tenant_id, (request.params as { id: string }).id)));
  app.patch("/forms/:id", async (request) => {
    const { updateForm } = await import("@dispatchmail/db");
    return presentForm(await retryTx(db, (client) => updateForm(client, request.auth!.tenant_id,
      (request.params as { id: string }).id, formUpdateSchema.parse(request.body))));
  });
  app.delete("/forms/:id", async (request) => {
    const formId = (request.params as { id: string }).id;
    if (!await deleteForm(db, request.auth!.tenant_id, formId)) throw new ApiError("not_found", 404, "Form not found");
    return { object: "form", id: formId, deleted: true };
  });
  // Minted management IDs cannot overlap the 43-character public keys. Let the
  // global CORS hook answer dashboard preflights without a public-origin lookup.
  app.options("/forms/:id(^form_[0-9a-f]{32}$)", async (_request, reply) => reply.code(204).send());
  app.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, done) => {
      const entries = new URLSearchParams(String(body));
      const fields: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [key, value] of entries) {
        if (Object.hasOwn(fields, key)) return done(new ApiError("validation_error", 400, "Repeated form fields are not allowed"));
        fields[key] = value;
      }
      done(null, fields);
    });
    const publicForm = async (request: FastifyRequest) => {
      const form = await getFormByKey(db, (request.params as { id: string }).id);
      if (!form) throw new ApiError("not_found", 404, "Form not found");
      if (!formOrigin(form, request.headers.origin)) throw new ApiError("forbidden", 403, "Origin is not allowed");
      return form;
    };
    scope.options("/forms/:id", { config: publicConfig }, async (request, reply) => {
      await publicForm(request);
      const method = request.headers["access-control-request-method"];
      const headers = String(request.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
      if (method !== "POST" || headers.some((value) => value !== "content-type"))
        throw new ApiError("forbidden", 403, "Preflight is not allowed");
      reply.header("access-control-allow-origin", request.headers.origin).header("vary", "Origin")
        .header("access-control-allow-methods", "POST").header("access-control-allow-headers", "content-type");
      return reply.code(204).send();
    });
    scope.post("/forms/:id", { config: publicConfig, bodyLimit: 16 * 1024 }, async (request, reply) => {
      const form = await publicForm(request);
      reply.header("access-control-allow-origin", request.headers.origin).header("vary", "Origin").header("cache-control", "no-store");
      if (honeypot(request.body)) return { ...formSuccess };
      try {
        await retryTx(db, async (client) => {
          const current = await getFormByKey(client, form.key, true);
          if (!current) throw new ApiError("not_found", 404, "Form not found");
          if (!formOrigin(current, request.headers.origin)) throw new ApiError("forbidden", 403, "Origin is not allowed");
          const input = await formSubmission(client, current, request.body,
            String(request.headers["content-type"]).startsWith("application/x-www-form-urlencoded"));
          await submitForm(client, current, input, request.request_id, { secret, enqueue: async (transaction, configured, email, token) => {
            const library = await loadLibrary();
            const installed = await installLibraryMissing(transaction, configured.tenant_id,
              libraryEntry(library, "confirm-subscription"), library.version);
            const response = await acceptEmail(transaction, { from: configured.from_email, to: email,
              template: { id: installed.id, variables: { CONFIRM_URL: `${appUrl.replace(/\/$/, "")}/confirm/${encodeURIComponent(token)}` } } },
              { tenant_id: configured.tenant_id, request_id: request.request_id }, { client: transaction, publicUrl });
            if (response.email.status !== "queued") throw new ApiError("application_error", 503, "Confirmation could not be queued");
          } });
        });
      } catch (error) {
        // Address-specific enqueue/suppression failures must not become an enumeration signal.
        if (error instanceof ApiError && error.statusCode === 503) return { ...formSuccess };
        throw error;
      }
      return { ...formSuccess };
    });
  });
  const token = (request: FastifyRequest) => {
    const payload = readConfirmationToken((request.params as { token: string }).token, secret);
    if (!payload) throw new ApiError("not_found", 404, "Confirmation link not found");
    return payload;
  };
  app.get("/confirm/:token", { config: { public: true } }, async (request, reply) => {
    const payload = token(request);
    const state = await confirmationState(db, payload);
    const form = await getForm(db, payload.tenant_id, payload.form_id);
    const brand = await loadBrand(db, payload.tenant_id);
    const vars = brandContext(brand.brand, { tenantName: brand.name, domain: brand.domain });
    reply.header("cache-control", "no-store");
    return { object: "confirmation", form_name: form.name, confirmed: Boolean(state.used_at), brand: {
      product_name: vars.PRODUCT_NAME, logo_url: vars.LOGO_URL || null, primary_color: vars.BRAND_COLOR,
      text_color: vars.BRAND_TEXT_COLOR, background_color: "#ffffff",
    } };
  });
  app.post("/confirm/:token", { config: { public: true }, bodyLimit: 1024 }, async (request, reply) => {
    const redirect_url = await retryTx(db, (client) => confirmForm(client, token(request), request.request_id));
    reply.header("cache-control", "no-store");
    return { object: "confirmation", confirmed: true, redirect_url };
  });
}
