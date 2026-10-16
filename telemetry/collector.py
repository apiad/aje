"""Ajé's development telemetry collector.

Accepts POSTs of JSON event arrays from the dev build, checks the shared token,
keeps only the fields the app's allowlist names, and appends one JSON line per
event to a file. Standard library only.

    AJE_TOKEN=... AJE_EVENTS=/path/events.jsonl python3 collector.py --port 8765
"""

import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = {"event", "t", "app", "sdk", "device", "install"}
# Mirrors ALLOWED in web/core/telemetry.js; web/test/telemetry.test.js checks it.
ALLOWED = {"op", "ok", "failure_code", "latency_ms", "kind", "sender", "length", "lines", "error", "stack", "bank", "via", "default_sub", "text", "age_ms"}
MAX_BODY = 256 * 1024
# The app's frontend runs in a WebView at this origin and posts with fetch, so it needs CORS.
ORIGIN = "https://appassets.androidplatform.net"


def clean(event):
    """Keep only allowlisted fields; drop anything else the client sent."""
    if not isinstance(event, dict) or "event" not in event:
        return None
    return {k: v for k, v in event.items() if k in BASE or k in ALLOWED}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.headers.get("X-Aje-Token") != os.environ["AJE_TOKEN"]:
            return self.reply(403)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.reply(413)
        try:
            events = json.loads(self.rfile.read(length))
        except ValueError:
            return self.reply(400)
        if not isinstance(events, list):
            return self.reply(400)
        received = int(time.time() * 1000)
        with open(os.environ["AJE_EVENTS"], "a", encoding="utf-8") as f:
            for e in filter(None, map(clean, events)):
                e["received"] = received
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
        self.reply(204)

    def do_GET(self):
        self.reply(404)

    def do_OPTIONS(self):
        self.reply(204)

    def reply(self, code):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Aje-Token")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
