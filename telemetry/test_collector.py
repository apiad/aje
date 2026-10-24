import json
import random
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

import collector

ROOT = Path(__file__).resolve().parent.parent
VECTORS = json.loads((ROOT / "web/test/fixtures/redact-vectors.json").read_text(encoding="utf-8"))
MENU_VECTORS = json.loads((ROOT / "web/test/fixtures/menu-vectors.json").read_text(encoding="utf-8"))
VOCAB = collector.load_vocab()


def at(hour, minute=0):
    return datetime(2026, 10, 23, hour, minute, tzinfo=timezone.utc).timestamp()


class Redact(unittest.TestCase):
    def test_vectors_match_the_app(self):
        for v in VECTORS:
            self.assertEqual(collector.redact(v["in"], VOCAB), v["out"], v["in"])

    def test_menu_vectors_match_the_app(self):
        for v in MENU_VECTORS:
            self.assertEqual(collector.redact_menu(v["in"], VOCAB), v["out"], v["in"])
            self.assertEqual(collector.clean({"event": "plan_menu", "menu": v["in"]}, VOCAB)["menu"], v["out"])


class Clean(unittest.TestCase):
    def test_drops_unknown_fields_and_redacts_again(self):
        row = collector.clean({"event": "sms", "install": "x", "t": 5, "amount": 3, "text": "ANA 12", "error": "Pérez", "latency_ms": 2349}, VOCAB)
        self.assertEqual(row, {"event": "sms", "text": "‹w› ##", "error": "‹w›", "latency_ms": 2300})

    def test_stack_keeps_only_frames(self):
        row = collector.clean({"event": "crash", "stack": "f@app.js:3:7\nANA PEREZ 9200\ng@core/ops.js:1:2"}, VOCAB)
        self.assertEqual(row["stack"], "f@app.js:3:7\ng@core/ops.js:1:2")

    def test_rejects_what_is_not_one_event(self):
        self.assertIsNone(collector.clean([{"event": "a"}], VOCAB))
        self.assertIsNone(collector.clean({"op": "46"}, VOCAB))


class StoreTest(unittest.TestCase):
    def test_rows_wait_for_the_hour_then_publish_shuffled(self):
        with TemporaryDirectory() as root:
            store = collector.Store(root, rng=random.Random(1), now=lambda: at(10))
            for i in range(20):
                store.add({"event": "e", "length": i}, at(10, 20))
            pending = Path(root, "pending", "2026-10-23T10.jsonl")
            self.assertEqual(json.loads(pending.read_text().splitlines()[0]), {"event": "e", "length": 0, "hour": "2026-10-23T10:00Z"})
            store.close_hours(at(10, 59))
            self.assertTrue(pending.exists())
            store.close_hours(at(11))
            self.assertFalse(pending.exists())
            rows = [json.loads(l) for l in Path(root, "data", "2026-10-23.jsonl").read_text().splitlines()]
            self.assertEqual(sorted(r["length"] for r in rows), list(range(20)))
            self.assertNotEqual([r["length"] for r in rows], list(range(20)))

    def test_a_restart_closes_hours_left_pending(self):
        with TemporaryDirectory() as root:
            collector.Store(root, now=lambda: at(10)).add({"event": "e"}, at(10, 5))
            collector.Store(root, now=lambda: at(12))
            self.assertEqual(list(Path(root, "pending").iterdir()), [])
            self.assertEqual(len(Path(root, "data", "2026-10-23.jsonl").read_text().splitlines()), 1)


class Server(unittest.TestCase):
    def setUp(self):
        self.dir = TemporaryDirectory()
        self.store = collector.Store(self.dir.name, now=lambda: at(10))
        handler = collector.make_handler(self.store, "tok", VOCAB, now=lambda: at(10, 30))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/t"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.dir.cleanup()

    def post(self, body, token="tok"):
        req = urllib.request.Request(self.url, data=body, method="POST", headers={"X-Aje-Token": token, "Content-Type": "application/json"})
        try:
            return urllib.request.urlopen(req).status
        except urllib.error.HTTPError as e:
            return e.code

    def test_status_codes(self):
        self.assertEqual(self.post(b'{"event": "app_start", "text": "ANA 5"}'), 204)
        self.assertEqual(self.post(b'{"event": "app_start"}', token="no"), 403)
        self.assertEqual(self.post(b"[1]"), 400)
        self.assertEqual(self.post(b"not json"), 400)
        self.assertEqual(self.post(b'{"event": "' + b"x" * 17000 + b'"}'), 413)
        rows = Path(self.dir.name, "pending", "2026-10-23T10.jsonl").read_text().splitlines()
        self.assertEqual([json.loads(r) for r in rows], [{"event": "app_start", "text": "‹w› #", "hour": "2026-10-23T10:00Z"}])


if __name__ == "__main__":
    unittest.main()
