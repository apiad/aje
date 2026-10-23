"""Drive the frontend against the mock in a phone-sized browser.

    uv run --with playwright python tools/smoke-web.py [outdir]
"""

import functools
import json
import subprocess
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


METRO = {"alias": "Metro CUP", "pan": "9227959900000001", "bank": "METROPOLITANO", "currency": "CUP"}


def card_sel(page):
    """The seeded card's face on the deck."""
    page.wait_for_function("globalThis.ajeDev")
    card_id = page.evaluate("ajeDev.store.state.cards[0].id")
    return f'#deck .acct[data-id="card:{card_id}"]'


def seed_card(page):
    """Starts with no cards, adds one through the store, and leaves it linked."""
    expect(page.locator("#add-card")).to_be_visible()
    page.evaluate("""async (c) => {
        const s = ajeDev.store;
        if (!s.state.cards.length) await s.updateCard((await s.addCard(c)).id, { state: "linked", step: 5 });
    }""", METRO)
    page.reload()


def deck(page):
    for acct in [card_sel(page), '#deck .acct[data-id="line:3"]', '#deck .acct[data-id="line:4"]']:
        expect(page.locator(acct)).to_have_count(1)
    expect(page.locator("#add-card")).to_be_visible()
    page.goto(page.url.split("#")[0] + "#/settings")
    expect(page.locator("#settings")).to_be_visible()


def balance_with_login(page):
    card = page.locator(card_sel(page))
    card.locator('[data-action="balance"]').click()
    expect(page.locator("#pin")).to_be_visible()
    page.fill("#pin", "1234")
    page.click("#pin-submit")
    expect(page.locator("#pin")).to_have_count(0)
    expect(page.locator("#sheet .spin")).to_be_visible()
    expect(card.locator(".bal")).to_have_text("1\u202f200,06 CUP", timeout=10_000)
    # The verified balance is on the card, so the sheet closes by itself.
    expect(page.locator("#sheet")).to_have_count(0, timeout=5_000)


def saved_pin_logs_in(page):
    # balance_with_login left "Recordarla" on, so the next lost session needs no typing.
    page.keyboard.press("Escape")
    page.click("#mock-panel summary")
    page.click("#mock-logout")
    card = page.locator(card_sel(page))
    card.locator('[data-action="balance"]').click()
    expect(page.locator("#sheet")).to_contain_text("Desbloquea la clave guardada")
    expect(page.locator("#sheet")).to_contain_text("Esperando el SMS del banco", timeout=10_000)
    expect(page.locator("#pin")).to_have_count(0)
    page.keyboard.press("Escape")
    page.goto(page.url.split("#")[0] + "#/settings")
    page.click("#settings .pin-forget")
    expect(page.locator("#pin-row .set-row")).to_have_count(0)
    page.goto(page.url.split("#")[0] + "#/home")
    page.click("#mock-panel summary")
    page.click("#mock-logout")
    page.locator(card_sel(page) + ' [data-action="balance"]').click()
    expect(page.locator("#pin")).to_be_visible(timeout=10_000)
    page.keyboard.press("Escape")


def transfer_refuses_decimals(page):
    page.goto(page.url.split("#")[0] + "#/transfer")
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
    expect(page.locator("#sheet .spin")).to_be_visible()
    expect(line.locator(".bal")).to_have_text("185,00 CUP", timeout=10_000)
    for stat, text in [("data", "3,2 GB"), ("voice", "1 h 20 min"), ("sms", "100"), ("cal", "2/2")]:
        expect(line.locator(f'[data-stat="{stat}"]')).to_have_text(text)
    expect(page.locator("#sheet")).to_have_count(0, timeout=5_000)


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
    page.goto(page.url.split("#")[0] + "#/transfer")
    page.fill("#tr-to", "9200950000000001")
    page.fill("#tr-amount", "77")
    page.dblclick("#tr-submit")
    expect(page.locator("#sheet .status")).to_contain_text("marcador")
    page.keyboard.press("Escape")
    page.click('nav a[href="#/history"]')
    expect(page.locator("#history .row", has_text="Transferencia · 77 CUP")).to_have_count(1)


def refused_login(page):
    page.goto(page.url.split("#")[0].split("?")[0] + "?mock=refuse-login#/home")
    page.locator(card_sel(page) + ' [data-action="balance"]').click()
    page.fill("#pin", "1234")
    page.click("#pin-submit")
    expect(page.locator("#sheet")).to_contain_text("Clave incorrecta")
    expect(page.locator("#pin-retry")).to_be_visible()


def type_number(page):
    """Skips the camera; without one, the scanner already went to the review screen."""
    try:
        expect(page.locator("#add-pan")).to_be_visible(timeout=3_000)
    except AssertionError:
        page.click("#add-type")


def add_card_linked_bank(page):
    """A second Metropolitano card: typed, linked with a coordinate after the bank's login."""
    page.click("#add-card")
    type_number(page)
    page.fill("#add-pan", "9227 9599 0000 0002")
    expect(page.locator("#add-facts")).to_contain_text("Banco Metropolitano")
    page.fill("#add-alias", "Metro dos")
    page.click("#add-next")
    # An earlier login proved the registration, so Ajé may skip the question.
    expect(page.locator("#add-registered, #add-pin, #add-coord, #addcard .pending").first).to_be_visible()
    if page.locator("#add-registered").count():
        page.click("#add-registered")
    # The bank may ask for a login before or after op 60; the mock drops its session between steps.
    for _ in range(2):
        expect(page.locator("#add-pin, #add-coord").first).to_be_visible(timeout=10_000)
        if page.locator("#add-pin").count():
            page.fill("#add-pin", "1234")
            page.click("#add-pin-submit")
            expect(page.locator("#add-coord")).to_be_visible(timeout=10_000)
        page.fill("#add-coord", "12")
        page.click("#add-link")
        expect(page.locator("#add-done, #add-pin").first).to_be_visible(timeout=10_000)
        if page.locator("#add-done").count():
            break
    expect(page.locator("#add-done")).to_contain_text("Metro dos", timeout=10_000)
    assert page.evaluate("ajeDev.store.state.cards.find((c) => c.alias === 'Metro dos').state") == "linked"


def add_clasica_via_mitransfer(page):
    """A Clásica: Ajé asks about MiTransfer, registers, logs in to MiTransfer, then associates with 111."""
    page.goto(page.url.split("#")[0] + "#/home")
    page.click("#add-card")
    type_number(page)
    page.fill("#add-pan", "9760 0300 0000 0001")
    page.fill("#add-alias", "Mi Clásica")
    page.click("#add-next")
    page.click("#mt-register")
    page.fill("#mt-ci", "00000000000")
    page.fill("#mt-pin", "4321")
    page.fill("#mt-pin2", "4321")
    page.click("#mt-register-send")
    expect(page.locator("#add-pin")).to_be_visible(timeout=10_000)
    expect(page.locator("#add-reply")).to_contain_text("registro")
    page.fill("#add-pin", "4321")
    page.click("#add-pin-submit")
    expect(page.locator("#add-auth")).to_be_visible(timeout=10_000)
    page.fill("#add-auth", "044915")
    page.fill("#add-terminal", "00014049")
    page.click("#add-associate")
    expect(page.locator("#add-done")).to_contain_text("Mi Clásica", timeout=10_000)
    state = page.evaluate("ajeDev.store.state")
    assert next(c for c in state["cards"] if c["alias"] == "Mi Clásica")["state"] == "associated"
    assert state["banks"]["MITRANSFER"]["registered"] is True
    assert "00000000000" not in json.dumps(state) and "4321" not in json.dumps(state)


def pending_card_resumes_guide(page):
    """A first BANDEC card, saved for later, reopens the guide where it stopped."""
    page.click("#add-card")
    type_number(page)
    page.fill("#add-pan", "9227 0699 0000 0003")
    page.click("#add-next")
    page.click("#add-not-registered")
    expect(page.locator("#add-guide li.now")).to_contain_text("Multibanca")
    page.click("#add-later")
    page.reload()
    page.wait_for_function("globalThis.ajeDev")
    card_id = page.evaluate("ajeDev.store.state.cards.find((c) => c.bank === 'BANDEC').id")
    page.click(f'[data-go-acct="card:{card_id}"]')
    page.locator(f'#deck .acct[data-id="card:{card_id}"] [data-action="resume"]').click()
    expect(page.locator("#add-guide li.now")).to_contain_text("Multibanca")



def scan_reads_card(p, base, out, errors):
    """The scanner reads a synthetic card from Chromium's fake camera into the review screen."""
    fixtures = out / "fixtures"
    subprocess.run([sys.executable, str(Path(__file__).parent / "gen-card-fixtures.py"), str(fixtures)], check=True, capture_output=True)
    browser = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                      f"--use-file-for-fake-video-capture={fixtures / 'camera.mjpeg'}"])
    page = browser.new_context(viewport={"width": 390, "height": 844}, permissions=["camera"]).new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base + "/index.html#/home")
    page.click("#add-card")
    expect(page.locator("#add-pan")).to_have_value("9227959900000001", timeout=60_000)
    expect(page.locator("#add-facts")).to_contain_text("Banco Metropolitano")
    page.screenshot(path=out / "scan_reads_card.png", full_page=True)
    browser.close()


FAKE_RELEASES = [{
    "tag_name": "v9.9.0-beta.1", "prerelease": True, "draft": False, "html_url": "https://github.com/apiad/aje/releases/tag/v9.9.0-beta.1",
    "assets": [
        {"name": "aje-9.9.0-beta.1-999.apk", "size": 7_400_000, "digest": "sha256:" + "ab" * 32,
         "browser_download_url": "https://github.com/apiad/aje/releases/download/v9.9.0-beta.1/aje-9.9.0-beta.1-999.apk"},
        {"name": "aje-9.9.0-beta.1-999.apk.sha256", "size": 90,
         "browser_download_url": "https://github.com/apiad/aje/releases/download/v9.9.0-beta.1/aje-9.9.0-beta.1-999.apk.sha256"},
    ],
}]


def fake_github(page, releases):
    """Answers the updater's GitHub requests, so the smoke test never reaches the network."""
    page.route("https://api.github.com/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(releases)))
    # Release downloads send no CORS headers, so a page can never read them: fail them, as a phone does.
    page.route("https://github.com/**", lambda r: r.abort())


def update_beta(page):
    """Stable sees no update; switching to beta finds the pre-release and installs it."""
    fake_github(page, FAKE_RELEASES)
    page.goto(page.url.split("#")[0] + "#/settings")
    page.click("#update-check")
    expect(page.locator("#update-result")).to_contain_text("última versión")
    page.get_by_role("button", name="Beta").click()
    page.click("#update-check")
    expect(page.locator("#update-result")).to_contain_text("9.9.0-beta.1")
    page.click("#update-settings")
    expect(page.locator("#update-settings-status")).to_contain_text("instalador")
    page.goto(page.url.split("#")[0] + "#/home")
    expect(page.locator("#update-banner")).to_contain_text("9.9.0-beta.1")

def consent_once(p, base, out, errors):
    """With an endpoint, a fresh install asks once: "Ahora no" keeps telemetry off for good; "Activar" turns it on."""
    for answer, on in (("#consent-no", False), ("#consent-yes", True)):
        ctx = p.chromium.launch().new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("**/config.json", lambda r: r.fulfill(status=200, content_type="application/json",
                   body='{"app":"smoke","telemetryUrl":"https://collector.invalid/t","telemetryToken":"t"}'))
        page.route("https://collector.invalid/**", lambda r: r.abort())
        page.route("https://api.github.com/**", lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
        page.goto(base + "/index.html#/home")
        expect(page.locator("#sheet")).to_contain_text("¿Nos ayudas a encontrar fallos?")
        page.screenshot(path=out / "consent.png")
        page.click(answer)
        expect(page.locator("#sheet")).to_have_count(0)
        page.reload()
        page.wait_for_selector("#view")
        expect(page.locator("#sheet")).to_have_count(0)
        page.goto(base + "/index.html#/settings")
        expect(page.get_by_role("button", name="Enviar telemetría")).to_have_attribute("aria-pressed", "true" if on else "false")
        ctx.close()


def open_line_transfer(page, sub=3):
    page.goto(page.url.split("#")[0] + f"#/line-transfer?sub={sub}")
    expect(page.locator("#line-transfer")).to_be_visible()


def line_sends(page):
    return page.evaluate("ajeDev.bridge.calls.filter((c) => c.method === 'dial' && c.args.code.startsWith('*234*1*')).length")


def ussd_codes(page):
    return page.evaluate("ajeDev.bridge.calls.filter((c) => c.method === 'sendUssd').map((c) => c.args.code)")


def fake_plan_catalog(page):
    """aje.apiad.net serves the bundled catalog with one price changed, so the step sees the hosted copy win."""
    catalog = json.loads((WEB.parent / "site/plans.json").read_text())
    next(p for g in catalog["groups"] for p in g["plans"] if p["path"] == "2*1")["price"] = 16
    page.route("https://aje.apiad.net/plans.json", lambda r: r.fulfill(
        status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(catalog)))


def buy_plan_from_catalog(page):
    page.evaluate("ajeDev.store.setMobileBalance(3, '185.00 CUP')")
    page.goto(page.url.split("#")[0] + "#/plans?sub=3")
    expect(page.locator("#plans")).to_be_visible()
    expect(page.locator("#plan-back")).to_be_hidden()
    expect(page.locator("#plan-captured")).to_contain_text("23-10-2026")
    # The hosted catalog replaces the bundled one: its changed price shows.
    expect(page.locator("#plan-2-1")).to_contain_text("16.00 CUP")
    expect(page.locator("#plan-1-4-1")).to_contain_text("240.00 CUP")
    page.click("#plan-1-4-1")
    expect(page.locator("#plan-price")).to_have_text("240.00 CUP")
    expect(page.locator("#plan-short")).to_be_visible()
    expect(page.locator("#plans .reply")).to_contain_text("Marque 1 para confirmar")
    page.click("#plan-back")
    page.click("#plan-1-2")
    expect(page.locator("#plan-short")).to_have_count(0)
    page.locator("#plan-buy").dblclick()
    expect(page.locator('#plan-result[data-outcome="dialer"]')).to_contain_text("Esperando el SMS de Cubacel")
    dials = page.evaluate("ajeDev.bridge.calls.filter((c) => c.method === 'dial').map((c) => c.args.code)")
    assert dials.count("*133*1*2#") == 1, dials
    assert not [c for c in ussd_codes(page) if c.startswith("*133")], ussd_codes(page)
    # Cubacel's SMS confirms the purchase and brings the balance; nothing more is sent.
    before = len(ussd_codes(page))
    expect(page.locator('#plan-result[data-outcome="bought"]')).to_contain_text("Plan comprado: Plan toDus", timeout=10_000)
    expect(page.locator("#plan-result")).to_contain_text("Saldo de la línea: 160.00 CUP")
    assert ussd_codes(page)[before:] == [], ussd_codes(page)[before:]


def charge_by_qr(page):
    page.goto(page.url.split("#")[0] + "#/line-charge?sub=3")
    expect(page.locator("#line-charge")).to_be_visible()
    page.fill("#lc-number", "+53 5555 5555")
    page.fill("#lc-amount", "150")
    page.fill("#lc-name", "Ana")
    charges = page.evaluate("ajeDev.store.state.attempts.filter((a) => a.op === '234-charge').length")
    page.locator("#lc-show").dblclick()
    expect(page.locator("#lc-qr svg")).to_be_visible()
    # Review finding 4: a double tap creates one charge.
    page.wait_for_timeout(300)
    assert page.evaluate("ajeDev.store.state.attempts.filter((a) => a.op === '234-charge').length") == charges + 1
    expect(page.locator("#lc-status")).to_contain_text("Esperando el pago")
    expect(page.locator("#line-charge")).to_contain_text("150 CUP")
    page.click("#mock-panel summary")
    page.click("#mock-line-received")
    expect(page.locator("#lc-status")).to_contain_text("Recibido 25 CUP de 56666666", timeout=10_000)
    # Review finding 6: the charge's detail shows who paid, not this line's own number.
    cid = page.evaluate("ajeDev.store.state.attempts.find((a) => a.op === '234-charge' && a.state === 'verified').id")
    page.goto(page.url.split("#")[0] + f"#/history/{cid}")
    expect(page.locator("#detail")).to_contain_text("Desde")
    expect(page.locator("#detail")).to_contain_text("56666666")
    expect(page.locator("#detail")).not_to_contain_text("55555555")
    # The line's number is asked once.
    page.goto(page.url.split("#")[0] + "#/line-charge?sub=3")
    expect(page.locator("#lc-number")).to_have_count(0)
    expect(page.locator("#lc-amount")).to_be_visible()


def pay_by_qr(page):
    dials = line_sends(page)
    page.goto(page.url.split("#")[0] + "#/qr")
    expect(page.locator("#qr-scan")).to_be_visible()
    # Headless Chromium has no camera: the scanner says so and offers the number instead.
    expect(page.locator("#qr-msg")).to_contain_text("cámara", timeout=10_000)
    page.evaluate("dispatchEvent(new CustomEvent('aje-qr', { detail: 'https://example.com/pago' }))")
    expect(page.locator("#qr-msg")).to_have_text("Este QR no es un cobro de Ajé")
    page.evaluate("dispatchEvent(new CustomEvent('aje-qr', { detail: 'aje:saldo?v=9&n=56666666' }))")
    expect(page.locator("#qr-msg")).to_have_text("Actualiza Ajé para leer este QR")
    page.click("#mock-panel summary")
    page.click("#mock-qr")
    expect(page.locator("#line-transfer")).to_be_visible()
    expect(page.locator("#lt-to")).to_have_text("Para Ana · 56666666")
    expect(page.locator("#lt-amount")).to_have_value("150")
    expect(page.locator("#lt-submit")).to_have_text("Pasar 150 CUP")
    # Scanning fills the form; nothing goes out until the person taps Pasar and gives the key.
    assert line_sends(page) == dials
    # Review finding 7: leaving the QR tab removes its test listener, so the panel's QR does nothing elsewhere.
    page.goto(page.url.split("#")[0] + "#/qr")
    expect(page.locator("#qr-scan")).to_be_visible()
    page.goto(page.url.split("#")[0] + "#/history")
    page.evaluate("dispatchEvent(new CustomEvent('aje-qr', { detail: 'aje:saldo?v=1&n=56666666&m=150' }))")
    page.wait_for_timeout(300)
    assert "#/history" in page.url, page.url


def scanner_without_reader(page):
    # Review finding 1: a reader that does not load never opens the camera.
    page.route("**/vendor/qr/jsQR.js", lambda r: r.abort())
    # A fresh page: the reader is loaded once per page, so an earlier visit must not have loaded it.
    page.goto(page.url.split("#")[0].split("?")[0] + "#/home")
    page.reload()
    page.wait_for_selector("#view")
    page.evaluate("""() => {
        window.cameraAsked = 0;
        const md = navigator.mediaDevices;
        if (md) md.getUserMedia = async () => { window.cameraAsked++; throw new Error("no camera here"); };
    }""")
    page.goto(page.url.split("#")[0] + "#/qr")
    expect(page.locator("#qr-msg")).to_contain_text("lector de QR", timeout=10_000)
    assert page.evaluate("window.cameraAsked") == 0
    page.unroute("**/vendor/qr/jsQR.js")
    page.goto(page.url.split("#")[0] + "#/home")


def line_transfer_by_number(page):
    open_line_transfer(page)
    page.fill("#lt-num", "+53 5555 5555")
    expect(page.locator("#lt-to")).to_contain_text("55555555")
    page.fill("#lt-amount", "25")
    expect(page.locator("#lt-submit")).to_have_text("Pasar 25 CUP")
    expect(page.locator("#lt-total")).to_have_text("30 CUP")
    page.click("#lt-submit")
    expect(page.locator("#key-input")).to_be_visible()
    expect(page.locator("#key-remember")).to_have_attribute("aria-pressed", "true")
    page.fill("#key-input", "9876")
    page.click("#key-submit")
    expect(page.locator('#lt-result[data-outcome="dialer"]')).to_be_visible(timeout=10_000)
    page.click("#mock-panel summary")
    page.click("#mock-line-sent")
    expect(page.locator("#lt-result")).to_contain_text("Verificada", timeout=10_000)
    page.keyboard.press("Escape")
    assert page.evaluate("ajeDev.store.state.attempts[0].op") == "234"
    assert page.evaluate("ajeDev.store.state.attempts[0].state") == "verified"
    # The verified transfer reads the line's balance again.
    page.wait_for_function("ajeDev.bridge.calls.some((c) => c.method === 'sendUssd' && c.args.code === '*222#')")
    page.goto(page.url.split("#")[0] + "#/history")
    expect(page.locator(".row").first).to_contain_text("Saldo a 55555555")


def line_transfer_saved_key(page):
    open_line_transfer(page)
    expect(page.locator("#lt-recent button")).to_have_count(1)
    page.click("#lt-recent button")
    page.fill("#lt-amount", "10")
    page.click("#lt-submit")
    expect(page.locator('#lt-result[data-outcome="dialer"]')).to_be_visible(timeout=10_000)
    expect(page.locator("#key-input")).to_have_count(0)
    page.keyboard.press("Escape")


def line_transfer_forget_key(page):
    # Line 3 has the key saved by line_transfer_by_number: the dialer hides a refusal, so it can be forgotten.
    open_line_transfer(page)
    page.fill("#lt-num", "55555555")
    page.fill("#lt-amount", "10")
    page.click("#lt-submit")
    expect(page.locator('#lt-result[data-outcome="dialer"]')).to_be_visible(timeout=10_000)
    page.click("#lt-forget")
    expect(page.locator("#lt-forget")).to_contain_text("Clave olvidada")
    page.keyboard.press("Escape")
    page.click("#lt-submit")
    expect(page.locator("#key-input")).to_be_visible(timeout=10_000)
    page.fill("#key-input", "9876")
    page.click("#key-submit")
    expect(page.locator('#lt-result[data-outcome="dialer"]')).to_be_visible(timeout=10_000)
    page.keyboard.press("Escape")


def contact_with_landline(page):
    open_line_transfer(page)
    page.click("#lt-tab-con")
    page.evaluate("ajeDev.bridge.setNextContact({ name: 'Oficina', number: '7 800 0000' })")
    page.click("#lt-pick")
    expect(page.locator("#lt-error")).to_have_text("Ese número no es un móvil Cubacel.")
    page.click("#lt-pick")
    expect(page.locator("#lt-to")).to_have_text("Para Ben · 51000001")
    expect(page.locator("#lt-error")).to_be_hidden()


def double_tap_sends_once(page):
    open_line_transfer(page)
    before = line_sends(page)
    page.fill("#lt-num", "55555555")
    page.fill("#lt-amount", "5")
    page.evaluate("() => { const b = document.getElementById('lt-submit'); b.click(); b.click(); }")
    expect(page.locator('#lt-result[data-outcome="dialer"]')).to_be_visible(timeout=10_000)
    assert line_sends(page) == before + 1, (before, line_sends(page))
    page.keyboard.press("Escape")


def no_key_double_tap_sends_once(page):
    # Line 4 has no saved key: Pasar stays off while the send runs.
    open_line_transfer(page, sub=4)
    before = line_sends(page)
    page.fill("#lt-num", "55555555")
    page.fill("#lt-amount", "5")
    page.click("#lt-submit")
    page.fill("#key-input", "1111")
    page.click("#key-submit")
    expect(page.locator("#lt-submit")).to_be_disabled()
    expect(page.locator('#lt-result[data-outcome="dialer"]')).to_be_visible(timeout=10_000)
    assert line_sends(page) == before + 1, (before, line_sends(page))
    page.keyboard.press("Escape")
    expect(page.locator("#lt-submit")).to_be_enabled()


STEPS = [seed_card, deck, balance_with_login, saved_pin_logs_in, transfer_refuses_decimals, mobile_balance, history_and_verified_transfer,
         double_tap_transfers_once,
         line_transfer_by_number, buy_plan_from_catalog, charge_by_qr, pay_by_qr, line_transfer_saved_key, line_transfer_forget_key, no_key_double_tap_sends_once, contact_with_landline, double_tap_sends_once, add_card_linked_bank, add_clasica_via_mitransfer, pending_card_resumes_guide, update_beta, refused_login, scanner_without_reader]


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/aje-smoke")
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as p:
        page = p.chromium.launch().new_page(viewport={"width": 390, "height": 844})
        # scanner_without_reader blocks jsQR.js on purpose; its failed load is the one error expected.
        page.on("console", lambda m: m.type == "error" and not (m.text.startswith("Failed to load resource") and "jsQR.js" in (m.location or {}).get("url", ""))
                and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        fake_github(page, [])
        fake_plan_catalog(page)
        base = serve()
        for step in STEPS:
            page.goto(base + "/index.html#/home")
            step(page)
            page.screenshot(path=out / f"{step.__name__}.png", full_page=True)
        width = page.evaluate("document.documentElement.scrollWidth")
        scan_reads_card(p, base, out, errors)
        consent_once(p, base, out, errors)
    assert width <= 390, f"page is {width}px wide on a 390px phone"
    assert not errors, errors
    print(f"{len(STEPS) + 2} steps passed, 0 errors, {width}px wide")


if __name__ == "__main__":
    main()
