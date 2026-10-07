"""Builds the launch-screen art: the logo lockup and the "Powered by" strip.

Run from `apps/mobile`:  python scripts/gen_splash.py

1. `assets/images/splash-logo.png` — HP mark over the HostelPalika wordmark, on
   a transparent canvas cropped to the lockup with equal top and bottom padding.
   Whatever centres this image (the native splash, or `BrandSplash`) centres the
   *lockup*, so the mark sits just above the optical centre with the name under
   it. Android 12+ draws it inside a 288dp icon and masks everything outside a
   192dp circle, so every ink corner is kept inside a 90dp radius at the
   280dp it is designed at — and further inside at the 210dp app.json draws.

2. `assets/images/splash-branding.png` + `plugins/splash-branding-res/drawable-*`
   — "Powered by" and Softmato's logo as one 136x55dp image. The system splash
   never draws it (it varied by phone); on Android the native launch screen in
   `modules/hostelhub-boot-splash` does, and `BrandSplash` draws the same image
   at the same size and inset everywhere else.

After editing this, run it and copy the `LOGO_HEIGHT` ratio it prints into
`src/components/brand-splash.tsx`.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "assets" / "images"

# ---- Logo lockup -----------------------------------------------------------
CANVAS_W = 1024
IMAGE_WIDTH_DP = 280  # the lockup is designed at 280dp; app.json `imageWidth` draws it at 210 (75%)
PX_PER_DP = CANVAS_W / IMAGE_WIDTH_DP
MARK_DP = 128  # mark ink width
WORDMARK_DP = 136  # wordmark ink width
GAP_DP = 14
PAD_DP = 12
MASK_RADIUS_DP = 90  # Android 12 masks at 96dp; 6dp of slack


def ink(path):
    im = Image.open(path).convert("RGBA")
    return im.crop(im.getbbox())


def fit_width(im, width):
    return im.resize((round(width), round(width * im.height / im.width)), Image.LANCZOS)


mark = fit_width(ink(IMAGES / "logo-mark.png"), MARK_DP * PX_PER_DP)
wordmark = fit_width(ink(IMAGES / "wordmark.png"), WORDMARK_DP * PX_PER_DP)
gap, pad = round(GAP_DP * PX_PER_DP), round(PAD_DP * PX_PER_DP)

canvas_h = pad + mark.height + gap + wordmark.height + pad
logo = Image.new("RGBA", (CANVAS_W, canvas_h), (0, 0, 0, 0))
logo.alpha_composite(mark, ((CANVAS_W - mark.width) // 2, pad))
logo.alpha_composite(wordmark, ((CANVAS_W - wordmark.width) // 2, pad + mark.height + gap))
logo.save(IMAGES / "splash-logo.png")

half_h = (canvas_h / 2 - pad) / PX_PER_DP
corner = max(
    math.hypot(MARK_DP / 2, half_h),
    math.hypot(WORDMARK_DP / 2, half_h),
)
assert corner <= MASK_RADIUS_DP, f"lockup corner at {corner:.1f}dp would be masked"

# ---- Powered-by strip ------------------------------------------------------
STRIP_DP = (136, 55)
MASTER_SCALE = 8
SW, SH = STRIP_DP[0] * MASTER_SCALE, STRIP_DP[1] * MASTER_SCALE
TEXT = "Powered by"
TEXT_COLOR = (28, 25, 23, 255)  # palette.light.foreground
FONT = "C:/Windows/Fonts/georgiaz.ttf"  # bold italic, so it reads at 55dp
FONT_SIZE = 80
STRIP_GAP = 22

softmato = ink(IMAGES / "powered-by-softmato.png")
softmato = softmato.resize(
    (round(softmato.width * (SH - 24) / softmato.height), SH - 24), Image.LANCZOS
)
font = ImageFont.truetype(FONT, FONT_SIZE)
tx0, ty0, tx1, ty1 = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), TEXT, font=font)
text_w, text_h = tx1 - tx0, ty1 - ty0

total_w = text_w + STRIP_GAP + softmato.width
assert total_w <= SW, f"strip content {total_w}px overflows {SW}px"
x = (SW - total_w) // 2

strip = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
ImageDraw.Draw(strip).text((x - tx0, (SH - text_h) // 2 - ty0), TEXT, fill=TEXT_COLOR, font=font)
strip.alpha_composite(softmato, (x + text_w + STRIP_GAP, (SH - softmato.height) // 2))

strip.resize((STRIP_DP[0] * 4, STRIP_DP[1] * 4), Image.LANCZOS).save(IMAGES / "splash-branding.png")

BUCKETS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for bucket, scale in BUCKETS.items():
    out = ROOT / "plugins" / "splash-branding-res" / f"drawable-{bucket}"
    out.mkdir(parents=True, exist_ok=True)
    size = (round(STRIP_DP[0] * scale), round(STRIP_DP[1] * scale))
    strip.resize(size, Image.LANCZOS).save(out / "splashscreen_branding.png")

print(f"Done | logo {CANVAS_W}x{canvas_h} (LOGO_HEIGHT = {canvas_h} / {CANVAS_W}) | corner {corner:.1f}dp")
