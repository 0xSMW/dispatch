package dispatch

import (
	"encoding/json"
	"testing"
)

// Authored for milestone8; not executed during engineering.
func TestIntegrationContract(t *testing.T) {
	off := false
	body, err := json.Marshal(IntegrationInput{Provider: "webhook", Name: "App", Secret: "synthetic",
		Settings: IntegrationSettings{DeleteContact: &off}})
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	if value["settings"].(map[string]any)["delete_contact"] != false {
		t.Fatalf("false lost: %s", body)
	}
	client, calls := recorder(t, nil)
	if _, err := client.UpdateIntegration("int_1", Map{"settings": Map{"stripe_restricted_key": nil}}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RotateIntegration("int_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.IntegrationDeliveries("int_1"); err != nil {
		t.Fatal(err)
	}
	if (*calls)[0].Path != "/integrations/int_1" || (*calls)[1].Path != "/integrations/int_1/rotate" || (*calls)[2].Path != "/integrations/int_1/deliveries" {
		t.Fatalf("paths: %#v", *calls)
	}
}
