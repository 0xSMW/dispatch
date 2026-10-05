from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Literal, NotRequired, TypedDict, cast


Json = dict[str, Any]
PropertyType = Literal["string", "number", "boolean", "date"]
PropertyValue = str | int | float | bool | None
SendKind = Literal["transactional", "marketing"]


class ImportColumn(TypedDict, total=False):
    column: str
    type: PropertyType


class ImportColumnMap(TypedDict, total=False):
    email: ImportColumn
    first_name: ImportColumn | None
    last_name: ImportColumn | None
    unsubscribed: ImportColumn | None
    properties: dict[str, ImportColumn]

LifecycleEventType = Literal["email.unsubscribed", "automation.run.started", "automation.run.completed", "automation.run.failed"]
AutomationExitReason = Literal["completed", "exit", "filter", "stopped", "stranded"]

class AutomationRunEvent(TypedDict):
    automation_id: str
    run_id: str
    contact_id: str | None
    state: str
    exit_reason: AutomationExitReason | None

class SplitEmail(TypedDict):
    id: str
    to: str
    sandbox: bool


class SendResult(TypedDict):
    id: str
    sandbox: bool
    emails: NotRequired[list[SplitEmail]]
    request_id: NotRequired[str]

class ContactActivity(TypedDict):
    object: str
    id: str
    type: str
    created_at: str
    resource_id: NotRequired[str | None]
    label: NotRequired[str | None]
    email_id: NotRequired[str | None]
    automation_id: NotRequired[str | None]
    run_id: NotRequired[str | None]
    exit_reason: NotRequired[AutomationExitReason | None]


class AttachmentInput(TypedDict, total=False):
    filename: str
    content: str
    path: str
    content_type: str
    content_id: str
    disposition: Literal["attachment", "inline"]


class TagInput(TypedDict):
    name: str
    value: str


SendInput = TypedDict(
    "SendInput",
    {
        "from": str,
        "to": str | list[str],
        "cc": NotRequired[str | list[str]],
        "bcc": NotRequired[str | list[str]],
        "reply_to": NotRequired[str | list[str]],
        "subject": NotRequired[str],
        "html": NotRequired[str],
        "text": NotRequired[str],
        "template": NotRequired[str | dict[str, Any]],
        "variables": NotRequired[dict[str, Any]],
        "headers": NotRequired[dict[str, str]],
        "tags": NotRequired[list[TagInput] | dict[str, str]],
        "topic_id": NotRequired[str],
        "scheduled_at": NotRequired[str],
        "attachments": NotRequired[list[AttachmentInput]],
    },
    total=False,
)


class EmailUpdateInput(TypedDict, total=False):
    subject: str
    html: str | None
    text: str | None
    headers: dict[str, str]
    tags: list[TagInput] | dict[str, str]
    scheduled_at: str | None


class TemplateVariableInput(TypedDict, total=False):
    key: str
    type: Literal["string", "number", "list"]
    fallback_value: str | int | float | None


class TemplateInput(TypedDict, total=False):
    name: str
    alias: str
    subject: str
    html: str
    text: str
    reply_to: str | list[str]
    variables: list[str | TemplateVariableInput]
    publish: bool


class TemplateUpdateInput(TypedDict, total=False):
    name: str
    alias: str | None
    subject: str
    html: str | None
    text: str | None
    reply_to: str | list[str]
    variables: list[str | TemplateVariableInput]
    publish: bool


class ContactInput(TypedDict, total=False):
    email: str
    first_name: str
    last_name: str
    properties: dict[str, Any]
    unsubscribed: bool
    segments: list[dict[str, str]]
    topics: list[dict[str, str]]


class ContactUpdateInput(TypedDict, total=False):
    first_name: str | None
    last_name: str | None
    properties: dict[str, Any]
    unsubscribed: bool


class ContactPropertyInput(TypedDict, total=False):
    key: str
    type: PropertyType
    fallback_value: PropertyValue


class SuppressionInput(TypedDict, total=False):
    email: str
    reason: str


class TopicInput(TypedDict, total=False):
    name: str
    key: str
    description: str
    visibility: Literal["public", "private"]
    default_subscription: Literal["opt_in", "opt_out"]


class TopicUpdateInput(TypedDict, total=False):
    name: str
    key: str
    description: str | None
    visibility: Literal["public", "private"]


class TopicSubscriptionInput(TypedDict, total=False):
    email: str
    status: Literal["opt_in", "opt_out", "subscribed", "unsubscribed"]


class SegmentInput(TypedDict, total=False):
    rule: Rule | None
    name: str
    description: str


class SegmentUpdateInput(TypedDict, total=False):
    rule: Rule | None
    name: str
    description: str


class SegmentContactInput(TypedDict):
    email: str


BroadcastInput = TypedDict(
    "BroadcastInput",
    {
        "name": NotRequired[str],
        "from": str,
        "subject": NotRequired[str],
        "reply_to": NotRequired[str | list[str]],
        "preview_text": NotRequired[str],
        "html": NotRequired[str],
        "text": NotRequired[str],
        "template": NotRequired[str],
        "variables": NotRequired[dict[str, Any]],
        "topic_id": NotRequired[str],
        "segment_id": str,
        "scheduled_at": NotRequired[str],
        "send": NotRequired[bool],
    },
    total=False,
)


BroadcastUpdateInput = TypedDict(
    "BroadcastUpdateInput",
    {
        "name": NotRequired[str],
        "from": NotRequired[str],
        "subject": NotRequired[str],
        "reply_to": NotRequired[str | list[str]],
        "preview_text": NotRequired[str],
        "html": NotRequired[str],
        "text": NotRequired[str],
        "template": NotRequired[str],
        "variables": NotRequired[dict[str, Any]],
        "topic_id": NotRequired[str],
        "segment_id": NotRequired[str],
    },
    total=False,
)


SendEmailConfig = TypedDict(
    "SendEmailConfig",
    {
        "template": str | dict[str, Any],
        # Omission infers kind from topic_id. Marketing drafts can omit topic_id.
        "kind": NotRequired[SendKind],
        "from": NotRequired[str],
        "to": NotRequired[str],
        "subject": NotRequired[str],
        "reply_to": NotRequired[str | list[str]],
        "topic_id": NotRequired[str],
        "variables": NotRequired[dict[str, Any]],
        "variable_mapping": NotRequired[dict[str, str]],
    },
)

Operator = Literal[
    "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains",
    "starts_with", "ends_with", "within", "not_within", "exists", "is_empty",
]


class PredicateRule(TypedDict):
    scope: NotRequired[dict[str, str]]
    window: NotRequired[str]
    type: Literal["rule"]
    field: str
    operator: Operator
    value: NotRequired[Any]


class RuleGroup(TypedDict):
    type: Literal["and", "or"]
    rules: list[Rule]


Rule = PredicateRule | RuleGroup


class ExitConfig(TypedDict):
    pass


class FilterConfig(TypedDict):
    """next tests once; following saves a guard checked before every later step."""
    rule: Rule
    scope: Literal["next", "following"]


class BranchPath(TypedDict):
    key: str
    label: str
    rule: Rule


class BranchConfig(TypedDict):
    """Two to ten ordered paths with unique nonempty keys other than otherwise."""
    paths: list[BranchPath]


class AutomationGuard(TypedDict):
    filter: str
    rule: Rule


class AutomationRunStep(TypedDict):
    key: str
    type: str
    status: str
    started_at: str | None
    completed_at: str | None
    output: Json
    error: str | None


class AutomationRun(TypedDict):
    object: Literal["automation_run"]
    id: str
    automation_id: str
    status: Literal["running", "completed", "failed", "cancelled"]
    exit_reason: AutomationExitReason | None
    guards: list[AutomationGuard]
    event: Json
    error: str | None
    created_at: str
    updated_at: str
    steps: NotRequired[list[AutomationRunStep]]
    request_id: NotRequired[str]


class AutomationRunList(TypedDict):
    object: Literal["list"]
    data: list[AutomationRun]
    has_more: bool
    request_id: NotRequired[str]


class EventTriggerConfig(TypedDict):
    type: Literal["event"]
    event_name: str


class ContactCreatedTriggerConfig(TypedDict):
    type: Literal["contact_created"]


# "from" is a wire key, not a Python identifier. Do not rename nested config keys.
ContactUpdatedTriggerConfig = TypedDict(
    "ContactUpdatedTriggerConfig",
    {
        "type": Literal["contact_updated"],
        "field": NotRequired[str],
        "from": NotRequired[PropertyValue],
        "to": NotRequired[PropertyValue],
    },
)


class TopicSubscribedTriggerConfig(TypedDict):
    type: Literal["topic_subscribed"]
    topic_id: str


class SegmentAddedTriggerConfig(TypedDict):
    type: Literal["segment_added"]
    segment_id: str


AutomationTriggerConfig = (
    EventTriggerConfig | ContactCreatedTriggerConfig | ContactUpdatedTriggerConfig
    | TopicSubscribedTriggerConfig | SegmentAddedTriggerConfig
)
AutomationReentry = Literal["once", "every_time"]

class SegmentEnrollment(TypedDict):
    segment_id: str


class AllEnrollment(TypedDict):
    all: Literal[True]


AutomationEnrollment = SegmentEnrollment | AllEnrollment


class AutomationEnrollmentCounts(TypedDict):
    total: int
    processed: int
    enrolled: int
    skipped: int
    failed: int


class AutomationEnrollmentJob(TypedDict):
    object: Literal["automation_enrollment_job"]
    id: str
    automation_id: str
    segment_id: str | None
    status: Literal["queued", "in_progress", "completed", "failed", "cancelled"]
    counts: AutomationEnrollmentCounts
    error: str | None
    created_at: str
    completed_at: str | None


AutomationStatus = Literal["enabled", "paused", "disabled"]

class AutomationDryRun(TypedDict):
    stranded_runs: int
    by_step: dict[str, int]


class Automation(TypedDict):
    id: str
    trigger: str | None
    trigger_config: AutomationTriggerConfig
    reentry: AutomationReentry
    object: NotRequired[str]
    name: NotRequired[str]
    status: AutomationStatus
    version: int
    steps: NotRequired[list[dict[str, Any]]]
    connections: NotRequired[list[dict[str, Any]]]
    created_at: NotRequired[str]
    updated_at: NotRequired[str]
    request_id: NotRequired[str]


class AutomationStepInput(TypedDict, total=False):
    key: str
    type: Literal[
        "trigger", "send_email", "delay", "wait_for_event", "condition",
        "add_to_segment", "contact_update", "contact_delete", "exit", "filter", "branch",
    ]
    config: AutomationTriggerConfig | SendEmailConfig | ExitConfig | FilterConfig | BranchConfig | Rule | dict[str, Any]


AutomationConnectionInput = TypedDict(
    "AutomationConnectionInput",
    {
        "from": str,
        "to": str,
        "type": NotRequired[Literal["default", "condition_met", "condition_not_met", "timeout", "event_received", "branch"]],
        "path": NotRequired[str],
    },
)


class AutomationInput(TypedDict, total=False):
    name: str
    status: Literal["enabled", "disabled"]
    enabled: bool
    steps: list[AutomationStepInput | dict[str, Any]]
    connections: list[AutomationConnectionInput | dict[str, Any]]
    trigger: str
    reentry: AutomationReentry


class AutomationUpdateInput(TypedDict, total=False):
    name: str
    status: AutomationStatus
    enabled: bool
    steps: list[AutomationStepInput | dict[str, Any]]
    connections: list[AutomationConnectionInput | dict[str, Any]]
    trigger: str
    reentry: AutomationReentry


class EventDefinitionInput(TypedDict, total=False):
    name: str
    schema: dict[str, Literal["string", "number", "boolean", "date"]]


class EventDefinition(TypedDict):
    id: str
    name: str
    schema: dict[str, PropertyType]
    object: NotRequired[str]
    fired_count: NotRequired[int]
    last_fired_at: NotRequired[str | None]


class EventList(TypedDict):
    object: Literal["list"]
    has_more: bool
    data: list[EventDefinition]
    request_id: NotRequired[str]


AutomationInstallInput = TypedDict("AutomationInstallInput", {
    "from": str,
    "name": NotRequired[str],
    "topic_id": NotRequired[str],
})


class InstalledTemplate(TypedDict):
    id: str
    slug: str


class InstallationTemplates(TypedDict):
    created: list[InstalledTemplate]
    reused: list[InstalledTemplate]


class InstalledEvent(TypedDict):
    id: str
    name: str


class InstalledProperty(TypedDict):
    id: str
    key: str
    type: PropertyType


class AutomationInstallation(TypedDict):
    automation: Automation
    templates: InstallationTemplates
    events: list[InstalledEvent]
    properties: list[InstalledProperty]
    next_steps: list[str]
    request_id: NotRequired[str]


LibraryStage = Literal["acquisition", "onboarding", "retention", "reengagement", "dunning", "reactivation"]


class AutomationPresetEvent(TypedDict):
    name: str
    schema: dict[str, PropertyType]


class AutomationPresetProperty(TypedDict):
    key: str
    type: PropertyType


class AutomationPreset(TypedDict):
    """Read-only definition. Templates are library slugs, not tenant IDs.

    Newsletter topic_id is the {{topic_id}} install placeholder.
    """
    slug: str
    name: str
    stage: LibraryStage
    description: str
    when: str
    trigger_config: AutomationTriggerConfig
    reentry: AutomationReentry
    events: list[AutomationPresetEvent]
    properties: list[AutomationPresetProperty]
    steps: list[AutomationStepInput]
    connections: list[AutomationConnectionInput]
    templates: list[str]


class AutomationPresetDetail(AutomationPreset):
    object: Literal["automation_preset"]


class AutomationPresetList(TypedDict):
    object: Literal["list"]
    has_more: bool
    data: list[AutomationPreset]
    request_id: NotRequired[str]


class WebhookInput(TypedDict, total=False):
    endpoint: str
    events: list[str]
    status: Literal["enabled", "disabled"]


class DomainInput(TypedDict, total=False):
    name: str
    region: str
    custom_return_path: str
    open_tracking: bool
    click_tracking: bool
    tracking_subdomain: str
    tls: Literal["opportunistic", "enforced"]
    capabilities: dict[str, str]


class DispatchError(Exception):
    """Raised for a non-2xx response, or with status None when the request never got one."""

    def __init__(self, status: int | None, body: Any, request_id: str | None = None) -> None:
        self.status = status
        self.body = body
        if request_id:
            self.request_id: str | None = request_id
        elif isinstance(body, dict) and body.get("request_id"):
            self.request_id = str(body["request_id"])
        else:
            self.request_id = None
        self.name = body.get("name") if isinstance(body, dict) else None
        message = body.get("message") if isinstance(body, dict) else str(body)
        super().__init__(f"{status} {message}" if status is not None else str(message))


def _path(*parts: str) -> str:
    return "/" + "/".join(urllib.parse.quote(part, safe="") for part in parts)


def _query(path: str, params: dict[str, Any]) -> str:
    pairs: list[tuple[str, str]] = []
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            pairs.extend((key, str(item)) for item in value)
        elif isinstance(value, bool):
            pairs.append((key, "true" if value else "false"))
        else:
            pairs.append((key, str(value)))
    text = urllib.parse.urlencode(pairs)
    return f"{path}?{text}" if text else path


def _origin(url: str) -> tuple[str, str | None, int | None]:
    parsed = urllib.parse.urlsplit(url)
    port = parsed.port
    if port is None:
        port = {"http": 80, "https": 443}.get(parsed.scheme)
    return parsed.scheme, parsed.hostname, port


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, base_url: str) -> None:
        self.origin = _origin(base_url)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            same_origin = _origin(newurl) == self.origin
        except ValueError:
            same_origin = False
        if not same_origin:
            fp.close()
            raise urllib.error.URLError("Redirect to a different API origin is not allowed")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Dispatch:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        user_agent: str = "dispatch-python:0.1.0",
    ) -> None:
        self.api_key = api_key or os.getenv("DISPATCH_API_KEY")
        if not self.api_key:
            raise ValueError("Dispatch API key is required")
        # DISPATCH_API_URL is the name the CLI uses. The generic API_URL is not read: many
        # unrelated projects set it, and the key must not go to whatever host it names.
        url = base_url or os.getenv("DISPATCH_BASE_URL") or os.getenv("DISPATCH_API_URL") or "http://localhost:3100"
        self.base_url = url.rstrip("/")
        self.user_agent = user_agent

    # Platform
    def health(self) -> Json:
        return self._request("GET", "/health", auth=False)

    def setup(self) -> Json:
        # Sent with the key. Where public setup is on the route ignores it; in production it needs it.
        return self._request("GET", "/setup")

    def me(self) -> Json:
        return self._request("GET", "/me")

    def settings(self) -> Json:
        return self._request("GET", "/settings")

    def update_settings(self, settings: Json) -> Json:
        return self._request("PATCH", "/settings", settings)

    def users(self, **query: Any) -> Json:
        return self._request("GET", _query("/users", query))

    def create_user(self, user: Json) -> Json:
        return self._request("POST", "/users", user)

    def update_user(self, user_id: str, user: Json) -> Json:
        return self._request("PATCH", _path("users", user_id), user)

    def delete_user(self, user_id: str) -> Json:
        return self._request("DELETE", _path("users", user_id))

    def roles(self, **query: Any) -> Json:
        return self._request("GET", _query("/roles", query))

    def create_role(self, role: Json) -> Json:
        return self._request("POST", "/roles", role)

    def update_role(self, role_id: str, role: Json) -> Json:
        return self._request("PATCH", _path("roles", role_id), role)

    def delete_role(self, role_id: str) -> Json:
        return self._request("DELETE", _path("roles", role_id))

    def memberships(self, **query: Any) -> Json:
        return self._request("GET", _query("/memberships", query))

    def create_membership(self, user_id: str, role_id: str) -> Json:
        return self._request("POST", "/memberships", {"user_id": user_id, "role_id": role_id})

    def delete_membership(self, membership_id: str) -> Json:
        return self._request("DELETE", _path("memberships", membership_id))

    def sessions(self, **query: Any) -> Json:
        return self._request("GET", _query("/sessions", query))

    def create_session(self, email: str, password: str) -> Json:
        return self._request("POST", "/sessions", {"email": email, "password": password}, auth=False)

    def delete_session(self, session_id: str) -> Json:
        return self._request("DELETE", _path("sessions", session_id))

    def audit_logs(self, **query: Any) -> Json:
        return self._request("GET", _query("/audit-logs", query))

    # Emails
    def send(self, email: SendInput | Json, idempotency_key: str | None = None) -> SendResult:
        return cast(SendResult, self._request("POST", "/emails", email, idempotency_key=idempotency_key))

    def batch(
        self,
        emails: list[SendInput | Json],
        idempotency_key: str | None = None,
        batch_validation: Literal["strict", "permissive"] | None = None,
    ) -> Json:
        headers = {"x-batch-validation": batch_validation} if batch_validation else None
        return self._request("POST", "/emails/batch", emails, idempotency_key=idempotency_key, headers=headers)

    def emails(self, **query: Any) -> Json:
        """Return email dictionaries with sandbox true only for entirely simulated sends."""
        return self._request("GET", _query("/emails", query))

    def email(self, email_id: str) -> Json:
        """Return the email and recipients, each with a sandbox flag; sandbox never sends externally."""
        return self._request("GET", _path("emails", email_id))

    def update_email(self, email_id: str, email: EmailUpdateInput | Json) -> Json:
        return self._request("PATCH", _path("emails", email_id), email)

    def cancel_email(self, email_id: str) -> Json:
        return self._request("POST", _path("emails", email_id, "cancel"), {})

    def retry_email(self, email_id: str) -> Json:
        return self._request("POST", _path("emails", email_id, "retry"), {})

    def email_jobs(self, **query: Any) -> Json:
        return self._request("GET", _query("/email-jobs", query))

    def email_job(self, job_id: str) -> Json:
        return self._request("GET", _path("email-jobs", job_id))

    def email_attachments(self, email_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("emails", email_id, "attachments"), query))

    def email_attachment(self, email_id: str, attachment_id: str) -> Json:
        return self._request("GET", _path("emails", email_id, "attachments", attachment_id))

    def email_events(self, email_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("emails", email_id, "events"), query))

    def email_metrics(self, **query: Any) -> Json:
        return self._request("GET", _query("/emails/metrics", query))

    def share_email(self, email_id: str, expires_in: str | None = None) -> Json:
        body: Json = {} if expires_in is None else {"expires_in": expires_in}
        return self._request("POST", _path("emails", email_id, "share"), body)

    # Received emails
    def received_emails(self, **query: Any) -> Json:
        return self._request("GET", _query("/emails/receiving", query))

    def received_email(self, email_id: str, html_format: str | None = None) -> Json:
        return self._request("GET", _query(_path("emails", "receiving", email_id), {"html_format": html_format}))

    def simulate_received_email(self, email: Json) -> Json:
        return self._request("POST", "/emails/receiving/simulate", email)

    def received_attachments(self, email_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("emails", "receiving", email_id, "attachments"), query))

    def received_attachment(self, email_id: str, attachment_id: str) -> Json:
        return self._request("GET", _path("emails", "receiving", email_id, "attachments", attachment_id))

    def forward_received_email(
        self, email_id: str, to: str | list[str], from_: str, idempotency_key: str | None = None
    ) -> Json:
        # The HTML keeps its cid: references and the inline images travel as inline attachments.
        # Inlined as data URIs the HTML can pass the 1 MB limit, and Gmail and Outlook do not
        # show data images.
        received = self.received_email(email_id, html_format="cid")
        attachments = self._received_files(email_id)
        subject = received.get("subject") or "(no subject)"
        email: Json = {
            "from": from_,
            "to": to,
            "subject": subject if subject.lower().startswith("fwd:") else f"Fwd: {subject}",
        }
        if received.get("html"):
            email["html"] = received["html"]
        if received.get("text"):
            email["text"] = received["text"]
        if attachments:
            email["attachments"] = attachments
        return self.send(email, idempotency_key=idempotency_key)

    def _received_files(self, email_id: str) -> list[Json]:
        """A received email's attachments, downloaded through their signed URLs."""
        files: list[Json] = []
        for item in self.received_attachments(email_id, limit=100).get("data") or []:
            link = item.get("download_url")
            if not link:
                continue
            name = item.get("filename") or "attachment"
            try:
                # No API key: the signed URL is its own credential.
                with urllib.request.urlopen(urllib.request.Request(link, method="GET"), timeout=30) as response:
                    content = response.read()
            except (urllib.error.URLError, OSError) as error:
                status = error.code if isinstance(error, urllib.error.HTTPError) else None
                raise DispatchError(
                    status, {"name": "application_error", "message": f"Could not download the attachment {name}"}
                ) from error
            file: Json = {"filename": name, "content": base64.b64encode(content).decode("ascii")}
            if item.get("content_type"):
                file["content_type"] = item["content_type"]
            if item.get("content_id"):
                file["content_id"] = item["content_id"]
            files.append(file)
        return files

    # Domains
    def domains(self, **query: Any) -> Json:
        return self._request("GET", _query("/domains", query))

    def create_domain(self, domain: DomainInput | Json) -> Json:
        return self._request("POST", "/domains", domain)

    def domain(self, domain_id: str) -> Json:
        return self._request("GET", _path("domains", domain_id))

    def update_domain(self, domain_id: str, domain: DomainInput | Json) -> Json:
        return self._request("PATCH", _path("domains", domain_id), domain)

    def verify_domain(self, domain_id: str) -> Json:
        return self._request("POST", _path("domains", domain_id, "verify"), {})

    def doctor_domain(self, domain_id: str) -> Json:
        return self._request("GET", _path("domains", domain_id, "doctor"))

    def publish_route53(self, domain_id: str) -> Json:
        return self._request("POST", _path("domains", domain_id, "publish-route53"), {})

    def delete_domain(self, domain_id: str) -> Json:
        return self._request("DELETE", _path("domains", domain_id))

    # API keys
    def api_keys(self, **query: Any) -> Json:
        return self._request("GET", _query("/api-keys", query))

    def create_api_key(self, api_key: Json) -> Json:
        return self._request("POST", "/api-keys", api_key)

    def update_api_key(self, api_key_id: str, name: str) -> Json:
        return self._request("PATCH", _path("api-keys", api_key_id), {"name": name})

    def delete_api_key(self, api_key_id: str) -> Json:
        return self._request("DELETE", _path("api-keys", api_key_id))

    # Brand and template library
    def brand(self) -> Json:
        return self._request("GET", "/brand")
    def update_library_templates(self) -> Json:
        return self._request("POST", "/brand/update-library")
    def goals(self, **query: Any) -> Json:
        return self._request("GET", _query("/goals", query))
    def goal(self, goal_id: str) -> Json:
        return self._request("GET", _path("goals", goal_id))
    def create_goal(self, goal: Json) -> Json:
        return self._request("POST", "/goals", goal)
    def update_goal(self, goal_id: str, goal: Json) -> Json:
        return self._request("PATCH", _path("goals", goal_id), goal)
    def delete_goal(self, goal_id: str) -> Json:
        return self._request("DELETE", _path("goals", goal_id))
    def goal_metrics(self, goal_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("goals", goal_id) + "/metrics", query))

    def update_brand(self, brand: Json) -> Json:
        return self._request("PATCH", "/brand", brand)

    def template_library(self) -> Json:
        return self._request("GET", "/template-library")

    def template_library_entry(self, slug: str) -> Json:
        return self._request("GET", _path("template-library", slug))

    def template_library_automations(self) -> AutomationPresetList:
        return cast(AutomationPresetList, self._request("GET", "/template-library/automations"))

    def template_library_automation(self, slug: str) -> AutomationPresetDetail:
        return cast(AutomationPresetDetail, self._request("GET", _path("template-library", "automations", slug)))

    def template_library_install_automation(self, slug: str, **options: Any) -> AutomationInstallation:
        """Install disabled. Pass from via **{"from": sender}; newsletter requires topic_id."""
        return cast(AutomationInstallation, self._request("POST", _path("template-library", "automations", slug, "install"), options))

    def install_template(self, slug: str, options: Json | None = None) -> Json:
        return self._request("POST", _path("template-library", slug, "install"), options or {})

    # Templates
    def templates(self, **query: Any) -> Json:
        return self._request("GET", _query("/templates", query))

    def create_template(self, template: TemplateInput | Json) -> Json:
        return self._request("POST", "/templates", template)

    def template(self, template_id: str) -> Json:
        return self._request("GET", _path("templates", template_id))

    def update_template(self, template_id: str, template: TemplateUpdateInput | Json) -> Json:
        return self._request("PATCH", _path("templates", template_id), template)

    def publish_template(self, template_id: str, version_id: str | None = None) -> Json:
        body: Json = {"version_id": version_id} if version_id else {}
        return self._request("POST", _path("templates", template_id, "publish"), body)

    def duplicate_template(self, template_id: str, name: str | None = None) -> Json:
        body: Json = {"name": name} if name else {}
        return self._request("POST", _path("templates", template_id, "duplicate"), body)

    def template_versions(self, template_id: str) -> Json:
        return self._request("GET", _path("templates", template_id, "versions"))

    def create_template_version(self, template_id: str, version: Json) -> Json:
        return self._request("POST", _path("templates", template_id, "versions"), version)

    def render_template(self, template_id: str, variables: Json | None = None) -> Json:
        return self._request("POST", _path("templates", template_id, "render"), {"variables": variables or {}})

    def delete_template(self, template_id: str) -> Json:
        return self._request("DELETE", _path("templates", template_id))

    # Contacts. Every contact argument is an ID or an email address.
    def contacts(self, **query: Any) -> Json:
        return self._request("GET", _query("/contacts", query))

    def create_contact(self, contact: ContactInput | Json) -> Json:
        return self._request("POST", "/contacts", contact)

    def contact(self, contact: str) -> Json:
        return self._request("GET", _path("contacts", contact))

    def update_contact(self, contact: str, update: ContactUpdateInput | Json) -> Json:
        return self._request("PATCH", _path("contacts", contact), update)

    def delete_contact(self, contact: str) -> Json:
        return self._request("DELETE", _path("contacts", contact))

    def contact_activity(self, contact: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("contacts", contact, "activity"), query))

    def contact_segments(self, contact: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("contacts", contact, "segments"), query))

    def add_contact_segment(self, contact: str, segment_id: str) -> Json:
        return self._request("POST", _path("contacts", contact, "segments", segment_id), {})

    def remove_contact_segment(self, contact: str, segment_id: str) -> Json:
        return self._request("DELETE", _path("contacts", contact, "segments", segment_id))

    def contact_topics(self, contact: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("contacts", contact, "topics"), query))

    def update_contact_topics(self, contact: str, topics: list[dict[str, str]]) -> Json:
        return self._request("PATCH", _path("contacts", contact, "topics"), {"topics": topics})

    # Contact imports
    def import_contacts(
        self,
        file: bytes | str,
        column_map: ImportColumnMap | Json | None = None,
        on_conflict: Literal["upsert", "skip"] | None = None,
        segments: list[dict[str, str]] | None = None,
        topics: list[dict[str, str]] | None = None,
        filename: str = "contacts.csv",
        trigger_automations: bool | None = None,
    ) -> Json:
        """Omit trigger_automations to store the tenant default at creation.

        Create, list and detail responses include the stored trigger_automations boolean.
        """
        fields: dict[str, str] = {}
        if column_map is not None:
            fields["column_map"] = json.dumps(column_map)
        if on_conflict is not None:
            fields["on_conflict"] = on_conflict
        if segments is not None:
            fields["segments"] = json.dumps(segments)
        if topics is not None:
            fields["topics"] = json.dumps(topics)
        if trigger_automations is not None:
            fields["trigger_automations"] = json.dumps(trigger_automations)
        content = file.encode("utf-8") if isinstance(file, str) else file
        body, content_type = _multipart(fields, "file", filename, content)
        return self._request("POST", "/contacts/imports", raw=(body, content_type))

    def contact_imports(self, **query: Any) -> Json:
        return self._request("GET", _query("/contacts/imports", query))

    def contact_import(self, import_id: str) -> Json:
        return self._request("GET", _path("contacts", "imports", import_id))

    def cancel_contact_import(self, import_id: str) -> Json:
        return self._request("DELETE", _path("contacts", "imports", import_id))

    # Contact properties
    def contact_properties(self, **query: Any) -> Json:
        return self._request("GET", _query("/contact-properties", query))

    def create_contact_property(self, prop: ContactPropertyInput | Json) -> Json:
        return self._request("POST", "/contact-properties", prop)

    def contact_property(self, property_id: str) -> Json:
        return self._request("GET", _path("contact-properties", property_id))

    def update_contact_property(self, property_id: str, fallback_value: PropertyValue) -> Json:
        return self._request("PATCH", _path("contact-properties", property_id), {"fallback_value": fallback_value})

    def delete_contact_property(self, property_id: str) -> Json:
        return self._request("DELETE", _path("contact-properties", property_id))

    # Suppressions. Lookups and deletes take an ID or an email address.
    def suppressions(self, **query: Any) -> Json:
        return self._request("GET", _query("/suppressions", query))

    def suppress(self, suppression: SuppressionInput | Json | str) -> Json:
        body = {"email": suppression} if isinstance(suppression, str) else suppression
        return self._request("POST", "/suppressions", body)

    def suppression(self, suppression: str) -> Json:
        return self._request("GET", _path("suppressions", suppression))

    def unsuppress(self, suppression: str) -> Json:
        return self._request("DELETE", _path("suppressions", suppression))

    def suppress_batch(self, emails: list[str]) -> Json:
        return self._request("POST", "/suppressions/batch/add", {"emails": emails})

    def unsuppress_batch(self, emails: list[str] | None = None, ids: list[str] | None = None) -> Json:
        body: Json = {"emails": emails} if emails is not None else {"ids": ids}
        return self._request("POST", "/suppressions/batch/remove", body)

    # Topics
    def topics(self, **query: Any) -> Json:
        return self._request("GET", _query("/topics", query))

    def create_topic(self, topic: TopicInput | Json) -> Json:
        return self._request("POST", "/topics", topic)

    def topic(self, topic_id: str) -> Json:
        return self._request("GET", _path("topics", topic_id))

    def update_topic(self, topic_id: str, topic: TopicUpdateInput | Json) -> Json:
        return self._request("PATCH", _path("topics", topic_id), topic)

    def delete_topic(self, topic_id: str) -> Json:
        return self._request("DELETE", _path("topics", topic_id))

    def topic_subscriptions(self, topic_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("topics", topic_id, "subscriptions"), query))

    def subscribe_topic(
        self,
        topic_id: str,
        subscription: TopicSubscriptionInput | Json | str,
        status: Literal["subscribed", "unsubscribed"] = "subscribed",
    ) -> Json:
        body = {"email": subscription, "status": status} if isinstance(subscription, str) else subscription
        return self._request("POST", _path("topics", topic_id, "subscriptions"), body)

    def unsubscribe_topic(self, topic_id: str, email: str) -> Json:
        return self.subscribe_topic(topic_id, email, status="unsubscribed")

    # Public signup form management (authenticated; browser submissions need no key).
    def forms(self, **query: Any) -> Json:
        return self._request("GET", _query("/forms", query))

    def form(self, form_id: str) -> Json:
        return self._request("GET", _path("forms", form_id))

    def create_form(self, form: Json) -> Json:
        return self._request("POST", "/forms", form)

    def update_form(self, form_id: str, form: Json) -> Json:
        return self._request("PATCH", _path("forms", form_id), form)

    def delete_form(self, form_id: str) -> Json:
        return self._request("DELETE", _path("forms", form_id))

    # Credentials appear only in create/rotate responses, never ordinary GETs.
    def integrations(self, **query: Any) -> Json:
        return self._request("GET", _query("/integrations", query))

    def integration(self, integration_id: str) -> Json:
        return self._request("GET", _path("integrations", integration_id))

    def create_integration(self, integration: Json) -> Json:
        return self._request("POST", "/integrations", integration)

    def update_integration(self, integration_id: str, integration: Json) -> Json:
        return self._request("PATCH", _path("integrations", integration_id), integration)

    def delete_integration(self, integration_id: str) -> Json:
        return self._request("DELETE", _path("integrations", integration_id))

    def rotate_integration(self, integration_id: str) -> Json:
        return self._request("POST", _path("integrations", integration_id, "rotate"), {})

    def integration_deliveries(self, integration_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("integrations", integration_id, "deliveries"), query))

    # Segments
    def segments(self, **query: Any) -> Json:
        return self._request("GET", _query("/segments", query))

    def preview_segment(self, rule: Rule) -> Json:
        return self._request("POST", "/segments/preview", {"rule": rule})

    def create_segment(self, segment: SegmentInput | Json) -> Json:
        return self._request("POST", "/segments", segment)

    def segment(self, segment_id: str) -> Json:
        return self._request("GET", _path("segments", segment_id))

    def update_segment(self, segment_id: str, segment: SegmentUpdateInput | Json) -> Json:
        return self._request("PATCH", _path("segments", segment_id), segment)

    def delete_segment(self, segment_id: str) -> Json:
        return self._request("DELETE", _path("segments", segment_id))

    def segment_contacts(self, segment_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("segments", segment_id, "contacts"), query))

    def add_segment_contact(self, segment_id: str, contact: SegmentContactInput | Json | str) -> Json:
        body = {"email": contact} if isinstance(contact, str) else contact
        return self._request("POST", _path("segments", segment_id, "contacts"), body)

    def remove_segment_contact(self, segment_id: str, contact_id: str) -> Json:
        return self._request("DELETE", _path("segments", segment_id, "contacts", contact_id))

    # Broadcasts
    def broadcasts(self, **query: Any) -> Json:
        return self._request("GET", _query("/broadcasts", query))

    def create_broadcast(self, broadcast: BroadcastInput | Json) -> Json:
        return self._request("POST", "/broadcasts", broadcast)

    def broadcast(self, broadcast_id: str) -> Json:
        return self._request("GET", _path("broadcasts", broadcast_id))

    def update_broadcast(self, broadcast_id: str, broadcast: BroadcastUpdateInput | Json) -> Json:
        return self._request("PATCH", _path("broadcasts", broadcast_id), broadcast)

    def delete_broadcast(self, broadcast_id: str) -> Json:
        return self._request("DELETE", _path("broadcasts", broadcast_id))

    def send_broadcast(self, broadcast_id: str, scheduled_at: str | None = None) -> Json:
        body: Json = {"scheduled_at": scheduled_at} if scheduled_at else {}
        return self._request("POST", _path("broadcasts", broadcast_id, "send"), body)

    def pause_broadcast(self, broadcast_id: str) -> Json:
        return self._request("POST", _path("broadcasts", broadcast_id, "pause"), {})

    def resume_broadcast(self, broadcast_id: str) -> Json:
        return self._request("POST", _path("broadcasts", broadcast_id, "resume"), {})

    def cancel_broadcast(self, broadcast_id: str) -> Json:
        return self._request("POST", _path("broadcasts", broadcast_id, "cancel"), {})

    def duplicate_broadcast(self, broadcast_id: str, name: str | None = None) -> Json:
        body: Json = {"name": name} if name else {}
        return self._request("POST", _path("broadcasts", broadcast_id, "duplicate"), body)

    def broadcast_recipients(self, broadcast_id: str, type: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("broadcasts", broadcast_id, "recipients"), {"type": type, **query}))

    def broadcast_clicked_links(self, broadcast_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("broadcasts", broadcast_id, "clicked-links"), query))

    def broadcast_audience(self, broadcast_id: str) -> Json:
        """Who a send would reach now, and how many are left out and why."""
        return self._request("GET", _path("broadcasts", broadcast_id, "audience"))

    # Automations
    def enroll(self, automation_id: str, enrollment: AutomationEnrollment, idempotency_key: str | None = None) -> AutomationEnrollmentJob:
        """Enroll current live contacts into an enabled, unpaused contact flow."""
        return self._request("POST", _path("automations", automation_id, "enroll"), enrollment, idempotency_key=idempotency_key)

    def get_enrollment_job(self, automation_id: str, job_id: str) -> AutomationEnrollmentJob:
        return self._request("GET", _path("automations", automation_id, "enroll-jobs", job_id))

    def cancel_enrollment_job(self, automation_id: str, job_id: str) -> AutomationEnrollmentJob:
        """Cancel between batches, without cancelling already-created runs."""
        return self._request("DELETE", _path("automations", automation_id, "enroll-jobs", job_id))

    def automations(self, **query: Any) -> Json:
        return self._request("GET", _query("/automations", query))

    def create_automation(self, automation: AutomationInput | Json) -> Json:
        return self._request("POST", "/automations", automation)

    def automation(self, automation_id: str) -> Json:
        return self._request("GET", _path("automations", automation_id))

    def update_automation(self, automation_id: str, automation: AutomationUpdateInput | Json) -> Json:
        return self._request("PATCH", _path("automations", automation_id), automation)

    def dry_run_automation(self, automation_id: str, automation: AutomationUpdateInput | Json) -> AutomationDryRun:
        """Preview an ordinary update with the same validation, without saving changes."""
        return self._request("PATCH", _query(_path("automations", automation_id), {"dry_run": "true"}), automation)

    def delete_automation(self, automation_id: str) -> Json:
        return self._request("DELETE", _path("automations", automation_id))

    def duplicate_automation(self, automation_id: str) -> Json:
        return self._request("POST", _path("automations", automation_id, "duplicate"), {})

    def stop_automation(self, automation_id: str, reset_reentry: bool | None = None) -> Json:
        """Optionally reset once enrollments only for contacts whose active runs are cancelled."""
        body: Json = {} if reset_reentry is None else {"reset_reentry": reset_reentry}
        return self._request("POST", _path("automations", automation_id, "stop"), body)

    def automation_runs(self, automation_id: str, **query: Any) -> AutomationRunList:
        return self._request("GET", _query(_path("automations", automation_id, "runs"), query))

    def automation_run(self, automation_id: str, run_id: str) -> AutomationRun:
        return self._request("GET", _path("automations", automation_id, "runs", run_id))

    def automation_run_metrics(self, automation_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("automations", automation_id, "runs", "metrics"), query))

    # Events. /events holds definitions, /events/send fires one, /fired-events lists what fired.
    def send_event(
        self,
        event: str,
        payload: Json | None = None,
        contact_id: str | None = None,
        email: str | None = None,
    ) -> Json:
        body: Json = {"event": event, "payload": payload or {}}
        if contact_id:
            body["contact_id"] = contact_id
        if email:
            body["email"] = email
        return self._request("POST", "/events/send", body)

    def events(self, **query: Any) -> EventList:
        return cast(EventList, self._request("GET", _query("/events", query)))

    def create_event(self, event: EventDefinitionInput | Json) -> Json:
        return self._request("POST", "/events", event)

    def event(self, event: str) -> EventDefinition:
        return cast(EventDefinition, self._request("GET", _path("events", event)))

    def update_event(self, event: str, schema: Json) -> Json:
        return self._request("PATCH", _path("events", event), {"schema": schema})

    def delete_event(self, event: str) -> Json:
        return self._request("DELETE", _path("events", event))

    def fired_events(self, **query: Any) -> Json:
        return self._request("GET", _query("/fired-events", query))

    def fired_event(self, event_id: str) -> Json:
        return self._request("GET", _path("fired-events", event_id))

    # Webhooks
    def webhooks(self, **query: Any) -> Json:
        return self._request("GET", _query("/webhooks", query))

    def create_webhook(self, webhook: WebhookInput | Json) -> Json:
        return self._request("POST", "/webhooks", webhook)

    def webhook(self, webhook_id: str) -> Json:
        return self._request("GET", _path("webhooks", webhook_id))

    def update_webhook(self, webhook_id: str, webhook: Json) -> Json:
        return self._request("PATCH", _path("webhooks", webhook_id), webhook)

    def delete_webhook(self, webhook_id: str) -> Json:
        return self._request("DELETE", _path("webhooks", webhook_id))

    def rotate_webhook_secret(self, webhook_id: str) -> Json:
        return self._request("POST", _path("webhooks", webhook_id, "signing-secret", "rotate"), {})

    def webhook_events(self, webhook_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("webhooks", webhook_id, "events"), query))

    def webhook_event(self, webhook_id: str, event_id: str) -> Json:
        return self._request("GET", _path("webhooks", webhook_id, "events", event_id))

    def webhook_event_attempts(self, webhook_id: str, event_id: str, **query: Any) -> Json:
        return self._request("GET", _query(_path("webhooks", webhook_id, "events", event_id, "attempts"), query))

    def replay_webhook(self, webhook_id: str, event_id: str) -> Json:
        return self._request("POST", _path("webhooks", webhook_id, "events", event_id, "replay"), {})

    def test_webhook(self) -> Json:
        return self._request("POST", "/webhooks/test", {})

    # Logs, usage, and system
    def logs(self, **query: Any) -> Json:
        return self._request("GET", _query("/logs", query))

    def log(self, log_id: str) -> Json:
        return self._request("GET", _path("logs", log_id))

    def logs_export(self) -> Json:
        return self._request("GET", "/logs/export")

    def timeline(self, **query: Any) -> Json:
        return self._request("GET", _query("/timeline", query))

    def usage(self) -> Json:
        return self._request("GET", "/usage")

    def system(self) -> Json:
        return self._request("GET", "/system")

    def check_links(self, urls: list[str]) -> Json:
        return self._request("POST", "/links/check", {"urls": urls})

    def _request(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        *,
        auth: bool = True,
        idempotency_key: str | None = None,
        headers: dict[str, str] | None = None,
        raw: tuple[bytes, str] | None = None,
    ) -> Json:
        sent = {"accept": "application/json", "user-agent": self.user_agent}
        data: bytes | None = None
        if raw is not None:
            data, sent["content-type"] = raw
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            sent["content-type"] = "application/json"
        if auth:
            sent["authorization"] = f"Bearer {self.api_key}"
        if idempotency_key:
            sent["idempotency-key"] = idempotency_key
        sent.update(headers or {})

        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=sent, method=method)
        try:
            opener = urllib.request.build_opener(_SameOriginRedirectHandler(self.base_url))
            with opener.open(request, timeout=30) as response:
                text = response.read().decode("utf-8", errors="replace")
                status = response.status
                request_id = response.headers.get("x-request-id")
            if not text:
                return {}
            try:
                return json.loads(text)
            except json.JSONDecodeError as error:
                # A proxy's HTML page, for example. Callers catch DispatchError, not a JSON error.
                body = {"name": "application_error", "message": "The response was not JSON"}
                raise DispatchError(status, body, request_id=request_id) from error
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", errors="replace")
            try:
                parsed: Any = json.loads(text)
            except json.JSONDecodeError:
                parsed = {"name": "application_error", "message": text or error.reason}
            raise DispatchError(error.code, parsed, request_id=error.headers.get("x-request-id")) from error
        except (urllib.error.URLError, OSError) as error:
            reason = getattr(error, "reason", error)
            body = {"name": "application_error", "message": f"Unable to fetch data. The request could not be resolved: {reason}"}
            raise DispatchError(None, body) from error


def _header_value(value: str) -> str:
    # A quote or a line break in a file name would break out of the part header.
    return value.replace("\\", "_").replace('"', "_").replace("\r", " ").replace("\n", " ")


def _multipart(fields: dict[str, str], name: str, filename: str, content: bytes) -> tuple[bytes, str]:
    boundary = f"dispatch-{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for key, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{_header_value(filename)}"\r\n'
        "Content-Type: text/csv\r\n\r\n".encode("utf-8")
        + content
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


__all__ = [
    "Dispatch",
    "DispatchError",
    "SendInput",
    "SendResult",
    "SplitEmail",
    "ContactActivity",
    "LifecycleEventType",
    "AutomationRunEvent",
    "AutomationExitReason",
    "AutomationGuard",
    "AutomationRun",
    "AutomationRunList",
    "AutomationRunStep",
    "Operator",
    "Rule",
    "PredicateRule",
    "RuleGroup",
    "ExitConfig",
    "FilterConfig",
    "BranchPath",
    "BranchConfig",
    "EmailUpdateInput",
    "TemplateInput",
    "SendKind",
    "TemplateUpdateInput",
    "TemplateVariableInput",
    "ContactInput",
    "ContactUpdateInput",
    "ContactPropertyInput",
    "PropertyType",
    "PropertyValue",
    "ImportColumn",
    "ImportColumnMap",
    "SuppressionInput",
    "TopicInput",
    "TopicUpdateInput",
    "TopicSubscriptionInput",
    "SegmentInput",
    "SegmentUpdateInput",
    "SegmentContactInput",
    "BroadcastInput",
    "BroadcastUpdateInput",
    "AutomationInput",
    "Automation",
    "AutomationDryRun",
    "AutomationTriggerConfig",
    "AutomationReentry",
    "AutomationEnrollment",
    "SegmentEnrollment",
    "AllEnrollment",
    "AutomationEnrollmentCounts",
    "AutomationEnrollmentJob",
    "EventTriggerConfig",
    "ContactCreatedTriggerConfig",
    "ContactUpdatedTriggerConfig",
    "TopicSubscribedTriggerConfig",
    "SegmentAddedTriggerConfig",
    "AutomationUpdateInput",
    "AutomationStepInput",
    "SendEmailConfig",
    "AutomationConnectionInput",
    "EventDefinitionInput",
    "EventDefinition",
    "EventList",
    "AutomationInstallInput",
    "AutomationInstallation",
    "InstalledTemplate",
    "InstallationTemplates",
    "InstalledEvent",
    "InstalledProperty",
    "AutomationPreset",
    "AutomationPresetDetail",
    "AutomationPresetList",
    "AutomationPresetEvent",
    "AutomationPresetProperty",
    "LibraryStage",
    "WebhookInput",
    "DomainInput",
    "AttachmentInput",
    "TagInput",
]
