import { mapStripe } from "../../db/src/inbound/stripe.js";

// A finite provider input for the library build, not preview/sample data or a
// promise that arbitrary callers supply these fields. Runtime still validates
// each send's actual variables.
export async function paymentInput() {
  const mapped = await mapStripe({
    id: "evt_library_payment_failed",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_library",
        customer: "cus_library",
        customer_email: "ada@example.com",
        amount_due: 4900,
        currency: "usd",
        hosted_invoice_url: "https://billing.example/in_library",
        number: "INV-LIBRARY",
      },
    },
  });
  if (mapped.action !== "upsert" || mapped.event.name !== "stripe.invoice.payment_failed") {
    throw new Error("Library payment input did not map to stripe.invoice.payment_failed");
  }
  return mapped.event.data;
}
