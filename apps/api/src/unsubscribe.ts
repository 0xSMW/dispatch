import { ApiError, brandContext, unsubscribeSchema } from "@dispatchmail/core";
import {
  applyUnsubscribe,
  emit,
  loadBrand,
  oneClick,
  preferences,
  readUnsubscribeToken,
  retryTx,
  type Db,
  type Queryable,
  type UnsubscribeAction,
  type UnsubscribePayload,
} from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

// Public routes behind the preference page and RFC 8058 one-click. The token is the only credential.
export function registerUnsubscribe(app: FastifyInstance, deps: { db: Db; secret: string }) {
  const { db, secret } = deps;

  app.register(async (scope) => {
    // Mail clients send the one-click POST form-encoded. Parse it only on these routes.
    if (!scope.hasContentTypeParser("application/x-www-form-urlencoded")) {
      scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      });
    }
    // RFC 8058 prefers multipart for the same POST. The body is one small field, read as text.
    if (!scope.hasContentTypeParser("multipart/form-data")) {
      scope.addContentTypeParser("multipart/form-data", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, done) => {
        done(null, String(body));
      });
    }

    scope.get("/unsubscribe/:token", async (request) => {
      const payload = readToken(request, secret);
      return page(db, payload);
    });

    scope.post("/unsubscribe/:token", async (request) => {
      const payload = readToken(request, secret);
      const action = unsubscribeAction(request.body);
      await retryTx(db, async (client) => {
        const change = await applyUnsubscribe(client, payload, action, request.request_id);
        await emit(client, {
          tenantId: payload.tenant_id,
          requestId: request.request_id,
          type: change.type,
          resourceId: change.contact.id,
          data: { id: change.contact.id, email: change.contact.email },
        });
      });
      return page(db, payload);
    });
  });
}

function readToken(request: FastifyRequest, secret: string) {
  const payload = readUnsubscribeToken((request.params as { token: string }).token, secret);
  if (!payload) throw new ApiError("not_found", 404, "Unsubscribe link not found");
  return payload;
}

export function unsubscribeAction(body: unknown): UnsubscribeAction {
  if (oneClick(body)) return { kind: "one_click" };
  const input = unsubscribeSchema.parse(body ?? {});
  return "topics" in input ? { kind: "topics", topics: input.topics } : { kind: "all" };
}

async function page(db: Queryable, payload: UnsubscribePayload) {
  const current = await preferences(db, payload);
  const brand = await loadBrand(db, payload.tenant_id);
  const vars = brandContext(brand.brand, { tenantName: brand.name, domain: brand.domain });
  return {
    ...current,
    brand: {
      product_name: vars.PRODUCT_NAME,
      logo_url: vars.LOGO_URL || null,
      color: vars.BRAND_COLOR,
      text_color: vars.BRAND_TEXT_COLOR,
      // The tenant's own heading and line for this page. Null means the page's defaults.
      title: brand.brand.unsubscribe_title ?? null,
      description: brand.brand.unsubscribe_description ?? null,
    },
  };
}
