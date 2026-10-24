#!/usr/bin/env python3
"""Walk a USSD menu tree on a phone over adb and save every screen as JSON.

Android's USSD API cannot read the *133 menus, but the dialer accepts chained
shortcuts (*133*1*4#) and shows each reply in a dialog that uiautomator can
read. This script dials one shortcut at a time, breadth-first, reads the
dialog, cancels it and expands only the screens that are menus.

Safety: it never types into a dialog and never presses its send button. A
dialog is only ever cancelled (its Cancel button or BACK). A screen that asks
to confirm is a leaf: nothing longer than its path is dialed.

    python3 tools/ussd-explore.py --root 133 --out docs/ussd/133.json
"""

import argparse
import datetime
import json
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from collections import deque

MAX_DEPTH = 6
MIN_DELAY = 4.0
WAIT_DIALOG = 15.0
ERROR_RETRY_WAIT = 10.0

OPTION = re.compile(r"^\s*(\d{1,2})\s*(?:[.)\-:]\s*|\s+)(\S.*?)\s*$")
CONFIRM_WORDS = re.compile(r"compr|confirm|acept", re.I)
PRICE = re.compile(r"\d+(?:[.,]\d+)?\s*(?:cup|cuc|mlc|pesos|usd)\b|\$\s*\d|\d\s*\$", re.I)
YES_NO = re.compile(r"^\s*(s[ií]|no)\s*$", re.I)
BACK_LABEL = re.compile(
    r"^\s*(atr[aá]s|volver|salir|inicio|regresar|anterior|men[uú] anterior|men[uú] principal|men[uú]\s*$)", re.I
)
# A bare verb acts at once, with no confirm screen ("1 Habilitar" switched a service on).
ACTION_LABEL = re.compile(r"^\s*(habilitar|deshabilitar|activar|desactivar|adicionar|eliminar)\b(?!\s*/)", re.I)
INVALID = re.compile(r"opci[oó]n no v[aá]lida", re.I)
ERROR_TEXT = re.compile(
    r"mmi|problema de conexi|connection problem|no v[aá]lid|invalid|error|"
    r"no disponible|unavailable|intente m[aá]s tarde|try again",
    re.I,
)
PROGRESS_TEXT = re.compile(r"ejecutando|running|enviando|sending|cargando|loading", re.I)
CANCEL_LABEL = re.compile(r"^\s*(cancel(ar)?|descartar|dismiss|cerrar|close)\s*$", re.I)
SEND_LABEL = re.compile(r"enviar|send|responder|reply|aceptar|ok|accept|llamar|call", re.I)
DIALOG_PACKAGES = ("com.android.phone", "com.xiaomi.phone", "com.android.mms", "com.android.stk")


def redact(text):
    """Replace phone numbers, balances and long digit runs; keep prices."""
    text = re.sub(r"(?:\+53|0053)\s?\d{8}\b", "5XXXXXXX", text)
    text = re.sub(r"(?<!\d)[56]\d{7}(?!\d)", "5XXXXXXX", text)
    text = re.sub(r"([Ss]aldo\D{0,25}?)\d+(?:[.,]\d+)?", r"\g<1>0.00", text)
    return re.sub(r"\d{7,}", "#######", text)


class Phone:
    def __init__(self, adb, sim):
        self.adb = adb
        self.sim = sim

    def run(self, *args, timeout=30):
        out = subprocess.run([self.adb, *args], capture_output=True, text=True, timeout=timeout)
        if out.returncode != 0:
            raise RuntimeError(f"adb {' '.join(args)} failed: {out.stderr.strip()[-300:]}")
        return out.stdout

    def prop(self, name):
        return self.run("shell", "getprop", name).strip()

    def dial(self, code):
        self.run("shell", "am", "start", "-a", "android.intent.action.CALL", "-d", "tel:" + code.replace("#", "%23"))

    def nodes(self):
        xml = self.run("exec-out", "uiautomator", "dump", "/dev/tty")
        xml = xml[xml.find("<?xml") :]
        end = xml.rfind("</hierarchy>")
        if end < 0:
            return []
        return list(ET.fromstring(xml[: end + len("</hierarchy>")]).iter("node"))

    def back(self):
        self.run("shell", "input", "keyevent", "KEYCODE_BACK")

    def tap(self, node):
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
        self.run("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def read_dialog(nodes):
    """Return (text, cancel_button, busy) for a USSD dialog, or None if there is none."""
    nodes = [n for n in nodes if n.get("package") in DIALOG_PACKAGES]
    if not nodes:
        return None
    busy = any(n.get("class", "").endswith("ProgressBar") for n in nodes)
    message = [n for n in nodes if re.search(r":id/(ussd_)?message$", n.get("resource-id", "")) and n.get("text")]
    if not message:
        texts = [
            n
            for n in nodes
            if n.get("text") and n.get("class", "").endswith("TextView") and n.get("clickable") != "true"
        ]
        message = sorted(texts, key=lambda n: len(n.get("text")), reverse=True)[:1]
    text = message[0].get("text") if message else ""
    if PROGRESS_TEXT.search(text) and len(text) < 60:
        busy = True
    cancel = None
    for n in nodes:
        label = n.get("text") or n.get("content-desc") or ""
        if n.get("clickable") == "true" and CANCEL_LABEL.match(label) and not SEND_LABEL.search(label):
            cancel = n
    return text, cancel, busy


def wait_dialog(phone):
    deadline = time.monotonic() + WAIT_DIALOG
    while time.monotonic() < deadline:
        nodes = phone.nodes()
        dialog = read_dialog(nodes)
        if dialog and dialog[0] and not dialog[2]:
            return dialog[0]
        if not dialog and any(re.search(r"\bSIM\b", n.get("text") or "") for n in nodes):
            pick_sim(phone, nodes)
        time.sleep(1)
    return None


def pick_sim(phone, nodes):
    """Answer the dialer's SIM picker (not a USSD dialog) with the row --sim names."""
    rows = [n for n in nodes if n.get("resource-id", "").endswith(":id/label")]
    if phone.sim is None or phone.sim > len(rows):
        phone.back()
        sys.exit(f"The dialer asks which SIM to use ({len(rows)} rows). Pass --sim 1 or --sim 2.")
    rows.sort(key=lambda n: int(re.findall(r"\d+", n.get("bounds"))[1]))
    phone.tap(rows[phone.sim - 1])
    time.sleep(1)


def dismiss(phone):
    """Cancel whatever dialog is up: its Cancel button, else BACK. Never anything else."""
    for _ in range(4):
        nodes = phone.nodes()
        dialog = read_dialog(nodes)
        if dialog is None:
            return True
        if dialog[1] is not None:
            phone.tap(dialog[1])
        else:
            phone.back()
        time.sleep(1)
    return read_dialog(phone.nodes()) is None


def parse_options(text):
    options = []
    for line in text.splitlines():
        m = OPTION.match(line)
        if m:
            options.append({"key": m.group(1), "label": m.group(2)})
    return options


def classify(text, options):
    if not text.strip():
        return "error"
    yes_no = any(YES_NO.match(o["label"]) for o in options)
    accepts = any(o["key"] == "1" and CONFIRM_WORDS.search(o["label"]) for o in options)
    if CONFIRM_WORDS.search(text) or accepts or (PRICE.search(text) and yes_no):
        return "confirm"
    if INVALID.search(text):
        return "error"
    if len(options) >= 2:
        return "menu"
    if ERROR_TEXT.search(text):
        return "error"
    return "text"


def expandable(option):
    return not BACK_LABEL.match(option["label"]) and not ACTION_LABEL.match(option["label"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default="133")
    ap.add_argument("--out", required=True)
    ap.add_argument("--adb", default="adb")
    ap.add_argument("--delay", type=float, default=MIN_DELAY)
    ap.add_argument("--max-dials", type=int, default=80)
    ap.add_argument("--sim", type=int, help="row to pick (1 or 2) when the dialer asks which SIM to use")
    args = ap.parse_args()
    if args.delay < MIN_DELAY:
        ap.error(f"--delay must be at least {MIN_DELAY} s")
    if args.max_dials > 80:
        ap.error("--max-dials must be at most 80")

    phone = Phone(args.adb, args.sim)
    phone.run("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    dismiss(phone)
    doc = {
        "root": f"*{args.root}#",
        "captured": datetime.date.today().isoformat(),
        "android": phone.prop("ro.build.version.release"),
        "maker": phone.prop("ro.product.manufacturer"),
        "screens": [],
    }
    queue = deque([[]])
    texts = {}
    dials = 0
    last_dial = 0.0

    def save():
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
            f.write("\n")

    while queue and dials < args.max_dials:
        path = queue.popleft()
        code = "*" + "*".join([args.root, *path]) + "#"
        for attempt in (1, 2):
            if attempt == 2:
                if dials >= args.max_dials:
                    break
                time.sleep(ERROR_RETRY_WAIT)
            time.sleep(max(0.0, last_dial + args.delay - time.monotonic()))
            last_dial = time.monotonic()
            phone.dial(code)
            dials += 1
            raw = wait_dialog(phone)
            if not dismiss(phone):
                save()
                sys.exit(f"Could not cancel the dialog after {code}; stopping.")
            text = redact(raw or "")
            options = parse_options(text)
            kind = classify(text, options)
            if kind != "error" or INVALID.search(text):
                break
        screen = {"path": path, "code": code, "kind": kind, "text": text, "options": options}
        doc["screens"].append(screen)
        save()
        summary = text.replace("\n", " | ")[:110] if text else "(no dialog)"
        print(f"[{dials:2d}/{args.max_dials}] {code:<16} {kind:<7} {summary}", flush=True)
        texts[tuple(path)] = text
        # The network ignores a key it has no menu for and repeats the parent screen.
        repeats = bool(path) and texts.get(tuple(path[:-1])) == text
        if kind == "menu" and len(path) < MAX_DEPTH and not repeats:
            for option in options:
                if expandable(option):
                    queue.append([*path, option["key"]])

    counts = {}
    for s in doc["screens"]:
        counts[s["kind"]] = counts.get(s["kind"], 0) + 1
    print(f"{dials} dials, {len(doc['screens'])} screens, {len(queue)} paths left unvisited, {counts}")


if __name__ == "__main__":
    main()
