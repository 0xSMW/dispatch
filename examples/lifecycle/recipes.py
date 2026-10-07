"""App-owned calls using the real SDK. Importing never makes a request."""
from dispatch import Dispatch


def install(client: Dispatch, slug: str, sender: str, topic_id: str | None = None,
            name: str | None = None):
    options = {"from": sender}
    if topic_id is not None:
        options["topic_id"] = topic_id
    if name is not None:
        options["name"] = name
    return client.template_library_install_automation(slug, **options)


def review(client: Dispatch, installation):
    """Read only. Reused edited/draft templates are never changed or published."""
    templates = installation["templates"]
    return {
        "automation": client.automation(installation["automation"]["id"]),
        "templates": [client.template(item["id"])
                      for item in templates["created"] + templates["reused"]],
    }


def enable(client: Dispatch, automation_id: str):
    """Separate approval required after reviewing the graph and all emails."""
    return client.update_automation(automation_id, {"status": "enabled"})


def start_onboarding(client: Dispatch, email: str, topic_id: str):
    """Actual new signup, with consent; not a reset of an existing preference."""
    return client.create_contact({
        "email": email, "first_name": "Ada", "properties": {"activated": False},
        "topics": [{"id": topic_id, "subscription": "opt_in"}],
    })


def activate(client: Dispatch, email: str):
    return client.update_contact(email, {"properties": {"activated": True}})


def payment_failed(client: Dispatch, email: str, *, amount: str,
                   update_payment_url: str, invoice_number: str, invoice_id: str):
    """Forward actual billing values, not library preview samples."""
    return client.send_event("stripe.invoice.payment_failed", email=email, payload={
        "AMOUNT": amount, "UPDATE_PAYMENT_URL": update_payment_url,
        "INVOICE_NUMBER": invoice_number, "invoice_id": invoice_id,
    })


def invoice_paid(client: Dispatch, email: str, invoice_id: str):
    # Current waits are contact/event-name based, not automatically correlated.
    return client.send_event("stripe.invoice.paid", email=email,
                             payload={"invoice_id": invoice_id})
