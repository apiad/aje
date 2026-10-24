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


def settle_history(page):
    """"Revisar SMS" reads the inbox back 72 hours and says what it found; a second run adds nothing."""
    page.goto(page.url.split("#")[0] + "#/history")
    rows = page.locator("#history .row").count()
    page.click("#settle")
    expect(page.locator("#settle-note")).to_contain_text("Revisé", timeout=10_000)
    # The settle pill in a row's detail keeps the top bar's icon size.
    page.locator('#history .row:not([data-state="verified"])').first.click()
    width = page.locator("#detail #settle svg").bounding_box()["width"]
    assert width <= 16, f"settle icon is {width}px wide"
    page.goto(page.url.split("#")[0] + "#/history")
    assert page.locator("#history .row").count() == rows, "settle added history rows"
    since = page.evaluate("ajeDev.bridge.calls.filter((c) => c.method === 'readSms').at(-1).args.since")
    age = page.evaluate("Date.now()") - since
    assert 72 * 3600_000 <= age < 72 * 3600_000 + 60_000, f"settle read {age} ms back"


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


def already_authenticated_login(page):
    """The bank answers the login by USSD that the session is already open, and sends no SMS."""
    page.goto(page.url.split("#")[0].split("?")[0] + "?mock=already-auth#/home")
    expect(page.locator("#add-card")).to_be_visible()
    # Earlier steps left a recent login, which would skip the login step.
    page.evaluate("ajeDev.store.setBank('METROPOLITANO', { authenticatedAt: null })")
    page.click("#add-card")
    type_number(page)
    page.fill("#add-pan", "9227 9599 0000 0004")
    page.fill("#add-alias", "Metro tres")
    page.click("#add-next")
    expect(page.locator("#add-registered, #add-pin").first).to_be_visible()
    if page.locator("#add-registered").count():
        page.click("#add-registered")
    page.fill("#add-pin", "1234")
    page.click("#add-pin-submit")
    expect(page.locator("#add-coord")).to_be_visible(timeout=10_000)
    page.fill("#add-coord", "12")
    page.click("#add-link")
    expect(page.locator("#add-done")).to_contain_text("Metro tres", timeout=10_000)
    page.goto(page.url.split("#")[0].split("?")[0] + "#/home")


def pay_bills(page):
    """Servicios: a saved electricity bill is checked, shows its debt, and is paid with one tap; Nauta keeps its amount."""
    page.goto(page.url.split("#")[0].split("?")[0] + "#/pay")
    # The sample backup's electricity contract and Nauta account are offered.
    expect(page.locator("#bill-offers .row")).to_have_count(2)
    page.click("#bill-add")
    expect(page.locator('#bill-kind button.on')).to_have_text("Luz")
    page.fill("#bill-number", "12345")
    page.fill("#bill-alias", "Casa")
    page.click("#bill-save")
    expect(page.locator("#bill-error")).to_contain_text("13 dígitos")
    page.fill("#bill-number", "1234 5678 90123")
    page.click("#bill-save")
    expect(page.locator('#bills [data-bill]')).to_have_count(1)
    expect(page.locator("#bills")).to_contain_text("Casa")
    expect(page.locator("#bills")).to_contain_text("····0123")
    # A new account is unchecked: it offers Revisar, not Pagar.
    expect(page.locator("#bills [data-bill]")).to_have_attribute("data-status", "never")
    expect(page.locator("#bills [data-pay]")).to_have_count(0)
    page.locator("#bills [data-debt]").click()
    expect(page.locator("#sheet h3")).to_have_text("Deuda · Luz · Casa")
    # The reload dropped the mock's session: the bank asks for one first.
    expect(page.locator('#pin, #bill-result:not([data-state="sent"])').first).to_be_visible(timeout=10_000)
    if page.locator("#pin").count():
        page.fill("#pin", "1234")
        page.click("#pin-submit")
    expect(page.locator("#bill-result")).to_contain_text("Debe 85.40 CUP.", timeout=10_000)
    assert page.evaluate("ajeDev.bridge.calls.filter((c) => c.method === 'sendUssd').at(-1).args.code").startswith("*444*47*")
    # A check that ended well closes its sheet; the row keeps the answer.
    expect(page.locator("#sheet")).to_have_count(0, timeout=5_000)
    row = page.locator("#bills [data-bill]")
    expect(row).to_have_attribute("data-status", "owe")
    expect(row).to_contain_text("Debe 85.40 CUP")
    dials = page.evaluate("ajeDev.bridge.calls.filter((c) => c.method === 'dial').length")
    page.locator("#bills [data-pay]").click()
    expect(page.locator("#sheet")).to_contain_text("Luz · Casa")
    expect(page.locator("#bill-result")).to_contain_text("procesada", timeout=10_000)
    sent = page.evaluate("ajeDev.bridge.calls.filter((c) => c.method === 'sendUssd').map((c) => c.args.code)")
    assert sent[-1].startswith("*444*41*"), sent[-1:]
    assert page.evaluate("ajeDev.bridge.calls.filter((c) => c.method === 'dial').length") == dials, "paid without the dialer"
    expect(page.locator("#sheet")).to_have_count(0, timeout=5_000)
    # Paid after the check: the row says so and asks to check again to confirm.
    expect(row).to_have_attribute("data-status", "paid")
    expect(row).to_contain_text("Pagado 85.40 CUP")
    expect(row.locator("[data-debt]")).to_have_class("checkbtn due")
    # Nauta from the backup's offer: the user comes filled in, the amount is asked.
    page.locator("#bill-offers .row", has_text="ana.perez").locator("button").click()
    expect(page.locator('#bill-kind button.on')).to_have_text("Nauta")
    expect(page.locator("#bill-number")).to_have_value("ana.perez")
    expect(page.locator('#bill-nauta-type button.on')).to_have_text("Navegación internacional")
    expect(page.locator("#bill-scan")).to_have_count(0)
    page.click("#bill-save")
    expect(page.locator("#bill-error")).to_contain_text("importe")
    page.fill("#bill-amount", "100")
    page.click("#bill-save")
    expect(page.locator('#bills [data-bill]')).to_have_count(2)
    expect(page.locator("#bill-offers .row")).to_have_count(1)
    # With the session gone, paying asks for the key, logs in, pays, and the bank's SMS verifies it.
    page.click("#mock-panel summary")
    page.click("#mock-logout")
    page.locator("#bills [data-bill]", has_text="ana.perez").locator("[data-pay]").click()
    expect(page.locator("#pin")).to_be_visible(timeout=10_000)
    page.fill("#pin", "1234")
    page.click("#pin-submit")
    expect(page.locator('#bill-result[data-state="verified"]')).to_contain_text("Verificado", timeout=15_000)
    expect(page.locator("#sheet")).to_contain_text("AB000CD0001")
    page.keyboard.press("Escape")
    # Water asks for the company; the number's length follows it.
    page.click("#bill-add")
    page.click('#bill-kind button[data-value="water"]')
    page.click('#bill-region button[data-value="2"]')
    expect(page.locator("#bill")).to_contain_text("14 o 16 dígitos")
    page.click(".sbar .back")
    # Editing the Nauta account and deleting it.
    page.locator("#bills [data-bill]", has_text="ana.perez").locator(".tx").click()
    expect(page.locator("#bill-amount")).to_have_value("100")
    page.click("#bill-delete")
    expect(page.locator('#bills [data-bill]')).to_have_count(1)
    page.click('nav a[href="#/history"]')
    # The attempt the bank refused for want of a session, the payment, and the debt query.
    expect(page.locator("#history .row", has_text="Luz · Casa")).to_have_count(3)
    expect(page.locator("#history .row", has_text="ana.perez").first).to_contain_text("verificada")
    page.goto(page.url.split("#")[0] + "#/home")


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
        expect(page.locator("#addcard .matrix span")).to_have_count(100)
        expect(page.locator("#addcard .matrix span.hit")).to_have_count(1)
        expect(page.locator("#addcard .matrix")).not_to_contain_text("object")
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



def pending_card_resumes_ask(page):
    """A pending card whose bank's registration is unknown, as an imported one is, asks about it first."""
    expect(page.locator("#add-card")).to_be_visible()
    card_id = page.evaluate("""async () => (await ajeDev.store.addCard(
        { alias: "BPA CUP", pan: "9227129900000006", bank: "BPA", currency: "CUP" })).id""")
    page.reload()
    page.wait_for_function("globalThis.ajeDev")
    page.click(f'[data-go-acct="card:{card_id}"]')
    page.locator(f'#deck .acct[data-id="card:{card_id}"] [data-action="resume"]').click()
    expect(page.locator("#add-registered")).to_be_visible()


def pending_card_already_in_use(page):
    """A pending card the person already uses in Transfermóvil is ready without login or coordinate."""
    expect(page.locator("#add-card")).to_be_visible()
    card_id = page.evaluate("""async () => (await ajeDev.store.addCard(
        { alias: "Metro dos", pan: "9227959900000031", bank: "METROPOLITANO", currency: "CUP" })).id""")
    page.reload()
    page.wait_for_function("globalThis.ajeDev")
    page.click(f'[data-go-acct="card:{card_id}"]')
    page.locator(f'#deck .acct[data-id="card:{card_id}"] [data-action="resume"]').click()
    page.click("#add-trusted")
    expect(page.locator("#deck")).to_be_visible()
    card = page.evaluate(f"ajeDev.store.state.cards.find((c) => c.id === '{card_id}')")
    assert card["state"] == "linked" and card["unverified"] is True, card


def write_backup(path):
    subprocess.run(["node", str(WEB / "test" / "write-trm.mjs"), str(path)], check=True)
    return path


def import_backup(page):
    """A sample backup from this phone: the ticked cards come in linked, on trust until the bank serves them."""
    path = write_backup(Path("/tmp/aje-smoke-sample.trm"))
    page.click("#import-tm")
    expect(page.locator("#import-pick")).to_be_visible()
    expect(page.locator("#import")).not_to_contain_text("null")
    page.locator("#import-file").set_input_files(str(path))
    expect(page.locator("#import-cards input[type=checkbox]")).to_have_count(3)
    expect(page.locator('#import-cards label[data-pan-last4="0001"]')).to_contain_text("ya está en Ajé")
    expect(page.locator('#import-cards label[data-pan-last4="0014"]')).to_contain_text("Clásica empresarial")
    expect(page.locator("#import-kept")).to_contain_text("Destinatarios")
    expect(page.locator("#import-unreadable")).to_have_text("1 fila no se pudo leer.")
    expect(page.locator("#import-go")).to_have_text("Importar 3 tarjetas")
    page.locator('#import-cards label[data-pan-last4="0013"] input').uncheck()
    expect(page.locator("#import-go")).to_have_text("Importar 2 tarjetas")
    expect(page.locator("#import-same-phone")).to_be_checked()
    page.click("#import-go")
    expect(page.locator("#import-done")).to_contain_text("2 tarjetas listas")
    expect(page.locator("#import-first")).to_have_count(0)
    state = page.evaluate("""() => ({
        ready: ajeDev.store.state.cards.filter((c) => ["9227959900000011", "9760030000000012"].includes(c.pan)
            && ["linked", "associated"].includes(c.state) && c.unverified === true).length,
        banks: [ajeDev.store.state.banks.METROPOLITANO?.registered, ajeDev.store.state.banks.MITRANSFER?.registered],
        skipped: ajeDev.store.state.cards.some((c) => c.pan === "9227069900000013"),
        clasica: ajeDev.store.state.cards.find((c) => c.pan === "9760030000000012")?.currency,
        recipients: ajeDev.store.state.imported?.recipients.length,
        secret: JSON.stringify(ajeDev.store.state).includes('"pin"'),
    })""")
    assert state == {"ready": 2, "banks": [True, True], "skipped": False, "clasica": "USD", "recipients": 2, "secret": False}, state


def import_not_a_backup(page):
    """Any other file says so in one line and lets the person pick again."""
    path = Path("/tmp/aje-smoke-not-a-backup.txt")
    path.write_text("hola")
    page.goto(page.url.split("#")[0] + "#/settings")
    page.click("#import-tm-settings")
    page.locator("#import-file").set_input_files(str(path))
    expect(page.locator("#import-error")).to_have_text("Este archivo no es un respaldo de Transfermóvil.")
    expect(page.locator("#import-pick")).to_be_visible()


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
    # Transferir reads the destination card the same way, and leaves it to check before sending.
    page.goto(base + "/index.html#/home")
    seed_card(page)
    page.goto(base + "/index.html#/transfer")
    page.click("#tr-scan")
    expect(page.locator("#tr-to")).to_have_value("9227 9599 0000 0001", timeout=60_000)
    expect(page.locator("#tr-scanbox")).to_be_hidden()
    expect(page.locator("#tr-scan")).to_be_visible()
    page.screenshot(path=out / "transfer_scans_card.png", full_page=True)
    browser.close()


def scan_reads_bill(p, base, out, errors):
    """The bill form reads a printed bill's number from Chromium's fake camera."""
    fixtures = out / "fixtures"
    browser = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                      f"--use-file-for-fake-video-capture={fixtures / 'bill.mjpeg'}"])
    page = browser.new_context(viewport={"width": 390, "height": 844}, permissions=["camera"]).new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base + "/index.html#/home")
    seed_card(page)
    page.goto(base + "/index.html#/bill")
    page.click("#bill-scan")
    expect(page.locator("#bill-number")).to_have_value("1234567890123", timeout=60_000)
    expect(page.locator("#bill-scanbox")).to_be_hidden()
    page.screenshot(path=out / "scan_reads_bill.png", full_page=True)
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
    expect(page.locator("#update-settings-bar")).to_be_visible()
    expect(page.locator("#update-settings-status")).to_contain_text("MB")
    expect(page.locator("#update-settings-status")).to_contain_text("instalador", timeout=10_000)
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
        if on:
            telemetry_history_folds(page)
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


def charge_with_the_sims_number(page):
    # Android reports the mock's second SIM number: it fills the field, to confirm once.
    page.goto(page.url.split("#")[0] + "#/line-charge?sub=4")
    expect(page.locator("#line-charge")).to_be_visible()
    expect(page.locator("#lc-number")).to_have_value("51234567")
    page.click("#lc-show")
    expect(page.locator("#lc-qr svg")).to_be_visible()
    expect(page.locator(".qrcap")).to_contain_text("51234567")
    # Saved, it is not asked again, and it can be changed.
    page.goto(page.url.split("#")[0] + "#/home")
    page.goto(page.url.split("#")[0] + "#/line-charge?sub=4")
    expect(page.locator("#lc-number")).to_have_count(0)
    expect(page.locator("#lc-saved")).to_contain_text("51234567")
    page.click("#lc-change")
    expect(page.locator("#lc-number")).to_have_value("51234567")
    page.fill("#lc-number", "52222222")
    page.click("#lc-show")
    expect(page.locator(".qrcap")).to_contain_text("52222222")


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


def telemetry_history_folds(page):
    # What telemetry sent sits behind a fold, and the privacy link reads in the app's gold.
    history = page.locator("#telemetry-history")
    expect(history).to_be_visible()
    expect(history.locator(".set-row").first).to_be_hidden()
    history.locator("summary").click()
    expect(history.locator(".set-row").first).to_be_visible()
    page.evaluate("ajeDev.store.update({ channel: ajeDev.store.state.settings.channel })")  # a redraw keeps it open
    expect(history.locator(".set-row").first).to_be_visible()
    link = page.get_by_role("link", name="Cómo funciona")
    gold = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--gold').trim()")
    color = link.evaluate("(a) => getComputedStyle(a).color")
    probe = page.evaluate(f"(() => {{ const d = document.createElement('div'); d.style.color = '{gold}'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }})()")
    assert color == probe, (color, probe)


def inbox_from_sms(page):
    """A transfer to a card arrives: the bell counts it, the inbox names the contact, and opening it clears it."""
    page.wait_for_function("globalThis.ajeDev")
    expect(page.locator("#bell .count")).to_have_count(0)
    page.click("#mock-panel summary")
    page.click("#mock-card-received")
    expect(page.locator("#bell .count")).to_have_text("1", timeout=10_000)
    page.click("#bell")
    pending = page.locator("#inbox-pending")
    expect(pending).to_contain_text("Recibiste 1500.00 CUP de Mamá", timeout=10_000)
    row_id = page.evaluate("ajeDev.store.state.inbox[0].rowId")
    pending.locator(".notice").first.locator("button", has_text="Ver").click()
    page.wait_for_url(f"**#/history/{row_id}")
    expect(page.locator("#detail")).to_contain_text("Transferencia recibida")
    expect(page.locator("#detail")).to_contain_text("····0001")
    page.goto(page.url.split("#")[0] + "#/inbox")
    expect(page.locator("#inbox-seen")).to_contain_text("Recibiste 1500.00 CUP de Mamá")
    expect(page.locator("#inbox-pending .notice")).to_have_count(0)
    page.goto(page.url.split("#")[0] + "#/home")
    expect(page.locator("#bell .count")).to_have_count(0)
    # A second notice is cleared by dismissing it.
    page.click("#mock-panel summary")
    page.click("#mock-recharge-intl")
    expect(page.locator("#bell .count")).to_have_text("1", timeout=10_000)
    page.click("#bell")
    expect(page.locator("#inbox-pending")).to_contain_text("recarga internacional")
    page.locator("#inbox-pending .notice").first.locator("button", has_text="Descartar").click()
    expect(page.locator("#inbox-pending .notice")).to_have_count(0)
    # A notification opens its own notice, highlighted.
    nid = page.evaluate("ajeDev.store.state.inbox[0].id")
    page.goto(page.url.split("#")[0] + f"#/inbox/{nid}")
    expect(page.locator(f'.notice.hl[data-id="{nid}"]')).to_have_count(1)
    page.goto(page.url.split("#")[0] + "#/home")
    expect(page.locator("#bell .count")).to_have_count(0)


STEPS = [seed_card, deck, balance_with_login, saved_pin_logs_in, transfer_refuses_decimals, mobile_balance, history_and_verified_transfer, settle_history,
         double_tap_transfers_once, inbox_from_sms,
         line_transfer_by_number, buy_plan_from_catalog, charge_with_the_sims_number, charge_by_qr, pay_by_qr, line_transfer_saved_key, line_transfer_forget_key, no_key_double_tap_sends_once, contact_with_landline, double_tap_sends_once, add_card_linked_bank, add_clasica_via_mitransfer, pending_card_resumes_guide, pending_card_resumes_ask, pending_card_already_in_use, import_backup, pay_bills, import_not_a_backup, update_beta, refused_login, already_authenticated_login, scanner_without_reader]


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
        scan_reads_bill(p, base, out, errors)
        consent_once(p, base, out, errors)
    assert width <= 390, f"page is {width}px wide on a 390px phone"
    assert not errors, errors
    print(f"{len(STEPS) + 3} steps passed, 0 errors, {width}px wide")


if __name__ == "__main__":
    main()
