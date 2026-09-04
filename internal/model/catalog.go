// Package model describes Kokoro voice packs served from local disk.
package model

import "slices"

// Voice is a selectable Kokoro speaker.
type Voice struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Locale     string  `json:"locale"`
	Gender     string  `json:"gender"`
	Grade      string  `json:"grade,omitempty"`
	Default    bool    `json:"default,omitempty"`
	SizeHintMB float64 `json:"size_hint_mb"`
	Notes      string  `json:"notes,omitempty"`
}

// Catalog is the ordered list of voices exposed by the API.
type Catalog struct {
	ModelID string  `json:"model_id"`
	Dtype   string  `json:"dtype"`
	Voices  []Voice `json:"voices"`
}

// DefaultCatalog returns built-in Kokoro voices (no network).
func DefaultCatalog() Catalog {
	return Catalog{
		ModelID: "Kokoro-82M-v1.0-ONNX",
		Dtype:   "fp32|q8",
		Voices: []Voice{
			{ID: "af_heart", Label: "Heart", Locale: "en-us", Gender: "female", Grade: "A", Default: true, SizeHintMB: 0.3, Notes: "Default American English."},
			{ID: "af_bella", Label: "Bella", Locale: "en-us", Gender: "female", Grade: "A-", SizeHintMB: 0.3, Notes: "Warm and clear."},
			{ID: "af_sarah", Label: "Sarah", Locale: "en-us", Gender: "female", Grade: "C+", SizeHintMB: 0.3},
			{ID: "af_nicole", Label: "Nicole", Locale: "en-us", Gender: "female", Grade: "B-", SizeHintMB: 0.3},
			{ID: "af_nova", Label: "Nova", Locale: "en-us", Gender: "female", Grade: "C", SizeHintMB: 0.3},
			{ID: "af_sky", Label: "Sky", Locale: "en-us", Gender: "female", Grade: "C-", SizeHintMB: 0.3},
			{ID: "am_adam", Label: "Adam", Locale: "en-us", Gender: "male", Grade: "F+", SizeHintMB: 0.3},
			{ID: "am_michael", Label: "Michael", Locale: "en-us", Gender: "male", Grade: "C+", SizeHintMB: 0.3},
			{ID: "am_fenrir", Label: "Fenrir", Locale: "en-us", Gender: "male", Grade: "C+", SizeHintMB: 0.3},
			{ID: "am_puck", Label: "Puck", Locale: "en-us", Gender: "male", Grade: "C+", SizeHintMB: 0.3},
			{ID: "bf_emma", Label: "Emma", Locale: "en-gb", Gender: "female", Grade: "B-", SizeHintMB: 0.3, Notes: "British English."},
			{ID: "bf_isabella", Label: "Isabella", Locale: "en-gb", Gender: "female", Grade: "C", SizeHintMB: 0.3},
			{ID: "bm_george", Label: "George", Locale: "en-gb", Gender: "male", Grade: "C", SizeHintMB: 0.3},
			{ID: "bm_lewis", Label: "Lewis", Locale: "en-gb", Gender: "male", Grade: "D+", SizeHintMB: 0.3},
		},
	}
}

// ByID returns a voice or false when unknown.
func (c Catalog) ByID(id string) (Voice, bool) {
	for i := range c.Voices {
		if c.Voices[i].ID == id {
			return c.Voices[i], true
		}
	}
	return Voice{}, false
}

// DefaultVoice returns the catalog default or the first entry.
func (c Catalog) DefaultVoice() (Voice, bool) {
	for i := range c.Voices {
		if c.Voices[i].Default {
			return c.Voices[i], true
		}
	}
	if len(c.Voices) == 0 {
		return Voice{}, false
	}
	return c.Voices[0], true
}

// IDs returns voice identifiers in catalog order.
func (c Catalog) IDs() []string {
	ids := make([]string, 0, len(c.Voices))
	for i := range c.Voices {
		ids = append(ids, c.Voices[i].ID)
	}
	return slices.Clone(ids)
}
