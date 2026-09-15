#!/usr/bin/env python3
"""Minimal jinx-service-builder-test backend skeleton for Pocket Network.

Implements only the shape Pocket requires: the three probe endpoints, JSON-object
responses, JSON 4xx for bad input, and one example resource that wraps non-JSON
output (HTML) in a string field. Replace the render() logic with your service.

No framework, standard library only. Run:  python server.py  (listens on :8080)
Every rule enforced here is explained in the skill's references/design-rules.md.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVICE = "jinx-service-builder-test"
VERSION = "1.0.0"


def render(body):
    """REPLACE with your service. Returns a JSON-serializable object.

    Non-JSON output (HTML here) is carried as a string field so the response body
    still starts with '{'. Raises ValueError on bad input.
    """
    csv = body.get("csv")
    if not isinstance(csv, str) or not csv.strip():
        raise ValueError("field 'csv' is required and must be a non-empty string")
    html = f"<!DOCTYPE html><html><body><pre>{csv}</pre></body></html>"
    return {"content_type": "text/html", "body": html}


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/v1/version":
            return self._json(200, {"service": SERVICE, "version": VERSION})
        if self.path == "/healthz":
            return self._json(200, {"status": "ok"})
        if self.path == "/":
            # The RelayMiner's backend ping hits the backend root; answer with a JSON object.
            return self._json(200, {"service": SERVICE, "status": "ok"})
        return self._json(404, {"error": {"code": "not_found", "message": "unknown path"}})

    def _read_body(self):
        """Read the request body whether it is sized or chunked.

        The RelayMiner forwards relay bodies with Transfer-Encoding: chunked and no
        Content-Length, which the standard library does not decode for you. A backend
        that only honours Content-Length sees an empty body on every relay.
        """
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            data = b""
            while True:
                line = self.rfile.readline().strip()
                size = int(line.split(b";")[0], 16) if line else 0
                if size == 0:
                    while True:  # consume any trailer lines up to the blank line
                        t = self.rfile.readline()
                        if t in (b"\r\n", b"\n", b""):
                            break
                    return data
                data += self.rfile.read(size)
                self.rfile.readline()  # CRLF after each chunk
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_HEAD(self):
        # Reachability probes may use HEAD; BaseHTTPRequestHandler would answer 501 otherwise.
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, HEAD, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/v1/REPLACE-resource":
            return self._json(404, {"error": {"code": "not_found", "message": "unknown path"}})
        raw = self._read_body()
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            # Bad input is a 4xx with a JSON body, never a 5xx and never HTML.
            return self._json(400, {"error": {"code": "invalid_json", "message": "body must be JSON"}})
        try:
            return self._json(200, render(body))
        except ValueError as e:
            return self._json(422, {"error": {"code": "invalid_input", "message": str(e)}})
        # Let genuine bugs raise a 500; do not use 500 for expected conditions.

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
