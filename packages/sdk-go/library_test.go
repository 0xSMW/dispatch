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

func TestTemplateLibraryInstallAutomation(t *testing.T) {
	for _, dependencies := range []bool{false, true} {
		t.Run(map[bool]string{false: "empty", true: "created-and-reused"}[dependencies], func(t *testing.T) {
			created, reused, events, properties := []Map{}, []Map{}, []Map{}, []Map{}
			input := AutomationInstallInput{From: "Acme <you@acme.com>"}
			wantBody := Map{"from": input.From}
			if dependencies {
				created = append(created, Map{"id": "tpl_1", "slug": "welcome"})
				reused = append(reused, Map{"id": "tpl_2", "slug": "tips"})
				events = append(events, Map{"id": "evt_1", "name": "user.activated"})
				properties = append(properties, Map{"id": "prop_1", "key": "activated", "type": "boolean"})
				input.Name, input.TopicID = "Custom", "topic_1"
				wantBody["name"], wantBody["topic_id"] = input.Name, input.TopicID
			}
			aggregate := Map{
				"automation": Map{
					"object": "automation", "id": "auto_1", "name": "Welcome", "status": "disabled", "version": 1,
					"trigger": nil, "trigger_config": Map{"type": "contact_created"}, "reentry": "once",
					"steps":       []Map{{"key": "trigger", "type": "trigger", "config": Map{"type": "contact_created"}}},
					"connections": []Map{},
					"created_at":  "2026-10-05T00:00:00Z", "updated_at": "2026-10-05T00:00:00Z",
				},
				"templates": Map{"created": created, "reused": reused}, "events": events, "properties": properties,
				"next_steps": []string{"Review the automation and its emails", "Enable the automation"}, "request_id": "req_install",
			}
			path := "/template-library/automations/onboarding%2Fdrip%20%3F%23%25/install"
			client, calls := recorder(t, map[string]canned{"POST " + path: {200, aggregate}})
			got, err := client.TemplateLibraryInstallAutomation("onboarding/drip ?#%", input)
			if err != nil || got == nil || got.Automation.ID != "auto_1" || got.Automation.Status != "disabled" || got.RequestID != "req_install" {
				t.Fatalf("installation: %#v, %v", got, err)
			}
			if got.Templates.Created == nil || got.Templates.Reused == nil || got.Events == nil || got.Properties == nil {
				t.Fatalf("lost empty arrays: %#v", got)
			}
			encoded, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			expected, _ := json.Marshal(aggregate)
			var actual, want any
			if err := json.Unmarshal(encoded, &actual); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(expected, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, want) {
				t.Fatalf("aggregate changed: %s; want %s", encoded, expected)
			}
			if len(*calls) != 1 || (*calls)[0].Method != "POST" || (*calls)[0].Path != path {
				t.Fatalf("request: %#v", *calls)
			}
			body, _ := json.Marshal(wantBody)
			var sent any
			if err := json.Unmarshal((*calls)[0].Raw, &sent); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(body, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(sent, want) {
				t.Fatalf("body: %#v; want %#v", sent, want)
			}
		})
	}
}

func TestTemplateLibraryInstallAutomationErrors(t *testing.T) {
	for _, failure := range []struct {
		status        int
		name, message string
	}{{403, "forbidden", "Access denied"}, {404, "not_found", "Preset not found"}, {409, "conflict", "Name already exists"}, {422, "validation_error", "Choose a topic"}} {
		t.Run(failure.name, func(t *testing.T) {
			body := Map{"name": failure.name, "message": failure.message, "request_id": "req_error"}
			client, _ := recorder(t, map[string]canned{"POST /template-library/automations/newsletter-welcome/install": {failure.status, body}})
			got, err := client.TemplateLibraryInstallAutomation("newsletter-welcome", AutomationInstallInput{From: "you@acme.com"})
			var apiErr *Error
			if got != nil || !errors.As(err, &apiErr) || apiErr.Status != failure.status || apiErr.Name != failure.name || apiErr.Message != failure.message || apiErr.RequestID != "req_error" {
				t.Fatalf("error: %#v, %v", got, err)
			}
			raw, _ := json.Marshal(apiErr.Body)
			want, _ := json.Marshal(body)
			if string(raw) != string(want) {
				t.Fatalf("error body: %s; want %s", raw, want)
			}
		})
	}
}

func TestEventDefinitionCounts(t *testing.T) {
	page := Map{"object": "list", "has_more": true, "data": []Map{
		{"id": "evt_0", "name": "never", "schema": Map{}, "fired_count": 0, "last_fired_at": nil},
		{"id": "evt_1", "name": "fired", "schema": Map{}, "fired_count": 3, "last_fired_at": "2026-10-05T00:00:00Z"},
	}}
	client, _ := recorder(t, map[string]canned{"GET /events": {200, page}})
	listed, err := client.Events()
	if err != nil || !listed.HasMore || len(listed.Data) != 2 || listed.Data[0]["fired_count"] != float64(0) || listed.Data[0]["last_fired_at"] != nil || listed.Data[1]["fired_count"] != float64(3) || listed.Data[1]["last_fired_at"] != "2026-10-05T00:00:00Z" {
		t.Fatalf("counts: %#v, %v", listed, err)
	}
	for _, sample := range []struct {
		body  string
		count *int
		last  *string
	}{
		{`{"id":"evt_0","name":"never","schema":{},"fired_count":0,"last_fired_at":null}`, Ptr(0), nil},
		{`{"id":"evt_0","name":"never","schema":{}}`, nil, nil},
		{`{"id":"evt_1","name":"fired","schema":{},"fired_count":3,"last_fired_at":"2026-10-05T00:00:00Z"}`, Ptr(3), Ptr("2026-10-05T00:00:00Z")},
	} {
		var event EventDefinition
		if err := json.Unmarshal([]byte(sample.body), &event); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(event.LastFiredAt, sample.last) || !reflect.DeepEqual(event.FiredCount, sample.count) {
			t.Fatalf("nullable/optional counts: %#v", event)
		}
	}
}
