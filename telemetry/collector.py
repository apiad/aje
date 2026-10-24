"""Ajé's public telemetry collector.

Accepts one JSON event per POST, checks the shared token (public: it ships in the APK and only
keeps noise out), keeps only the fields the app's allowlist names, redacts text again with the
app's vocabulary, and stamps the hour the event arrived. It never writes an IP or a request log.

Rows wait in pending/<hour>.jsonl. Once the hour is over, its rows are shuffled and appended to
data/<day>.jsonl, the public dataset, so their order says nothing about who sent them together.
Standard library only.

    AJE_TOKEN=... python3 collector.py --port 8767 --root /var/lib/aje-collector
"""

import argparse
import json
import os
import random
import re
import threading
import time
import unicodedata
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = {"event", "app", "commit", "android", "maker"}
# Mirrors ALLOWED in web/core/telemetry.js; web/test/telemetry.test.js checks it.
ALLOWED = {"op", "bank", "via", "ok", "failure_code", "latency_ms", "age_ms", "kind", "sender", "length", "lines", "text", "error", "stack", "menu", "cards", "added", "kept", "late_min", "jobs"}
FIELDS = frozenset(BASE | ALLOWED)
MAX_BODY = 16 * 1024
MAX_FRAMES = 20
# The app's frontend runs in a WebView at this origin and posts with fetch, so it needs CORS.
ORIGIN = "https://appassets.androidplatform.net"
VOCAB_JS = Path(__file__).resolve().parent.parent / "web" / "core" / "vocab.js"
FRAME = re.compile(r"^[^\n@]{1,200}@[^\n@]{1,300}$")


def load_vocab(path=VOCAB_JS):
    """The JSON array inside web/core/vocab.js."""
    src = path.read_text(encoding="utf-8")
    return frozenset(json.loads(src[src.index("["):src.rindex("]") + 1]))


def fold(word):
    return "".join(c for c in unicodedata.normalize("NFD", word) if not unicodedata.category(c).startswith("M")).lower()


def _shape(token):
    out = []
    for c in token:
        cat = unicodedata.category(c)
        if cat.startswith("N"):
            out.append("#")
        elif cat == "Lu":
            out.append("A")
        elif cat.startswith("L"):
            out.append("a")
        else:
            out.append(c)
    return "".join(out)


def redact(text, vocab):
    """The same rules as web/core/redact.js: shapes for words with digits, ‹w› outside the vocabulary."""
    parts = re.split(r"(‹w›|(?:[^\W_]|[̀-ͯ])+)", text)
    out = []
    for i, tok in enumerate(parts):
        if i % 2 == 0 or tok == "‹w›":
            out.append(tok)
        elif any(unicodedata.category(c).startswith("N") for c in tok):
            out.append(_shape(tok))
        else:
            out.append(tok if fold(tok) in vocab else "‹w›")
    return "".join(out)


DIGIT_RUN = re.compile(r"\d(?:[ .-]?\d){6,}")
DATE = re.compile(r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}")
BALANCE = re.compile(r"(saldo[^\d#]{0,15})([\d.,]+)", re.IGNORECASE)


def redact_menu(text, vocab):
    """The same rules as redactMenu in web/core/redact.js: digits stay, but not a run of 7 or more, a date or a balance."""
    def hide(run):
        return re.sub(r"\d", "#", run)
    text = DIGIT_RUN.sub(lambda m: hide(m.group(0)), text)
    text = DATE.sub(lambda m: hide(m.group(0)), text)
    text = BALANCE.sub(lambda m: m.group(1) + hide(m.group(2)), text)
    parts = re.split(r"(‹w›|(?:[^\W_]|[̀-ͯ])+)", text)
    out = []
    for i, tok in enumerate(parts):
        if i % 2 == 0 or tok == "‹w›":
            out.append(tok)
        elif any(unicodedata.category(c).startswith("N") for c in tok):
            out.append("".join("A" if unicodedata.category(c) == "Lu" else "a" if unicodedata.category(c).startswith("L") else c for c in tok))
        else:
            out.append(tok if fold(tok) in vocab else "‹w›")
    return "".join(out)


def clean(event, vocab):
    """Keep only allowlisted fields and redact again; None for anything that is not an event."""
    if not isinstance(event, dict) or not isinstance(event.get("event"), str):
        return None
    row = {}
    for k, v in event.items():
        if k not in FIELDS or v is None or isinstance(v, (dict, list)):
            continue
        if k in ("text", "error"):
            v = redact(str(v), vocab)
        elif k == "menu":
            v = redact_menu(str(v), vocab)
        elif k == "stack":
            v = "\n".join(line for line in str(v).split("\n") if FRAME.match(line))
            v = "\n".join(v.split("\n")[:MAX_FRAMES])
        elif k in ("latency_ms", "age_ms"):
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                continue
            v = int(round(v / 100) * 100)
        elif isinstance(v, str):
            v = v[:64]
        row[k] = v
    return row


def hour_of(now):
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H")


class Store:
    """pending/<hour>.jsonl while the hour runs; data/<day>.jsonl, shuffled, once it is over."""

    def __init__(self, root, rng=None, now=time.time):
        self.pending = Path(root) / "pending"
        self.data = Path(root) / "data"
        self.pending.mkdir(parents=True, exist_ok=True)
        self.data.mkdir(parents=True, exist_ok=True)
        self.rng = rng or random.SystemRandom()
        self.lock = threading.Lock()
        self.close_hours(now())

    def add(self, row, now):
        hour = hour_of(now)
        row = {**row, "hour": hour + ":00Z"}
        with self.lock, open(self.pending / f"{hour}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def close_hours(self, now):
        current = hour_of(now)
        with self.lock:
            for path in sorted(self.pending.glob("*.jsonl")):
                if path.stem >= current:
                    continue
                lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
                self.rng.shuffle(lines)
                with open(self.data / f"{path.stem[:10]}.jsonl", "a", encoding="utf-8") as f:
                    f.writelines(lines)
                path.unlink()


def make_handler(store, token, vocab, now=time.time):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.headers.get("X-Aje-Token") != token:
                return self.reply(403)
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self.reply(413)
            try:
                row = clean(json.loads(self.rfile.read(length)), vocab)
            except ValueError:
                return self.reply(400)
            if row is None:
                return self.reply(400)
            store.add(row, now())
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
            pass  # No request log: it would hold the client's address.

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8767)
    ap.add_argument("--root", default="/var/lib/aje-collector")
    args = ap.parse_args()
    store = Store(args.root)

    def tick():
        while True:
            time.sleep(60)
            store.close_hours(time.time())

    threading.Thread(target=tick, daemon=True).start()
    handler = make_handler(store, os.environ["AJE_TOKEN"], load_vocab())
    ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
