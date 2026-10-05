# Lifecycle SDK examples

Start with the [six recipes](../../docs/automations/README.md). `recipes.ts` covers all six producers using the actual TypeScript SDK; `recipes.py` and `recipes.go` show installation, read-only review, explicit enable, contact state and billing events with the actual Python/Go clients.

These are importable functions, not auto-running programs. There are no embedded credentials or requests on import. Tests replace HTTP transport in memory: no server, provider, database, container or live account is contacted. Mock results prove call shapes and error handling, not installation, timing, rendering or delivery.

## Using the functions

Supply `DISPATCH_API_URL` and `DISPATCH_API_KEY` from your environment and use a verified tenant sender. Install returns a disabled automation. Review its graph, templates, required variables, publication, brand and consent before separately approving enable. Never automatically publish a reused draft. Newsletter requires a live tenant topic at installation; other Marketing presets can install without topics but cannot enable until their topics are supplied.

### TypeScript

```ts
import { Dispatch } from "@dispatchmail/sdk";
import { install, review } from "./recipes.js";

const client = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY, baseUrl: process.env.DISPATCH_API_URL });
const installed = await install(client, "onboarding-drip", "Acme <hello@acme.com>", "topic_123");
const inspection = await review(client, installed.automation.id,
  [...installed.templates.created, ...installed.templates.reused].map(item => item.id));
// Stop here for review. Call enable(client, installed.automation.id) only after approval.
```

### Python

Install the local SDK with `python -m pip install ./packages/sdk-python` from the repository root, or use the offline `PYTHONPATH` below without installing anything.

```python
import os
from dispatch import Dispatch
from recipes import install, review, payment_failed

client = Dispatch(api_key=os.environ["DISPATCH_API_KEY"], base_url=os.environ["DISPATCH_API_URL"])
installed = install(client, "onboarding-drip", "Acme <hello@acme.com>", topic_id="topic_123")
inspection = review(client, installed)
# After an actual billing failure, use real invoice values:
# payment_failed(client, customer_email, amount=formatted_amount,
#                update_payment_url=authenticated_payment_url,
#                invoice_number=invoice_number, invoice_id=invoice_id)
```

### Go

`go.mod` resolves `github.com/dispatch/dispatch-go` to the repository's SDK, with no downloaded dependency.

```go
client := dispatch.New("") // Environment key and API URL.
installed, err := Install(client, "onboarding-drip", "Acme <hello@acme.com>", "topic_123", "")
if err != nil { return err }
inspection, err := Review(client, installed)
if err != nil { return err }
// Inspect inspection.Automation and inspection.Templates before approving enable.
_ = inspection // Pass this to your app's review UI.
// Stop here. Enable(client, installed.Automation.ID) is a separate approved call.
```

The payment examples take actual `AMOUNT`, `UPDATE_PAYMENT_URL`, `INVOICE_NUMBER` and `invoice_id`, not preview samples. Paid events match the contact and event name today, with no automatic invoice correlation. The preset never cancels a subscription. Billing must cancel before the final notice; do not enable unchanged if your policy cannot ensure that. Manual production is available now; a future authenticated Stripe receiver must verify signatures, deduplicate events and map billing truth before forwarding. Installing the preset sets up no receiver.

## Offline checks

From the repository root, using Node 24.21.0 and existing tooling (no installation needed):

```sh
pnpm exec vitest run examples/lifecycle/recipes.test.ts
pnpm exec tsc --project examples/lifecycle/tsconfig.json
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=packages/sdk-python:examples/lifecycle python3 -m unittest discover -s examples/lifecycle -p 'test_*.py'
cd examples/lifecycle && GOPROXY=off GOTOOLCHAIN=local go test -count=1 ./...
```

Checks cover every preset's install options, separate review/enable, app-owned state/event payloads, real SDK errors, exact recipe graphs and public links/anchors. They are not live acceptance evidence.
