# Goals and conversions

Goals measure outcomes retroactively. Create a goal today and measure earlier automation, broadcast or step sends. You do not attach a goal before sending.

```json
{
  "name": "Upgrade",
  "target": { "event": "upgraded" },
  "window_days": 30,
  "eligibility": null
}
```

Create with `POST /goals`, list with `GET /goals`, and retrieve, edit or soft-delete with `GET`, `PATCH` or `DELETE /goals/{id}`. Full access is required for writes. Viewers can read goals and reports.

```text
GET /goals/{id}/metrics?broadcast_id=broadcast_123&start_date=2026-09-01T00:00:00Z&end_date=2026-10-01T00:00:00Z
```

## Counting rules

- Choose `automation_id` or `broadcast_id`, not both. An automation can also use `step_key`. Omit scope for all attributed sends.
- A reached contact must be live and linked by `emails.contact_id`. A queued email alone is not a send. Legacy sends without a contact ID cannot be assigned by guessing an address.
- The cohort uses each contact's **first real send in the selected scope across retained history**, then selects first sends in `[start_date, end_date)`. Repeated sends do not restart the window or add contacts. A later step has its own first-send cohort.
- Bounds are ISO datetimes. The default end is database measurement time; default start is 30 days before end.
- Conversion timestamps must be at or after first send and at or before `first_send + window_days`, capped at measurement time. A conversion after `end_date` still counts if inside that window.
- Count a contact at most once. `rate` is a fraction, `converted / contacts_reached`, and is zero for an empty cohort.
- Daily rows are **UTC first-send cohorts**, not conversion-day activity. Empty days are included.
- Eligibility uses **current** live contact state, not state at send time. Changing eligibility or contact properties can therefore change a historical report.
- Sandbox send events never enter the cohort. Recorded real attribution remains real even if a later retry is routed to sandbox.

Event targets match the real custom event name and tenant, using a case-insensitive contact email. Deleted events do not count. Address changes can affect email-based historical event matching; events do not contain a guaranteed historical contact identity.

## Contact-state targets and history limits

Use `{ "rule": ... }` instead of `{ "event": ... }` for a contact-state target. The shared typed rule grammar supports groups and declared string, number, boolean and date properties, plus built-in contact scalars. A conversion is **entry into the whole rule**, false before a recorded write and true afterward. Already matching today is not a conversion. All changed fields from one request at one history timestamp are evaluated together, so compound rules do not match unrelated per-field changes. Relative-date operators use the change timestamp. Passage of time without a recorded change is not an entry.

Rules share the ten-level grammar, not segment-only five-level/twenty-condition limits. Targets cannot use event fields or email engagement. Topic/segment rule targets are refused because older removal paths do not provide complete history. Current topic/static-segment eligibility remains available.

Contact history starts when contact-change recording was introduced. No pre-history snapshots are fabricated. History is pruned according to `CONTACT_CHANGES_RETENTION_DAYS` (default 400); reports cannot recover removed transitions. The response exposes the earliest retained tenant change as `history.available_from`, not a promise of complete history for every contact. Writes at identical timestamps use request IDs to break ties; historical transaction order cannot be recovered when no order was recorded.

## SDKs and dashboard

```ts
const { data: goal } = await dispatch.goals.create({
  name: "Upgrade", target: { event: "upgraded" }, windowDays: 30,
});
const report = await dispatch.goals.metrics(goal!.id, {
  broadcastId: "broadcast_123",
  startDate: "2026-09-01T00:00:00Z", endDate: "2026-10-01T00:00:00Z",
});
```

Go exposes `Goals`, `Goal`, `CreateGoal`, `UpdateGoal`, `DeleteGoal` and `GoalMetrics`. Python exposes `goals`, `goal`, `create_goal`, `update_goal`, `delete_goal` and `goal_metrics`. Go/Python query names are snake_case.

The Goals page manages definitions. Automation Metrics, broadcast details and global Metrics show the same conversion report with a goal picker. Global Metrics also offers automation or broadcast scope selection.
