package dispatch

import "net/url"

// FormInput configures a public signup form. Nil DoubleOptIn uses the server's true default.
type FormInput struct {
	Name           string   `json:"name"`
	TopicIDs       []string `json:"topic_ids"`
	Properties     []string `json:"properties,omitempty"`
	DoubleOptIn    *bool    `json:"double_opt_in,omitempty"`
	FromEmail      string   `json:"from_email"`
	AllowedOrigins []string `json:"allowed_origins"`
	RedirectURL    *string  `json:"redirect_url,omitempty"`
}

type Form struct {
	Object         string   `json:"object"`
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Key            string   `json:"key"`
	TopicIDs       []string `json:"topic_ids"`
	Properties     []string `json:"properties"`
	DoubleOptIn    bool     `json:"double_opt_in"`
	FromEmail      string   `json:"from_email"`
	AllowedOrigins []string `json:"allowed_origins"`
	RedirectURL    *string  `json:"redirect_url"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

func (c *Client) Forms(query ...url.Values) (*ListResponse[Form], error) {
	return get[ListResponse[Form]](c, with("/forms", query))
}
func (c *Client) Form(id string) (*Form, error) { return get[Form](c, at("forms", id)) }
func (c *Client) CreateForm(input FormInput) (*Form, error) { return post[Form](c, "/forms", input) }
// Use Map to clear redirect_url with nil or to preserve omitted fields.
func (c *Client) UpdateForm(id string, input any) (*Form, error) {
	return patch[Form](c, at("forms", id), input)
}
func (c *Client) DeleteForm(id string) (*Deleted, error) { return remove(c, at("forms", id)) }
