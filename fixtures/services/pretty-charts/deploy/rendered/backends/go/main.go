// Minimal pretty-charts backend skeleton for Pocket Network.
// Implements only what Pocket requires: the three probe endpoints, JSON-object
// responses, JSON 4xx for bad input, and one example resource that wraps non-JSON
// output (HTML) in a string field. Replace render() with your service.
//
// Standard library only. Run: go run main.go (listens on :8080)
// The rules enforced here are explained in the skill's references/design-rules.md.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const service = "pretty-charts"
const version = "1.0.0"

func writeJSON(w http.ResponseWriter, status int, obj any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(obj)
}

func errObj(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

// render REPLACE with your service. Non-JSON output (HTML) is carried in a string
// field so the response body still starts with '{'.
func render(body map[string]any) (any, int, string) {
	csv, ok := body["csv"].(string)
	if !ok || strings.TrimSpace(csv) == "" {
		return nil, 422, "field 'csv' is required and must be a non-empty string"
	}
	html := fmt.Sprintf("<!DOCTYPE html><html><body><pre>%s</pre></body></html>", csv)
	return map[string]any{"content_type": "text/html", "body": html}, 200, ""
}

func main() {
	mux := http.NewServeMux()
	// The RelayMiner's backend ping hits the root; anything but a 2xx marks the backend
	// unreachable. "/" also catches every unknown path, so answer 404 JSON there.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			writeJSON(w, 200, map[string]string{"service": service, "status": "ok"})
			return
		}
		writeJSON(w, 404, map[string]any{"error": map[string]string{"code": "not_found", "message": "unknown path"}})
	})
	mux.HandleFunc("/v1/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"service": service, "version": version})
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/v1/REPLACE-resource", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 404, errObj("not_found", "unknown path"))
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, errObj("invalid_json", "body must be JSON"))
			return
		}
		out, status, msg := render(body)
		if status != 200 {
			writeJSON(w, status, errObj("invalid_input", msg))
			return
		}
		writeJSON(w, 200, out)
	})
	_ = http.ListenAndServe("0.0.0.0:8080", mux)
}
