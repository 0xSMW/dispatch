package dispatch

import "net/url"

type IntegrationSettings struct {
	MapPlan             *bool   `json:"map_plan,omitempty"`
	DeleteContact       *bool   `json:"delete_contact,omitempty"`
	SecretHeader        string  `json:"secret_header,omitempty"`
	StripeRestrictedKey *string `json:"stripe_restricted_key,omitempty"`
}

type IntegrationInput struct {
	Provider string              `json:"provider"`
	Name     string              `json:"name"`
	Secret   string              `json:"secret"`
	Slug     string              `json:"slug,omitempty"`
	Settings IntegrationSettings `json:"settings,omitempty"`
}

// Integration is credential-free. Create/rotate are the only token/URL responses.
type Integration struct {
	Object           string  `json:"object"`
	ID               string  `json:"id"`
	Provider         string  `json:"provider"`
	Name             string  `json:"name"`
	Slug             string  `json:"slug"`
	Settings         Map     `json:"settings"`
	HasRestrictedKey bool    `json:"has_restricted_key"`
	LastReceivedAt   *string `json:"last_received_at"`
	CreatedAt        string  `json:"created_at"`
	UpdatedAt        string  `json:"updated_at"`
}
type CreatedIntegration struct {
	Integration
	Token string `json:"token"`
	URL   string `json:"url"`
}
type InboundDelivery struct {
	ID              string  `json:"id"`
	IntegrationID   string  `json:"integration_id"`
	ProviderEventID string  `json:"provider_event_id"`
	Status          string  `json:"status"`
	EventName       *string `json:"event_name"`
	ContactID       *string `json:"contact_id"`
	Error           *string `json:"error"`
	CreatedAt       string  `json:"created_at"`
}

func (c *Client) Integrations(query ...url.Values) (*ListResponse[Integration], error) {
	return get[ListResponse[Integration]](c, with("/integrations", query))
}
func (c *Client) Integration(id string) (*Integration, error) {
	return get[Integration](c, at("integrations", id))
}
func (c *Client) CreateIntegration(input IntegrationInput) (*CreatedIntegration, error) {
	return post[CreatedIntegration](c, "/integrations", input)
}

// Map preserves omitted settings; stripe_restricted_key:nil explicitly removes the key.
func (c *Client) UpdateIntegration(id string, input any) (*Integration, error) {
	return patch[Integration](c, at("integrations", id), input)
}
func (c *Client) DeleteIntegration(id string) (*Deleted, error) {
	return remove(c, at("integrations", id))
}
func (c *Client) RotateIntegration(id string) (*CreatedIntegration, error) {
	return post[CreatedIntegration](c, at("integrations", id)+"/rotate", Map{})
}
func (c *Client) IntegrationDeliveries(id string, query ...url.Values) (*ListResponse[InboundDelivery], error) {
	return get[ListResponse[InboundDelivery]](c, with(at("integrations", id)+"/deliveries", query))
}
