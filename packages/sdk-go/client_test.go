package dispatch

import (
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

func TestRoutes(t *testing.T) {
	page := url.Values{"limit": {"5"}}
	cases := []struct {
		name   string
		call   func(c *Client) error
		method string
		path   string
		body   any
	}{
		{"Emails", func(c *Client) error { _, err := c.Emails(page); return err }, "GET", "/emails?limit=5", nil},
		{"Email", func(c *Client) error { _, err := c.Email("e1"); return err }, "GET", "/emails/e1", nil},
		{"UpdateEmail", func(c *Client) error { _, err := c.UpdateEmail("e1", Map{"scheduled_at": "in 1 hour"}); return err }, "PATCH", "/emails/e1", map[string]any{"scheduled_at": "in 1 hour"}},
		{"CancelEmail", func(c *Client) error { _, err := c.CancelEmail("e1"); return err }, "POST", "/emails/e1/cancel", map[string]any{}},
		{"EmailJobs", func(c *Client) error { _, err := c.EmailJobs(url.Values{"email_id": {"e1"}}); return err }, "GET", "/email-jobs?email_id=e1", nil},
		{"EmailJob", func(c *Client) error { _, err := c.EmailJob("j1"); return err }, "GET", "/email-jobs/j1", nil},
		{"EmailMetrics", func(c *Client) error { _, err := c.EmailMetrics(url.Values{"metrics": {"sent"}}); return err }, "GET", "/emails/metrics?metrics=sent", nil},
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
