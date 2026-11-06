# SPDX-License-Identifier: AGPL-3.0-only
#
# about の最初の画面の 3D（q47 の場面）を、three.js で描くための小さな形に書き出す（2026-11-06 本人が承認）。
# - pdf_ref2.py で場面を組み、変形を当てた形を取り出し、物ごとに面を減らし（Decimate）、1 つにまとめる。
# - 光と陰（柔らかい面の光・空の光・物どうしの影）を、Cycles で頂点の色に焼き込む（three.js では光の計算をしない）。
# - 位置はカメラから見た座標（遠近のない見下ろし。x 右・y 上・z 手前）にして 16 ビットに、色は表示用の 8 ビットに。
# - 三角の番号は差分にして、全体を raw deflate で縮め、base64 で JS の中に入れる（外のファイル・読み込みの仕組みを使わない）。
#
# 使い方（作業フォルダで）:
#   blender -b --factory-startup -P design/3d/export_about3d.py -- --out src/site/about-3d-data.js [--samples 64] [--scale 1.0]
# --scale は面を減らす割合を全体に掛ける（大きいほど面が多い）。

import bpy
import bmesh
import base64
import math
import os
import runpy
import struct
import sys
import zlib
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


OUT = arg("--out", "src/site/about-3d-data.js")
SAMPLES = int(arg("--samples", "64"))
SCALE = float(arg("--scale", "1.0"))
HERE = os.path.dirname(os.path.abspath(__file__))

# 場面を組む（書き出しはしない）
sys.argv = [sys.argv[0], "--", "--no-render", "--out", os.path.join(HERE, "_unused.png"), "--width", "1920", "--height", "1080"]
runpy.run_path(os.path.join(HERE, "pdf_ref2.py"), run_name="__main__")
scene = bpy.context.scene
cam = scene.camera
dg = bpy.context.evaluated_depsgraph_get()


def keep_ratio(name, n):
    """物ごとに、面を残す割合（帯はなめらかなので大きく減らす。字は形が崩れやすいので控えめ）"""
    if n < 80 or "錠の胴" in name:  # 鍵穴をくり抜いた錠の胴は減らさない（平らな面がゆがみ、陰が放射状の縞になる）
        return 1.0
    if name in ("紺の帯", "黒い帯", "下の黒い帯"):
        r = 0.05  # 2.2% では曲がった所が角ばった
    elif name.startswith("字:"):
        r = 0.4  # 字は先に平らな面をまとめ、三角に分けてから減らす（画面で 1 字 約 25px）
    elif name.startswith("星"):
        r = 0.12
    elif name.startswith("札の板"):
        r = 0.25
    else:
        r = 0.2
    return max(80 / n, min(1.0, r * SCALE))


# 変形を当てた形を、世界の座標の新しい物にする
parts = []
for ob in list(scene.objects):
    if ob.type != "MESH" or ob.hide_render or ob.name == "床":
        continue
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=False, depsgraph=dg)
    me.transform(ob.matrix_world)
    nob = bpy.data.objects.new("出:" + ob.name, me)
    scene.collection.objects.link(nob)
    if ob.name.startswith("字:"):  # 押し出した字は平らな面ばかり：同じ面の三角をまとめる（形は崩れない）
        dp = nob.modifiers.new("平らな面をまとめる", "DECIMATE")
        dp.decimate_type = "DISSOLVE"
        dp.angle_limit = math.radians(2)
        nob.modifiers.new("三角に分ける", "TRIANGULATE")
    r = keep_ratio(ob.name, len(me.vertices))
    if r < 1.0:
        dm = nob.modifiers.new("面を減らす", "DECIMATE")
        dm.ratio = r
        dm.use_collapse_triangulate = True
    parts.append(nob)
    ob.hide_render = True
for ob in scene.objects:
    if ob.name == "床":
        ob.hide_render = True

# 減らした形を当てて、1 つにまとめる
bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.convert(target="MESH")
_c = sorted(((len(p.data.vertices), p.name) for p in parts), reverse=True)
_g = {}
for n_, nm in _c:
    k_ = "字" if nm.startswith("出:字:") else "帯" if "帯" in nm else "星" if nm.startswith("出:星") else "札の板" if "札の板" in nm else "そのほか"
    _g[k_] = _g.get(k_, 0) + n_
print("[about3d] 減らしたあとの頂点", _g, "多い順", _c[:8])
bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = "about3d"
me = body.data
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.triangulate(bm, faces=bm.faces)
# 頂点の色は頂点の所でしか焼けない。大きな平らな面（紙・層・札・消しゴム）は縁の頂点しかなく、面の中が縁の暗い色で塗られる。
# 長い辺を分けて、面の中にも頂点を置く（MAXE より長い辺がなくなるまで、最大 6 回）
MAXE = float(arg("--max-edge", "0"))  # 0 なら分けない（色だけを焼くときは要らない）
for _ in range(6 if MAXE > 0 else 0):
    long_ = [e for e in bm.edges if e.calc_length() > MAXE]
    if not long_:
        break
    bmesh.ops.subdivide_edges(bm, edges=long_, cuts=1, use_grid_fill=False)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
# 角の立った所（50° より急）は頂点を分ける（three.js で法線を作ったときに、陰が角でにじまないように）
sharp = [e for e in bm.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(50)]
bmesh.ops.split_edges(bm, edges=sharp)
bm.to_mesh(me)
bm.free()
for p in me.polygons:
    p.use_smooth = True

# 光と陰を頂点の色に焼く（拡散の光の直接・間接と、物の色）
attr = me.color_attributes.new("焼いた色", "FLOAT_COLOR", "POINT")
me.color_attributes.active_color = attr
scene.render.engine = "CYCLES"
scene.cycles.samples = SAMPLES
scene.cycles.device = "CPU"
bk = scene.render.bake
bk.target = "VERTEX_COLORS"
# 物の色だけを焼く（光と陰は three.js で付ける。陰まで焼くと、頂点がまばらな所で暗い色が広くにじむため）
bk.use_pass_direct = False
bk.use_pass_indirect = False
bk.use_pass_color = True
bk.margin = 0
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.bake(type="DIFFUSE")

# カメラから見た座標へ
inv = cam.matrix_world.inverted()
exposure = 2 ** scene.view_settings.exposure


def srgb(v):
    v = max(0.0, min(1.0, v))
    return v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


pos = [inv @ v.co for v in me.vertices]
_m = [sum(c.color[ch] for c in attr.data) / max(1, len(attr.data)) for ch in range(3)]
print(f"[about3d] 焼いた色の平均（直線の値） {[round(x, 3) for x in _m]}")
cols = attr.data
lo = [min(p[i] for p in pos) for i in range(3)]
hi = [max(p[i] for p in pos) for i in range(3)]
span = [max(1e-6, hi[i] - lo[i]) for i in range(3)]
nv = len(pos)
buf = bytearray()
for i in range(3):  # 位置：x 全部、y 全部、z 全部の順（縮めやすい）
    buf += struct.pack(f"<{nv}H", *[round((p[i] - lo[i]) / span[i] * 65535) for p in pos])
for ch in range(3):  # 色：r 全部、g 全部、b 全部
    buf += bytes(round(srgb(c.color[ch]) * 255) for c in cols)
idx = [v for p in me.polygons for v in p.vertices]
prev = 0
deltas = []
for v in idx:  # 三角の番号は前との差（zigzag）を 32 ビットで
    d = v - prev
    prev = v
    deltas.append((d << 1) ^ (d >> 31) if d >= 0 else ((-d) << 1) - 1)
buf += struct.pack(f"<{len(deltas)}I", *deltas)
co = zlib.compressobj(9, zlib.DEFLATED, -15)
packed = co.compress(bytes(buf)) + co.flush()

key = next(o for o in scene.objects if o.type == "LIGHT")
kd = (inv.to_3x3() @ (key.matrix_world.to_3x3() @ Vector((0, 0, 1)))).normalized()  # 光の来る向き（カメラから見た座標）
up = (inv.to_3x3() @ Vector((0, 0, 1))).normalized()  # 空（上）の向き
ortho = cam.data.ortho_scale
aspect = scene.render.resolution_y / scene.render.resolution_x
js = "\n".join([
    "// SPDX-License-Identifier: AGPL-3.0-only",
    "//",
    "// about の最初の画面の 3D の形（q47）。design/3d/export_about3d.py で作ったもの。直接書き換えない。",
    "// 位置はカメラから見た座標を 16 ビットに、色は物の色（sRGB の 8 ビット。光と陰は three.js で付ける）。三角の番号は差分。全体を raw deflate で縮めて base64。",
    f"export const META = {{ vertices: {nv}, triangles: {len(idx) // 3}, lo: {[round(x, 5) for x in lo]}, span: {[round(x, 5) for x in span]}, halfWidth: {round(ortho / 2, 5)}, aspect: {round(aspect, 5)}, key: {[round(x, 4) for x in kd]}, up: {[round(x, 4) for x in up]}, exposure: {round(exposure, 4)} }};",
    f'export const DATA = "{base64.b64encode(packed).decode()}";',
    "",
])
open(os.path.join(os.getcwd(), OUT) if not os.path.isabs(OUT) else OUT, "w", encoding="utf-8", newline="\n").write(js)
print(f"[about3d] 頂点 {nv}、三角 {len(idx) // 3}、元 {len(buf)} バイト、縮めて {len(packed)} バイト、base64 {len(js)} バイト → {OUT}")
