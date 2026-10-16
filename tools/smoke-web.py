"""Drive the frontend against the mock in a phone-sized browser.

    uv run --with playwright python tools/smoke-web.py [outdir]
"""

import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

WEB = Path(__file__).resolve().parent.parent / "web"


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves web/ as the APK does, including the config.json the build writes."""

    def do_GET(self):
        if self.path.split("?")[0] == "/config.json":
            body = b'{"app":"smoke","telemetryUrl":"","telemetryToken":""}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(Handler, directory=WEB)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}"


def deck(page):
    for acct in ["card:CUP", "card:CUC", "card:USD", "line:3", "line:4"]:
        expect(page.locator(f'#deck .acct[data-id="{acct}"]')).to_have_count(1)
    page.goto(page.url.split("#")[0] + "#/settings")
    expect(page.locator("#settings")).to_be_visible()


STEPS = [deck]  # tasks 10 and 11 append theirs


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/aje-smoke")
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as p:
        page = p.chromium.launch().new_page(viewport={"width": 390, "height": 844})
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        base = serve()
        for step in STEPS:
            page.goto(base + "/index.html#/home")
            step(page)
            page.screenshot(path=out / f"{step.__name__}.png", full_page=True)
        width = page.evaluate("document.documentElement.scrollWidth")
    assert width <= 390, f"page is {width}px wide on a 390px phone"
    assert not errors, errors
    print(f"{len(STEPS)} steps passed, 0 errors, {width}px wide")


if __name__ == "__main__":
    main()
