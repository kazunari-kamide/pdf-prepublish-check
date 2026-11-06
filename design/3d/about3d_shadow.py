# SPDX-License-Identifier: AGPL-3.0-only
#
# about の 3D の下に敷く「床の影だけ」の絵を書き出す（2026-11-06 本人が承認）。
# 物はカメラに写さず（visible_camera を切る）、影だけを床（影を受けるだけの面）に落とす。
# 物の所を後から抜く作り方だと、3D の物の縁に白い縁が出るため、物の下の影も本物のまま残す。
# 使い方: blender -b --factory-startup -P design/3d/about3d_shadow.py -- --out 出力.png [--width 2752 --height 1536 --samples 200]
import os
import runpy
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
arg = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
OUT = arg("--out", "shadow.png")
W, H, S = arg("--width", "2752"), arg("--height", "1536"), arg("--samples", "200")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.argv = [sys.argv[0], "--", "--no-render", "--out", OUT, "--width", W, "--height", H, "--samples", S]
runpy.run_path(os.path.join(HERE, "pdf_ref2.py"), run_name="__main__")
for ob in bpy.context.scene.objects:
    if ob.type in ("MESH", "CURVE", "FONT") and ob.name != "床":
        ob.visible_camera = False
bpy.context.scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"[shadow] 書き出し：{OUT}")
