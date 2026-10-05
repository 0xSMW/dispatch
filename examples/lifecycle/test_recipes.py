import io
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch
from dispatch import Dispatch, DispatchError
import recipes


class Response:
    status = 200
    headers = {}

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self):
        return json.dumps(self.body).encode()


class RecipesTest(unittest.TestCase):
    def test_public_python_snippets_compile_without_execution(self):
        root = Path(__file__).resolve().parents[2]
        paths = [root / "README.md", root / "docs/automations/README.md",
                 root / "examples/lifecycle/README.md"]
        for path in paths:
            for index, snippet in enumerate(re.findall(r"```python\n([\s\S]*?)\n```", path.read_text())):
                compile(snippet, f"{path}:python-block-{index}", "exec")
        compile((root / "examples/lifecycle/recipes.py").read_text(), "recipes.py", "exec")

    def setUp(self):
        self.client = Dispatch(api_key="offline-example", base_url="https://offline.invalid")
        self.calls = []
        self.body = {"id": "contact_123"}

        def open_request(request, **_):
            self.calls.append((request.method, request.full_url,
                               json.loads(request.data) if request.data else None))
            return Response(self.body)

        self.transport = patch("urllib.request.OpenerDirector.open", side_effect=open_request)
        self.transport.start()
        self.addCleanup(self.transport.stop)

    def test_all_six_installs_are_disabled_and_preserve_aggregate(self):
        self.body = {
            "automation": {"id": "auto_123", "status": "disabled"},
            "templates": {"created": [], "reused": []}, "events": [], "properties": [],
            "next_steps": ["Review the automation and its emails", "Enable the automation"],
            "request_id": "req_offline",
        }
        for slug in ("newsletter-welcome", "onboarding-drip", "invite-to-upgrade",
                     "win-back", "failed-payment", "come-back"):
            topic = None if slug == "failed-payment" else "topic_123"
            result = recipes.install(self.client, slug, "Acme <hello@acme.com>", topic, "Reviewed")
            self.assertEqual(result, self.body)
            options = {"from": "Acme <hello@acme.com>", "name": "Reviewed"}
            if topic:
                options["topic_id"] = topic
            self.assertEqual(self.calls[-1], (
                "POST", f"https://offline.invalid/template-library/automations/{slug}/install", options))
        self.assertEqual(len(self.calls), 6)

    def test_review_only_reads_then_enable_is_explicit(self):
        installed = {"automation": {"id": "auto_123"},
                     "templates": {"created": [{"id": "tpl_new"}], "reused": [{"id": "tpl_draft"}]}}
        recipes.review(self.client, installed)
        self.assertEqual([c[0] for c in self.calls], ["GET", "GET", "GET"])
        self.assertTrue(self.calls[-1][1].endswith("/templates/tpl_draft"))
        recipes.enable(self.client, "auto_123")
        self.assertEqual(self.calls[-1][2], {"status": "enabled"})

    def test_signup_and_activation_preserve_boolean_type(self):
        recipes.start_onboarding(self.client, "ada@example.com", "topic_123")
        recipes.activate(self.client, "ada@example.com")
        self.assertEqual(self.calls[0][2], {
            "email": "ada@example.com", "first_name": "Ada", "properties": {"activated": False},
            "topics": [{"id": "topic_123", "subscription": "opt_in"}],
        })
        self.assertEqual(self.calls[1][2], {"properties": {"activated": True}})

    def test_real_payment_values_and_paid_event_not_a_cancellation_call(self):
        recipes.payment_failed(self.client, "ada@example.com", amount="EUR 57.40",
                               update_payment_url="https://billing.example.test/cus_42",
                               invoice_number="ACME-8042", invoice_id="in_42")
        recipes.invoice_paid(self.client, "ada@example.com", "in_42")
        self.assertEqual(self.calls[0][2]["payload"], {
            "AMOUNT": "EUR 57.40", "UPDATE_PAYMENT_URL": "https://billing.example.test/cus_42",
            "INVOICE_NUMBER": "ACME-8042", "invoice_id": "in_42",
        })
        self.assertEqual(self.calls[1][2], {
            "event": "stripe.invoice.paid", "email": "ada@example.com", "payload": {"invoice_id": "in_42"},
        })
        self.assertTrue(all(c[1].endswith("/events/send") for c in self.calls))

    def test_sdk_errors_propagate(self):
        from urllib.error import HTTPError
        error_body = json.dumps({"name": "validation_error", "message": "Choose a topic"}).encode()
        with patch("urllib.request.OpenerDirector.open",
                   side_effect=HTTPError("https://offline.invalid", 422, "validation_error", {},
                                         io.BytesIO(error_body))):
            with self.assertRaises(DispatchError) as error:
                recipes.install(self.client, "newsletter-welcome", "hello@acme.com")
        self.assertEqual(error.exception.status, 422)
        self.assertIn("Choose a topic", str(error.exception))


if __name__ == "__main__":
    unittest.main()
