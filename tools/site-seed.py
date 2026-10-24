"""Writes site/demo-state.json, the store the landing page's demo starts from.

    uv run --with playwright python tools/site-seed.py

It runs a few of the smoke test's flows against the mock, so every row of the demo's history
went through the real workflow and SMS parser, then keeps the store they left behind.
"""

import importlib.util
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("smoke", ROOT / "tools" / "smoke-web.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

FLOWS = [smoke.seed_card, smoke.balance_with_login, smoke.mobile_balance, smoke.history_and_verified_transfer,
         smoke.line_transfer_by_number, smoke.buy_plan_from_catalog, smoke.add_card_linked_bank, smoke.import_backup, smoke.pay_bills,
         smoke.inbox_from_sms]

# How long ago each history row happened, newest first.
HOURS_AGO = [0.2, 1.5, 3, 5, 22, 26, 30, 49, 52, 75, 98]


def main():
    with sync_playwright() as p:
        page = p.chromium.launch().new_page(viewport={"width": 390, "height": 844})
        smoke.fake_github(page, [])
        smoke.fake_plan_catalog(page)
        base = smoke.serve()
        for flow in FLOWS:
            page.goto(base + "/index.html#/home")
            # A flow's later checks assume a fresh smoke run; what it did before one fails stays in the demo.
            try:
                flow(page)
            except AssertionError as e:
                print(f"{flow.__name__} stopped early: {str(e).splitlines()[0]}")
        page.goto(base + "/index.html#/home")
        page.wait_for_function("globalThis.ajeDev")
        state = page.evaluate("ajeDev.store.state")
    # The demo opens on the deck, not on the telemetry question.
    state["settings"]["telemetryAsked"] = True
    # The flows ran within a minute and test failures on the way; the demo shows a few days that went well.
    state["attempts"] = [a for a in state["attempts"] if a["state"] == "verified"]
    for i, a in enumerate(state["attempts"]):
        ago = HOURS_AGO[min(i, len(HOURS_AGO) - 1)] * 3_600_000
        a.update({k: v - ago for k, v in a.items() if isinstance(v, int) and v > 1_600_000_000_000})
    names = {"Metro dos": "Ahorro", "Clásica-0012": "Clásica"}
    for c in state["cards"]:
        c["alias"] = names.get(c["alias"], c["alias"])
    out = ROOT / "site" / "demo-state.json"
    out.write_text(json.dumps({"capturedAt": int(time.time() * 1000), "state": state}, ensure_ascii=False) + "\n")
    print(f"{out}: {len(state['cards'])} cards, {len(state['attempts'])} history rows, {len(state['bills'])} bills")


if __name__ == "__main__":
    main()
