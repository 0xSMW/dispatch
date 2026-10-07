import threading
import unittest
from http.server import HTTPServer
from typing import get_args, get_type_hints

from dispatch import Dispatch, SendEmailConfig, SendInput, SendKind
from test_dispatch import Recorder


class TestSendKind(unittest.TestCase):
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

    def test_explicit_and_legacy_config_wire_contracts(self):
        self.assertEqual(get_args(SendKind), ("transactional", "marketing"))
        self.assertIn("kind", SendEmailConfig.__optional_keys__)
        for config in [
            {"template": "receipt", "kind": "transactional"},
            {"template": "newsletter", "kind": "marketing", "topic_id": "topic_1"},
            {"template": "newsletter", "kind": "marketing"},
            {"template": "receipt"},
            {"template": "newsletter", "topic_id": "topic_1"},
        ]:
            with self.subTest(config=config):
                Recorder.calls = []
                typed: SendEmailConfig = config
                body = {"name": "Typed", "status": "disabled", "steps": [
                    {"key": "send", "type": "send_email", "config": typed},
                ]}
                self.client.create_automation(body)
                self.client.update_automation("auto/1", body)
                self.client.dry_run_automation("auto/1", body)
                self.assertEqual([call["path"] for call in Recorder.calls], [
                    "/automations", "/automations/auto%2F1", "/automations/auto%2F1?dry_run=true",
                ])
                for call in Recorder.calls:
                    self.assertEqual(call["body"], body)
                    self.assertEqual("kind" in call["body"]["steps"][0]["config"], "kind" in config)

    def test_normalized_response_config_preserves_kind(self):
        steps = [
            {"key": "receipt", "type": "send_email", "config": {"template": "receipt", "kind": "transactional"}},
            {"key": "newsletter", "type": "send_email", "config": {
                "template": "newsletter", "kind": "marketing", "topic_id": "topic_1",
            }},
        ]
        Recorder.responses = {
            ("POST", "/automations"): (200, {"id": "auto_1", "steps": steps}),
            ("GET", "/automations/auto_1"): (200, {"id": "auto_1", "steps": steps}),
        }
        legacy = {"name": "Legacy", "steps": [
            {"key": "receipt", "type": "send_email", "config": {"template": "receipt"}},
        ]}
        self.assertEqual(self.client.create_automation(legacy)["steps"], steps)
        self.assertEqual(Recorder.calls[0]["body"], legacy)
        self.assertEqual(self.client.automation("auto_1")["steps"], steps)

    def test_template_detail_and_list_kinds(self):
        for kind in get_args(SendKind):
            with self.subTest(kind=kind):
                template = {"object": "template", "id": "template_1", "name": "Template", "kind": kind}
                listed = {"object": "list", "has_more": False, "data": [template]}
                Recorder.responses = {
                    ("GET", "/templates/template_1"): (200, template),
                    ("GET", "/templates"): (200, listed),
                }
                self.assertEqual(self.client.template("template_1"), template)
                self.assertEqual(self.client.templates(), listed)

    def test_ordinary_sends_remain_topic_based(self):
        self.assertNotIn("kind", get_type_hints(SendInput))
        body = {"from": "hello@acme.com", "to": "alex@acme.com", "subject": "Hello", "text": "Hello"}
        self.client.send(body)
        self.client.send({**body, "topic_id": "topic_1"})
        self.assertEqual(Recorder.calls[0]["body"], body)
        self.assertEqual(Recorder.calls[1]["body"], {**body, "topic_id": "topic_1"})
