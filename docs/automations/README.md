# Lifecycle recipes

Six starting points, installed disabled. Transactional sending remains one request; lifecycle setup is optional.

| Stage | Recipe | Starts when |
|:---|:---|:---|
| acquisition | [Newsletter welcome](newsletter-welcome.md) | `{"type":"topic_subscribed","topic_id":"{{topic_id}}"}` |
| onboarding | [Onboarding drip](onboarding-drip.md) | `{"type":"contact_created"}` |
| retention | [Invite to upgrade](invite-to-upgrade.md) | `{"type":"event","event_name":"usage.limit_reached"}` |
| reengagement | [Win back](win-back.md) | `{"type":"event","event_name":"user.inactive"}` |
| dunning | [Failed payment](failed-payment.md) | `{"type":"event","event_name":"stripe.invoice.payment_failed"}` |
| reactivation | [Come back](come-back.md) | `{"type":"contact_updated","field":"plan","to":"canceled"}` |

## Discover and install

`GET /template-library/automations` returns `{object: "list", has_more: false, data: [...]}`. This fixed collection has slugs, not ID cursors. `GET /template-library/automations/{slug}` returns `{object: "automation_preset", ...definition}`. Listing and preview install nothing.

### TypeScript

```ts
const presets = await dispatch.templates.library.automations();
const preset = await dispatch.templates.library.automation("onboarding-drip");
const installed = await dispatch.templates.library.installAutomation("onboarding-drip", {
  from: "Acme <hello@acme.com>", topicId: "topic_123",
});
if (installed.error) throw new Error(installed.error.message);
// installed.data.automation.status === "disabled"
```

### Python

```python
installed = dispatch.template_library_install_automation(
    "onboarding-drip", **{"from": "Acme <hello@acme.com>", "topic_id": "topic_123"})
# Exceptions propagate; installed["automation"]["status"] == "disabled"
```

### Go

```go
installed, err := client.TemplateLibraryInstallAutomation("onboarding-drip", dispatch.AutomationInstallInput{
    From: "Acme <hello@acme.com>", TopicID: "topic_123",
})
if err != nil { return err }
// installed.Automation.Status == "disabled"
```

Authenticated `POST /template-library/automations/{slug}/install` accepts `{name?, from, topic_id?}`. HTTP 200 returns a full disabled automation, templates.created/reused (IDs/slugs), newly created events/properties and next_steps, with existing request_id metadata. Empty arrays remain present. A sender on a verified, sending-enabled live tenant domain is required (missing: 422 `Choose a sender`). Newsletter also requires a live same-tenant topic (missing: 422 `Choose a topic`). Other Marketing presets can install topicless, but cannot enable until every Marketing step has a live topic.

`next_steps` is ordered: `Choose a topic for marketing steps` when missing, then `Review the automation and its emails`, then `Enable the automation`. Newsletter never installs with an unresolved topic. The newsletter placeholder above belongs to the read-only definition, not an install request or stored trigger.

## Review before enabling

A second installation needs a distinct name; live name conflicts return 409. Compatible definitions are reused unchanged; incompatible types return 409. New template copies are published, but reused edited/draft copies are never overwritten or auto-published. Review publication, variables, content, brand, links, consent and business timing. Explicitly enable with `dispatch.automations.update(id, { status: "enabled" })` or `PATCH /automations/{id}` with `{"status":"enabled"}`. next_steps are guidance, not proof of complete app data.

Recipes preserve shipped freshness, graph and re-entry. Newsletter uses a binary Condition; a general Branch still needs 2–10 paths plus Otherwise. Following filters recheck on resume; enable does not replay history. Payment waits are contact/event-name based, not invoice-correlated. The preset does not cancel subscriptions or configure an authenticated Stripe receiver.

[Offline SDK examples and checks](../../examples/lifecycle/README.md) make no live requests on import or test. See [automation semantics](../automations.md), [properties and consent](../audience.md), [variables](../templates.md#variables) and [domains](../domains.md).

## Ask your agent

```text
Help me review Dispatch lifecycle presets and draft a disabled automation using the shipped API. Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.
```
