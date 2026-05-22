# Dispatch Python SDK

Small stdlib client for the local Dispatch API.

```py
from dispatch import Dispatch

client = Dispatch()
email = client.send(
    {
        "from": "hello@example.com",
        "to": "you@example.com",
        "subject": "Hello",
        "text": "Sent locally.",
    },
    idempotency_key="example-1",
)
```

