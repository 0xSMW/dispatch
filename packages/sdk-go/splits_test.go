package dispatch

import (
	"net/url"
	"reflect"
	"testing"
)

// Authored for the milestone8 Go SDK gate, not executed during engineering.
func TestSplitWireContracts(t *testing.T) {
	client, calls := recorder(t, nil)
	if _, err := client.AutomationSplitMetrics("a/1", "s/1", url.Values{"start_date": {"2026-09-01"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.PickAutomationWinner("a/1", "s/1", "b", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := client.UpdateAutomation("a/1", AutomationUpdate{Status: AutomationEnabled, ExpectedVersion: Ptr(1)}); err != nil {
		t.Fatal(err)
	}
	if (*calls)[0].Path != "/automations/a%2F1/steps/s%2F1/metrics?start_date=2026-09-01" {
		t.Fatalf("metrics: %+v", (*calls)[0])
	}
	if !reflect.DeepEqual((*calls)[1].Body, Map{"variant": "b", "version": float64(0)}) {
		t.Fatalf("winner: %+v", (*calls)[1])
	}
}
