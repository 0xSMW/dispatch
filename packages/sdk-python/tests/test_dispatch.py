import base64
import json
import io
import socket
import threading
import unittest
import urllib.request
import urllib.response
from email.message import Message
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

from dispatch import Dispatch, DispatchError


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

    def test_send_headers(self):
        result = self.client.send({"from": "a@x.com", "to": "b@x.com", "subject": "Hi", "text": "Yo"}, idempotency_key="idem-1")
        self.assertEqual(result["id"], "x")
        sent = Recorder.calls[0]
        self.assertEqual(sent["path"], "/emails")
        self.assertEqual(sent["headers"]["idempotency-key"], "idem-1")
        self.assertEqual(sent["headers"]["authorization"], "Bearer sk_test")

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
