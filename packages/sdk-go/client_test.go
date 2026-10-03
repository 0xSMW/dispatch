package dispatch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

type recorded struct {
	Method  string
	Path    string
	Body    any
	Raw     []byte
	Headers http.Header
}

type canned struct {
	status int
	body   any
}

func recorder(t *testing.T, responses map[string]canned) (*Client, *[]recorded) {
	t.Helper()
	calls := &[]recorded{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body any
		if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") && len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		*calls = append(*calls, recorded{Method: r.Method, Path: r.URL.RequestURI(), Body: body, Raw: raw, Headers: r.Header.Clone()})
		reply, ok := responses[r.Method+" "+r.URL.RequestURI()]
		if !ok {
			reply = canned{200, map[string]any{"object": "ok", "id": "x"}}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req_go")
		w.WriteHeader(reply.status)
		_ = json.NewEncoder(w).Encode(reply.body)
	}))
	t.Cleanup(server.Close)
	client := New("sk_test")
	client.BaseURL = server.URL
	return client, calls
}

func TestNewClient(t *testing.T) {
	t.Setenv("DISPATCH_BASE_URL", "")
	t.Setenv("API_URL", "")
	c := New("test-api-key")
	if c.APIKey != "test-api-key" || c.BaseURL != "http://localhost:3100" || c.UserAgent != "dispatch-go:0.1.0" {
		t.Fatalf("unexpected client: %+v", c)
	}
}

func TestAutomationPauseContracts(t *testing.T) {
	for _, status := range []string{AutomationEnabled, AutomationPaused, AutomationDisabled} {
		t.Run(status, func(t *testing.T) {
			want := Automation{ID: "a/1", Status: status, Version: 4, TriggerConfig: AutomationTriggerConfig{Type: TriggerContactCreated}, Reentry: ReentryOnce}
			client, calls := recorder(t, map[string]canned{
				"PATCH /automations/a%2F1":          {200, want},
				"GET /automations/a%2F1":            {200, want},
				"GET /automations?status=" + status: {200, ListResponse[Automation]{Object: "list", Data: []Automation{want}}},
			})
			updated, err := client.UpdateAutomation("a/1", AutomationUpdate{Status: status})
			if err != nil || !reflect.DeepEqual(updated, &want) {
				t.Fatalf("update: %+v, %v", updated, err)
			}
			if !reflect.DeepEqual((*calls)[0].Body, Map{"status": status}) {
				t.Fatalf("update body: %#v", (*calls)[0].Body)
			}
			got, err := client.Automation("a/1")
			if err != nil || !reflect.DeepEqual(got, &want) {
				t.Fatalf("get: %+v, %v", got, err)
			}
			list, err := client.Automations(url.Values{"status": {status}})
			if err != nil || len(list.Data) != 1 || !reflect.DeepEqual(list.Data[0], want) {
				t.Fatalf("list: %+v, %v", list, err)
			}
		})
	}
	for _, enabled := range []bool{false, true} {
		client, calls := recorder(t, nil)
		if _, err := client.UpdateAutomation("a1", AutomationUpdate{Enabled: Ptr(enabled)}); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual((*calls)[0].Body, Map{"enabled": enabled}) {
			t.Fatalf("legacy update: %#v", (*calls)[0].Body)
		}
		if _, err := client.CreateAutomation(AutomationInput{Name: "Legacy", Steps: []AutomationStep{}, Enabled: Ptr(enabled)}); err != nil {
			t.Fatal(err)
		}
		body := (*calls)[1].Body.(map[string]any)
		if body["enabled"] != enabled {
			t.Fatalf("legacy create: %#v", body)
		}
		if _, exists := body["version"]; exists {
			t.Fatal("create sent read-only version")
		}
	}
	client, _ := recorder(t, map[string]canned{
		"PATCH /automations/a1": {409, Map{"name": "conflict", "message": "Disabled cannot pause"}},
	})
	_, err := client.UpdateAutomation("a1", AutomationUpdate{Status: AutomationPaused})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 409 {
		t.Fatalf("conflict: %v", err)
	}
}

func TestEnrollmentContracts(t *testing.T) {
	job := Map{
		"object": "automation_enrollment_job", "id": "j/1", "automation_id": "a/1",
		"segment_id": nil, "status": "queued", "error": nil,
		"created_at": "2026-10-03T00:00:00Z", "completed_at": nil,
		"counts": Map{"total": 501, "processed": 0, "enrolled": 0, "skipped": 0, "failed": 0},
	}
	cancelled := Map{"object": "automation_enrollment_job", "id": "j/1", "status": "cancelled", "counts": job["counts"]}
	client, calls := recorder(t, map[string]canned{
		"POST /automations/a%2F1/enroll":              {202, job},
		"GET /automations/a%2F1/enroll-jobs/j%2F1":    {200, job},
		"DELETE /automations/a%2F1/enroll-jobs/j%2F1": {200, cancelled},
		"DELETE /contacts/imports/i%2F1":              {200, Map{"object": "contact_import", "id": "i/1", "status": "cancelled"}},
	})
	created, err := client.Enroll("a/1", AutomationEnrollment{All: true}, "enroll-retry")
	if err != nil || created.Status != "queued" || created.Counts.Total != 501 || created.SegmentID != nil || created.CompletedAt != nil || created.Error != nil {
		t.Fatalf("create: %+v, %v", created, err)
	}
	if (*calls)[0].Headers.Get("Idempotency-Key") != "enroll-retry" {
		t.Fatal("missing enrollment idempotency key")
	}
	if _, err := client.Enroll("a/1", AutomationEnrollment{SegmentID: "s/1"}); err != nil {
		t.Fatal(err)
	}
	got, err := client.GetEnrollmentJob("a/1", "j/1")
	if err != nil || !reflect.DeepEqual(got, created) {
		t.Fatalf("get: %+v, %v", got, err)
	}
	stopped, err := client.CancelEnrollmentJob("a/1", "j/1")
	if err != nil || stopped.Status != "cancelled" || stopped.Counts.Total != 501 {
		t.Fatalf("cancel: %+v, %v", stopped, err)
	}
	imported, err := client.CancelContactImport("i/1")
	if err != nil || imported["status"] != "cancelled" {
		t.Fatalf("import: %v, %v", imported, err)
	}
	for index, want := range []Map{{"all": true}, {"segment_id": "s/1"}} {
		if !reflect.DeepEqual((*calls)[index].Body, map[string]any(want)) {
			t.Fatalf("body: %v", (*calls)[index].Body)
		}
	}
	for _, index := range []int{2, 3, 4} {
		if len((*calls)[index].Raw) != 0 {
			t.Fatalf("unexpected body: %s", (*calls)[index].Raw)
		}
	}
	if len(*calls) != 5 {
		t.Fatalf("unexpected extra requests: %v", *calls)
	}
}

func TestTypedPropertyAndMappingContracts(t *testing.T) {
	client, calls := recorder(t, nil)
	if _, err := client.CreateContactProperty(ContactPropertyInput{Key: "activated", Type: "boolean", FallbackValue: false}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateContactProperty(ContactPropertyInput{Key: "last_active_at", Type: "date", FallbackValue: "2026-10-03T09:30:00+02:00"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.UpdateContactProperty("prop_1", nil); err != nil {
		t.Fatal(err)
	}
	for index, want := range []Map{
		{"key": "activated", "type": "boolean", "fallback_value": false},
		{"key": "last_active_at", "type": "date", "fallback_value": "2026-10-03T09:30:00+02:00"},
		{"fallback_value": nil},
	} {
		if !reflect.DeepEqual((*calls)[index].Body, map[string]any(want)) {
			t.Fatalf("request %d: %#v", index, (*calls)[index].Body)
		}
	}
	config := SendEmailConfig{Template: Map{"id": "template_1", "variables": Map{"PLAN": "contact.plan", "FLAG": false}}, VariableMapping: map[string]string{"PLAN": "contact.plan", "WHEN": "event.received_at"}}
	if _, err := client.CreateAutomation(Map{"name": "Typed", "steps": []Map{{"key": "send", "type": "send_email", "config": config}}}); err != nil {
		t.Fatal(err)
	}
	body := (*calls)[3].Body.(map[string]any)
	got := body["steps"].([]any)[0].(map[string]any)["config"].(map[string]any)
	if !reflect.DeepEqual(got["variable_mapping"], map[string]any{"PLAN": "contact.plan", "WHEN": "event.received_at"}) {
		t.Fatalf("mappings: %#v", got)
	}
	if got["template"].(map[string]any)["variables"].(map[string]any)["PLAN"] != "contact.plan" {
		t.Fatalf("literal changed: %#v", got)
	}
	if _, err := client.ImportContacts(ContactImportInput{File: []byte("email,when\na@example.com,2026-10-03\n"), ColumnMap: map[string]any{"properties": map[string]ImportColumn{"when": {Column: "when", Type: "date"}}}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string((*calls)[4].Raw), `"type":"date"`) {
		t.Fatalf("date mapping missing: %s", (*calls)[4].Raw)
	}
}

func TestAutomationTriggerContracts(t *testing.T) {
	configs := []AutomationTriggerConfig{
		{Type: TriggerEvent, EventName: "user.created"},
		{Type: TriggerContactCreated},
		{Type: TriggerContactUpdated},
		{Type: TriggerContactUpdated, Field: "unsubscribed", From: json.RawMessage("false"), To: json.RawMessage("true")},
		{Type: TriggerContactUpdated, Field: "properties.score", From: json.RawMessage("0"), To: json.RawMessage("42.5")},
		{Type: TriggerContactUpdated, Field: "properties.last_active_at", From: json.RawMessage("null"), To: json.RawMessage(`"2026-10-03T09:30:00+02:00"`)},
		{Type: TriggerContactUpdated, Field: "first_name", From: json.RawMessage(`"Ada"`), To: json.RawMessage("null")},
		{Type: TriggerTopicSubscribed, TopicID: "topic_1"},
		{Type: TriggerSegmentAdded, SegmentID: "segment_1"},
	}
	for _, config := range configs {
		t.Run(string(config.Type)+"/"+config.Field, func(t *testing.T) {
			var trigger *string
			if config.Type == TriggerEvent {
				trigger = Ptr(config.EventName)
			}
			want := Automation{ID: "a1", Name: "Contacts", Trigger: trigger, TriggerConfig: config, Reentry: ReentryEveryTime}
			client, calls := recorder(t, map[string]canned{
				"POST /automations":              {200, want},
				"PATCH /automations/a1":          {200, want},
				"GET /automations/a1":            {200, want},
				"POST /automations/a1/duplicate": {200, want},
				"GET /automations":               {200, ListResponse[Automation]{Object: "list", Data: []Automation{want}}},
			})
			steps := []AutomationStep{{Key: "start", Type: "trigger", Config: config}}
			input := AutomationInput{Name: "Contacts", Steps: steps, Reentry: ReentryEveryTime}
			created, err := client.CreateAutomation(input)
			if err != nil || !reflect.DeepEqual(created, &want) {
				t.Fatalf("create: %+v, %v", created, err)
			}
			body := (*calls)[0].Body.(map[string]any)
			var expected map[string]any
			raw, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(raw, &expected); err != nil {
				t.Fatal(err)
			}
			got := body["steps"].([]any)[0].(map[string]any)["config"]
			if body["reentry"] != "every_time" || !reflect.DeepEqual(got, expected) {
				t.Fatalf("wire config: %#v", body)
			}
			updated, err := client.UpdateAutomation("a1", Map{"steps": steps, "reentry": ReentryOnce})
			if err != nil || !reflect.DeepEqual(updated, &want) || (*calls)[1].Body.(map[string]any)["reentry"] != "once" {
				t.Fatalf("update: %+v, %v", updated, err)
			}
			if !reflect.DeepEqual((*calls)[1].Body.(map[string]any)["steps"].([]any)[0].(map[string]any)["config"], expected) {
				t.Fatalf("update config changed: %#v", (*calls)[1].Body)
			}
			gotAutomation, err := client.Automation("a1")
			if err != nil || !reflect.DeepEqual(gotAutomation, &want) {
				t.Fatalf("get: %+v, %v", gotAutomation, err)
			}
			duplicate, err := client.DuplicateAutomation("a1")
			if err != nil || !reflect.DeepEqual(duplicate, &want) {
				t.Fatalf("duplicate: %+v, %v", duplicate, err)
			}
			list, err := client.Automations()
			if err != nil || len(list.Data) != 1 || !reflect.DeepEqual(list.Data[0], want) {
				t.Fatalf("list: %+v, %v", list, err)
			}
		})
	}
	client, calls := recorder(t, nil)
	input := AutomationInput{Name: "Legacy", Trigger: "user.created", Steps: []AutomationStep{{Key: "start", Type: "trigger", Config: Map{"event_name": "user.created"}}}}
	if _, err := client.CreateAutomation(input); err != nil {
		t.Fatal(err)
	}
	body := (*calls)[0].Body.(map[string]any)
	if body["trigger"] != "user.created" || body["steps"].([]any)[0].(map[string]any)["config"].(map[string]any)["event_name"] != "user.created" {
		t.Fatalf("legacy trigger: %#v", body)
	}
	if _, exists := body["reentry"]; exists {
		t.Fatalf("optional reentry was sent: %#v", body)
	}
}

func TestMarketingSplitResponse(t *testing.T) {
	split := []SplitEmail{{ID: "email_1", To: "ada@example.com", Sandbox: true}, {ID: "email_2", To: "bob@dispatch-fixture.net", Sandbox: false}}
	result := Map{"id": "email_1", "emails": split}
	client, _ := recorder(t, map[string]canned{
		"POST /emails":       {200, result},
		"POST /emails/batch": {200, Map{"data": []any{result}}},
	})
	email, err := client.Send(Map{"from": "a@example.com", "to": []string{"ada@example.com", "bob@dispatch-fixture.net"}, "topic_id": "topic_1", "text": "Hi"}, "")
	if err != nil || !reflect.DeepEqual(email.Emails, split) {
		t.Fatalf("split send: %+v, %v", email, err)
	}
	batch, err := client.Batch([]Map{{"to": []string{"ada@example.com", "bob@dispatch-fixture.net"}}}, "", "strict")
	if err != nil || len(batch.Data) != 1 || !reflect.DeepEqual(batch.Data[0].Emails, split) {
		t.Fatalf("split batch: %+v, %v", batch, err)
	}
}

func TestSandboxResponses(t *testing.T) {
	recipients := []EmailRecipient{
		{ID: "rcpt_1", Email: "test@example.com", Kind: "cc", Status: "delivered", Sandbox: true, CreatedAt: "2026-10-03T10:00:00Z"},
		{ID: "rcpt_2", Email: "ada@acme.com", Kind: "to", Status: "delivered", Sandbox: false, CreatedAt: "2026-10-03T10:00:00Z"},
	}
	sandbox := Map{"id": "email_1", "sandbox": true, "last_event": "delivered"}
	client, _ := recorder(t, map[string]canned{
		"POST /emails":        {200, sandbox},
		"POST /emails/batch":  {200, Map{"data": []any{sandbox}}},
		"GET /emails":         {200, Map{"object": "list", "has_more": false, "data": []any{sandbox}}},
		"GET /emails/email_2": {200, Map{"id": "email_2", "sandbox": false, "last_event": "delivered", "recipients": recipients}},
	})
	sent, err := client.Send(Map{"from": "a@acme.com", "to": "test@example.com", "subject": "Test", "text": "Hi"}, "")
	if err != nil || !sent.Sandbox {
		t.Fatalf("sandbox send: %+v, %v", sent, err)
	}
	batch, err := client.Batch([]Map{{"to": "test@example.com"}}, "", "strict")
	if err != nil || len(batch.Data) != 1 || !batch.Data[0].Sandbox {
		t.Fatalf("sandbox batch: %+v, %v", batch, err)
	}
	page, err := client.Emails(nil)
	if err != nil || len(page.Data) != 1 || !page.Data[0].Sandbox || page.Data[0].LastEvent != "delivered" {
		t.Fatalf("sandbox list: %+v, %v", page, err)
	}
	detail, err := client.Email("email_2")
	if err != nil || detail.Sandbox || detail.LastEvent != "delivered" || !reflect.DeepEqual(detail.Recipients, recipients) {
		t.Fatalf("mixed detail: %+v, %v", detail, err)
	}
}

func TestRoutes(t *testing.T) {
	page := url.Values{"limit": {"5"}}
	cases := []struct {
		name   string
		call   func(c *Client) error
		method string
		path   string
		body   any
	}{
		{"Settings", func(c *Client) error { _, err := c.Settings(); return err }, "GET", "/settings", nil},
		{"UpdateSettings", func(c *Client) error { _, err := c.UpdateSettings(Map{"import_trigger_automations": true}); return err }, "PATCH", "/settings", map[string]any{"import_trigger_automations": true}},
		{"Emails", func(c *Client) error { _, err := c.Emails(page); return err }, "GET", "/emails?limit=5", nil},
		{"Email", func(c *Client) error { _, err := c.Email("e1"); return err }, "GET", "/emails/e1", nil},
		{"UpdateEmail", func(c *Client) error { _, err := c.UpdateEmail("e1", Map{"scheduled_at": "in 1 hour"}); return err }, "PATCH", "/emails/e1", map[string]any{"scheduled_at": "in 1 hour"}},
		{"CancelEmail", func(c *Client) error { _, err := c.CancelEmail("e1"); return err }, "POST", "/emails/e1/cancel", map[string]any{}},
		{"EmailJobs", func(c *Client) error { _, err := c.EmailJobs(url.Values{"email_id": {"e1"}}); return err }, "GET", "/email-jobs?email_id=e1", nil},
		{"EmailJob", func(c *Client) error { _, err := c.EmailJob("j1"); return err }, "GET", "/email-jobs/j1", nil},
		{"EmailMetrics", func(c *Client) error { _, err := c.EmailMetrics(url.Values{"metrics": {"sent"}}); return err }, "GET", "/emails/metrics?metrics=sent", nil},
		{"AutomationEmailMetrics", func(c *Client) error {
			_, err := c.EmailMetrics(url.Values{"automation_id": {"a1"}, "dimensions": {"step"}})
			return err
		}, "GET", "/emails/metrics?automation_id=a1&dimensions=step", nil},
		{"ShareEmail", func(c *Client) error { _, err := c.ShareEmail("e1", "10m"); return err }, "POST", "/emails/e1/share", map[string]any{"expires_in": "10m"}},
		{"ReceivedEmail", func(c *Client) error { _, err := c.ReceivedEmail("r1", url.Values{"html_format": {"cid"}}); return err }, "GET", "/emails/receiving/r1?html_format=cid", nil},
		{"ReceivedAttachments", func(c *Client) error { _, err := c.ReceivedAttachments("r1"); return err }, "GET", "/emails/receiving/r1/attachments", nil},
		{"Domain", func(c *Client) error { _, err := c.Domain("d1"); return err }, "GET", "/domains/d1", nil},
		{"UpdateDomain", func(c *Client) error { _, err := c.UpdateDomain("d1", Map{"tls": "enforced"}); return err }, "PATCH", "/domains/d1", map[string]any{"tls": "enforced"}},
		{"PublishRoute53", func(c *Client) error { _, err := c.PublishRoute53("d1"); return err }, "POST", "/domains/d1/publish-route53", map[string]any{}},
		{"DeleteDomain", func(c *Client) error { _, err := c.DeleteDomain("d1"); return err }, "DELETE", "/domains/d1", nil},
		{"APIKeys", func(c *Client) error { _, err := c.APIKeys(); return err }, "GET", "/api-keys", nil},
		{"UpdateAPIKey", func(c *Client) error { _, err := c.UpdateAPIKey("k1", "ci"); return err }, "PATCH", "/api-keys/k1", map[string]any{"name": "ci"}},
		{"Brand", func(c *Client) error { _, err := c.Brand(); return err }, "GET", "/brand", nil},
		{"UpdateBrand", func(c *Client) error { _, err := c.UpdateBrand(Map{"product_name": "Acme"}); return err }, "PATCH", "/brand", map[string]any{"product_name": "Acme"}},
		{"TemplateLibrary", func(c *Client) error { _, err := c.TemplateLibrary(); return err }, "GET", "/template-library", nil},
		{"InstallTemplate", func(c *Client) error { _, err := c.InstallTemplate("welcome"); return err }, "POST", "/template-library/welcome/install", map[string]any{}},
		{"PublishTemplate", func(c *Client) error { _, err := c.PublishTemplate("welcome", "v1"); return err }, "POST", "/templates/welcome/publish", map[string]any{"version_id": "v1"}},
		{"DuplicateTemplate", func(c *Client) error { _, err := c.DuplicateTemplate("welcome", ""); return err }, "POST", "/templates/welcome/duplicate", map[string]any{}},
		{"TemplateVersions", func(c *Client) error { _, err := c.TemplateVersions("welcome"); return err }, "GET", "/templates/welcome/versions", nil},
		{"CreateTemplateVersion", func(c *Client) error { _, err := c.CreateTemplateVersion("welcome", Map{"subject": "Hi"}); return err }, "POST", "/templates/welcome/versions", map[string]any{"subject": "Hi"}},
		{"CreateContact", func(c *Client) error { _, err := c.CreateContact(ContactInput{Email: "ada@x.com"}); return err }, "POST", "/contacts", map[string]any{"email": "ada@x.com"}},
		{"Contact", func(c *Client) error { _, err := c.Contact("ada@x.com"); return err }, "GET", "/contacts/ada@x.com", nil},
		{"ContactActivity", func(c *Client) error { _, err := c.ContactActivity("c1"); return err }, "GET", "/contacts/c1/activity", nil},
		{"AddContactSegment", func(c *Client) error { _, err := c.AddContactSegment("c1", "s1"); return err }, "POST", "/contacts/c1/segments/s1", map[string]any{}},
		{"UpdateContactTopics", func(c *Client) error {
			_, err := c.UpdateContactTopics("c1", []TopicChoice{{ID: "t1", Subscription: "opt_out"}})
			return err
		}, "PATCH", "/contacts/c1/topics", map[string]any{"topics": []any{map[string]any{"id": "t1", "subscription": "opt_out"}}}},
		{"ContactImports", func(c *Client) error { _, err := c.ContactImports(url.Values{"status": {"completed"}}); return err }, "GET", "/contacts/imports?status=completed", nil},
		{"ContactImport", func(c *Client) error { _, err := c.ContactImport("imp_1"); return err }, "GET", "/contacts/imports/imp_1", nil},
		{"CreateContactProperty", func(c *Client) error {
			_, err := c.CreateContactProperty(ContactPropertyInput{Key: "plan"})
			return err
		}, "POST", "/contact-properties", map[string]any{"key": "plan"}},
		{"UpdateContactProperty", func(c *Client) error { _, err := c.UpdateContactProperty("p1", "free"); return err }, "PATCH", "/contact-properties/p1", map[string]any{"fallback_value": "free"}},
		{"DeleteContactProperty", func(c *Client) error { _, err := c.DeleteContactProperty("p1"); return err }, "DELETE", "/contact-properties/p1", nil},
		{"Suppression", func(c *Client) error { _, err := c.Suppression("x@x.com"); return err }, "GET", "/suppressions/x@x.com", nil},
		{"SuppressBatch", func(c *Client) error { _, err := c.SuppressBatch([]string{"a@x.com"}); return err }, "POST", "/suppressions/batch/add", map[string]any{"emails": []any{"a@x.com"}}},
		{"UnsuppressBatch", func(c *Client) error { _, err := c.UnsuppressBatch(nil, []string{"sup_1"}); return err }, "POST", "/suppressions/batch/remove", map[string]any{"ids": []any{"sup_1"}}},
		{"Topics", func(c *Client) error { _, err := c.Topics(); return err }, "GET", "/topics", nil},
		{"SubscribeTopic", func(c *Client) error { _, err := c.SubscribeTopic("t1", "ada@x.com"); return err }, "POST", "/topics/t1/subscriptions", map[string]any{"email": "ada@x.com", "status": "subscribed"}},
		{"Segments", func(c *Client) error { _, err := c.Segments(); return err }, "GET", "/segments", nil},
		{"SegmentContacts", func(c *Client) error { _, err := c.SegmentContacts("s1"); return err }, "GET", "/segments/s1/contacts", nil},
		{"CreateBroadcast", func(c *Client) error {
			_, err := c.CreateBroadcast(BroadcastInput{From: "a@x.com", SegmentID: "s1", PreviewText: "P"})
			return err
		}, "POST", "/broadcasts", map[string]any{"from": "a@x.com", "segment_id": "s1", "preview_text": "P"}},
		{"SendBroadcast", func(c *Client) error { _, err := c.SendBroadcast("b1", "in 1 hour"); return err }, "POST", "/broadcasts/b1/send", map[string]any{"scheduled_at": "in 1 hour"}},
		{"DuplicateBroadcast", func(c *Client) error { _, err := c.DuplicateBroadcast("b1", ""); return err }, "POST", "/broadcasts/b1/duplicate", map[string]any{}},
		{"BroadcastRecipients", func(c *Client) error { _, err := c.BroadcastRecipients("b1", "bounced", page); return err }, "GET", "/broadcasts/b1/recipients?limit=5&type=bounced", nil},
		{"BroadcastClickedLinks", func(c *Client) error { _, err := c.BroadcastClickedLinks("b1"); return err }, "GET", "/broadcasts/b1/clicked-links", nil},
		{"PauseBroadcast", func(c *Client) error { _, err := c.PauseBroadcast("b1"); return err }, "POST", "/broadcasts/b1/pause", map[string]any{}},
		{"Automations", func(c *Client) error { _, err := c.Automations(); return err }, "GET", "/automations", nil},
		{"DuplicateAutomation", func(c *Client) error { _, err := c.DuplicateAutomation("a1"); return err }, "POST", "/automations/a1/duplicate", map[string]any{}},
		{"AutomationRuns", func(c *Client) error { _, err := c.AutomationRuns("a1", url.Values{"status": {"failed"}}); return err }, "GET", "/automations/a1/runs?status=failed", nil},
		{"AutomationRun", func(c *Client) error { _, err := c.AutomationRun("a1", "run_1"); return err }, "GET", "/automations/a1/runs/run_1", nil},
		{"SendEvent", func(c *Client) error {
			_, err := c.SendEvent(EventInput{Event: "user.created", Email: "ada@x.com", Payload: Map{"plan": "pro"}})
			return err
		}, "POST", "/events/send", map[string]any{"event": "user.created", "email": "ada@x.com", "payload": map[string]any{"plan": "pro"}}},
		{"CreateEvent", func(c *Client) error {
			_, err := c.CreateEvent(EventDefinitionInput{Name: "user.created", Schema: map[string]string{"plan": "string"}})
			return err
		}, "POST", "/events", map[string]any{"name": "user.created", "schema": map[string]any{"plan": "string"}}},
		{"UpdateEvent", func(c *Client) error {
			_, err := c.UpdateEvent("user.created", map[string]string{"plan": "number"})
			return err
		}, "PATCH", "/events/user.created", map[string]any{"schema": map[string]any{"plan": "number"}}},
		{"FiredEvents", func(c *Client) error { _, err := c.FiredEvents(); return err }, "GET", "/fired-events", nil},
		{"FiredEvent", func(c *Client) error { _, err := c.FiredEvent("ev_1"); return err }, "GET", "/fired-events/ev_1", nil},
		{"RotateWebhookSecret", func(c *Client) error { _, err := c.RotateWebhookSecret("w1"); return err }, "POST", "/webhooks/w1/signing-secret/rotate", map[string]any{}},
		{"WebhookEvents", func(c *Client) error { _, err := c.WebhookEvents("w1"); return err }, "GET", "/webhooks/w1/events", nil},
		{"WebhookEvent", func(c *Client) error { _, err := c.WebhookEvent("w1", "ev_1"); return err }, "GET", "/webhooks/w1/events/ev_1", nil},
		{"ReplayWebhook", func(c *Client) error { _, err := c.ReplayWebhook("w1", "ev_1"); return err }, "POST", "/webhooks/w1/events/ev_1/replay", map[string]any{}},
		{"Logs", func(c *Client) error { _, err := c.Logs(url.Values{"status": {"4xx"}}); return err }, "GET", "/logs?status=4xx", nil},
		{"Timeline", func(c *Client) error { _, err := c.Timeline(); return err }, "GET", "/timeline", nil},
		{"Usage", func(c *Client) error { _, err := c.Usage(); return err }, "GET", "/usage", nil},
		{"System", func(c *Client) error { _, err := c.System(); return err }, "GET", "/system", nil},
		{"Me", func(c *Client) error { _, err := c.Me(); return err }, "GET", "/me", nil},
		{"AuditLogs", func(c *Client) error { _, err := c.AuditLogs(); return err }, "GET", "/audit-logs", nil},
		{"CreateMembership", func(c *Client) error { _, err := c.CreateMembership("u1", "r1"); return err }, "POST", "/memberships", map[string]any{"user_id": "u1", "role_id": "r1"}},
		{"CheckLinks", func(c *Client) error { _, err := c.CheckLinks([]string{"https://x.com"}); return err }, "POST", "/links/check", map[string]any{"urls": []any{"https://x.com"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client, calls := recorder(t, nil)
			if err := tc.call(client); err != nil {
				t.Fatalf("call failed: %v", err)
			}
			sent := (*calls)[0]
			if sent.Method != tc.method || sent.Path != tc.path {
				t.Fatalf("got %s %s, want %s %s", sent.Method, sent.Path, tc.method, tc.path)
			}
			if strings.Contains(sent.Path, "/v1/") {
				t.Fatalf("path still has /v1: %s", sent.Path)
			}
			if tc.body != nil && !reflect.DeepEqual(sent.Body, tc.body) {
				t.Fatalf("body %#v, want %#v", sent.Body, tc.body)
			}
		})
	}
}

func TestSendHeadersAndFlatBody(t *testing.T) {
	client, calls := recorder(t, map[string]canned{"POST /emails": {200, map[string]any{"id": "email_1"}}})
	email, err := client.Send(SendInput{From: "a@x.com", To: "b@x.com", Subject: "Hi", Text: "Yo", ReplyTo: "r@x.com"}, "idem-1")
	if err != nil || email.ID != "email_1" {
		t.Fatalf("send: %+v %v", email, err)
	}
	sent := (*calls)[0]
	if sent.Headers.Get("Idempotency-Key") != "idem-1" || sent.Headers.Get("Authorization") != "Bearer sk_test" {
		t.Fatalf("headers: %v", sent.Headers)
	}
	if sent.Body.(map[string]any)["reply_to"] != "r@x.com" {
		t.Fatalf("body: %v", sent.Body)
	}
}

func TestBatchSendsBareArrayWithValidation(t *testing.T) {
	client, calls := recorder(t, map[string]canned{"POST /emails/batch": {200, map[string]any{"data": []any{map[string]any{"id": "email_1"}}}}})
	emails := []SendInput{{From: "a@x.com", To: "b@x.com", Subject: "Hi", Text: "Yo"}}
	result, err := client.Batch(emails, "idem-2", "permissive")
	if err != nil || len(result.Data) != 1 || result.Data[0].ID != "email_1" {
		t.Fatalf("batch: %+v %v", result, err)
	}
	sent := (*calls)[0]
	if _, ok := sent.Body.([]any); !ok {
		t.Fatalf("batch body should be an array: %#v", sent.Body)
	}
	if sent.Headers.Get("Idempotency-Key") != "idem-2" || sent.Headers.Get("X-Batch-Validation") != "permissive" {
		t.Fatalf("headers: %v", sent.Headers)
	}
}

func TestFlatResponses(t *testing.T) {
	client, _ := recorder(t, map[string]canned{
		"GET /contacts/c1": {200, map[string]any{"object": "contact", "id": "c1", "email": "ada@x.com", "unsubscribed": true}},
		"GET /topics":      {200, map[string]any{"object": "list", "has_more": false, "data": []any{map[string]any{"id": "t1", "name": "News", "default_subscription": "opt_in"}}}},
	})
	contact, err := client.Contact("c1")
	if err != nil || contact.Email != "ada@x.com" || !contact.Unsubscribed {
		t.Fatalf("contact: %+v %v", contact, err)
	}
	topics, err := client.Topics()
	if err != nil || len(topics.Data) != 1 || topics.Data[0].DefaultSubscription != "opt_in" {
		t.Fatalf("topics: %+v %v", topics, err)
	}
}

func TestPublicRoutesSkipAuthorization(t *testing.T) {
	client, calls := recorder(t, nil)
	if _, err := client.Health(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Setup(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateSession("a@x.com", "a long private password"); err != nil {
		t.Fatal(err)
	}
	if body := (*calls)[2].Body.(map[string]any); body["password"] != "a long private password" || body["api_key"] != nil {
		t.Fatalf("session body = %v", body)
	}
	for _, call := range *calls {
		// /setup needs the key in production, where public setup is off.
		want := ""
		if call.Path == "/setup" {
			want = "Bearer sk_test"
		}
		if call.Headers.Get("Authorization") != want {
			t.Fatalf("%s authorization = %q", call.Path, call.Headers.Get("Authorization"))
		}
	}
}

func TestImportContactsUploadsMultipart(t *testing.T) {
	client, calls := recorder(t, nil)
	_, err := client.ImportContacts(ContactImportInput{File: []byte("email\nada@x.com\n"), OnConflict: "skip", ColumnMap: Map{"email": Map{"column": "email"}}})
	if err != nil {
		t.Fatal(err)
	}
	sent := (*calls)[0]
	mediaType, params, _ := mime.ParseMediaType(sent.Headers.Get("Content-Type"))
	if sent.Path != "/contacts/imports" || mediaType != "multipart/form-data" {
		t.Fatalf("got %s %s", sent.Path, mediaType)
	}
	form, err := multipart.NewReader(strings.NewReader(string(sent.Raw)), params["boundary"]).ReadForm(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	if form.Value["on_conflict"][0] != "skip" || form.Value["column_map"][0] != `{"email":{"column":"email"}}` {
		t.Fatalf("fields: %v", form.Value)
	}
	file, _ := form.File["file"][0].Open()
	content, _ := io.ReadAll(file)
	if string(content) != "email\nada@x.com\n" || form.File["file"][0].Filename != "contacts.csv" {
		t.Fatalf("file: %q", content)
	}
}

func TestImportTriggerAutomations(t *testing.T) {
	off, on := false, true
	for _, tc := range []struct {
		name   string
		flag   *bool
		stored bool
		value  string
	}{
		{"omitted", nil, true, ""},
		{"false", &off, false, "false"},
		{"true", &on, true, "true"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			imported := Map{"object": "contact_import", "id": "imp_1", "trigger_automations": tc.stored}
			client, calls := recorder(t, map[string]canned{
				"POST /contacts/imports":      {202, imported},
				"GET /contacts/imports/imp_1": {200, imported},
				"GET /contacts/imports":       {200, Map{"object": "list", "has_more": false, "data": []Map{imported}}},
			})
			created, err := client.ImportContacts(ContactImportInput{
				File: []byte("email\nada@x.com\n"), TriggerAutomations: tc.flag,
			})
			if err != nil {
				t.Fatal(err)
			}
			sent := (*calls)[0]
			mediaType, params, err := mime.ParseMediaType(sent.Headers.Get("Content-Type"))
			if err != nil || sent.Method != "POST" || sent.Path != "/contacts/imports" || mediaType != "multipart/form-data" {
				t.Fatalf("request: %+v, media type: %s, error: %v", sent, mediaType, err)
			}
			form, err := multipart.NewReader(bytes.NewReader(sent.Raw), params["boundary"]).ReadForm(1 << 20)
			if err != nil {
				t.Fatal(err)
			}
			defer form.RemoveAll()
			values, exists := form.Value["trigger_automations"]
			if tc.flag == nil {
				if exists {
					t.Fatalf("omitted flag was sent: %v", values)
				}
			} else if !reflect.DeepEqual(values, []string{tc.value}) {
				t.Fatalf("flag = %v, want %q", values, tc.value)
			}
			if !reflect.DeepEqual(created, imported) {
				t.Fatalf("create = %v, want %v", created, imported)
			}
			detail, err := client.ContactImport("imp_1")
			if err != nil || !reflect.DeepEqual(detail, imported) {
				t.Fatalf("detail = %v, error = %v", detail, err)
			}
			list, err := client.ContactImports()
			if err != nil {
				t.Fatal(err)
			}
			if len(list.Data) != 1 || !reflect.DeepEqual(list.Data[0], imported) {
				t.Fatalf("list = %+v", list)
			}
		})
	}
}

func TestStopAutomationResetReentry(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []bool
		body any
	}{
		{"omitted", nil, map[string]any{}},
		{"false", []bool{false}, map[string]any{"reset_reentry": false}},
		{"true", []bool{true}, map[string]any{"reset_reentry": true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, calls := recorder(t, map[string]canned{
				"POST /automations/a1/stop": {200, Map{"object": "automation", "id": "a1", "stopped": 2}},
			})
			result, err := client.StopAutomation("a1", tc.args...)
			if err != nil {
				t.Fatal(err)
			}
			sent := (*calls)[0]
			if sent.Method != "POST" || sent.Path != "/automations/a1/stop" || !reflect.DeepEqual(sent.Body, tc.body) {
				t.Fatalf("request = %+v, want body %v", sent, tc.body)
			}
			if tc.args == nil && string(sent.Raw) != "{}" {
				t.Fatalf("omitted options changed the legacy empty JSON body: %s", sent.Raw)
			}
			if result["stopped"] != float64(2) {
				t.Fatalf("result = %v", result)
			}
		})
	}
}

func TestForwardReceivedEmail(t *testing.T) {
	client, calls := recorder(t, map[string]canned{
		"GET /emails/receiving/r1?html_format=cid": {200, map[string]any{"id": "r1", "subject": "Invoice", "html": "<p>Due</p>"}},
		"POST /emails": {200, map[string]any{"id": "email_9"}},
	})
	email, err := client.ForwardReceivedEmail("r1", "ops@x.com", "bot@x.com", "")
	if err != nil || email.ID != "email_9" {
		t.Fatalf("forward: %+v %v", email, err)
	}
	want := map[string]any{"from": "bot@x.com", "to": "ops@x.com", "subject": "Fwd: Invoice", "html": "<p>Due</p>"}
	sent := (*calls)[len(*calls)-1]
	if sent.Path != "/emails" || !reflect.DeepEqual(sent.Body, want) {
		t.Fatalf("body %#v", sent.Body)
	}
}

func TestForwardCarriesAttachments(t *testing.T) {
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("PNGDATA"))
	}))
	defer files.Close()
	client, calls := recorder(t, map[string]canned{
		"GET /emails/receiving/r1?html_format=cid": {200, map[string]any{"id": "r1", "subject": "Fwd: Logo", "html": "<img src=\"cid:logo\">"}},
		"GET /emails/receiving/r1/attachments?limit=100": {200, map[string]any{"object": "list", "data": []any{
			map[string]any{"id": "a1", "filename": "logo.png", "content_type": "image/png", "content_id": "logo", "download_url": files.URL + "/logo"},
		}}},
		"POST /emails": {200, map[string]any{"id": "email_9"}},
	})
	if _, err := client.ForwardReceivedEmail("r1", "ops@x.com", "bot@x.com", ""); err != nil {
		t.Fatalf("forward: %v", err)
	}
	body := (*calls)[len(*calls)-1].Body.(map[string]any)
	want := []any{map[string]any{"filename": "logo.png", "content": base64.StdEncoding.EncodeToString([]byte("PNGDATA")), "content_type": "image/png", "content_id": "logo"}}
	if body["subject"] != "Fwd: Logo" || !reflect.DeepEqual(body["attachments"], want) {
		t.Fatalf("body %#v", body)
	}
}

func TestWithContextCancelsARequest(t *testing.T) {
	client, calls := recorder(t, map[string]canned{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.WithContext(ctx).Domains()
	var apiErr *Error
	if !errors.As(err, &apiErr) || !errors.Is(apiErr.Cause, context.Canceled) {
		t.Fatalf("want a cancelled request, got %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("request reached the server: %+v", *calls)
	}
	// The original client is untouched.
	if _, err := client.Domains(); err != nil {
		t.Fatalf("plain client: %v", err)
	}
}

func TestUpdatesSendFalseAndNull(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"contact", ContactUpdate{Unsubscribed: Ptr(false), LastName: Null[string]()}, `{"last_name":null,"unsubscribed":false}`},
		{"email", EmailUpdateInput{HTML: Null[string](), Text: Set("Hi")}, `{"html":null,"text":"Hi"}`},
		{"domain", DomainUpdate{OpenTracking: Ptr(false), Capabilities: &DomainCapabilities{Receiving: "enabled"}}, `{"open_tracking":false,"capabilities":{"receiving":"enabled"}}`},
		{"template", TemplateUpdate{Subject: Null[string](), Track: Ptr(false)}, `{"subject":null,"track":false}`},
		{"webhook", WebhookUpdate{Enabled: Ptr(false)}, `{"enabled":false}`},
		{"topic", TopicUpdate{Description: Null[string]()}, `{"description":null}`},
		// Nothing set, nothing sent: no empty name or endpoint for the API to refuse.
		{"empty", TemplateUpdate{}, `{}`},
		{"create", ContactInput{Email: "a@x.com", Unsubscribed: Ptr(false)}, `{"email":"a@x.com","unsubscribed":false}`},
	}
	for _, item := range cases {
		got, err := json.Marshal(item.in)
		if err != nil || string(got) != item.want {
			t.Fatalf("%s: %s %v", item.name, got, err)
		}
	}
}

func TestErrorResponse(t *testing.T) {
	client, _ := recorder(t, map[string]canned{
		"GET /domains/missing": {404, map[string]any{"name": "not_found", "statusCode": 404, "message": "Domain not found"}},
	})
	_, err := client.Domain("missing")
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("want *Error, got %v", err)
	}
	if apiErr.Status != 404 || apiErr.Name != "not_found" || apiErr.RequestID != "req_go" || apiErr.Error() != "404 Domain not found" {
		t.Fatalf("unexpected error: %+v", apiErr)
	}
}

func TestNetworkFailure(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	client := New("sk_test")
	client.BaseURL = "http://" + address
	_, err = client.Emails()
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 0 || apiErr.Name != "application_error" || apiErr.Cause == nil {
		t.Fatalf("unexpected error: %#v", err)
	}
}
