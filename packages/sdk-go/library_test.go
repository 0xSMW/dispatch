package dispatch

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestTemplateLibraryAutomations(t *testing.T) {
	preset := Map{
		"slug": "newsletter-welcome", "name": "Newsletter welcome", "stage": "acquisition",
		"description": "Welcome a subscriber.", "when": "Start on subscription.",
		"trigger_config": Map{"type": "topic_subscribed", "topic_id": "{{topic_id}}"}, "reentry": "once",
		"events":     []Map{{"name": "stripe.invoice.payment_failed", "schema": Map{"AMOUNT": "string", "UPDATE_PAYMENT_URL": "string"}}},
		"properties": []Map{{"key": "activated", "type": "boolean"}},
		"steps": []Map{
			{"key": "start", "type": "trigger", "config": Map{"type": "topic_subscribed", "topic_id": "{{topic_id}}"}},
			{"key": "active", "type": "condition", "config": Map{"type": "rule", "field": "contact.activated", "operator": "eq", "value": false}},
			{"key": "send", "type": "send_email", "config": Map{"template": "newsletter-welcome", "kind": "marketing", "variable_mapping": Map{"camelKey": "event.AMOUNT"}}},
		},
		"connections": []Map{{"from": "active", "to": "send", "type": "condition_not_met"}},
		"templates":   []string{"newsletter-welcome"},
	}
	detail := Map{"object": "automation_preset"}
	for key, value := range preset {
		detail[key] = value
	}
	path := "/template-library/automations/newsletter%2Fwelcome%20%3F%23%25"
	page := Map{"object": "list", "has_more": false, "data": []Map{preset}}
	client, calls := recorder(t, map[string]canned{
		"GET /template-library/automations": {200, page},
		"GET " + path:                       {200, detail},
	})
	listed, err := client.TemplateLibraryAutomations()
	if err != nil || listed.Object != "list" || listed.HasMore || len(listed.Data) != 1 {
		t.Fatalf("list: %#v, %v", listed, err)
	}
	got, err := client.TemplateLibraryAutomation("newsletter/welcome ?#%")
	if err != nil || got.Object != "automation_preset" {
		t.Fatalf("detail: %#v, %v", got, err)
	}
	if !reflect.DeepEqual(got.AutomationPreset, listed.Data[0]) || got.Stage != StageAcquisition || got.TriggerConfig.TopicID != "{{topic_id}}" {
		t.Fatalf("wire definitions differ: %#v / %#v", got, listed)
	}
	for _, pair := range []struct{ got, want any }{{listed, page}, {got, detail}} {
		encoded, err := json.Marshal(pair.got)
		if err != nil {
			t.Fatal(err)
		}
		want, err := json.Marshal(pair.want)
		if err != nil {
			t.Fatal(err)
		}
		var parsed, expected any
		if err := json.Unmarshal(encoded, &parsed); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(want, &expected); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(parsed, expected) {
			t.Fatalf("wire changed: %s; want %s", encoded, want)
		}
	}
	for index, wantPath := range []string{"/template-library/automations", path} {
		if (*calls)[index].Method != "GET" || (*calls)[index].Path != wantPath || len((*calls)[index].Raw) != 0 {
			t.Fatalf("unexpected request: %#v", (*calls)[index])
		}
	}
}

func TestTemplateLibraryAutomationsEmptyAndMissing(t *testing.T) {
	client, calls := recorder(t, map[string]canned{
		"GET /template-library/automations":         {200, Map{"object": "list", "has_more": false, "data": []Map{}}},
		"GET /template-library/automations/missing": {404, Map{"name": "not_found", "message": "Preset not found"}},
	})
	listed, err := client.TemplateLibraryAutomations()
	if err != nil || listed.Object != "list" || listed.HasMore || listed.Data == nil || len(listed.Data) != 0 {
		t.Fatalf("empty list: %#v, %v", listed, err)
	}
	got, err := client.TemplateLibraryAutomation("missing")
	var apiErr *Error
	if got != nil || !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Fatalf("missing detail: %#v, %v", got, err)
	}
	if body, ok := apiErr.Body.(map[string]any); !ok || body["name"] != "not_found" {
		t.Fatalf("missing error body: %#v", apiErr.Body)
	}
	if len(*calls) != 2 {
		t.Fatalf("unexpected calls: %#v", *calls)
	}
}
