import os
from dispatch import Dispatch


api_key = os.getenv("DISPATCH_API_KEY")
if not api_key:
    raise SystemExit("DISPATCH_API_KEY is required")

client = Dispatch(api_key=api_key)

response = client.send(
    {
        "from": "hello@example.com",
        "to": "python@example.com",
        "subject": "Python SDK smoke",
        "text": "Sent through the local Dispatch API.",
    },
    idempotency_key="python-example",
)

print(response)
