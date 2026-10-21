"""Superseded 2026-10-21: the printed agreement is now built from the same terms as the
in-app signed one. Run `npm run build:paper-agreement` in apps/web instead.
letterhead.pdf here is still the source of apps/web/src/modules/hostels/agreement-letterhead.ts.

(Old: agreement.html -> Chrome PDF -> stamped onto letterhead.pdf -> ../hostel-register-agreement.pdf)"""
raise SystemExit("Superseded - run `npm run build:paper-agreement` in apps/web.")
import os, subprocess
import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BODY = os.path.join(HERE, "_body.pdf")
OUT = os.path.join(HERE, "..", "hostel-register-agreement.pdf")

subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=5000",
                f"--print-to-pdf={BODY}", "file:///" + os.path.join(HERE, "agreement.html").replace("\\", "/")],
               check=True, capture_output=True, timeout=120)

lh, body = pymupdf.open(os.path.join(HERE, "letterhead.pdf")), pymupdf.open(BODY)
doc = pymupdf.open()
for i in range(len(body)):
    page = doc.new_page(width=lh[0].rect.width, height=lh[0].rect.height)
    page.show_pdf_page(page.rect, lh, 0)
    page.show_pdf_page(page.rect, body, i)
doc.set_metadata({"title": "Hostel Registration & Service Agreement - Softmato", "author": "Softmato Technology Private Limited"})
doc.save(OUT, garbage=3, deflate=True)

# the clauses on each page must end above whatever comes next (page foot / signature block)
checks = {0: ("Owner’s initials", 742), 1: ("Owner’s Signature", 745)}
for i, (nxt, limit) in checks.items():
    blocks = body[i].get_text("blocks")
    stop = next(b for b in blocks if b[4].startswith(nxt))
    end = max(b[3] for b in blocks if b[1] < stop[1])
    print(f"page {i + 1}: clauses end at {end:.0f}pt (limit {limit})", "OVERFLOW" if end > limit else "ok")
for i, p in enumerate(doc):
    p.get_pixmap(dpi=110).save(os.path.join(HERE, f"_prev{i + 1}.png"))
assert len(doc) == 2, f"expected 2 pages, got {len(doc)}"
