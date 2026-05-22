from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


Json = dict[str, Any]


class DispatchError(Exception):
    def __init__(self, status: int, body: Any) -> None:
        self.status = status
        self.body = body
        message = body.get("message") if isinstance(body, dict) else str(body)
        super().__init__(f"{status} {message}")


class Dispatch:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        user_agent: str = "dispatch-python/0.1.0",
    ) -> None:
        self.api_key = api_key or os.getenv("DISPATCH_API_KEY")
        if not self.api_key:
            raise ValueError("Dispatch API key is required")
        self.base_url = (base_url or os.getenv("API_URL", "http://localhost:3100")).rstrip("/")
        self.user_agent = user_agent

    def setup(self) -> Json:
        return self._request("GET", "/v1/setup", auth=False)

    def health(self) -> Json:
        return self._request("GET", "/health", auth=False)

    def send(self, email: Json, idempotency_key: str | None = None) -> Json:
        return self._request("POST", "/v1/emails", email, idempotency_key=idempotency_key)

    def batch(self, emails: list[Json], idempotency_key: str | None = None) -> Json:
        return self._request("POST", "/v1/emails/batch", {"emails": emails}, idempotency_key=idempotency_key)

    def emails(self) -> Json:
        return self._request("GET", "/v1/emails")

    def email(self, email_id: str) -> Json:
        return self._request("GET", f"/v1/emails/{email_id}")

    def email_events(self, email_id: str) -> Json:
        return self._request("GET", f"/v1/emails/{email_id}/events")

    def domains(self) -> Json:
        return self._request("GET", "/v1/domains")

    def create_domain(self, domain: Json) -> Json:
        return self._request("POST", "/v1/domains", domain)

    def verify_domain(self, domain_id: str) -> Json:
        return self._request("POST", f"/v1/domains/{domain_id}/verify", {})

    def doctor_domain(self, domain_id: str) -> Json:
        return self._request("GET", f"/v1/domains/{domain_id}/doctor")

    def templates(self) -> Json:
        return self._request("GET", "/v1/templates")

    def create_template(self, template: Json) -> Json:
        return self._request("POST", "/v1/templates", template)

    def render_template(self, template_id: str, variables: Json | None = None) -> Json:
        return self._request("POST", f"/v1/templates/{template_id}/render", {"variables": variables or {}})

    def contacts(self) -> Json:
        return self._request("GET", "/v1/contacts")

    def create_contact(self, contact: Json) -> Json:
        return self._request("POST", "/v1/contacts", contact)

    def suppressions(self) -> Json:
        return self._request("GET", "/v1/suppressions")

    def suppress(self, suppression: Json) -> Json:
        return self._request("POST", "/v1/suppressions", suppression)

    def webhooks(self) -> Json:
        return self._request("GET", "/v1/webhooks")

    def create_webhook(self, webhook: Json) -> Json:
        return self._request("POST", "/v1/webhooks", webhook)

    def events(self) -> Json:
        return self._request("GET", "/v1/events")

    def create_event(self, event: Json) -> Json:
        return self._request("POST", "/v1/events", event)

    def automations(self) -> Json:
        return self._request("GET", "/v1/automations")

    def create_automation(self, automation: Json) -> Json:
        return self._request("POST", "/v1/automations", automation)

    def received_emails(self) -> Json:
        return self._request("GET", "/v1/received-emails")

    def simulate_received_email(self, email: Json) -> Json:
        return self._request("POST", "/v1/received-emails/simulate", email)

    def logs(self) -> Json:
        return self._request("GET", "/v1/logs")

    def _request(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        *,
        auth: bool = True,
        idempotency_key: str | None = None,
    ) -> Json:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "accept": "application/json",
            "user-agent": self.user_agent,
        }
        if data is not None:
            headers["content-type"] = "application/json"
        if auth:
            headers["authorization"] = f"Bearer {self.api_key}"
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key

        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8")
            try:
                parsed: Any = json.loads(raw)
            except json.JSONDecodeError:
                parsed = raw
            raise DispatchError(error.code, parsed) from error


__all__ = ["Dispatch", "DispatchError"]
