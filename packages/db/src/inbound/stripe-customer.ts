import { ApiError } from "@dispatchmail/core";
import { email, object, type InboundDependencies } from "./types.js";
import type { StripeCustomer } from "./stripe.js";

/** Restricted-key retrieval only; callers run this before entering database retries. */
export async function stripeCustomer(
  customerId: string,
  restrictedKey: string,
  transport: NonNullable<InboundDependencies["customerTransport"]> = globalThis.fetch,
): Promise<StripeCustomer | null> {
  if (!/^cus_[a-zA-Z0-9]+$/.test(customerId) || !/^rk_(test|live)_[a-zA-Z0-9]+$/.test(restrictedKey)) {
    throw new ApiError("validation_error", 400, "Invalid Stripe customer lookup");
  }
  try {
    const response = await transport(`https://api.stripe.com/v1/customers/${customerId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${restrictedKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("lookup_failed");
    const customer = object(await response.json());
    if (!customer || customer.id !== customerId) throw new Error("invalid_customer");
    if (customer.deleted === true) return { id: customerId, deleted: true };
    return { id: customerId, email: email(customer.email) ?? null };
  } catch {
    // Never surface Stripe's response body, credentials or a transport exception.
    throw new ApiError("internal_error", 503, "Stripe customer lookup failed");
  }
}
