# SPDX-License-Identifier: AGPL-3.0-only
#
# 合成の見本：JPEG 2000（JPXDecode）の画像だけの 1 ページの PDF（スキャンした紙のつもり。字は入っていない）。
# 白い紙に、字の行のような灰色の帯を並べただけの架空の絵。実在の書類は使わない。
# 使い方（Pillow と、その JPEG 2000 の部品が要る）：python scripts/samples/make-jpx-scan.py
# 出力：scripts/samples/jpx-scan-synthetic.pdf（npm run check:browser の既定の見本の 1 つ）
#
# 大きさを A4 の 200dpi（1654×2339）にしているのは、PDF.js が画像を解くのに時間がかかるようにするため。
# 1 ページ目を描いている途中で、もう一度描く頼みが来たときに、絵が灰色のまま残らないかを確かめる（2026-11-07）。
import io
import random
from pathlib import Path

from PIL import Image, ImageDraw

W, H = 1654, 2339
rng = random.Random(20261107)
img = Image.new("L", (W, H), 250)
d = ImageDraw.Draw(img)
y = 180
while y < H - 200:
    x = 160
    while x < W - 160:
        w = rng.randint(30, 160)
        d.rectangle([x, y, min(x + w, W - 160), y + 26], fill=rng.randint(40, 90))
        x += w + rng.randint(14, 30)
    y += 58 + (40 if rng.random() < 0.12 else 0)
buf = io.BytesIO()
img.save(buf, "JPEG2000", quality_mode="rates", quality_layers=[40], irreversible=True)
jpx = buf.getvalue()

content = b"q 595 0 0 842 0 0 cm /Im0 Do Q\n"
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    b"<< /Length %d >>\nstream\n" % len(content) + content + b"endstream",
    b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode /Length %d >>\nstream\n"
    % (W, H, len(jpx))
    + jpx
    + b"\nendstream",
]
out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
offsets = []
for i, body in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offsets:
    out += b"%010d 00000 n \n" % o
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
Path(__file__).with_name("jpx-scan-synthetic.pdf").write_bytes(bytes(out))
print(len(out), "bytes")
