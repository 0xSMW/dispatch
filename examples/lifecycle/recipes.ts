import { Dispatch, type Result } from "../../packages/sdk/src/index.js";

// Importing makes no requests. Invoke these functions only after approval.
export function value<T>(result: Result<T>): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function install(dispatch: Dispatch, slug: string, from: string, topicId?: string, name?: string) {
  return value(await dispatch.templates.library.installAutomation(slug, { from, topicId, name }));
}

// Inspection only: never overwrites, publishes, or enables anything.
export async function review(dispatch: Dispatch, id: string, templateIds: string[]) {
  const automation = value(await dispatch.automations.get(id));
  const templates = [];
  for (const templateId of templateIds) templates.push(value(await dispatch.templates.get(templateId)));
  return { automation, templates };
}

// Separate approval after reviewing next_steps, content, variables and consent.
export async function enable(dispatch: Dispatch, id: string) {
  return value(await dispatch.automations.update(id, { status: "enabled" }));
}

export async function subscribeNewsletter(dispatch: Dispatch, email: string, topicId: string) {
  // Opt_out-default topic; consented new subscriber, not an existing user's reset.
  value(await dispatch.contacts.create({ email, firstName: "Ada", properties: { activated: false },
    topics: [{ id: topicId, subscription: "opt_out" }] }));
  return value(await dispatch.contacts.topics.update({ email,
    topics: [{ id: topicId, subscription: "opt_in" }] }));
}

export async function activate(dispatch: Dispatch, email: string) {
  return value(await dispatch.contacts.update({ email, properties: { activated: true } }));
}

export async function startOnboarding(dispatch: Dispatch, email: string, topicId: string) {
  // Genuinely new signup after enabling; topic preference must reflect consent.
  return value(await dispatch.contacts.create({ email, firstName: "Ada", properties: { activated: false },
    topics: [{ id: topicId, subscription: "opt_in" }] }));
}

export async function reachLimit(dispatch: Dispatch, email: string) {
  // Actual free account state first; payloads do not update contact.plan.
  value(await dispatch.contacts.update({ email, properties: { plan: "free" } }));
  return value(await dispatch.events.send({ event: "usage.limit_reached", email, payload: {} }));
}

export async function upgrade(dispatch: Dispatch, email: string) {
  return value(await dispatch.contacts.update({ email, properties: { plan: "pro" } }));
}

export async function markInactive(dispatch: Dispatch, email: string, lastActiveAt: string) {
  value(await dispatch.contacts.update({ email, properties: { last_active_at: lastActiveAt } }));
  return value(await dispatch.events.send({ event: "user.inactive", email, payload: {} }));
}

export async function recordActivity(dispatch: Dispatch, email: string, at: string) {
  return value(await dispatch.contacts.update({ email, properties: { last_active_at: at } }));
}

export type Invoice = { amount: string; updatePaymentUrl: string; number: string; id: string };

export async function paymentFailed(dispatch: Dispatch, email: string, invoice: Invoice) {
  // Actual billing values, never library preview samples.
  return value(await dispatch.events.send({ event: "stripe.invoice.payment_failed", email,
    payload: { AMOUNT: invoice.amount, UPDATE_PAYMENT_URL: invoice.updatePaymentUrl,
      INVOICE_NUMBER: invoice.number, invoice_id: invoice.id } }));
}

export async function invoicePaid(dispatch: Dispatch, email: string, invoiceId: string) {
  return value(await dispatch.events.send({ event: "stripe.invoice.paid", email,
    payload: { invoice_id: invoiceId } }));
}

export async function cancelPlan(dispatch: Dispatch, email: string) {
  // Only after the billing system actually cancels the subscription.
  return value(await dispatch.contacts.update({ email, properties: { plan: "canceled" } }));
}

export async function restorePlan(dispatch: Dispatch, email: string) {
  return value(await dispatch.contacts.update({ email, properties: { plan: "pro" } }));
}
