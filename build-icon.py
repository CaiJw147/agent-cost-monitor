"""Rebuild the icon ladder properly, from the 512x512 source.

`npx tauri icon` produced a technically complete .ico (16/24/32/48/64/256) but with two
problems that both show up as blur in the taskbar, where only 32px is ever shown:

  1. every entry was stored as a PNG. Windows has supported PNG-in-ICO since Vista, but the
     convention every icon tool follows is DIB for the small sizes and PNG only for 256 —
     the shell paths that draw a taskbar button are the least forgiving about it;
  2. the small sizes come from one big downscale of a 512px image, and the detail that makes
     a dollar sign legible at 32px is exactly what a careless one-step reduction smears.

So this does both: an explicit halving ladder with LANCZOS (512 -> 256 -> 128 -> 64 -> 32 -> 16,
resampling only by factors of two), and DIB entries for every size below 256.
"""
import io
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
ICONS = ROOT / "src-tauri" / "icons"
PREVIEW = ROOT / "build" / "icon-ladder"
SIZES = [16, 24, 32, 48, 64, 128, 256]

source = Image.open(ROOT / "icon.png").convert("RGBA")
print(f"source {source.width}x{source.height}")


def ladder(image, target):
    """Halve while it stays above the target, then one final exact step."""
    current = image
    while current.width // 2 >= target and current.width % 2 == 0:
        current = current.resize((current.width // 2, current.height // 2), Image.Resampling.LANCZOS)
    if current.width != target:
        current = current.resize((target, target), Image.Resampling.LANCZOS)
    return current


def dib(im):
    """A 32bpp BMP entry: BITMAPINFOHEADER, XOR pixels bottom-up, then the AND mask."""
    w, h = im.size
    px = im.load()
    stride = ((w + 31) // 32) * 4
    header = struct.pack(
        "<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4 + stride * h, 0, 0, 0, 0
    )
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row
    return header + bytes(xor) + bytes(mask)


def png(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


PREVIEW.mkdir(parents=True, exist_ok=True)
images = {}
for size in SIZES:
    im = ladder(source, size)
    images[size] = im
    im.save(PREVIEW / f"{size}.png")

entries = [(size, dib(images[size]) if size < 256 else png(images[size])) for size in SIZES]
offset = 6 + 16 * len(entries)
directory = b""
blobs = b""
for size, blob in entries:
    directory += struct.pack(
        "<BBBBHHII", size if size < 256 else 0, size if size < 256 else 0, 0, 0, 1, 32, len(blob), offset + len(blobs)
    )
    blobs += blob
ico = struct.pack("<HHH", 0, 1, len(entries)) + directory + blobs
(ICONS / "icon.ico").write_bytes(ico)
print(f"wrote icon.ico  {len(ico)} bytes  {len(entries)} entries (DIB below 256, PNG at 256)")

# The PNG copies the bundle also carries, from the same ladder so they cannot disagree.
images[256].save(ICONS / "128x128@2x.png")
images[128].save(ICONS / "128x128.png")
images[64].save(ICONS / "64x64.png")
images[32].save(ICONS / "32x32.png")
images[256].save(ICONS / "icon.png")
print("rewrote 32/64/128/128@2x/icon.png from the same ladder")

# A 4x-magnified sheet of the size that actually matters, for eyeballing.
old = Image.open(ROOT / "build" / "icon-old-32.png").convert("RGBA") if (ROOT / "build" / "icon-old-32.png").exists() else None
new = images[32].resize((128, 128), Image.Resampling.NEAREST)
if old is not None:
    sheet = Image.new("RGBA", (272, 128), (24, 24, 26, 255))
    sheet.paste(old.resize((128, 128), Image.Resampling.NEAREST), (0, 0))
    sheet.paste(new, (144, 0))
    sheet.save(ROOT / "build" / "icon-compare.png")
    print("wrote build/icon-compare.png  (left: tauri icon's 32px, right: this ladder's)")
else:
    new.save(ROOT / "build" / "icon-new-32.png")
    print("wrote build/icon-new-32.png  (no old copy to compare against)")
