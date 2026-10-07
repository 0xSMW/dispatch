import base64
import json
import io
import socket
import threading
import unittest
import urllib.request
import urllib.response
from email.message import Message
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch
from typing import Literal, NotRequired, get_args, get_type_hints

from dispatch import (
    Automation, AutomationConnectionInput, AutomationDryRun, AutomationExitReason, AutomationGuard,
    AutomationInput, AutomationRun, AutomationRunEvent, AutomationRunList, AutomationStepInput,
    AutomationTriggerConfig, AutomationUpdateInput, BranchConfig, BranchPath, ContactActivity, ContactPropertyInput,
    AutomationPreset, AutomationPresetDetail, AutomationPresetEvent, AutomationPresetList, AutomationPresetProperty, LibraryStage,
    AutomationInstallInput, AutomationInstallation, EventDefinition, EventList,
    Dispatch, DispatchError, ExitConfig, FilterConfig, ImportColumnMap, PredicateRule, RuleGroup,
    SendEmailConfig,
)


class Recorder(BaseHTTPRequestHandler):
    calls: list[dict] = []
    responses: dict[tuple[str, str], tuple[int, object]] = {}

    def _handle(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        content_type = self.headers.get("Content-Type", "")
        body = json.loads(raw) if raw and content_type.startswith("application/json") else raw
        Recorder.calls.append({
            "method": self.command,
            "path": self.path,
            "body": body,
            "headers": {key.lower(): value for key, value in self.headers.items()},
        })
        status, payload = Recorder.responses.get((self.command, self.path), (200, {"object": "ok", "id": "x"}))
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Request-Id", "req_py")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    do_GET = do_POST = do_PATCH = do_DELETE = _handle

    def log_message(self, format, *args):
        pass


CASES = [
    ("emails", lambda c: c.emails(limit=5, after="e0"), "GET", "/emails?limit=5&after=e0", None),
    ("email", lambda c: c.email("e1"), "GET", "/emails/e1", None),
    ("update_email", lambda c: c.update_email("e1", {"scheduled_at": "in 1 hour"}), "PATCH", "/emails/e1", {"scheduled_at": "in 1 hour"}),
    ("cancel_email", lambda c: c.cancel_email("e1"), "POST", "/emails/e1/cancel", {}),
    ("retry_email", lambda c: c.retry_email("e1"), "POST", "/emails/e1/retry", {}),
    ("email_jobs", lambda c: c.email_jobs(email_id="e1"), "GET", "/email-jobs?email_id=e1", None),
    ("email_job", lambda c: c.email_job("j1"), "GET", "/email-jobs/j1", None),
    ("email_attachments", lambda c: c.email_attachments("e1"), "GET", "/emails/e1/attachments", None),
    ("email_events", lambda c: c.email_events("e1"), "GET", "/emails/e1/events", None),
    ("email_metrics", lambda c: c.email_metrics(metrics=["sent", "open_rate"]), "GET", "/emails/metrics?metrics=sent&metrics=open_rate", None),
    ("automation_email_metrics", lambda c: c.email_metrics(dimensions="step", automation_id="a1"), "GET", "/emails/metrics?dimensions=step&automation_id=a1", None),
    ("share_email", lambda c: c.share_email("e1", "10m"), "POST", "/emails/e1/share", {"expires_in": "10m"}),
    ("received_emails", lambda c: c.received_emails(), "GET", "/emails/receiving", None),
    ("received_email", lambda c: c.received_email("r1", html_format="cid"), "GET", "/emails/receiving/r1?html_format=cid", None),
    ("received_attachment", lambda c: c.received_attachment("r1", "a1"), "GET", "/emails/receiving/r1/attachments/a1", None),
    ("simulate_received_email", lambda c: c.simulate_received_email({"from": "a@x.com"}), "POST", "/emails/receiving/simulate", {"from": "a@x.com"}),
    ("domain", lambda c: c.domain("d1"), "GET", "/domains/d1", None),
    ("update_domain", lambda c: c.update_domain("d1", {"tls": "enforced"}), "PATCH", "/domains/d1", {"tls": "enforced"}),
    ("publish_route53", lambda c: c.publish_route53("d1"), "POST", "/domains/d1/publish-route53", {}),
    ("api_keys", lambda c: c.api_keys(), "GET", "/api-keys", None),
    ("update_api_key", lambda c: c.update_api_key("k1", "ci"), "PATCH", "/api-keys/k1", {"name": "ci"}),
    ("delete_api_key", lambda c: c.delete_api_key("k1"), "DELETE", "/api-keys/k1", None),
    ("brand", lambda c: c.brand(), "GET", "/brand", None),
    ("settings", lambda c: c.settings(), "GET", "/settings", None),
    ("update_settings", lambda c: c.update_settings({"import_trigger_automations": True}), "PATCH", "/settings", {"import_trigger_automations": True}),
    ("update_brand", lambda c: c.update_brand({"product_name": "Acme"}), "PATCH", "/brand", {"product_name": "Acme"}),
    ("template_library", lambda c: c.template_library(), "GET", "/template-library", None),
    ("install_template", lambda c: c.install_template("welcome"), "POST", "/template-library/welcome/install", {}),
    ("publish_template", lambda c: c.publish_template("welcome", "v1"), "POST", "/templates/welcome/publish", {"version_id": "v1"}),
    ("duplicate_template", lambda c: c.duplicate_template("welcome"), "POST", "/templates/welcome/duplicate", {}),
    ("template_versions", lambda c: c.template_versions("welcome"), "GET", "/templates/welcome/versions", None),
    ("create_template_version", lambda c: c.create_template_version("welcome", {"subject": "Hi"}), "POST", "/templates/welcome/versions", {"subject": "Hi"}),
    ("create_contact", lambda c: c.create_contact({"email": "ada@x.com"}), "POST", "/contacts", {"email": "ada@x.com"}),
    ("contacts", lambda c: c.contacts(segment_id="s1"), "GET", "/contacts?segment_id=s1", None),
    ("contact", lambda c: c.contact("ada@x.com"), "GET", "/contacts/ada%40x.com", None),
    ("update_contact", lambda c: c.update_contact("c1", {"unsubscribed": True}), "PATCH", "/contacts/c1", {"unsubscribed": True}),
    ("delete_contact", lambda c: c.delete_contact("c1"), "DELETE", "/contacts/c1", None),
    ("contact_activity", lambda c: c.contact_activity("c1"), "GET", "/contacts/c1/activity", None),
    ("add_contact_segment", lambda c: c.add_contact_segment("c1", "s1"), "POST", "/contacts/c1/segments/s1", {}),
    ("remove_contact_segment", lambda c: c.remove_contact_segment("c1", "s1"), "DELETE", "/contacts/c1/segments/s1", None),
    ("update_contact_topics", lambda c: c.update_contact_topics("c1", [{"id": "t1", "subscription": "opt_out"}]), "PATCH", "/contacts/c1/topics", {"topics": [{"id": "t1", "subscription": "opt_out"}]}),
    ("contact_imports", lambda c: c.contact_imports(status="completed"), "GET", "/contacts/imports?status=completed", None),
    ("contact_import", lambda c: c.contact_import("imp_1"), "GET", "/contacts/imports/imp_1", None),
    ("create_contact_property", lambda c: c.create_contact_property({"key": "plan"}), "POST", "/contact-properties", {"key": "plan"}),
    ("update_contact_property", lambda c: c.update_contact_property("p1", "free"), "PATCH", "/contact-properties/p1", {"fallback_value": "free"}),
    ("delete_contact_property", lambda c: c.delete_contact_property("p1"), "DELETE", "/contact-properties/p1", None),
    ("suppress", lambda c: c.suppress("x@x.com"), "POST", "/suppressions", {"email": "x@x.com"}),
    ("suppression", lambda c: c.suppression("x@x.com"), "GET", "/suppressions/x%40x.com", None),
    ("unsuppress", lambda c: c.unsuppress("x@x.com"), "DELETE", "/suppressions/x%40x.com", None),
    ("suppress_batch", lambda c: c.suppress_batch(["a@x.com"]), "POST", "/suppressions/batch/add", {"emails": ["a@x.com"]}),
    ("unsuppress_batch", lambda c: c.unsuppress_batch(ids=["sup_1"]), "POST", "/suppressions/batch/remove", {"ids": ["sup_1"]}),
    ("create_topic", lambda c: c.create_topic({"name": "News", "default_subscription": "opt_in"}), "POST", "/topics", {"name": "News", "default_subscription": "opt_in"}),
    ("subscribe_topic", lambda c: c.subscribe_topic("t1", "ada@x.com"), "POST", "/topics/t1/subscriptions", {"email": "ada@x.com", "status": "subscribed"}),
    ("segment_contacts", lambda c: c.segment_contacts("s1"), "GET", "/segments/s1/contacts", None),
    ("create_broadcast", lambda c: c.create_broadcast({"from": "a@x.com", "segment_id": "s1"}), "POST", "/broadcasts", {"from": "a@x.com", "segment_id": "s1"}),
    ("send_broadcast", lambda c: c.send_broadcast("b1", "in 1 hour"), "POST", "/broadcasts/b1/send", {"scheduled_at": "in 1 hour"}),
    ("duplicate_broadcast", lambda c: c.duplicate_broadcast("b1"), "POST", "/broadcasts/b1/duplicate", {}),
    ("broadcast_recipients", lambda c: c.broadcast_recipients("b1", "bounced", bounce_type="Permanent"), "GET", "/broadcasts/b1/recipients?type=bounced&bounce_type=Permanent", None),
    ("broadcast_clicked_links", lambda c: c.broadcast_clicked_links("b1"), "GET", "/broadcasts/b1/clicked-links", None),
    ("pause_broadcast", lambda c: c.pause_broadcast("b1"), "POST", "/broadcasts/b1/pause", {}),
    ("create_automation", lambda c: c.create_automation({"name": "A", "steps": []}), "POST", "/automations", {"name": "A", "steps": []}),
    ("duplicate_automation", lambda c: c.duplicate_automation("a1"), "POST", "/automations/a1/duplicate", {}),
    ("automation_runs", lambda c: c.automation_runs("a1", status="failed"), "GET", "/automations/a1/runs?status=failed", None),
    ("automation_run", lambda c: c.automation_run("a1", "run_1"), "GET", "/automations/a1/runs/run_1", None),
    ("send_event", lambda c: c.send_event("user.created", {"plan": "pro"}, email="ada@x.com"), "POST", "/events/send", {"event": "user.created", "payload": {"plan": "pro"}, "email": "ada@x.com"}),
    ("create_event", lambda c: c.create_event({"name": "user.created", "schema": {"plan": "string"}}), "POST", "/events", {"name": "user.created", "schema": {"plan": "string"}}),
    ("update_event", lambda c: c.update_event("user.created", {"plan": "number"}), "PATCH", "/events/user.created", {"schema": {"plan": "number"}}),
    ("fired_events", lambda c: c.fired_events(limit=2), "GET", "/fired-events?limit=2", None),
    ("fired_event", lambda c: c.fired_event("ev_1"), "GET", "/fired-events/ev_1", None),
    ("rotate_webhook_secret", lambda c: c.rotate_webhook_secret("w1"), "POST", "/webhooks/w1/signing-secret/rotate", {}),
    ("webhook_events", lambda c: c.webhook_events("w1"), "GET", "/webhooks/w1/events", None),
    ("webhook_event_attempts", lambda c: c.webhook_event_attempts("w1", "ev_1"), "GET", "/webhooks/w1/events/ev_1/attempts", None),
    ("replay_webhook", lambda c: c.replay_webhook("w1", "ev_1"), "POST", "/webhooks/w1/events/ev_1/replay", {}),
    ("logs", lambda c: c.logs(status="4xx"), "GET", "/logs?status=4xx", None),
    ("logs_export", lambda c: c.logs_export(), "GET", "/logs/export", None),
    ("timeline", lambda c: c.timeline(), "GET", "/timeline", None),
    ("usage", lambda c: c.usage(), "GET", "/usage", None),
    ("system", lambda c: c.system(), "GET", "/system", None),
    ("me", lambda c: c.me(), "GET", "/me", None),
    ("audit_logs", lambda c: c.audit_logs(action="api_key.created"), "GET", "/audit-logs?action=api_key.created", None),
    ("users", lambda c: c.users(), "GET", "/users", None),
    ("create_membership", lambda c: c.create_membership("u1", "r1"), "POST", "/memberships", {"user_id": "u1", "role_id": "r1"}),
    ("check_links", lambda c: c.check_links(["https://x.com"]), "POST", "/links/check", {"urls": ["https://x.com"]}),
]


class TestDispatch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Recorder)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        Recorder.calls = []
        Recorder.responses = {}
        self.client = Dispatch(api_key="sk_test", base_url=f"http://127.0.0.1:{self.server.server_port}")

    def test_routes(self):
        for name, call, method, path, body in CASES:
            with self.subTest(name):
                Recorder.calls = []
                call(self.client)
                sent = Recorder.calls[0]
                self.assertEqual(sent["method"], method)
                self.assertEqual(sent["path"], path)
                self.assertNotIn("/v1/", sent["path"])
                if body is not None:
                    self.assertEqual(sent["body"], body)

    def test_contact_activity_exit_reasons(self):
        self.assertEqual(get_type_hints(ContactActivity)["exit_reason"], AutomationExitReason | None)
        self.assertEqual(get_type_hints(ContactActivity, include_extras=True)["exit_reason"], NotRequired[AutomationExitReason | None])
        for reason in (*get_args(AutomationExitReason), None, "absent"):
            with self.subTest(reason=reason):
                activity: ContactActivity = {
                    "object": "contact_activity", "id": "r1:completed",
                    "type": "automation.run.completed", "label": "done", "resource_id": "r1",
                    "automation_id": "a1", "run_id": "r1", "email_id": None,
                    "created_at": "2026-10-04T00:00:00Z",
                }
                if reason != "absent":
                    activity["exit_reason"] = reason
                page = {"object": "list", "has_more": True, "data": [activity]}
                path = "/contacts/c%2F1/activity?after=r0%3Acompleted&limit=5"
                Recorder.responses = {("GET", path): (200, page)}
                result = self.client.contact_activity("c/1", after="r0:completed", limit=5)
                self.assertEqual(result, page)
                self.assertEqual(json.loads(json.dumps(result)), page)
                self.assertEqual(Recorder.calls[-1]["path"], path)

    def test_template_library_automations(self):
        preset: AutomationPreset = {
            "slug": "newsletter-welcome", "name": "Newsletter welcome", "stage": "acquisition",
            "description": "Welcome a subscriber.", "when": "Start on subscription.",
            "trigger_config": {"type": "topic_subscribed", "topic_id": "{{topic_id}}"}, "reentry": "once",
            "events": [{"name": "stripe.invoice.payment_failed", "schema": {"AMOUNT": "string", "UPDATE_PAYMENT_URL": "string"}}],
            "properties": [{"key": "activated", "type": "boolean"}],
            "steps": [
                {"key": "start", "type": "trigger", "config": {"type": "topic_subscribed", "topic_id": "{{topic_id}}"}},
                {"key": "active", "type": "condition", "config": {"type": "rule", "field": "contact.activated", "operator": "eq", "value": False}},
                {"key": "send", "type": "send_email", "config": {"template": "newsletter-welcome", "kind": "marketing", "variable_mapping": {"camelKey": "event.AMOUNT"}}},
            ],
            "connections": [{"from": "active", "to": "send", "type": "condition_not_met"}],
            "templates": ["newsletter-welcome"],
        }
        for data in ([], [preset]):
            with self.subTest(data=data):
                page = {"object": "list", "has_more": False, "data": data}
                Recorder.responses[("GET", "/template-library/automations")] = (200, page)
                listed = self.client.template_library_automations()
                self.assertEqual(listed, page)
                self.assertEqual(json.loads(json.dumps(listed)), page)
                self.assertEqual(Recorder.calls[-1]["method"], "GET")
                self.assertEqual(Recorder.calls[-1]["path"], "/template-library/automations")
                self.assertEqual(Recorder.calls[-1]["body"], b"")
        path = "/template-library/automations/newsletter%2Fwelcome%20%3F%23%25"
        detail = {"object": "automation_preset", **preset}
        Recorder.responses[("GET", path)] = (200, detail)
        got = self.client.template_library_automation("newsletter/welcome ?#%")
        self.assertEqual(got, detail)
        self.assertEqual(json.loads(json.dumps(got)), detail)
        self.assertEqual(Recorder.calls[-1]["method"], "GET")
        self.assertEqual(Recorder.calls[-1]["path"], path)
        self.assertEqual(Recorder.calls[-1]["body"], b"")
        self.assertEqual(get_type_hints(Dispatch.template_library_automations)["return"], AutomationPresetList)
        self.assertEqual(get_type_hints(Dispatch.template_library_automation)["return"], AutomationPresetDetail)
        self.assertEqual(get_type_hints(AutomationPresetList)["data"], list[AutomationPreset])
        self.assertEqual(get_type_hints(AutomationPresetDetail)["object"], Literal["automation_preset"])
        self.assertEqual(get_type_hints(AutomationPreset)["trigger_config"], AutomationTriggerConfig)
        self.assertEqual(get_type_hints(AutomationPreset)["events"], list[AutomationPresetEvent])
        self.assertEqual(get_type_hints(AutomationPreset)["properties"], list[AutomationPresetProperty])
        self.assertEqual(get_args(LibraryStage), ("acquisition", "onboarding", "retention", "reengagement", "dunning", "reactivation"))

    def test_template_library_automation_not_found(self):
        path = "/template-library/automations/missing"
        Recorder.responses[("GET", path)] = (404, {"name": "not_found", "message": "Preset not found"})
        with self.assertRaises(DispatchError) as caught:
            self.client.template_library_automation("missing")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.body["name"], "not_found")

    def test_template_library_install_automation(self):
        for dependencies in (False, True):
            with self.subTest(dependencies=dependencies):
                aggregate = {
                    "automation": {
                        "object": "automation", "id": "auto_1", "name": "Welcome", "status": "disabled", "version": 1,
                        "trigger": None, "trigger_config": {"type": "contact_created"}, "reentry": "once",
                        "steps": [{"key": "trigger", "type": "trigger", "config": {"type": "contact_created"}}],
                        "connections": [], "created_at": "2026-10-05T00:00:00Z", "updated_at": "2026-10-05T00:00:00Z",
                    },
                    "templates": {
                        "created": [{"id": "tpl_1", "slug": "welcome"}] if dependencies else [],
                        "reused": [{"id": "tpl_2", "slug": "tips"}] if dependencies else [],
                    },
                    "events": [{"id": "evt_1", "name": "user.activated"}] if dependencies else [],
                    "properties": [{"id": "prop_1", "key": "activated", "type": "boolean"}] if dependencies else [],
                    "next_steps": ["Review the automation and its emails", "Enable the automation"],
                    "request_id": "req_install",
                }
                path = "/template-library/automations/onboarding%2Fdrip%20%3F%23%25/install"
                Recorder.responses[("POST", path)] = (200, aggregate)
                options = {"from": "Acme <you@acme.com>"}
                if dependencies:
                    options.update(name="Custom", topic_id="topic_1")
                got = self.client.template_library_install_automation("onboarding/drip ?#%", **options)
                self.assertEqual(got, aggregate)
                self.assertEqual(json.loads(json.dumps(got)), aggregate)
                self.assertEqual(Recorder.calls[-1]["method"], "POST")
                self.assertEqual(Recorder.calls[-1]["path"], path)
                self.assertEqual(Recorder.calls[-1]["body"], options)
                self.assertEqual(Recorder.calls[-1]["headers"]["authorization"], "Bearer sk_test")
        self.assertEqual(get_type_hints(Dispatch.template_library_install_automation)["return"], AutomationInstallation)
        self.assertEqual(get_type_hints(AutomationInstallInput, include_extras=True)["topic_id"], NotRequired[str])
        self.assertEqual(get_type_hints(AutomationInstallInput)["from"], str)
        self.assertEqual(get_type_hints(AutomationInstallation)["automation"], Automation)
        self.assertEqual(get_type_hints(AutomationInstallation, include_extras=True)["request_id"], NotRequired[str])

    def test_template_library_install_errors(self):
        for status, name, message in (
            (403, "forbidden", "Access denied"), (404, "not_found", "Preset not found"),
            (409, "conflict", "Name already exists"), (422, "validation_error", "Choose a topic"),
        ):
            with self.subTest(status=status):
                body = {"name": name, "message": message, "request_id": "req_error"}
                Recorder.responses[("POST", "/template-library/automations/newsletter-welcome/install")] = (status, body)
                with self.assertRaises(DispatchError) as caught:
                    self.client.template_library_install_automation("newsletter-welcome", **{"from": "you@acme.com"})
                self.assertEqual(caught.exception.status, status)
                self.assertEqual(caught.exception.body, body)
                self.assertEqual(Recorder.calls[-1]["body"], {"from": "you@acme.com"})

    def test_event_list_counts(self):
        page = {"object": "list", "has_more": True, "data": [
            {"id": "evt_0", "name": "never", "schema": {}, "fired_count": 0, "last_fired_at": None},
            {"id": "evt_1", "name": "fired", "schema": {}, "fired_count": 3, "last_fired_at": "2026-10-05T00:00:00Z"},
        ]}
        path = "/events?after=evt_prev&limit=2"
        Recorder.responses[("GET", path)] = (200, page)
        self.assertEqual(self.client.events(after="evt_prev", limit=2), page)
        detail = {"id": "evt_0", "name": "never", "schema": {}}
        Recorder.responses[("GET", "/events/evt_0")] = (200, detail)
        self.assertEqual(self.client.event("evt_0"), detail)
        self.assertEqual(get_type_hints(Dispatch.events)["return"], EventList)
        self.assertEqual(get_type_hints(EventDefinition, include_extras=True)["fired_count"], NotRequired[int])
        self.assertEqual(get_type_hints(EventDefinition, include_extras=True)["last_fired_at"], NotRequired[str | None])

    def test_flow_config_contracts(self):
        self.assertEqual(get_args(get_type_hints(FilterConfig)["scope"]), ("next", "following"))
        self.assertEqual(get_type_hints(BranchConfig), {"paths": list[BranchPath]})
        self.assertEqual(get_type_hints(ExitConfig), {})
        self.assertEqual(get_type_hints(AutomationGuard)["filter"], str)
        self.assertIn("branch", get_args(get_type_hints(AutomationConnectionInput)["type"]))
        self.assertEqual(get_type_hints(AutomationConnectionInput)["path"], str)
        self.assertEqual(get_args(get_type_hints(AutomationStepInput)["type"]), (
            "trigger", "send_email", "delay", "wait_for_event", "condition",
            "add_to_segment", "contact_update", "contact_delete", "exit", "filter", "branch", "split",
        ))
        self.assertEqual(get_type_hints(RuleGroup)["rules"], list[PredicateRule | RuleGroup])
        rule = {"type": "rule", "field": "contact.activated", "operator": "eq", "value": False}
        paths = [
            {"key": "free", "label": "Free", "rule": {"type": "rule", "field": "contact.plan", "operator": "eq", "value": "free"}},
            {"key": "active", "label": "Active", "rule": {"type": "and", "rules": [
                {"type": "rule", "field": "contact.score", "operator": "gte", "value": 0},
                {"type": "rule", "field": "event.isTrial", "operator": "eq", "value": True},
            ]}},
        ]
        for scope in ("next", "following"):
            with self.subTest(scope=scope):
                Recorder.calls = []
                create: AutomationInput = {
                    "name": "Onboarding", "status": "disabled", "reentry": "once",
                    "steps": [
                        {"key": "start", "type": "trigger", "config": {"type": "contact_created"}},
                        {"key": "audience", "type": "filter", "config": {"rule": rule, "scope": scope}},
                        {"key": "choose", "type": "branch", "config": {"paths": paths}},
                        {"key": "end", "type": "exit", "config": {}},
                    ],
                    "connections": [
                        {"from": "start", "to": "audience"},
                        {"from": "audience", "to": "choose", "type": "default"},
                        *[{"from": "choose", "to": "end", "type": "branch", "path": key} for key in ("free", "active", "otherwise")],
                    ],
                }
                self.client.create_automation(create)
                self.client.update_automation("a/1", create)
                self.client.dry_run_automation("a/1", create)
                self.assertEqual([call["path"] for call in Recorder.calls], [
                    "/automations", "/automations/a%2F1", "/automations/a%2F1?dry_run=true",
                ])
                for call in Recorder.calls:
                    self.assertEqual(call["body"], create)

    def test_flow_run_contracts(self):
        reasons = ("completed", "exit", "filter", "stopped", "stranded")
        self.assertEqual(get_args(AutomationExitReason), reasons)
        self.assertEqual(get_type_hints(AutomationRun)["exit_reason"], AutomationExitReason | None)
        self.assertEqual(get_type_hints(AutomationRun)["guards"], list[AutomationGuard])
        self.assertIs(get_type_hints(Dispatch.automation_run)["return"], AutomationRun)
        self.assertIs(get_type_hints(Dispatch.automation_runs)["return"], AutomationRunList)
        for status, reason in [
            ("running", None), ("failed", None), ("completed", "completed"), ("completed", "exit"),
            ("completed", "filter"), ("cancelled", "stopped"), ("cancelled", "stranded"),
        ]:
            with self.subTest(status=status, reason=reason):
                run = {
                    "object": "automation_run", "id": "r/1", "automation_id": "a/1",
                    "status": status, "exit_reason": reason, "error": "Send failed" if status == "failed" else None,
                    "guards": [{"filter": "audience", "rule": {
                        "type": "rule", "field": "contact.activated", "operator": "eq", "value": False,
                    }}],
                    "event": {"id": "ev1", "name": "user.created", "email": None, "payload": {"isTrial": True}},
                    "created_at": "2026-10-04T00:00:00Z", "updated_at": "2026-10-04T00:01:00Z",
                    "steps": [
                        {"key": "choose", "type": "branch", "status": "completed", "output": {"path": "active"}},
                        {"key": "send", "type": "send_email", "status": "completed", "output": {"exited": "filter", "filter": "audience"}},
                    ],
                }
                listing = {"object": "list", "has_more": False, "data": [run]}
                Recorder.responses = {
                    ("GET", "/automations/a%2F1/runs/r%2F1"): (200, run),
                    ("GET", f"/automations/a%2F1/runs?status={status}"): (200, listing),
                }
                result = self.client.automation_run("a/1", "r/1")
                self.assertEqual(result, run)
                self.assertEqual(self.client.automation_runs("a/1", status=status)["data"], [run])
                Recorder.responses[("GET", "/automations/a%2F1/runs/r%2F1")] = (200, {**run, "guards": []})
                self.assertEqual(self.client.automation_run("a/1", "r/1")["guards"], [])

    def test_flow_webhook_contracts(self):
        hints = get_type_hints(AutomationRunEvent)
        self.assertEqual(hints["exit_reason"], AutomationExitReason | None)
        self.assertIn("exit_reason", AutomationRunEvent.__required_keys__)
        self.assertNotIn("failed", get_args(AutomationExitReason))
        for state, reason in [
            ("ready", None), ("failed", None), ("done", "completed"), ("done", "exit"),
            ("done", "filter"), ("stopped", "stopped"), ("stopped", "stranded"),
        ]:
            event: AutomationRunEvent = {
                "automation_id": "a1", "run_id": "r1", "contact_id": None, "state": state, "exit_reason": reason,
            }
            self.assertEqual(json.loads(json.dumps(event)), event)

    def test_automation_pause_contracts(self):
        self.assertEqual(get_args(get_type_hints(AutomationInput)["status"]), ("enabled", "disabled"))
        self.assertEqual(get_args(get_type_hints(AutomationUpdateInput)["status"]), ("enabled", "paused", "disabled"))
        self.assertIs(get_type_hints(Automation)["version"], int)
        self.assertNotIn("version", get_type_hints(AutomationInput))
        self.assertNotIn("version", get_type_hints(AutomationUpdateInput))
        for status in ("enabled", "paused", "disabled"):
            with self.subTest(status=status):
                automation: Automation = {
                    "id": "a/1", "status": status, "version": 4, "trigger": None,
                    "trigger_config": {"type": "contact_created"}, "reentry": "once",
                }
                Recorder.responses = {
                    ("PATCH", "/automations/a%2F1"): (200, automation),
                    ("GET", "/automations/a%2F1"): (200, automation),
                    ("GET", f"/automations?status={status}"): (200, {"object": "list", "data": [automation]}),
                }
                self.assertEqual(self.client.update_automation("a/1", {"status": status}), automation)
                self.assertEqual(Recorder.calls[-1]["body"], {"status": status})
                self.assertEqual(self.client.automation("a/1"), automation)
                self.assertEqual(self.client.automations(status=status)["data"], [automation])
        for enabled in (False, True):
            self.client.update_automation("a1", {"enabled": enabled})
            self.assertEqual(Recorder.calls[-1]["body"], {"enabled": enabled})
            self.client.create_automation({"name": "Legacy", "steps": [], "enabled": enabled})
            self.assertEqual(Recorder.calls[-1]["body"], {"name": "Legacy", "steps": [], "enabled": enabled})
        Recorder.responses[("PATCH", "/automations/a1")] = (409, {"name": "conflict", "message": "Disabled cannot pause"})
        with self.assertRaises(DispatchError) as caught:
            self.client.update_automation("a1", {"status": "paused"})
        self.assertEqual(caught.exception.status, 409)

    def test_automation_dry_run_contracts(self):
        self.assertIs(get_type_hints(Dispatch.dry_run_automation)["return"], AutomationDryRun)
        self.assertEqual(get_type_hints(AutomationDryRun), {"stranded_runs": int, "by_step": dict[str, int]})
        self.assertNotIn("used_keys", get_type_hints(Automation))
        self.assertNotIn("used_keys", get_type_hints(AutomationUpdateInput))
        update: AutomationUpdateInput = {
            "name": "Edited", "reentry": "once",
            "steps": [
                {"key": "start", "type": "trigger", "config": {"type": "contact_updated", "field": "activated", "from": False, "to": True}},
                {"key": "send", "type": "send_email", "config": {"template": "welcome", "variables": {"camelKey": "literal"}}},
            ],
            "connections": [{"from": "start", "to": "send", "type": "default"}],
        }
        saved = {"id": "a/1", "status": "paused", "version": 5}
        for preview in ({"stranded_runs": 3, "by_step": {"removed": 2, "send/email": 1}}, {"stranded_runs": 0, "by_step": {}}):
            with self.subTest(preview=preview):
                Recorder.calls = []
                Recorder.responses = {
                    ("PATCH", "/automations/a%2F1?dry_run=true"): (200, preview),
                    ("PATCH", "/automations/a%2F1"): (200, saved),
                }
                self.assertEqual(self.client.dry_run_automation("a/1", update), preview)
                self.assertEqual(Recorder.calls[0]["method"], "PATCH")
                self.assertEqual(Recorder.calls[0]["path"], "/automations/a%2F1?dry_run=true")
                self.assertEqual(Recorder.calls[0]["body"], update)
                self.assertEqual(self.client.update_automation("a/1", update), saved)
                self.assertEqual(Recorder.calls[1]["body"], update)

    def test_automation_dry_run_errors(self):
        for status in (403, 409, 422):
            with self.subTest(status=status):
                Recorder.responses[("PATCH", "/automations/a1?dry_run=true")] = (
                    status, {"name": "conflict", "message": "Cannot save this graph"}
                )
                with self.assertRaises(DispatchError) as caught:
                    self.client.dry_run_automation("a1", {"steps": []})
                self.assertEqual(caught.exception.status, status)

    def test_send_headers(self):
        result = self.client.send({"from": "a@x.com", "to": "b@x.com", "subject": "Hi", "text": "Yo"}, idempotency_key="idem-1")
        self.assertEqual(result["id"], "x")
        sent = Recorder.calls[0]
        self.assertEqual(sent["path"], "/emails")
        self.assertEqual(sent["headers"]["idempotency-key"], "idem-1")
        self.assertEqual(sent["headers"]["authorization"], "Bearer sk_test")

    def test_typed_property_and_mapping_contracts(self):
        prop: ContactPropertyInput = {"key": "activated", "type": "boolean", "fallback_value": False}
        self.client.create_contact_property(prop)
        self.assertEqual(Recorder.calls[-1]["body"], prop)
        self.assertIs(Recorder.calls[-1]["body"]["fallback_value"], False)
        date: ContactPropertyInput = {"key": "last_active_at", "type": "date", "fallback_value": "2026-10-03T09:30:00+02:00"}
        self.client.create_contact_property(date)
        self.assertEqual(Recorder.calls[-1]["body"], date)
        self.client.update_contact_property("prop_1", False)
        self.assertEqual(Recorder.calls[-1]["body"], {"fallback_value": False})
        self.client.update_contact_property("prop_1", None)
        self.assertEqual(Recorder.calls[-1]["body"], {"fallback_value": None})
        config: SendEmailConfig = {
            "template": {"id": "template_1", "variables": {"PLAN": "contact.plan", "FLAG": False}},
            "variable_mapping": {"PLAN": "contact.plan", "WHEN": "event.received_at"},
        }
        self.client.create_automation({"name": "Typed", "steps": [{"key": "send", "type": "send_email", "config": config}]})
        self.assertEqual(Recorder.calls[-1]["body"]["steps"][0]["config"], config)
        column_map: ImportColumnMap = {"properties": {"when": {"column": "when", "type": "date"}}}
        self.client.import_contacts("email,when\na@example.com,2026-10-03\n", column_map=column_map)
        self.assertIn(json.dumps(column_map).encode(), Recorder.calls[-1]["body"])

    def test_automation_trigger_contracts(self):
        configs: list[AutomationTriggerConfig] = [
            {"type": "event", "event_name": "user.created"},
            {"type": "contact_created"},
            {"type": "contact_updated"},
            {"type": "contact_updated", "field": "unsubscribed", "from": False, "to": True},
            {"type": "contact_updated", "field": "properties.score", "from": 0, "to": 42.5},
            {"type": "contact_updated", "field": "properties.last_active_at", "from": None, "to": "2026-10-03T09:30:00+02:00"},
            {"type": "contact_updated", "field": "first_name", "from": "Ada", "to": None},
            {"type": "topic_subscribed", "topic_id": "topic_1"},
            {"type": "segment_added", "segment_id": "segment_1"},
        ]
        for config in configs:
            with self.subTest(config=config):
                automation: Automation = {
                    "id": "a1", "trigger": config.get("event_name"),
                    "status": "disabled", "version": 0,
                    "trigger_config": config, "reentry": "every_time",
                }
                for route in [
                    ("POST", "/automations"), ("PATCH", "/automations/a1"),
                    ("GET", "/automations/a1"), ("POST", "/automations/a1/duplicate"),
                ]:
                    Recorder.responses[route] = (200, automation)
                Recorder.responses[("GET", "/automations")] = (200, {"object": "list", "has_more": False, "data": [automation]})
                steps = [{"key": "start", "type": "trigger", "config": config}]
                create: AutomationInput = {"name": "Contacts", "steps": steps, "reentry": "every_time"}
                result = self.client.create_automation(create)
                self.assertEqual(Recorder.calls[-1]["body"], create)
                self.assertEqual(result["trigger"], automation["trigger"])
                self.assertEqual(result["trigger_config"], config)
                self.assertEqual(result["reentry"], "every_time")
                # bool and int compare equal in Python, so also check JSON primitive types.
                for key in ("from", "to"):
                    if key in config:
                        self.assertIs(type(result["trigger_config"][key]), type(config[key]))
                        self.assertIs(type(Recorder.calls[-1]["body"]["steps"][0]["config"][key]), type(config[key]))
                update: AutomationUpdateInput = {"steps": steps, "reentry": "once"}
                self.client.update_automation("a1", update)
                self.assertEqual(Recorder.calls[-1]["body"], update)
                self.assertEqual(self.client.automation("a1")["trigger_config"], config)
                self.assertEqual(self.client.duplicate_automation("a1")["trigger_config"], config)
                self.assertEqual(self.client.automations()["data"][0]["trigger_config"], config)
        legacy: AutomationInput = {
            "name": "Legacy", "trigger": "user.created",
            "steps": [{"key": "start", "type": "trigger", "config": {"event_name": "user.created"}}],
        }
        self.client.create_automation(legacy)
        self.assertEqual(Recorder.calls[-1]["body"], legacy)

    def test_marketing_split_response(self):
        result = {"id": "email_1", "emails": [
            {"id": "email_1", "to": "ada@example.com"},
            {"id": "email_2", "to": "bob@example.com"},
        ]}
        Recorder.responses[("POST", "/emails")] = (200, result)
        Recorder.responses[("POST", "/emails/batch")] = (200, {"data": [result]})
        email = {"from": "a@example.com", "to": ["ada@example.com", "bob@example.com"], "topic_id": "topic_1", "text": "Hi"}
        self.assertEqual(self.client.send(email)["emails"], result["emails"])
        self.assertEqual(self.client.batch([email])["data"][0]["emails"], result["emails"])

    def test_sandbox_response_contract(self):
        sandbox = {"id": "email_1", "sandbox": True, "last_event": "delivered"}
        recipients = [
            {"id": "rcpt_1", "email": "test@example.com", "kind": "cc", "sandbox": True, "status": "delivered"},
            {"id": "rcpt_2", "email": "ada@acme.com", "kind": "to", "sandbox": False, "status": "delivered"},
        ]
        mixed = {"id": "email_2", "sandbox": False, "last_event": "delivered", "recipients": recipients}
        Recorder.responses.update({
            ("POST", "/emails"): (200, sandbox),
            ("POST", "/emails/batch"): (200, {"data": [sandbox]}),
            ("GET", "/emails"): (200, {"object": "list", "has_more": False, "data": [sandbox]}),
            ("GET", "/emails/email_2"): (200, mixed),
        })
        email = {"from": "a@acme.com", "to": "test@example.com", "subject": "Test", "text": "Hi"}
        self.assertIs(self.client.send(email)["sandbox"], True)
        self.assertIs(self.client.batch([email])["data"][0]["sandbox"], True)
        self.assertEqual(self.client.emails()["data"][0], sandbox)
        self.assertEqual(self.client.email("email_2"), mixed)

    def test_batch_sends_a_bare_array(self):
        emails = [{"from": "a@x.com", "to": "b@x.com", "subject": "Hi", "text": "Yo"}]
        self.client.batch(emails, idempotency_key="idem-2", batch_validation="permissive")
        sent = Recorder.calls[0]
        self.assertEqual(sent["body"], emails)
        self.assertEqual(sent["headers"]["idempotency-key"], "idem-2")
        self.assertEqual(sent["headers"]["x-batch-validation"], "permissive")

    def test_public_routes_skip_authorization(self):
        self.client.health()
        self.client.setup()
        self.client.create_session("a@x.com", "a long private password")
        self.assertEqual([call["path"] for call in Recorder.calls], ["/health", "/setup", "/sessions"])
        self.assertEqual(Recorder.calls[2]["body"], {"email": "a@x.com", "password": "a long private password"})
        self.assertNotIn("authorization", Recorder.calls[0]["headers"])
        self.assertNotIn("authorization", Recorder.calls[2]["headers"])
        # /setup needs the key in production, where public setup is off.
        self.assertEqual(Recorder.calls[1]["headers"]["authorization"], "Bearer sk_test")

    def test_import_contacts_uploads_multipart(self):
        self.client.import_contacts("email\nada@x.com\n", column_map={"email": {"column": "email"}}, on_conflict="skip")
        sent = Recorder.calls[0]
        self.assertEqual(sent["path"], "/contacts/imports")
        self.assertTrue(sent["headers"]["content-type"].startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="on_conflict"\r\n\r\nskip', sent["body"])
        self.assertIn(b'filename="contacts.csv"', sent["body"])
        self.assertIn(b"email\nada@x.com\n", sent["body"])

    def test_import_trigger_automations(self):
        for flag in (None, False, True):
            with self.subTest(trigger_automations=flag):
                Recorder.calls = []
                imported = {"object": "contact_import", "id": "imp_1", "trigger_automations": True if flag is None else flag}
                Recorder.responses = {
                    ("POST", "/contacts/imports"): (202, imported),
                    ("GET", "/contacts/imports/imp_1"): (200, imported),
                    ("GET", "/contacts/imports"): (200, {"object": "list", "has_more": False, "data": [imported]}),
                }
                # Existing positional arguments remain in place; omission leaves the tenant default to the API.
                options = {} if flag is None else {"trigger_automations": flag}
                created = self.client.import_contacts("email\nada@x.com\n", None, None, None, None, "old.csv", **options)
                sent = Recorder.calls[0]
                self.assertEqual(sent["method"], "POST")
                self.assertEqual(sent["path"], "/contacts/imports")
                content_type = sent["headers"]["content-type"]
                self.assertTrue(content_type.startswith("multipart/form-data; boundary="))
                form = BytesParser(policy=default).parsebytes(
                    f"Content-Type: {content_type}\r\n\r\n".encode() + sent["body"]
                )
                fields = {part.get_param("name", header="content-disposition"): part for part in form.iter_parts()}
                if flag is None:
                    self.assertNotIn("trigger_automations", fields)
                else:
                    self.assertEqual(fields["trigger_automations"].get_content(), "true" if flag else "false")
                self.assertEqual(fields["file"].get_filename(), "old.csv")
                self.assertEqual(fields["file"].get_content(), "email\nada@x.com\n")
                self.assertEqual(created, imported)
                self.assertEqual(self.client.contact_import("imp_1"), imported)
                self.assertEqual(self.client.contact_imports()["data"], [imported])

    def test_stop_automation_reset_reentry(self):
        for flag in (None, False, True):
            with self.subTest(reset_reentry=flag):
                Recorder.calls = []
                result = {"object": "automation", "id": "a1", "stopped": 2}
                Recorder.responses = {("POST", "/automations/a%2F1/stop"): (200, result)}
                stopped = self.client.stop_automation("a/1") if flag is None else self.client.stop_automation("a/1", reset_reentry=flag)
                sent = Recorder.calls[0]
                self.assertEqual(sent["method"], "POST")
                self.assertEqual(sent["path"], "/automations/a%2F1/stop")
                self.assertEqual(sent["body"], {} if flag is None else {"reset_reentry": flag})
                self.assertEqual(stopped, result)

    def test_enrollment_contracts(self):
        job = {
            "object": "automation_enrollment_job", "id": "j/1", "automation_id": "a/1",
            "segment_id": None, "status": "queued", "error": None,
            "created_at": "2026-10-03T00:00:00Z", "completed_at": None,
            "counts": {"total": 501, "processed": 0, "enrolled": 0, "skipped": 0, "failed": 0},
        }
        cancelled = {**job, "status": "cancelled"}
        imported = {"object": "contact_import", "id": "i/1", "status": "cancelled"}
        Recorder.responses = {
            ("POST", "/automations/a%2F1/enroll"): (202, job),
            ("GET", "/automations/a%2F1/enroll-jobs/j%2F1"): (200, job),
            ("DELETE", "/automations/a%2F1/enroll-jobs/j%2F1"): (200, cancelled),
            ("DELETE", "/contacts/imports/i%2F1"): (200, imported),
        }
        self.assertEqual(self.client.enroll("a/1", {"all": True}, idempotency_key="enroll-retry"), job)
        self.assertEqual(Recorder.calls[-1]["body"], {"all": True})
        self.assertEqual(Recorder.calls[-1]["headers"]["idempotency-key"], "enroll-retry")
        self.assertEqual(self.client.enroll("a/1", {"segment_id": "s/1"}), job)
        self.assertEqual(Recorder.calls[-1]["body"], {"segment_id": "s/1"})
        self.assertEqual(self.client.get_enrollment_job("a/1", "j/1"), job)
        self.assertEqual(self.client.cancel_enrollment_job("a/1", "j/1"), cancelled)
        self.assertEqual(self.client.cancel_contact_import("i/1"), imported)
        self.assertEqual([call["method"] for call in Recorder.calls], ["POST", "POST", "GET", "DELETE", "DELETE"])
        self.assertTrue(all(call["body"] == b"" for call in Recorder.calls[2:]))
        self.assertEqual(len(Recorder.calls), 5)

    def test_forward_received_email(self):
        Recorder.responses[("GET", "/emails/receiving/r1?html_format=cid")] = (200, {"id": "r1", "subject": "Invoice", "html": "<p>Due</p>"})
        self.client.forward_received_email("r1", "ops@x.com", "bot@x.com")
        self.assertEqual(Recorder.calls[0]["path"], "/emails/receiving/r1?html_format=cid")
        self.assertEqual(Recorder.calls[1]["path"], "/emails/receiving/r1/attachments?limit=100")
        self.assertEqual(Recorder.calls[-1]["path"], "/emails")
        self.assertEqual(
            Recorder.calls[-1]["body"],
            {"from": "bot@x.com", "to": "ops@x.com", "subject": "Fwd: Invoice", "html": "<p>Due</p>"},
        )

    def test_forward_carries_attachments(self):
        Recorder.responses[("GET", "/emails/receiving/r2?html_format=cid")] = (200, {"id": "r2", "subject": "Logo", "html": '<img src="cid:logo">'})
        Recorder.responses[("GET", "/emails/receiving/r2/attachments?limit=100")] = (
            200,
            {
                "object": "list",
                "data": [
                    {
                        "id": "a1",
                        "filename": "logo.png",
                        "content_type": "image/png",
                        "content_id": "logo",
                        "download_url": f"{self.client.base_url}/files/logo",
                    }
                ],
            },
        )
        Recorder.responses[("GET", "/files/logo")] = (200, {"png": 1})
        self.client.forward_received_email("r2", "ops@x.com", "bot@x.com")
        download = next(call for call in Recorder.calls if call["path"] == "/files/logo")
        # The signed URL is its own credential, so the key is not sent with the download.
        self.assertNotIn("authorization", download["headers"])
        self.assertEqual(
            Recorder.calls[-1]["body"]["attachments"],
            [
                {
                    "filename": "logo.png",
                    "content": base64.b64encode(json.dumps({"png": 1}).encode("utf-8")).decode("ascii"),
                    "content_type": "image/png",
                    "content_id": "logo",
                }
            ],
        )

    def test_error_response_raises(self):
        Recorder.responses[("GET", "/domains/missing")] = (404, {"name": "not_found", "statusCode": 404, "message": "Domain not found"})
        with self.assertRaises(DispatchError) as raised:
            self.client.domain("missing")
        self.assertEqual(raised.exception.status, 404)
        self.assertEqual(raised.exception.name, "not_found")
        self.assertEqual(raised.exception.request_id, "req_py")
        self.assertIn("404 Domain not found", str(raised.exception))

    def test_network_failure_raises_with_no_status(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        client = Dispatch(api_key="sk_test", base_url=f"http://127.0.0.1:{port}")
        with self.assertRaises(DispatchError) as raised:
            client.emails()
        self.assertIsNone(raised.exception.status)
        self.assertEqual(raised.exception.name, "application_error")


class TestRedirects(unittest.TestCase):
    def request_with_redirect(self, base_url, target):
        calls = []

        def respond(handler, request):
            calls.append(request)
            headers = Message()
            if len(calls) == 1:
                headers["Location"] = target
                status, body = 302, b""
            else:
                status, body = 200, b'{"id":"redirected"}'
            response = urllib.response.addinfourl(io.BytesIO(body), headers, request.full_url, status)
            response.msg = "Found" if status == 302 else "OK"
            return response

        client = Dispatch(api_key="sk_test", base_url=base_url)
        # Run urllib's real redirect machinery with both transports replaced: no DNS or sockets.
        with patch.object(urllib.request.HTTPHandler, "http_open", respond), patch.object(
            urllib.request.HTTPSHandler, "https_open", respond
        ):
            try:
                result = client.emails()
            except DispatchError as error:
                return calls, error
        return calls, result

    def test_same_origin_redirects_preserve_authorization(self):
        for base_url, target in [
            ("https://api.example.com", "/redirected"),
            ("https://api.example.com", "https://api.example.com:443/redirected"),
            ("http://api.example.com:80", "http://api.example.com/redirected"),
            ("https://api.example.com:8443", "https://api.example.com:8443/redirected"),
        ]:
            with self.subTest(base_url=base_url, target=target):
                calls, result = self.request_with_redirect(base_url, target)
                self.assertEqual(result, {"id": "redirected"})
                self.assertEqual(len(calls), 2)
                self.assertEqual(calls[1].get_header("Authorization"), "Bearer sk_test")

    def test_cross_origin_redirects_stop_before_followup_request(self):
        for target in [
            "https://sub.api.example.com/emails",
            "https://api.example.com:8443/emails",
            "http://api.example.com/emails",
            "https://other.example.com/emails",
        ]:
            with self.subTest(target=target):
                calls, error = self.request_with_redirect("https://api.example.com", target)
                self.assertIsInstance(error, DispatchError)
                self.assertIsNone(error.status)
                self.assertIn("different API origin", str(error))
                self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
