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

Set `topic_id` for Marketing sends. Multiple recipients become separate To-only emails with recipient-specific unsubscribe links. The response keeps `id` and adds an optional `emails` list of `{id, to}` entries. Each split batch item has the same shape. A retry with the same idempotency key returns the same IDs. Transactional sends without `topic_id` are unchanged.

