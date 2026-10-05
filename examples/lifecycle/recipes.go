// Package lifecycle contains app-owned SDK calls, not a live-running program.
package lifecycle

import dispatch "github.com/dispatch/dispatch-go"

func Install(client *dispatch.Client, slug, sender, topicID, name string) (*dispatch.AutomationInstallation, error) {
	return client.TemplateLibraryInstallAutomation(slug, dispatch.AutomationInstallInput{
		From: sender, TopicID: topicID, Name: name,
	})
}

// Review reads the graph and every template; it never publishes reused drafts.
func Review(client *dispatch.Client, installed *dispatch.AutomationInstallation) error {
	if _, err := client.Automation(installed.Automation.ID); err != nil {
		return err
	}
	for _, item := range installed.Templates.Created {
		if _, err := client.Template(item.ID); err != nil {
			return err
		}
	}
	for _, item := range installed.Templates.Reused {
		if _, err := client.Template(item.ID); err != nil {
			return err
		}
	}
	return nil
}

// Enable is a separate, approved operation after reviewing next_steps/content.
func Enable(client *dispatch.Client, id string) (*dispatch.Automation, error) {
	return client.UpdateAutomation(id, dispatch.AutomationUpdate{Status: dispatch.AutomationEnabled})
}

func StartOnboarding(client *dispatch.Client, email, topicID string) (*dispatch.Contact, error) {
	// Actual new signup, with consent; never reset an existing user's preferences.
	return client.CreateContact(dispatch.ContactInput{
		Email: email, FirstName: "Ada", Properties: map[string]any{"activated": false},
		Topics: []dispatch.TopicChoice{{ID: topicID, Subscription: "opt_in"}},
	})
}

func Activate(client *dispatch.Client, email string) (*dispatch.Contact, error) {
	return client.UpdateContact(email, dispatch.ContactUpdate{Properties: map[string]any{"activated": true}})
}

type Invoice struct {
	Amount, UpdatePaymentURL, Number, ID string
}

func PaymentFailed(client *dispatch.Client, email string, invoice Invoice) (dispatch.Map, error) {
	return client.SendEvent(dispatch.EventInput{
		Event: "stripe.invoice.payment_failed", Email: email,
		Payload: map[string]any{
			"AMOUNT": invoice.Amount, "UPDATE_PAYMENT_URL": invoice.UpdatePaymentURL,
			"INVOICE_NUMBER": invoice.Number, "invoice_id": invoice.ID,
		},
	})
}

func InvoicePaid(client *dispatch.Client, email, invoiceID string) (dispatch.Map, error) {
	// Included invoice_id does not change today's contact/event-name wait matching.
	return client.SendEvent(dispatch.EventInput{
		Event: "stripe.invoice.paid", Email: email, Payload: map[string]any{"invoice_id": invoiceID},
	})
}
