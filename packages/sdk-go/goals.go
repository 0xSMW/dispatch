package dispatch

import "net/url"

type GoalInput struct {
	Name        string `json:"name"`
	Target      Map    `json:"target"`
	Eligibility *Rule  `json:"eligibility,omitempty"`
	WindowDays  int    `json:"window_days,omitempty"`
}
type Goal struct {
	Object      string `json:"object"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Target      Map    `json:"target"`
	Eligibility *Rule  `json:"eligibility"`
	WindowDays  int    `json:"window_days"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}
type GoalDay struct {
	Date            string  `json:"date"`
	ContactsReached int     `json:"contacts_reached"`
	Converted       int     `json:"converted"`
	Rate            float64 `json:"rate"`
}
type GoalMetrics struct {
	Object          string    `json:"object"`
	GoalID          string    `json:"goal_id"`
	StartDate       string    `json:"start_date"`
	EndDate         string    `json:"end_date"`
	ContactsReached int       `json:"contacts_reached"`
	Converted       int       `json:"converted"`
	Rate            float64   `json:"rate"`
	Data            []GoalDay `json:"data"`
	History         struct {
		AvailableFrom *string `json:"available_from"`
		Limitation    string  `json:"limitation"`
	} `json:"history"`
}
type LibraryUpdateItem struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Slug   string `json:"slug"`
	Reason string `json:"reason,omitempty"`
}
type LibraryUpdates struct {
	Updated []LibraryUpdateItem `json:"updated"`
	Skipped []LibraryUpdateItem `json:"skipped"`
}

func (c *Client) Goals(query ...url.Values) (*ListResponse[Goal], error) {
	return get[ListResponse[Goal]](c, with("/goals", query))
}
func (c *Client) Goal(id string) (*Goal, error)             { return get[Goal](c, at("goals", id)) }
func (c *Client) CreateGoal(input GoalInput) (*Goal, error) { return post[Goal](c, "/goals", input) }

// Map can clear eligibility with nil while preserving omitted fields.
func (c *Client) UpdateGoal(id string, input any) (*Goal, error) {
	return patch[Goal](c, at("goals", id), input)
}
func (c *Client) DeleteGoal(id string) (*Deleted, error) { return remove(c, at("goals", id)) }
func (c *Client) GoalMetrics(id string, query ...url.Values) (*GoalMetrics, error) {
	return get[GoalMetrics](c, with(at("goals", id)+"/metrics", query))
}
func (c *Client) UpdateLibraryTemplates() (*LibraryUpdates, error) {
	return post[LibraryUpdates](c, "/brand/update-library", nil)
}
