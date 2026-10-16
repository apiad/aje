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


def balance_with_login(page):
    card = page.locator('#deck .acct[data-id="card:CUP"]')
    card.locator('[data-action="balance"]').click()
    expect(page.locator("#pin")).to_be_visible()
    page.fill("#pin", "1234")
    page.click("#pin-submit")
    expect(page.locator("#pin")).to_have_count(0)
    expect(card.locator(".bal")).to_have_text("1\u202f200,06 CUP", timeout=10_000)


def saved_pin_logs_in(page):
    # balance_with_login left "Recordarla" on, so the next lost session needs no typing.
    page.keyboard.press("Escape")
    page.click("#mock-panel summary")
    page.click("#mock-logout")
    card = page.locator('#deck .acct[data-id="card:CUP"]')
    card.locator('[data-action="balance"]').click()
    expect(page.locator("#sheet")).to_contain_text("Desbloquea la clave guardada")
    expect(page.locator("#sheet")).to_contain_text("Esperando el SMS del banco", timeout=10_000)
    expect(page.locator("#pin")).to_have_count(0)
    page.keyboard.press("Escape")
    page.goto(page.url.split("#")[0] + "#/settings")
    page.click("#pin-forget")
    expect(page.locator("#pin-row .set-row")).to_have_count(0)
    page.goto(page.url.split("#")[0] + "#/home")
    page.click("#mock-panel summary")
    page.click("#mock-logout")
    page.locator('#deck .acct[data-id="card:CUP"] [data-action="balance"]').click()
    expect(page.locator("#pin")).to_be_visible(timeout=10_000)
    page.keyboard.press("Escape")


def transfer_refuses_decimals(page):
    page.goto(page.url.split("#")[0] + "#/transfer?from=CUP")
    page.fill("#tr-to", "9200 9500 0000 0001")
    page.fill("#tr-amount", "150.50")
    page.click("#tr-submit")
    expect(page.locator("#tr-error")).to_be_visible()
    page.fill("#tr-amount", "100")
    page.click("#tr-submit")
    expect(page.locator("#sheet .status")).to_contain_text("marcador")


def mobile_balance(page):
    page.click('[data-go-acct="line:3"]')
    line = page.locator('#deck .acct[data-id="line:3"]')
    line.locator('[data-action="mobile-balance"]').click()
    expect(line.locator(".bal")).to_have_text("185,00 CUP", timeout=10_000)


def history_and_verified_transfer(page):
    transfer_refuses_decimals(page)
    page.click("#mock-panel summary")
    page.click('#mock-panel [data-sms="transfer"]')
    page.click("#mock-send")
    expect(page.locator("#sheet .status")).to_contain_text("Verificada", timeout=10_000)
    page.keyboard.press("Escape")
    page.click('nav a[href="#/history"]')
    first = page.locator("#history .row").first
    expect(first).to_have_attribute("data-state", "verified", timeout=10_000)
    width = first.locator("svg").first.bounding_box()["width"]
    assert width <= 24, f"history row icon is {width}px wide"
    first.click()
    expect(page.locator("#detail")).to_contain_text("AB0000XYZ0001")


def double_tap_transfers_once(page):
    page.goto(page.url.split("#")[0] + "#/transfer?from=CUP")
    page.fill("#tr-to", "9200950000000001")
    page.fill("#tr-amount", "77")
    page.dblclick("#tr-submit")
    expect(page.locator("#sheet .status")).to_contain_text("marcador")
    page.keyboard.press("Escape")
    page.click('nav a[href="#/history"]')
    expect(page.locator("#history .row", has_text="Transferencia · 77 CUP")).to_have_count(1)


def refused_login(page):
    page.goto(page.url.split("#")[0].split("?")[0] + "?mock=refuse-login#/home")
    page.locator('#deck .acct[data-id="card:CUP"] [data-action="balance"]').click()
    page.fill("#pin", "1234")
    page.click("#pin-submit")
    expect(page.locator("#sheet")).to_contain_text("Clave incorrecta")
    expect(page.locator("#pin-retry")).to_be_visible()


STEPS = [deck, balance_with_login, saved_pin_logs_in, transfer_refuses_decimals, mobile_balance, history_and_verified_transfer,
         double_tap_transfers_once, refused_login]


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
