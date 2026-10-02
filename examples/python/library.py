import os
from dispatch import Dispatch


api_key = os.getenv("DISPATCH_API_KEY")
if not api_key:
    raise SystemExit("DISPATCH_API_KEY is required")

client = Dispatch(api_key=api_key)
sender = os.getenv("DISPATCH_FROM", "hello@example.com")
recipient = os.getenv("DISPATCH_TO", "ada@example.com")

reset = client.send(
    {
        "from": sender,
        "to": recipient,
        "template": "password-reset",
        "variables": {"ACTION_URL": "https://example.com/reset/abc123"},
    }
)
print(reset)

receipt = client.send(
    {
        "from": sender,
        "to": recipient,
        "template": "receipt",
        "variables": {
            "RECEIPT_NUMBER": "1042",
            "PAID_AT": "2026-10-01 15:04 UTC",
            "TOTAL": "$49.00",
            "LINE_ITEMS": [
                {"description": "Pro plan", "quantity": "1", "amount": "$49.00"}
            ],
        },
    }
)
print(receipt)
