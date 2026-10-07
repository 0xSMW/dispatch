package lifecycle

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	dispatch "github.com/dispatch/dispatch-go"
)

type request struct {
	method, path string
	body         map[string]any
}
type transport struct {
	calls     []request
	body      string
	responses map[string]string
	status    int
}

func (tr *transport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := map[string]any{}
	if req.Body != nil {
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			return nil, err
		}
	}
	tr.calls = append(tr.calls, request{req.Method, req.URL.EscapedPath(), body})
	status := tr.status
	if status == 0 {
		status = 200
	}
	response := tr.body
	if value, ok := tr.responses[req.URL.EscapedPath()]; ok {
		response = value
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}},
		Body: io.NopCloser(strings.NewReader(response)), Request: req}, nil
}

func offline() (*dispatch.Client, *transport) {
	tr := &transport{body: `{"id":"contact_123"}`}
	return &dispatch.Client{APIKey: "offline-example", BaseURL: "https://offline.invalid",
		HTTPClient: &http.Client{Transport: tr}}, tr
}

func TestAllSixInstallDisabled(t *testing.T) {
	client, tr := offline()
	tr.body = `{"automation":{"id":"auto_123","status":"disabled"},"templates":{"created":[],"reused":[]},"events":[],"properties":[],"next_steps":["Review the automation and its emails","Enable the automation"],"request_id":"req_offline"}`
	for _, slug := range []string{"newsletter-welcome", "onboarding-drip", "invite-to-upgrade", "win-back", "failed-payment", "come-back"} {
		topic := "topic_123"
		if slug == "failed-payment" {
			topic = ""
		}
		installed, err := Install(client, slug, "Acme <hello@acme.com>", topic, "Reviewed")
		if err != nil {
			t.Fatal(err)
		}
		if installed.Automation.Status != "disabled" || installed.RequestID != "req_offline" ||
			installed.Events == nil || installed.Properties == nil {
			t.Fatalf("aggregate lost: %+v", installed)
		}
		call := tr.calls[len(tr.calls)-1]
		if call.method != "POST" || call.path != "/template-library/automations/"+slug+"/install" ||
			call.body["from"] != "Acme <hello@acme.com>" || call.body["name"] != "Reviewed" {
			t.Fatalf("wrong install: %+v", call)
		}
		if topic == "" {
			if _, present := call.body["topic_id"]; present {
				t.Fatal("Transactional example supplied a topic")
			}
		} else if call.body["topic_id"] != topic {
			t.Fatalf("topic lost: %+v", call)
		}
	}
	if len(tr.calls) != 6 {
		t.Fatal("installation performed unexpected calls")
	}
}

func TestReviewAndExplicitEnable(t *testing.T) {
	client, tr := offline()
	tr.responses = map[string]string{
		"/automations/auto_123": `{"id":"auto_123","status":"disabled","steps":[{"key":"welcome","type":"send_email"}]}`,
		"/templates/tpl_new":    `{"id":"tpl_new","html":"<p>Welcome</p>","status":"published"}`,
		"/templates/tpl_draft":  `{"id":"tpl_draft","html":"<p>Tenant-edited draft</p>","has_unpublished_versions":true}`,
	}
	var installed dispatch.AutomationInstallation
	if err := json.Unmarshal([]byte(`{"automation":{"id":"auto_123"},"templates":{"created":[{"id":"tpl_new"}],"reused":[{"id":"tpl_draft"}]}}`), &installed); err != nil {
		t.Fatal(err)
	}
	inspection, err := Review(client, &installed)
	if err != nil {
		t.Fatal(err)
	}
	if inspection.Automation.ID != "auto_123" || inspection.Automation.Status != "disabled" ||
		len(inspection.Automation.Steps) != 1 || len(inspection.Templates) != 2 ||
		*inspection.Templates[0].HTML != "<p>Welcome</p>" ||
		*inspection.Templates[1].HTML != "<p>Tenant-edited draft</p>" ||
		!inspection.Templates[1].HasUnpublishedVersions {
		t.Fatalf("review content unavailable: %+v", inspection)
	}
	for _, call := range tr.calls {
		if call.method != "GET" {
			t.Fatalf("review wrote: %+v", call)
		}
	}
	if len(tr.calls) != 3 || tr.calls[2].path != "/templates/tpl_draft" {
		t.Fatal("review missed reused draft")
	}
	if _, err := Enable(client, "auto_123"); err != nil {
		t.Fatal(err)
	}
	if tr.calls[3].body["status"] != "enabled" || tr.calls[3].method != "PATCH" {
		t.Fatal("enable did not use ordinary status update")
	}
}

func TestReviewErrorsReturnNoInspectionOrWrites(t *testing.T) {
	for _, failure := range []string{"/automations/auto_123", "/templates/tpl_new", "/templates/tpl_draft"} {
		t.Run(failure, func(t *testing.T) {
			client, tr := offline()
			tr.status = 404
			tr.body = `{"name":"not_found","message":"Review resource missing"}`
			installed := &dispatch.AutomationInstallation{}
			if err := json.Unmarshal([]byte(`{"automation":{"id":"auto_123"},"templates":{"created":[{"id":"tpl_new"}],"reused":[{"id":"tpl_draft"}]}}`), installed); err != nil {
				t.Fatal(err)
			}
			// Successful earlier reads return 200; only the selected resource fails.
			client.HTTPClient.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
				tr.status = 200
				if req.URL.Path == failure {
					tr.status = 404
				}
				return tr.RoundTrip(req)
			})
			inspection, err := Review(client, installed)
			if inspection != nil || err == nil || !strings.Contains(err.Error(), "Review resource missing") {
				t.Fatalf("partial review or error lost: %+v, %v", inspection, err)
			}
			for _, call := range tr.calls {
				if call.method != "GET" {
					t.Fatalf("failed review wrote: %+v", call)
				}
			}
			if tr.calls[len(tr.calls)-1].path != failure {
				t.Fatal("review continued after failed read")
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestContactStateAndActualInvoice(t *testing.T) {
	client, tr := offline()
	if _, err := StartOnboarding(client, "ada@example.com", "topic_123"); err != nil {
		t.Fatal(err)
	}
	if _, err := Activate(client, "ada@example.com"); err != nil {
		t.Fatal(err)
	}
	if tr.calls[0].body["first_name"] != "Ada" ||
		tr.calls[0].body["properties"].(map[string]any)["activated"] != false ||
		tr.calls[1].body["properties"].(map[string]any)["activated"] != true {
		t.Fatal("typed signup/activation state lost")
	}
	invoice := Invoice{"EUR 57.40", "https://billing.example.test/cus_42", "ACME-8042", "in_42"}
	if _, err := PaymentFailed(client, "ada@example.com", invoice); err != nil {
		t.Fatal(err)
	}
	if _, err := InvoicePaid(client, "ada@example.com", invoice.ID); err != nil {
		t.Fatal(err)
	}
	payload := tr.calls[2].body["payload"].(map[string]any)
	if payload["AMOUNT"] != invoice.Amount || payload["UPDATE_PAYMENT_URL"] != invoice.UpdatePaymentURL ||
		payload["INVOICE_NUMBER"] != invoice.Number || payload["invoice_id"] != invoice.ID {
		t.Fatalf("caller data replaced: %+v", payload)
	}
	if tr.calls[3].body["event"] != "stripe.invoice.paid" ||
		tr.calls[3].body["payload"].(map[string]any)["invoice_id"] != invoice.ID ||
		tr.calls[2].path != "/events/send" || tr.calls[3].path != "/events/send" {
		t.Fatal("payment examples invented provider/correlation calls")
	}
}

func TestInstallErrorsPropagate(t *testing.T) {
	client, tr := offline()
	tr.status = 422
	tr.body = `{"name":"validation_error","message":"Choose a topic"}`
	if _, err := Install(client, "newsletter-welcome", "hello@acme.com", "", ""); err == nil ||
		!strings.Contains(err.Error(), "Choose a topic") {
		t.Fatalf("error lost: %v", err)
	}
	if len(tr.calls) != 1 {
		t.Fatal("failed installation caused follow-up writes")
	}
}
