package model_test

import (
	"testing"

	"github.com/Quad4-Software/speakasm/internal/model"
)

func TestDefaultCatalog(t *testing.T) {
	t.Parallel()
	c := model.DefaultCatalog()
	if c.ModelID == "" {
		t.Fatal("missing model id")
	}
	if len(c.Voices) == 0 {
		t.Fatal("empty voices")
	}
	v, ok := c.DefaultVoice()
	if !ok || v.ID == "" {
		t.Fatal("missing default voice")
	}
	got, ok := c.ByID(v.ID)
	if !ok || got.ID != v.ID {
		t.Fatalf("ByID failed for %q", v.ID)
	}
	if _, ok := c.ByID("does-not-exist"); ok {
		t.Fatal("expected miss")
	}
	ids := c.IDs()
	if len(ids) != len(c.Voices) {
		t.Fatalf("ids=%d voices=%d", len(ids), len(c.Voices))
	}
}
