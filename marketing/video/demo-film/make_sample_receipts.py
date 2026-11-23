"""Sample payment receipts for the demo films and the user guide.

A made-up "Sample Wallet" (no real wallet's name or marks) with a SAMPLE · DEMO ONLY
stamp, laid out the way the claim parser reads a receipt (finance/evidencetext.go):
"Amount Paid: Rs …", "Transaction ID: …", "Paid to …", the bill's reference code in
Remarks. Run: python make_sample_receipts.py  → assets/samples/receipt-*.png
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "assets" / "samples"
FONTS = Path("C:/Windows/Fonts")
W, H = 1080, 1920

RECEIPTS = [
    # ch 35: the resident's own claim against his Poush bill (HIM-00FS-POU83).
    dict(file="receipt-resident-rent.png", amount="5,000.00", to="Himalaya Boys Hostel",
         by="Aarav Sherestha", txn="7KQ2M9X", when="2026-11-23 14:05",
         remarks="HIM-00FS-POU83 Poush rent", purpose="Rent payment"),
    # ch 17: the hostel's expense bill, shared into Expenses.
    dict(file="receipt-expense-grocery.png", amount="850.00", to="Khanal Kirana Store",
         by="Himalaya Boys Hostel", txn="R4T8WZ2", when="2026-11-22 09:20",
         remarks="Vegetables and eggs", purpose="Merchant payment"),
]


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def draw(r):
    """A wallet app's "Transaction details" screen, as a phone screenshot."""
    img = Image.new("RGB", (W, H), "#f4f6f8")
    d = ImageDraw.Draw(img)
    green, ink, muted, line = "#15803d", "#111827", "#6b7280", "#e5e7eb"
    # Status bar + app bar (made-up "Demo Pay": no real wallet's name or marks).
    d.rectangle([0, 0, W, 260], fill=green)
    d.text((48, 40), r["when"][-5:], font=font("segoeuib.ttf", 34), fill="white")
    d.text((W - 48, 40), "4G  86%", font=font("segoeuib.ttf", 30), fill="white", anchor="ra")
    d.line([(60, 170), (90, 140), (60, 170), (90, 200)], fill="white", width=8)
    d.text((140, 170), "Transaction Details", font=font("segoeuib.ttf", 44), fill="white", anchor="lm")
    d.text((W - 60, 170), "Demo Pay", font=font("segoeui.ttf", 34), fill="#bbf7d0", anchor="rm")

    d.rounded_rectangle([40, 300, W - 40, 1560], radius=28, fill="white")
    d.ellipse([W // 2 - 64, 350, W // 2 + 64, 478], fill="#dcfce7")
    d.line([(W // 2 - 30, 416), (W // 2 - 8, 440), (W // 2 + 34, 392)], fill=green, width=12)
    d.text((W // 2, 530), "Payment Successful", font=font("segoeuib.ttf", 42), fill=green, anchor="mm")
    d.text((W // 2, 640), f"NPR {r['amount']}", font=font("segoeuib.ttf", 88), fill=ink, anchor="mm")
    d.text((W // 2, 730), r["when"], font=font("segoeui.ttf", 34), fill=muted, anchor="mm")
    d.line([(90, 800), (W - 90, 800)], fill=line, width=2)

    rows = [("Transaction ID", r["txn"]), ("Amount Paid", f"Rs {r['amount']}"), ("Paid to", r["to"]),
            ("Paid by", r["by"]), ("Service", r["purpose"]), ("Remarks", r["remarks"]),
            ("Charge", "Rs 0.00"), ("Status", "Complete")]
    y = 850
    for label, value in rows:
        d.text((100, y), label, font=font("segoeui.ttf", 36), fill=muted)
        d.text((W - 100, y), value, font=font("segoeuib.ttf", 36), fill=ink, anchor="ra")
        y += 84
    d.line([(90, y), (W - 90, y)], fill=line, width=2)

    for x0, label, fill, fg in [(60, "Share", "white", green), (W // 2 + 20, "Download", green, "white")]:
        d.rounded_rectangle([x0, 1620, x0 + W // 2 - 80, 1730], radius=55, fill=fill, outline=green, width=4)
        d.text((x0 + (W // 2 - 80) // 2, 1675), label, font=font("segoeuib.ttf", 40), fill=fg, anchor="mm")
    d.text((W // 2, 1830), "Sample receipt for HostelPalika demos and guides · not a real payment",
           font=font("segoeui.ttf", 26), fill="#9ca3af", anchor="mm")

    # The stamp: diagonal and light, so the receipt still reads like a screenshot.
    stamp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(stamp).text((W // 2, H // 2), "SAMPLE · DEMO ONLY", font=font("segoeuib.ttf", 88),
                               fill=(220, 38, 38, 48), anchor="mm")
    img = Image.alpha_composite(img.convert("RGBA"), stamp.rotate(30, center=(W // 2, H // 2)))
    img.convert("RGB").save(OUT / r["file"])
    return OUT / r["file"]


if __name__ == "__main__":
    for r in RECEIPTS:
        print(draw(r))
