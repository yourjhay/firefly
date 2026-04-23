"""Compose the fireflies.io promotional poster."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG_PATH = Path("/Users/rj/.cursor/projects/Users-rj-web-maze-game/assets/fireflies_bg.png")
QR_PATH = Path("qr_code.png")
OUT_PATH = Path("fireflies_promo.png")

URL = "http://10.60.250.137:3000"
TITLE = "fireflies.io"
TAGLINE = "a multiplayer maze race"
CTA = "Scan to play  \u2022  same Wi-Fi"

TARGET_W, TARGET_H = 1600, 900  # 16:9 poster

def load_font(size, bold=False):
    candidates_bold = [
        "/System/Library/Fonts/Supplemental/Futura.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Avenir Next.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ]
    candidates = [
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Supplemental/Futura.ttc",
        "/System/Library/Fonts/Avenir Next.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in (candidates_bold if bold else candidates):
        try:
            if path.endswith(".ttc"):
                # index 2 is usually Bold for HelveticaNeue
                idx = 2 if bold else 0
                return ImageFont.truetype(path, size, index=idx)
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()

def draw_text_with_glow(base, xy, text, font, fill, glow=(255, 200, 80), glow_strength=6, glow_radius=12):
    glow_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow_layer)
    for _ in range(glow_strength):
        gdraw.text(xy, text, font=font, fill=glow + (160,))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(glow_radius))
    base.alpha_composite(glow_layer)
    ImageDraw.Draw(base).text(xy, text, font=font, fill=fill)

def main():
    bg = Image.open(BG_PATH).convert("RGBA")
    bg = bg.resize((TARGET_W, TARGET_H), Image.LANCZOS)

    # Darken bg slightly + vignette
    vignette = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    vd = ImageDraw.Draw(vignette)
    vd.rectangle([(0, 0), bg.size], fill=(0, 0, 0, 70))
    bg = Image.alpha_composite(bg, vignette)

    # Subtle left-side dark gradient for text readability
    grad = Image.new("RGBA", (TARGET_W, TARGET_H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for x in range(TARGET_W):
        t = 1 - (x / TARGET_W)
        alpha = int(170 * (t ** 1.6))
        gd.line([(x, 0), (x, TARGET_H)], fill=(5, 6, 18, alpha))
    bg.alpha_composite(grad)

    # ---- QR card on the right ----
    qr = Image.open(QR_PATH).convert("RGBA")
    QR_SIZE = 440
    qr = qr.resize((QR_SIZE, QR_SIZE), Image.NEAREST)

    card_pad = 32
    card_w = QR_SIZE + card_pad * 2
    card_h = QR_SIZE + card_pad * 2 + 70  # extra for URL text
    card_x = TARGET_W - card_w - 70
    card_y = (TARGET_H - card_h) // 2

    # Glow behind card
    glow = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.rounded_rectangle(
        [card_x - 20, card_y - 20, card_x + card_w + 20, card_y + card_h + 20],
        radius=40,
        fill=(255, 196, 80, 120),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(35))
    bg.alpha_composite(glow)

    card = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    cdraw = ImageDraw.Draw(card)
    cdraw.rounded_rectangle(
        [card_x, card_y, card_x + card_w, card_y + card_h],
        radius=28,
        fill=(255, 255, 255, 245),
    )
    # gold border
    cdraw.rounded_rectangle(
        [card_x, card_y, card_x + card_w, card_y + card_h],
        radius=28,
        outline=(247, 201, 72, 255),
        width=4,
    )
    bg.alpha_composite(card)

    bg.alpha_composite(qr, (card_x + card_pad, card_y + card_pad))

    # URL under QR
    url_font = load_font(26, bold=True)
    draw = ImageDraw.Draw(bg)
    url_w = draw.textlength(URL, font=url_font)
    draw.text(
        (card_x + (card_w - url_w) / 2, card_y + card_pad + QR_SIZE + 18),
        URL,
        font=url_font,
        fill=(20, 22, 44, 255),
    )

    # ---- Left side text ----
    title_font = load_font(150, bold=True)
    tag_font = load_font(44, bold=False)
    cta_font = load_font(30, bold=True)
    small_font = load_font(24, bold=False)

    left_x = 90
    # Title with warm glow
    draw_text_with_glow(
        bg,
        (left_x, 260),
        TITLE,
        title_font,
        fill=(255, 238, 180, 255),
        glow=(255, 190, 70),
        glow_strength=8,
        glow_radius=18,
    )

    # Underline accent
    accent = ImageDraw.Draw(bg)
    accent.rectangle([left_x, 430, left_x + 180, 438], fill=(247, 201, 72, 255))

    # Tagline
    accent.text(
        (left_x, 460),
        TAGLINE,
        font=tag_font,
        fill=(230, 232, 255, 255),
    )

    # Bullet feature list
    features = [
        "\u2022  Race through a fresh maze every round",
        "\u2022  First to the golden tile wins",
        "\u2022  Play on any device, no install",
    ]
    for i, line in enumerate(features):
        accent.text(
            (left_x, 540 + i * 40),
            line,
            font=small_font,
            fill=(200, 210, 240, 255),
        )

    # CTA
    accent.text(
        (left_x, 720),
        CTA,
        font=cta_font,
        fill=(255, 214, 120, 255),
    )

    bg.convert("RGB").save(OUT_PATH, "PNG", optimize=True)
    print(f"Saved {OUT_PATH} ({bg.size[0]}x{bg.size[1]})")

if __name__ == "__main__":
    main()
