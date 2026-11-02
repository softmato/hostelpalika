package softmato

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRetriesKeepOneIdempotencyKey(t *testing.T) {
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		if r.Header.Get("Authorization") != "Bearer s" {
			t.Error("no bearer")
		}
		if len(keys) == 1 {
			w.WriteHeader(500)
			w.Write([]byte(`{"error":{"code":"INTERNAL","message":"x"}}`))
			return
		}
		w.Write([]byte(`{"invoice_id":"i1","invoice_no":"SMT-1"}`))
	}))
	defer srv.Close()
	c := New(srv.URL+"/", "s", "w")
	inv, err := c.CreateInvoice(context.Background(), CreateInvoice{})
	if err != nil || inv.InvoiceID != "i1" || len(keys) != 2 || keys[0] == "" || keys[0] != keys[1] {
		t.Fatal(inv, err, keys)
	}
}

func TestErrorsClassify(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"code":"RESOURCE_NOT_FOUND","message":"no"}}`))
	}))
	c := New(srv.URL, "s", "w")
	if d, err := c.GetInvoice(context.Background(), "a/b"); d != nil || err != nil {
		t.Fatal(d, err)
	}
	if f, err := c.Download(context.Background(), "receipts", "x"); f != nil || err != nil {
		t.Fatal(f, err)
	}
	srv.Close()
	if _, err := c.GetInvoice(context.Background(), "x"); !IsDown(err) {
		t.Fatal("closed server must read as down", err)
	}
	if New("", "s", "w") != nil {
		t.Fatal("not configured must be nil")
	}
}
