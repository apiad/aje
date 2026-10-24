"""Reads every synthetic card with the app's own scanner code and vendored Tesseract.

    uv run --with playwright --with pillow python tools/ocr-check.py

Runs before a release, not in `make test`: it takes a few seconds per card.
"""

import base64
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def main():
    out = ROOT / "build" / "ocr-fixtures"
    subprocess.run([sys.executable, str(ROOT / "tools" / "gen-card-fixtures.py"), str(out)], check=True)
    cases = json.loads((out / "cases.json").read_text())
    # The static server that serves web/ lives in smoke-web.py.
    spec = importlib.util.spec_from_file_location("smoke", ROOT / "tools" / "smoke-web.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    base = mod.serve()
    failures = []
    with sync_playwright() as p:
        page = p.chromium.launch().new_page()
        page.goto(base + "/index.html")
        for c in cases:
            data = "data:image/png;base64," + base64.b64encode((out / c["file"]).read_bytes()).decode()
            got = page.evaluate("""async (src) => {
                const s = await import("/ui/scanner.js");
                const o = await import("/core/ocr.js");
                const img = new Image(); img.src = src; await img.decode();
                const text = await s.readText(s.numberBand(img, { x: 0, y: 0, w: img.width, h: img.height }));
                return { text, pan: o.panFromText(text) };
            }""", data)
            ok = got["pan"] == c["number"]
            print(f"{'ok  ' if ok else 'FAIL'} {c['file']} {c['number']} read {got['text'].strip()!r}")
            if not ok:
                failures.append(c["file"])
    print(f"{len(cases) - len(failures)}/{len(cases)} cards read")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
