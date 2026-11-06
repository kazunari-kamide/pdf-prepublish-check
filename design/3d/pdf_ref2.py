# SPDX-License-Identifier: AGPL-3.0-only
#
# ref2（本人が作ったイメージ）を下敷きにした飾りの絵（3 枚重ねの台に PDF の紙、墨消しの帯、まわりに文房具と字の札。遠近のない見下ろし）を、Blender で一から組み立てて、Cycles で書き出す。
# 形・材質・光・カメラは、すべてこのスクリプトで作る（外のモデル・画像は使わない）。字（「PDF」と札の字）は、同梱の書体 Zen Maru Gothic を立体にする。
# 地は透明で書き出し、床には影だけを写す。地の色（大きな色の面）は、書き出したあとに敷く（光のむらでグラデーションにしないため）。
#
#   blender -b --factory-startup -P design/3d/pdf_ref2.py -- --out .tmp/3d-blender/ref2.png --width 1600 --height 900 --samples 128
#
# 引数（-- のあと）
#   --out      書き出す PNG の場所
#   --width / --height   画素の数
#   --samples  光の計算の回数（少ないほど速い。ノイズは消す処理で落とす）
#   --wide     写す横の広さ（正投影のカメラの広さ。場面の単位。既定 8.4）
#   --elev     見下ろす角度（度。既定 40）
#   --cpu      GPU を使わない
#   --font     「PDF」の字の書体のファイル（既定は同梱の Zen Maru Gothic Black）

import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def arg(name, default):
    if name in argv:
        return argv[argv.index(name) + 1]
    return default


OUT = arg("--out", "//ref2.png")
WIDTH = int(arg("--width", "1600"))
HEIGHT = int(arg("--height", "900"))
SAMPLES = int(arg("--samples", "128"))
WIDE = float(arg("--wide", "8.46"))
ELEV = float(arg("--elev", "39"))
USE_CPU = "--cpu" in argv
import os

FONT = arg("--font", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts", "source", "zen-maru-gothic", "ZenMaruGothic-Black.ttf"))  # 「PDF」の字の書体（OFL。リポジトリに同梱するもの）

# ── 色（案 C に合わせたやわらかい色。墨と紅はアクセント。sRGB の 16 進） ──
HEX = {
    "white": "#ffffff",
    "paper_tint": "#e6e6f0",
    "row": "#a99fdc",
    "navy": "#3b3f73",
    "charcoal": "#29282e",
    "ink": "#4a4a55",
    "coral": "#f48b86",
    "coral_light": "#f9b8b4",
    "red": "#ea5a5e",
    "mint": "#8adcb8",
    "teal": "#4fbf9c",
    "lilac": "#dcbcea",
    "lilac_deep": "#a493e2",
    "blue": "#8ec2f0",
    "axis_blue": "#7d90e2",
    "pink": "#f49ab4",
    "yellow": "#eeb14a",
    "gold": "#f2b866",
    "peach": "#f7caa6",
    "cream": "#f7e3c8",
    "gray": "#bcb8cc",
    "conf_lilac_deep": "#b09ed8",
    "conf_coral": "#df8a8f",
    "conf_blue": "#8ab8d4",
    "conf_mint": "#8ed4b2",
    "dot_yellow": "#ecd27e",
    "coral_dark": "#a9504d",
    "text_gray": "#3c3c40",
    "eraser_coral": "#ef8f93",
    "periwinkle": "#868ad9",
    "bristle": "#efcaa8",
    "brush_ink": "#76747d",
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgba(name):
    h = HEX[name].lstrip("#")
    return tuple(srgb_to_linear(int(h[i : i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection


def material(name, color, rough=0.5, coat=0.0, sheen=0.0, metal=0.0, sss=0.0, transmission=0.0, ior=1.45):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = rgba(color) if isinstance(color, str) else color
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = 0.3
    p.inputs["Sheen Weight"].default_value = sheen
    p.inputs["Sheen Roughness"].default_value = 0.4
    p.inputs["Subsurface Weight"].default_value = sss
    p.inputs["Transmission Weight"].default_value = transmission
    p.inputs["IOR"].default_value = ior
    return m


def toy(name, color):
    """つやを抑えた樹脂（おもちゃの質感）"""
    return material(name, color, rough=0.42, coat=0.35)  # つやを少し（参考の質に寄せる）


M = {"paper": material("紙", "paper_tint", rough=0.55, sss=0.02)}
for k in HEX:
    if k not in M:
        M[k] = material(k, k, rough=0.35, coat=float(arg("--coat", "0.15")))  # ref2 のような少しつやのある樹脂
M["text_gray"] = material("札の字", "text_gray", rough=0.85, coat=0.0)  # 札の字はつや消し（光の照り返しでにじまないように）
M["ink_drop"] = material("墨だまり", "charcoal", rough=0.55, coat=0.1)
for _k in ("white", "yellow", "lilac_deep"):
    M["dot_" + _k] = material("粒" + _k, "dot_yellow" if _k == "yellow" else _k, rough=0.4, coat=0.4)  # 墨は、つやを控えめに

# ── 形の道具 ───────────────────────────────────────
def new_obj(name, me, mat=None, parent=None):
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    if mat:
        ob.data.materials.append(mat)
    if parent:
        ob.parent = parent
    return ob


def smooth(ob):
    for p in ob.data.polygons:
        p.use_smooth = True


def bevel(ob, width, segments=4, angle=40):
    b = ob.modifiers.new("角を丸める", "BEVEL")
    b.width = width
    b.segments = segments
    b.limit_method = "ANGLE"
    b.angle_limit = math.radians(angle)
    b.harden_normals = True
    smooth(ob)
    return b


def subsurf(ob, level=2):
    s = ob.modifiers.new("なめらかに", "SUBSURF")
    s.levels = level
    s.render_levels = level
    smooth(ob)


def outline_prism(name, pts, depth, mat, parent=None):
    """XZ 面の輪郭 pts を、-Y の向きへ depth だけ押し出した板（表は -Y を向く）"""
    bm = bmesh.new()
    vs = [bm.verts.new((x, 0.0, z)) for x, z in pts]
    f = bm.faces.new(vs)
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    moved = [e for e in r["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=moved, vec=(0, -depth, 0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return new_obj(name, me, mat, parent)


def rounded_box(name, size, radius, mat, parent=None, segments=5):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    ob = new_obj(name, me, mat, parent)
    ob.scale = size
    bpy.context.view_layer.update()
    # 大きさを形に焼き込んでから丸める（丸みが縦横で同じになるように）
    me.transform(ob.matrix_basis.copy().to_3x3().to_4x4())
    ob.scale = (1, 1, 1)
    bevel(ob, radius, segments)
    return ob


def capsule(name, length, radius, mat, parent=None):
    """長さ length・太さ radius の、両端の丸い棒（X の向き）"""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=radius)
    for v in bm.verts:
        if v.co.x > 0:
            v.co.x += length / 2
        elif v.co.x < 0:
            v.co.x -= length / 2
    bm.to_mesh(me)
    bm.free()
    ob = new_obj(name, me, mat, parent)
    smooth(ob)
    return ob


def torus(name, major, minor, mat, parent=None, seg=64, rings=20):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    for i in range(seg):
        a = 2 * math.pi * i / seg
        for j in range(rings):
            b = 2 * math.pi * j / rings
            r = major + minor * math.cos(b)
            bm.verts.new((r * math.cos(a), r * math.sin(a), minor * math.sin(b)))
    bm.verts.ensure_lookup_table()
    for i in range(seg):
        for j in range(rings):
            a = i * rings + j
            b = ((i + 1) % seg) * rings + j
            c = ((i + 1) % seg) * rings + (j + 1) % rings
            d = i * rings + (j + 1) % rings
            bm.faces.new([bm.verts[a], bm.verts[b], bm.verts[c], bm.verts[d]])
    bm.to_mesh(me)
    bm.free()
    ob = new_obj(name, me, mat, parent)
    smooth(ob)
    return ob


def cylinder(name, radius, depth, mat, parent=None, verts=64):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=radius, radius2=radius, depth=depth)
    bm.to_mesh(me)
    bm.free()
    return new_obj(name, me, mat, parent)


def empty(name, parent=None):
    e = bpy.data.objects.new(name, None)
    col.objects.link(e)
    if parent:
        e.parent = parent
    return e


def mesh_sphere(name, r, mat, parent):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r)
    bm.to_mesh(me)
    bm.free()
    ob = new_obj(name, me, mat, parent)
    smooth(ob)
    return ob


def flat_prism(name, pts, depth, mat, parent=None):
    """XY 面の輪郭 pts を、上（+Z）へ depth だけ押し出した板（上の面の高さ = depth）"""
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, 0.0)) for x, y in pts]
    f = bm.faces.new(vs)
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    moved = [e for e in r["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=moved, vec=(0, 0, depth))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return new_obj(name, me, mat, parent)


def bar_flat(name, x0, x1, y, h, z, mat, parent, thick=0.022):
    r = rounded_box(name, (x1 - x0, h, thick), min(h, 0.06) / 2 - 0.002, mat, parent, 4)
    r.location = ((x0 + x1) / 2, y, z + thick / 2)
    return r




# ── 小物（どれも角を大きく丸め、つやを抑えた樹脂） ────────────────
def prism_xy(name, pts, depth, mat, parent=None, bev=0.02, seg=4):
    ob = flat_prism(name, pts, depth, mat, parent)
    bevel(ob, bev, seg, 50)
    return ob


def star(name, r_out, r_in, depth, mat, parent=None):
    pts = []
    for i in range(10):
        a = math.pi / 2 + i * math.pi / 5
        r = r_out if i % 2 == 0 else r_in
        pts.append((r * math.cos(a), r * math.sin(a)))
    return prism_xy(name, pts, depth, mat, parent, bev=depth * 0.42, seg=5)


def check_mark(name, size, depth, mat, parent=None):
    k = size
    pts = [(-0.55 * k, 0.15 * k), (-0.15 * k, -0.35 * k), (0.55 * k, 0.45 * k), (0.38 * k, 0.6 * k), (-0.15 * k, 0.02 * k), (-0.4 * k, 0.3 * k)]
    return prism_xy(name, pts, depth, mat, parent, bev=depth * 0.42, seg=5)


def stamp(parent, base_mat, knob_mat):
    g = empty("スタンプ", parent)
    pad = rounded_box("スタンプの面", (0.5, 0.34, 0.05), 0.02, M["ink"], g, 3)
    pad.location.z = 0.025
    base = rounded_box("スタンプの台", (0.54, 0.38, 0.16), 0.06, base_mat, g, 6)
    base.location.z = 0.05 + 0.08
    neck = cylinder("スタンプの首", 0.095, 0.16, knob_mat, g, 40)
    bevel(neck, 0.02, 3)
    neck.location.z = 0.21 + 0.08
    knob = mesh_sphere("スタンプのつまみ", 0.14, knob_mat, g)
    knob.location.z = 0.44
    knob.scale = (1, 1, 1.15)
    return g


def eraser(parent, body_mat, sleeve_mat):
    g = empty("消しゴム", parent)
    body = rounded_box("消しゴム", (0.6, 0.32, 0.17), 0.06, body_mat, g, 6)
    body.location.z = 0.085
    sleeve = rounded_box("消しゴムの紙", (0.38, 0.335, 0.18), 0.04, sleeve_mat, g, 5)
    sleeve.location = (0.12, 0, 0.09)
    return g


def marker(parent, body_mat, cap_mat):
    g = empty("マーカー", parent)
    r = 0.085
    body = capsule("マーカーの胴", 0.62, r, body_mat, g)
    body.location = (0, 0, r)
    cap = capsule("マーカーのふた", 0.26, r * 1.07, cap_mat, g)
    cap.location = (0.36, 0, r)
    ring = torus("マーカーの帯", r * 0.98, 0.014, cap_mat, g, 48, 10)
    ring.location = (-0.2, 0, r)
    ring.rotation_euler = (0, math.radians(90), 0)
    end = bpy.data.meshes.new("マーカーの先")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=r * 0.8, radius2=r * 0.25, depth=0.16)
    bm.to_mesh(end)
    bm.free()
    tip = new_obj("マーカーの先", end, cap_mat, g)
    tip.location = (-0.38, 0, r)
    tip.rotation_euler = (0, math.radians(-90), 0)
    bevel(tip, 0.015, 3)
    step = cylinder("マーカーの段", r * 1.12, 0.03, cap_mat, g, 48)
    bevel(step, 0.01, 2)
    step.location = (0.22, 0, r)
    step.rotation_euler = (0, math.radians(90), 0)
    return g


def ink_bottle(parent, glass_mat, cap_mat, label_mat):
    g = empty("インクの瓶", parent)
    body = rounded_box("瓶", (0.34, 0.34, 0.3), 0.09, glass_mat, g, 6)
    body.location.z = 0.15
    label = rounded_box("瓶のラベル", (0.25, 0.02, 0.15), 0.01, label_mat, g, 3)
    label.location = (0, -0.172, 0.14)
    shoulder = cylinder("瓶の肩", 0.1, 0.05, glass_mat, g, 48)
    bevel(shoulder, 0.02, 3)
    shoulder.location.z = 0.31
    neck = cylinder("瓶の首", 0.065, 0.08, glass_mat, g, 48)
    bevel(neck, 0.02, 3)
    neck.location.z = 0.36
    cap = cylinder("瓶のふた", 0.085, 0.09, cap_mat, g, 48)
    bevel(cap, 0.03, 5)
    cap.location.z = 0.43
    return g


def sticky_pad(parent, mats):
    g = empty("付箋", parent)
    for i, m in enumerate(mats):
        p = rounded_box(f"付箋{i}", (0.46, 0.46, 0.022), 0.03, m, g, 3)
        p.location = (i * 0.03, -i * 0.02, 0.011 + i * 0.024)
        p.rotation_euler = (0, 0, math.radians(i * 7))
    return g


def confetti(name, w, h, mat, parent, x, y, z, rot):
    c = rounded_box(name, (w, h, 0.014), 0.005, mat, parent, 2)
    c.location = (x, y, z)
    c.rotation_euler = rot
    return c


def loupe_toy(parent, ring_mat, handle_mat):
    g = empty("虫めがね", parent)
    ring = torus("輪", 0.26, 0.06, ring_mat, g, 72, 24)
    glass = cylinder("玉", 0.25, 0.03, M["lens"], g)
    bevel(glass, 0.012, 3)
    shine = capsule("玉のつや", 0.09, 0.016, M["white_toy"], g)
    shine.location = (-0.08, 0.08, 0.02)
    shine.rotation_euler = (0, 0, math.radians(45))
    for name, length, rad, dist, m in (("首", 0.1, 0.07, 0.34, ring_mat), ("柄", 0.4, 0.08, 0.6, handle_mat)):
        c = capsule(name, length, rad, m, g)
        c.location = (dist * math.cos(math.radians(-40)), dist * math.sin(math.radians(-40)), 0)
        c.rotation_euler = (0, 0, math.radians(-40))
    return g


# ── ref2 を下敷きにした場面 ────────────────────────────
# 3 枚重ねの台（薄紫・緑）の上に大きな PDF の紙。上に紅の帯と白い立体の「PDF」、中に棒グラフ・円グラフ・面グラフ・行。
# 黒・墨・紺の墨消しの帯を紙にかけ、2 本は端を台の外へ垂らす。帯に南京錠と目の札。
# まわりに刷毛と墨のしずく、南京錠と鍵、消しゴム、マーカー 2 本、スタンプ、✓ の吹き出し、字の札、星・紙吹雪・粒。


FONT_BOLD = os.path.join(os.path.dirname(FONT), "ZenMaruGothic-Bold.ttf")  # 一段細い太さ（印鑑の札。本人の指示）


def text3d(body, size, mat, parent=None, extrude=0.04, bev=0.02, spacing=1.0, font=None):
    cu = bpy.data.curves.new("字", "FONT")
    cu.body = body
    cu.font = bpy.data.fonts.load(font or FONT)
    cu.size = size
    cu.space_character = spacing
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = extrude
    cjk = any(ord(ch) > 127 for ch in body)
    cu.bevel_depth = 0.0 if cjk else bev  # 漢字は字の形の線が重なっているので、面取りで面が崩れる。押し出しだけにする
    cu.bevel_resolution = 3
    cu.offset = 0.0 if cjk else -bev * 0.35
    cu.materials.append(mat)
    ob = bpy.data.objects.new("字:" + body, cu)
    col.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    ob.select_set(False)
    if parent:
        ob.parent = parent
    return ob


def rrect(w, h, r, n=8, cx=0.0, cy=0.0):
    """角の丸い長方形の輪郭（XY）"""
    pts = []
    for qx, qy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        ccx, ccy = cx + qx * (w / 2 - r), cy + qy * (h / 2 - r)
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((ccx + r * math.cos(a), ccy + r * math.sin(a)))
    return pts


def arc_tube(name, radius, minor, a0, a1, mat, parent=None, seg=40, rings=14):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    for i in range(seg + 1):
        a = a0 + (a1 - a0) * i / seg
        for j in range(rings):
            b = 2 * math.pi * j / rings
            rr = radius + minor * math.cos(b)
            bm.verts.new((rr * math.cos(a), rr * math.sin(a), minor * math.sin(b)))
    bm.verts.ensure_lookup_table()
    for i in range(seg):
        for j in range(rings):
            q = [i * rings + j, (i + 1) * rings + j, (i + 1) * rings + (j + 1) % rings, i * rings + (j + 1) % rings]
            bm.faces.new([bm.verts[k] for k in q])
    for a in (a0, a1):
        bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=8, radius=minor, matrix=Matrix.Translation((radius * math.cos(a), radius * math.sin(a), 0)))
    bm.to_mesh(me)
    bm.free()
    ob = new_obj(name, me, mat, parent)
    smooth(ob)
    return ob


def carve(body, cutters, mat):
    """鍵穴を彫る：部品の形で body をくり抜く（部品は書き出さない）。くり抜いた面は mat の色に"""
    body.data.materials.append(mat)
    for c_ in cutters:
        c_.hide_render = True
        c_.display_type = "WIRE"
        bo = body.modifiers.new("鍵穴を彫る", "BOOLEAN")
        bo.object = c_
        bo.operation = "DIFFERENCE"
        bo.material_mode = "TRANSFER"
        body.modifiers.move(len(body.modifiers) - 1, 0)  # 角を丸める前にくり抜く（後だと鍵穴のそばに暗いくさびが出る）


HEX["keyhole_gold"] = "#9a5a38"
M["keyhole_gold"] = material("鍵穴の暗い橙", "keyhole_gold", rough=0.6)


def padlock(parent, body_mat, shackle_mat, s=1.0):
    g = empty("南京錠", parent)
    body = rounded_box("錠の胴", (0.34 * s, 0.16 * s, 0.33 * s), 0.045 * s, body_mat, g, 6)  # 角の丸い四角で面は平ら  # ほぼ正方形（ref2 90×88）
    body.location.z = 0.165 * s
    sh = arc_tube("錠のつる", 0.1 * s, 0.03 * s, 0, math.pi, shackle_mat, g)
    sh.rotation_euler = (math.radians(90), 0, 0)
    sh.location = (0.03 * s, 0.02 * s, 0.35 * s)  # つるは右寄り
    for sgn in (-1, 1):
        leg = cylinder("つるの脚", 0.03 * s, 0.06 * s, shackle_mat, g, 20)
        leg.location = (0.03 * s + sgn * 0.1 * s, 0.02 * s, 0.33 * s)
    hole = cylinder("鍵穴", 0.05 * s, 0.08 * s, M["keyhole_gold"], g, 24)
    hole.rotation_euler = (math.radians(90), 0, 0)
    hole.location = (0, -0.08 * s, 0.225 * s)  # 胴の上から約 4 割（ref2）
    slot = rounded_box("鍵穴の下", (0.04 * s, 0.08 * s, 0.1 * s), 0.012 * s, M["keyhole_gold"], g, 2)  # 下が細長い
    slot.location = (0, -0.08 * s, 0.16 * s)
    carve(body, [hole, slot], M["keyhole_gold"])  # 彫り込んだ鍵穴（ref2）
    return g


def key(parent, mat, s=1.0):
    g = empty("鍵", parent)
    ring = torus("鍵の輪", 0.06 * s, 0.045 * s, mat, g, 40, 14)
    ring.location.z = 0.03 * s
    shaft = capsule("鍵の軸", 0.26 * s, 0.035 * s, mat, g)
    shaft.location = (0.22 * s, 0, 0.03 * s)
    for i, x in enumerate((0.28, 0.35)):
        t = rounded_box(f"鍵の歯{i}", (0.035 * s, 0.07 * s, 0.05 * s), 0.012 * s, mat, g, 2)
        t.location = (x * s, -0.05 * s, 0.03 * s)
    return g


def brush(parent):
    """刷毛（ref2 の形）：柄は太く短く、先が丸く、穴がひとつ。桃色の口金。生成りの毛は 5 本の指のように分かれ、
    先は丸い塊。毛先だけ墨で灰色。局所の座標で、柄は +x、毛先は -x"""
    g = empty("刷毛", parent)
    # 柄：平たい板。口金の側が広く、先へ細くなり、先は丸い（ref2 の形）
    pts = [(0.2, -0.32), (0.32, -0.24), (0.44, -0.16), (0.68, -0.15), (0.78, -0.17)]
    pts += [(0.86 + 0.17 * math.cos(math.radians(a)), 0.17 * math.sin(math.radians(a))) for a in range(-80, 81, 8)]
    pts += [(0.78, 0.17), (0.68, 0.15), (0.44, 0.16), (0.32, 0.24), (0.2, 0.32)]  # 口金の側が広く、くびれて、先は丸くふくらむ
    handle = prism_xy("刷毛の柄", pts, 0.22, M["coral"], g, bev=0.07, seg=6)
    handle.location.z = -0.11
    hole = cylinder("柄の穴", 0.05, 0.02, M["coral_dark"], g, 32)
    hole.location = (0.92, 0, 0.103)  # 上の面とほぼ同じ高さの暗い円：へこんだ穴に見える
    band = rounded_box("口金", (0.13, 0.68, 0.3), 0.045, M["pink"], g, 5)
    band.location = (0.17, 0, 0)
    root = rounded_box("毛の根元", (0.14, 0.64, 0.26), 0.06, M["bristle"], g, 6)  # 指を根元でつなぐ塊
    root.location = (0.06, 0, 0.0)
    for k in range(4):
        yk = -0.24 + k * 0.16
        f = capsule(f"毛{k}", 0.16, 0.09, M["bristle"], g)  # 指：丸くふくらみ、となりと少し重なる
        f.scale = (1, 1, 1.4)
        f.location = (-0.06, yk, 0.03)
    t_ = rounded_box("毛先の墨", (0.24, 0.62, 0.2), 0.09, M["brush_ink"], g, 8)  # 毛の下の層の先だけが墨で灰色（手本の形）
    t_.location = (-0.2, 0, -0.07)
    return g


def ink_puddle(name, x, y, s, mat):
    """いびつな豆の形の墨だまり（薄い）"""
    pts = []
    for i in range(40):
        a = 2 * math.pi * i / 40
        r = 1.0 + 0.1 * math.cos(2 * a) + 0.08 * math.sin(3 * a + 0.7) + 0.05 * math.cos(5 * a) - 0.3 * max(0.0, math.cos(a - 1.7)) ** 5
        pts.append((s * 1.15 * r * math.cos(a), s * 0.82 * r * math.sin(a)))
    ob = prism_xy(name, pts, 0.09, mat, None, bev=0.044, seg=7)
    ob.location = (x, y, 0.0)
    return ob


def drop(name, r, x, y):
    d = mesh_sphere(name, r, M["charcoal"], None)
    d.scale = (1.2, 1.0, 0.35)
    d.location = (x, y, r * 0.3)
    return d


def eye_badge(parent):
    g = empty("目の札", parent)
    pts = [(-0.16, 0.12), (0.16, 0.12), (0.16, -0.02), (0.0, -0.17), (-0.16, -0.02)]
    sh = prism_xy("札", pts, 0.1, M["lilac_deep"], g, bev=0.045, seg=7)
    eye = cylinder("白目", 0.11, 0.03, M["white"], g, 40)
    eye.scale = (1.0, 0.66, 1)
    eye.location = (0, 0.0, 0.085)
    pupil = cylinder("黒目", 0.05, 0.03, M["navy"], g, 32)
    hl = cylinder("目の光", 0.015, 0.03, M["white"], g, 16)
    hl.location = (0.02, 0.02, 0.115)
    pupil.location = (0, 0.0, 0.1)
    return g


def bubble(text, w, h, bg, fg, tail_x=-0.3, size=None, icon=None):
    """字の札（吹き出し）：XY 面に作り、あとでカメラの方へ起こす"""
    g = empty("札:" + text)
    plate = prism_xy("札の板", rrect(w, h, h * 0.42), 0.16, bg, g, bev=0.07, seg=7)
    tail = prism_xy("札のしっぽ", [(tail_x * w - 0.08, -h / 2 + 0.03), (tail_x * w + 0.08, -h / 2 + 0.03), (tail_x * w - 0.1, -h / 2 - 0.13)], 0.09, bg, g, bev=0.03, seg=4)
    cjk = any(ord(ch) > 127 for ch in text)
    t = text3d(text, size or h * (0.6 if cjk else 0.56), fg, g, extrude=0.009, bev=0.0, spacing=1.06 if cjk else 1.0)
    t.visible_shadow = False  # 字は影を落とさない（字の中やすき間が影で埋まらないように）
    t.location = ((0.1 if icon else 0.0) * w, 0.0, 0.162)
    if icon == "shield":
        pts = [(-0.08, 0.07), (0.08, 0.07), (0.08, -0.01), (0.0, -0.09), (-0.08, -0.01)]
        ic = prism_xy("盾", pts, 0.05, M["red"], g, bev=0.02, seg=4)
        ic.location = (-w / 2 + 0.2, 0, 0.16)
        ck = check_mark("盾の✓", 0.09, 0.03, M["white"], g)
        ck.location = (-w / 2 + 0.2, 0.0, 0.22)
    return g


def face_camera(ob, x, y, z, rz=0.0, tilt=-22.0):
    ob.location = (x, y, z)
    ob.rotation_euler = (math.radians(90 - ELEV + tilt), 0, math.radians(rz))
    return ob


def smooth_path(pts, it=3):
    """折れ線の角を丸める（チャイキン法）。端の点は残す"""
    for _ in range(it):
        out = [pts[0]]
        for (ax, az), (bx, bz) in zip(pts[:-1], pts[1:]):
            out += [(0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz), (0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz)]
        out.append(pts[-1])
        pts = out
    return pts


def strap(name, y, x0, mat, ztop, width=0.3, drape=True, x_end=None, flip=False, me=0.11, le=0.13, thick=0.045):
    """紙にかけた墨消しの帯。紙の面にぴったり沿って載る。drape のときは、紙の端から緑の段・薄紫の段の縁に沿って垂れ、
    床に触れて、先は浅い三角のぎざぎざに切れる。flip のときは、紙のまん中で 180 度回して、左の端へ垂らす"""
    e = 0.004  # 面からの浮き（ほぼ接する）
    if drape:
        # me・le：紙の端から、緑の段・薄紫の段の縁までの出（左右で違う）。帯はそれぞれの段の上を通り、縁で折れて下りる
        raw = [(x0, ztop + e), (PW - 0.02, ztop + e), (PW + 0.03, ztop - 0.05), (PW + 0.03, 0.38 + e), (PW + me - 0.02, 0.38 + e),
               (PW + me + 0.03, 0.33), (PW + me + 0.03, 0.2 + e), (PW + le - 0.02, 0.2 + e), (PW + le + 0.03, 0.15), (PW + le + 0.03, 0.05),
               (PW + le + 0.09, e), (PW + le + 0.4, e)]
        pts = smooth_path(raw)
    else:
        pts = [(x0 + (x_end - x0) * i / 24, ztop + e) for i in range(25)]
    ns = 12
    bm = bmesh.new()
    rows = []
    for k, (px, pz) in enumerate(pts):
        row = []
        for j in range(ns + 1):
            yy = -width / 2 + width * j / ns
            dx = 0.0
            if k == len(pts) - 1 and drape:
                dx = 0.09 * (1 - abs((j % 6) - 3) / 3)  # 浅く太い三角の歯（2 つ）
            row.append(bm.verts.new((px + dx, y + yy, pz)))
        rows.append(row)
    for k in range(len(rows) - 1):
        for j in range(ns):
            bm.faces.new([rows[k][j], rows[k + 1][j], rows[k + 1][j + 1], rows[k][j + 1]])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    holder = empty(name + "の向き", paper_rig)
    if flip:
        holder.rotation_euler = (0, 0, math.pi)
    ob = new_obj(name, me, mat, holder)
    so = ob.modifiers.new("厚み", "SOLIDIFY")
    so.thickness = thick
    so.offset = 1.0  # 面の上（外側）へ厚みをつける：下の面に接したまま
    bevel(ob, 0.016, 3, 50)
    return ob


# ── 置き場所：ref2 の画面の位置（ref2 を 2000×1116 にした座標）から、場面の位置を逆算する ──
# カメラは遠近のない見下ろしなので、画面の点と高さ z が決まれば、場面の点が 1 つに決まる。
HEX.update({"row_gray": "#bfbcd6", "orange": "#f3a35c", "lock_gold": "#fccb85", "shackle": "#bfb5d3", "lock_coral": "#f19a92",
            "conf_pink": "#f3a0c4", "dot_blue": "#9fd0f2", "dot_pink": "#f4a3b8", "dot_mint": "#8fdcbd", "dot_teal": "#7cc9c0",
            "star_orange": "#f0a24e", "eye_lilac": "#afacec", "pad_yellow": "#f6d27a", "pad_lilac": "#c7b6ee", "pad_coral": "#f4a99a",
            "pen_navy": "#554f90", "magenta": "#c25bb0", "file_red": "#f07a7c", "bristle3": "#e8c4a6", "groove": "#d9b994", "cap_purple": "#54476e", "keyhole": "#4a3236", "key_ochre": "#e3a857", "check2": "#74c9a0", "star_gold": "#f3c766", "window": "#cbbdf2", "check_green": "#71cfa0", "ink_tip": "#5b5a63", "bristle2": "#f3dcc0"})
for k in HEX:
    if k not in M:
        M[k] = material(k, k, rough=0.35, coat=float(arg("--coat", "0.15")))
for _k in ("dot_blue", "dot_pink", "dot_mint", "dot_teal", "navy", "lilac_deep", "yellow", "white", "magenta"):
    M["dot2_" + _k] = material("粒2" + _k, "dot_yellow" if _k == "yellow" else _k, rough=0.35, coat=0.5)

SE, CE = math.sin(math.radians(ELEV)), math.cos(math.radians(ELEV))
TGT = Vector((0.0, 0.0, 0.25))
ASP = 0.5625


def P(px, py, z=0.0):
    X = (px / 2000 - 0.5) * WIDE
    s = (0.5 - py / 1116) * WIDE * ASP
    return Vector((X, TGT.y + (s - (z - TGT.z) * CE) / SE, z))


def R(px):
    """画面の画素の長さ（2000 幅）→ 場面の長さ"""
    return px * WIDE / 2000


ROT = math.radians(-32)
PW, PH, PF = 1.282, 1.873, 0.64
ZT = 0.34  # 紙の上の面（束を ref2 の厚みに：薄紫 0.13・緑 0.11・紙 0.1）
paper_rig = empty("紙の向き")
paper_rig.rotation_euler = (0, 0, ROT)
_c = P(1042, 536, ZT)
paper_rig.location = (_c.x - 0.103 * math.cos(ROT), _c.y - 0.103 * math.sin(ROT), 0)


def LP(px, py, z=ZT):
    """画面の点 → 紙の向きの座標（x：紙の左右、y：紙の上下）"""
    w = P(px, py, z)
    dx, dy = w.x - paper_rig.location.x, w.y - paper_rig.location.y
    c, s = math.cos(ROT), math.sin(ROT)
    return (dx * c + dy * s, -dx * s + dy * c)


# ── 台と紙 ─────────────────────────────────────────
def rpoly(pts, r, n=8):
    """多角形の角を、決まった長さ r で丸める（2 次ベジェ）"""
    out = []
    for i in range(len(pts)):
        P_ = Vector((*pts[i], 0))
        A_ = Vector((*pts[i - 1], 0))
        B_ = Vector((*pts[(i + 1) % len(pts)], 0))
        t_ = min(r, (A_ - P_).length * 0.45, (B_ - P_).length * 0.45)
        p1 = P_ + (A_ - P_).normalized() * t_
        p2 = P_ + (B_ - P_).normalized() * t_
        for k in range(n + 1):
            u = k / n
            q = p1 * (1 - u) ** 2 + P_ * 2 * u * (1 - u) + p2 * u ** 2
            out.append((q.x, q.y))
    return out


def layer_outline(d, cx, cy):
    """紙の輪郭（右上の角が斜めに切れた形）を、まわりに d だけ広げる"""
    k_ = d * math.tan(math.radians(22.5))
    return [(-PW - d + cx, -PH - d + cy), (PW + d + cx, -PH - d + cy), (PW + d + cx, PH - PF + k_ + cy), (PW - PF + k_ + cx, PH + d + cy), (-PW - d + cx, PH + d + cy)]


lil = prism_xy("台（薄紫）", rpoly(layer_outline(0.1, -0.02, -0.06), 0.26), 0.13, M["lilac"], paper_rig, bev=0.05, seg=6)
mint = prism_xy("台（緑）", rpoly(layer_outline(0.08, -0.01, -0.03), 0.24), 0.11, M["mint"], paper_rig, bev=0.05, seg=6)
mint.location.z = 0.13
outline = [(-PW, -PH), (PW, -PH), (PW, PH - PF), (PW - PF, PH), (-PW, PH)]
paper = prism_xy("紙", outline, 0.1, M["paper"], paper_rig, bev=0.04, seg=6)
paper.location.z = 0.24
BH = PH - LP(927, 285)[1]
HEX["band_pink"] = "#f2848c"
M["band_pink"] = material("帯の桃", "band_pink", rough=0.4, coat=0.1)
band = prism_xy("紅の帯", [(-PW, PH - BH), (PW, PH - BH), (PW, PH - PF), (PW - PF, PH), (-PW, PH)], 0.08, M["band_pink"], paper_rig, bev=0.035, seg=5)
band.location.z = ZT - 0.05
fa = PF / math.sqrt(2)
A = Vector((PW - PF, PH, 0))
B = Vector((PW, PH - PF, 0))
mid = (A + B) / 2
inw = Vector((-1, -1, 0)).normalized()
def round_poly(pts, it=4):
    """閉じた多角形の角を丸める（チャイキン法）"""
    for _ in range(it):
        q = []
        for i in range(len(pts)):
            (x0_, y0_), (x1_, y1_) = pts[i], pts[(i + 1) % len(pts)]
            q += [(0.75 * x0_ + 0.25 * x1_, 0.75 * y0_ + 0.25 * y1_), (0.25 * x0_ + 0.75 * x1_, 0.25 * y0_ + 0.75 * y1_)]
        pts = q
    return pts


apex = (mid.x + inw.x * fa * 0.95, mid.y + inw.y * fa * 0.95)
_tri = [(A.x + 0.01, A.y - 0.03), (B.x - 0.03, B.y + 0.01), apex]
_cx, _cy = sum(q[0] for q in _tri) / 3, sum(q[1] for q in _tri) / 3
fl_pts = rpoly(_tri, 0.2)
fl_c = Vector(((A.x + B.x + apex[0]) / 3, (A.y + B.y + apex[1]) / 3, 0))
flg = empty("折り返した角", paper_rig)
flg.location = (mid.x, mid.y, ZT + 0.03)
flg.rotation_euler = (0, 0, 0)
HEX["flap_pink"] = "#f4b2b6"
M["flap_pink"] = material("めくれの桃", "flap_pink", rough=0.45, coat=0.05)
flap = prism_xy("折り返した角の紙", [(x - mid.x, y - mid.y) for x, y in fl_pts], 0.03, M["flap_pink"], flg, bev=0.014, seg=5)  # 薄い紙
# 内側の角を持ち上げる：対角線（A→B）を軸に 10° 起こす
_ax = (B - A).normalized()
flg.rotation_mode = "AXIS_ANGLE"
flg.rotation_axis_angle = (math.radians(-3), _ax.x, _ax.y, 0)

_l = LP(1112, 300)
M["letter"] = material("字の白", "white", rough=0.55, coat=0.05)
big = text3d("PDF", 0.6, M["letter"], paper_rig, extrude=0.035, bev=0.015, spacing=1.16)
big.location = (_l[0], _l[1], ZT + 0.09)
big.rotation_euler = (math.radians(16), 0, 0)
# 小さな PDF のファイル：角の折れた淡い桃色の紙に、赤い札と白い「PDF」
_l = LP(1281, 377)
icg = empty("小さなファイル", paper_rig)
icg.location = (_l[0], _l[1], ZT + 0.02)
icg.rotation_euler = (math.radians(25), 0, 0)
HEX["file_pink"] = "#fdb2b3"
HEX["file_curl"] = "#fdc3c6"
M["file_pink"] = material("ファイルの桃", "file_pink", rough=0.45, coat=0.15)
M["file_curl"] = material("めくれの淡い桃", "file_curl", rough=0.55, coat=0.05)
FD = 0.1  # 塊の厚み
_fn = 0.15  # 右上の角を切る長さ
fbody = prism_xy("ファイル", rpoly([(-0.19, -0.23), (0.22, -0.23), (0.22, 0.2 - _fn), (0.22 - _fn, 0.2), (-0.19, 0.2)], 0.1), FD, M["file_pink"], icg, bev=0.035, seg=6)
# めくれ：切った角の斜めの線を折り目にして、角の三角を手前へ折り返す（先を丸め、折り目は塊とつながる高さ）
_A, _B = (0.22 - _fn, 0.2), (0.22, 0.2 - _fn)
_C = (0.22 - _fn, 0.2 - _fn)
_cg = empty("めくれの軸", icg)
_cg.location = (_C[0], _C[1], FD - 0.035)
_ax = Vector((_B[0] - _A[0], _B[1] - _A[1], 0)).normalized()
_cg.rotation_mode = "AXIS_ANGLE"
_cg.rotation_axis_angle = (math.radians(3), _ax.x, _ax.y, 0)
_a2 = Vector((_A[0] - _C[0] - 0.004, _A[1] - _C[1] - 0.012, 0))
_b2 = Vector((_B[0] - _C[0] - 0.012, _B[1] - _C[1] - 0.004, 0))
_ctl = (_a2 + _b2) / 2 + ((_a2 + _b2) / 2).normalized() * (_a2 - _b2).length * 0.32  # 外へふくらむ
_arc = [tuple(_b2 * (1 - t) ** 2 + _ctl * 2 * t * (1 - t) + _a2 * t * t)[:2] for t in [k / 12 for k in range(1, 12)]]
curl = prism_xy("ファイルのめくれ", rpoly([tuple(_a2)[:2], (0.006, 0.006), tuple(_b2)[:2]] + _arc, 0.04), 0.05, M["file_curl"], _cg, bev=0.024, seg=6)
lab = prism_xy("ファイルの札", rrect(0.4, 0.17, 0.05, cx=-0.012, cy=-0.05), 0.06, M["red"], icg, bev=0.024, seg=5)
lab.location.z = FD - 0.03
small = text3d("PDF", 0.14, M["white"], icg, extrude=0.02, bev=0.008, spacing=1.08)
small.location = (-0.012, -0.05, FD + 0.03)


def row(a, b, mat, h=0.06, thick=0.03, dy=0.0, dx0=0.0, dx1=0.0, name="行"):
    x0, y0 = LP(*a)
    x1, y1 = LP(*b)
    return bar_flat(name, min(x0, x1) + dx0, max(x0, x1) + dx1, (y0 + y1) / 2 + dy, h, ZT, mat, paper_rig, thick=thick)


G = M["row_gray"]
row((935, 324), (1112, 397), M["navy"], h=0.07, name="題の行")
for k, (d0, d1) in enumerate(((0.0, 0.12), (0.0, 0.06), (0.0, -0.12))):
    row((935, 324), (1112, 397), G, dy=-0.125 * (k + 1), dx0=d0, dx1=d1)

# 棒グラフ：青い L 字の軸に、平たい棒 5 本（左から右へ高くなる）、右上がりの矢印、上に短い線 2 本
cx0, cy0 = LP(762, 489)
ytop = LP(862, 397)[1]
xend = LP(942, 574)[0]
bar_flat("グラフの縦軸", cx0 - 0.03, cx0 + 0.03, (cy0 + ytop) / 2, ytop - cy0, ZT, M["axis_blue"], paper_rig, thick=0.03)
bar_flat("グラフの横軸", cx0 - 0.03, xend, cy0, 0.06, ZT, M["axis_blue"], paper_rig, thick=0.03)
for i, (hh, m) in enumerate(((0.18, "lilac_deep"), (0.28, "blue"), (0.42, "pink"), (0.38, "yellow"), (0.54, "mint"))):
    x = cx0 + 0.14 + i * (xend - cx0 - 0.22) / 4
    b = rounded_box(f"棒{i}", (0.095, hh, 0.06), 0.022, M[m], paper_rig, 4)
    b.location = (x, cy0 + 0.06 + hh / 2, ZT + 0.035)
a0, a1 = LP(948, 482), LP(1015, 470)
ang = math.atan2(a1[1] - a0[1], a1[0] - a0[0])
ln = math.hypot(a1[0] - a0[0], a1[1] - a0[1])
arrow = capsule("矢印", ln - 0.08, 0.016, M["orange"], paper_rig)
arrow.location = ((a0[0] + a1[0]) / 2 - 0.03 * math.cos(ang), (a0[1] + a1[1]) / 2 - 0.03 * math.sin(ang), ZT + 0.03)
arrow.rotation_euler = (0, 0, ang)
tipm = bpy.data.meshes.new("矢印の先")
bm = bmesh.new()
bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=0.045, radius2=0.0, depth=0.085)
bm.to_mesh(tipm)
bm.free()
tip = new_obj("矢印の先", tipm, M["orange"], paper_rig)
tip.location = (a1[0], a1[1], ZT + 0.03)
tip.rotation_euler = (0, math.radians(90), ang)
row((865, 416), (923, 439), M["lilac_deep"], h=0.05, name="グラフの題")
row((854, 432), (898, 449), M["lilac_deep"], h=0.05, name="グラフの題2")

# 円グラフ（左の錠の右下。半分は錠と帯に隠れる）
pc = LP(769, 552)
for i, (b0, b1, m) in enumerate(((60, 190, "blue"), (190, 320, "yellow"), (320, 420, "pink"))):
    pts = [(0, 0)] + [(0.15 * math.cos(math.radians(b0 + (b1 - b0) * k / 16)), 0.15 * math.sin(math.radians(b0 + (b1 - b0) * k / 16))) for k in range(17)]
    w = prism_xy(f"円グラフ{i}", pts, 0.022, M[m], paper_rig, bev=0.008, seg=2)
    w.location = (pc[0] + 0.012 * math.cos(math.radians((b0 + b1) / 2)), pc[1] + 0.012 * math.sin(math.radians((b0 + b1) / 2)), ZT)
# 左の中ほどの行（4 本）
for k in range(4):
    row((795, 557), (905, 600), G, dy=-0.085 * k, dx1=-0.05 * k)
# 右の行（黒い帯の下。3 本）
for k in range(2):
    row((1073, 497), (1250, 560), G, dy=-0.1 * k, dx1=-0.12 * (k == 1))
# 山の形のグラフ：角の丸いカード 3 枚（間を空ける）。1 枚の中で 2 色を、ゆるい曲線で分ける（色は材質の中で分ける。形は 1 つの塊）
def two_tone(name, top, bot, pts3, soft=0.006):
    """紙の向きの座標で、3 点を通る曲線 y = a + b x + c x^2 より上を top、下を bot の色にする材質"""
    import mathutils
    n3 = len(pts3)
    A_ = mathutils.Matrix([[px_ ** j for j in range(n3)] for px_, _ in pts3])
    co = list(A_.inverted() @ Vector([py_ for _, py_ in pts3]))
    m = material(name, top, rough=0.35, coat=0.15)
    nt = m.node_tree
    N = nt.nodes
    tc = N.new("ShaderNodeTexCoord")
    sp = N.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sp.inputs[0])
    def mth(op, a, b):
        n_ = N.new("ShaderNodeMath")
        n_.operation = op
        for i_, v in enumerate((a, b)):
            if isinstance(v, (int, float)):
                n_.inputs[i_].default_value = v
            else:
                nt.links.new(v, n_.inputs[i_])
        return n_.outputs[0]
    X_, Y_ = sp.outputs["X"], sp.outputs["Y"]
    f_ = co[-1]  # ホーナー法：(((c3) x + c2) x + c1) x + c0
    for cj in reversed(co[:-1]):
        f_ = mth("ADD", mth("MULTIPLY", f_, X_) if not isinstance(f_, float) else mth("MULTIPLY", X_, f_), cj)
    d_ = mth("SUBTRACT", Y_, f_)
    mr = N.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHSTEP"
    nt.links.new(d_, mr.inputs["Value"])
    mr.inputs["From Min"].default_value = -soft
    mr.inputs["From Max"].default_value = soft
    mx = N.new("ShaderNodeMix")
    mx.data_type = "RGBA"
    nt.links.new(mr.outputs["Result"], mx.inputs[0])
    cin = [i_ for i_ in mx.inputs if i_.type == "RGBA" and i_.enabled]
    cin[0].default_value = rgba(bot)
    cin[1].default_value = rgba(top)
    cout = [o_ for o_ in mx.outputs if o_.type == "RGBA" and o_.enabled][0]
    nt.links.new(cout, N["Principled BSDF"].inputs["Base Color"])
    return m


CD = 0.045  # カードの厚み
HEX.update({"card_blue": "#80adee", "card_yellow": "#e2b061", "card_lilac": "#c1a7e0", "card_pink": "#f17ba2", "card_mint": "#79cbac"})
M["card_mint"] = material("山の緑", "card_mint", rough=0.35, coat=0.15)
def _lpt(p):
    return LP(p[0], p[1] - 6, ZT + CD)  # 上の面が ref2 の場所に来るように
for i, (poly, top, bot, cur) in enumerate((
        ([(972, 590), (1022, 541), (1064, 574), (1025, 617)], "card_blue", "card_yellow", [(972, 590), (1000, 583), (1025, 580), (1048, 585)]),
        ([(1032, 619), (1051, 594), (1080, 570), (1124, 566), (1146, 583), (1090, 646)], "card_lilac", "card_pink", [(1051, 595), (1088, 589), (1112, 587), (1127, 601)]),
        ([(1099, 649), (1152, 596), (1231, 588), (1151, 676)], None, "card_mint", None))):
    pts = [_lpt(p) for p in poly]
    mat = two_tone(f"山{i}の 2 色", top, bot, [_lpt(p) for p in cur]) if top else M[bot]
    blk = prism_xy(f"山{i}", rpoly(pts, 0.035, 6), CD, mat, paper_rig, bev=0.016, seg=4)
    blk.location.z = ZT
# 緑のカードの奥から、黄のカードの上の縁が少しのぞく
blk = prism_xy("山3", rpoly([_lpt(p) for p in [(1152, 597), (1166, 587), (1196, 585), (1220, 590), (1200, 597)]], 0.02, 4), CD * 0.8, M["yellow"], paper_rig, bev=0.012, seg=3)
blk.location.z = ZT
# ドーナツ（少し起こす）
dc = LP(962, 645)
dg = empty("ドーナツ", paper_rig)
dg.location = (dc[0], dc[1], ZT)
dg.rotation_euler = (0, 0, 0)
RO_, RI_ = 0.156, 0.156 * 0.74
HEX.update({"donut_teal": "#7cc6cb", "donut_beige": "#dfbc9f", "donut_pink": "#dc7aa4"})
for i, (b0, b1, m) in enumerate(((92, 212, "donut_teal"), (2, 92, "donut_beige"), (212, 362, "donut_pink"))):  # ref2：青緑 9〜1 時、ベージュ 1〜4 時、桃 4〜9 時（紙の向き 32° を足した）
    M.setdefault(m, material(m, m, rough=0.35, coat=0.15))
    tb = arc_tube(f"ドーナツ{i}", (RO_ + RI_) / 2, (RO_ - RI_) / 2, math.radians(b0), math.radians(b1), M[m], dg)  # 細い管、境に隙間なし
    tb.location.z = (RO_ - RI_) / 2 * 0.7
# 折れ線グラフの枠（白い枠にジグザグの線）
tl, brp = LP(985, 655), LP(1110, 740)
fx0, fx1, fy0, fy1 = tl[0], brp[0], brp[1], tl[1]
if fx0 > fx1:
    fx0, fx1 = fx1, fx0
if fy0 > fy1:
    fy0, fy1 = fy1, fy0
for nm, (x0_, x1_, yc, hh) in (("上", (fx0, fx1, fy1, 0.03)), ("下", (fx0, fx1, fy0, 0.03))):
    bar_flat("枠" + nm, x0_, x1_, yc, hh, ZT, M["lilac"], paper_rig, thick=0.025)
for nm, xc in (("左", fx0), ("右", fx1)):
    bar_flat("枠" + nm, xc - 0.015, xc + 0.015, (fy0 + fy1) / 2, fy1 - fy0, ZT, M["lilac"], paper_rig, thick=0.025)
for j, (pts, m) in enumerate((([(0.1, 0.25), (0.3, 0.72), (0.5, 0.3), (0.72, 0.8)], "orange"), ([(0.12, 0.6), (0.38, 0.35), (0.62, 0.8), (0.88, 0.45)], "mint"), ([(0.55, 0.2), (0.75, 0.62), (0.9, 0.3)], "lilac_deep"))):
    q = [(fx0 + (fx1 - fx0) * u, fy0 + (fy1 - fy0) * v) for u, v in pts]
    for (ax_, ay_), (bx_, by_) in zip(q[:-1], q[1:]):
        L_ = math.hypot(bx_ - ax_, by_ - ay_)
        sg = rounded_box(f"折れ線{j}", (L_ + 0.03, 0.03, 0.016), 0.007, M[m], paper_rig, 2)
        sg.location = ((ax_ + bx_) / 2, (ay_ + by_) / 2, ZT + 0.012 + 0.004 * j)
        sg.rotation_euler = (0, 0, math.atan2(by_ - ay_, bx_ - ax_))
# 下の行
for k in range(2):
    row((600, 631), (800, 705), G, dy=-0.06 - 0.13 * k, dx1=-0.05 * k)
for k in range(2):
    row((819, 735), (1000, 790), G, dy=-0.12 * k, dx1=-0.15 * k)


def _resample(pts, step):
    """折れ線を、ほぼ等間隔 step の点に並べ直す（曲がりの所でも面が細かくなるように）"""
    out = [pts[0]]
    for (ax, az), (bx, bz) in zip(pts, pts[1:]):
        L = math.hypot(bx - ax, bz - az)
        n_ = max(1, int(L / step))
        out += [(ax + (bx - ax) * t / n_, az + (bz - az) * t / n_) for t in range(1, n_ + 1)]
    return out


def strap2(name, y, x0, x1, mat, width=0.32, drape=False, lip=False, me=0.11, le=0.13, thick=0.11, cap_r=None):
    """紙にかけた墨消しの帯。drape：右の縁から段に沿って垂れ、床に触れて浅い三角のぎざぎざで切れる。lip：左の端が紙の縁を少し越えて下へ曲がる"""
    e = 0.001
    ztop = ZT
    if drape:
        # 紙の縁から、緑と薄紫の層の丸い縁をなめらかに越えて床へ落ち、床の上を平たく前へのびる
        Rt, Rb, xv, Lf = 0.1, 0.11, PW + 0.09, 0.12
        ct = (xv - Rt, ztop + e - Rt)  # 上の曲がりの中心（紙の角の内側）
        cb = (xv + Rb, e + Rb)  # 下の曲がりの中心
        raw = [(x0, ztop + e), (ct[0], ztop + e)]
        raw += [(ct[0] + Rt * math.cos(a), ct[1] + Rt * math.sin(a)) for a in [math.pi / 2 * (1 - i / 12) for i in range(1, 13)]]
        raw += [(cb[0] + Rb * math.cos(a), cb[1] + Rb * math.sin(a)) for a in [math.pi + math.pi / 2 * i / 12 for i in range(13)]]
        raw += [(cb[0] + Lf, e)]
        pts = _resample(raw, 0.012)
    else:
        pts = [(x0 + (x1 - x0) * i / 24, ztop + e) for i in range(25)]
        if lip:  # 左の端：まっすぐ外へ出て、少し下がるだけ
            xl_, Rl_ = -PW - 0.1, 0.1  # 紙の束の左の側面に沿って上り、紙の角を円弧で回って紙の上へ（右の垂れと同じ作り）
            cl_ = (xl_ + Rl_, ztop + e - Rl_)
            wrap = [(xl_, 0.15)] + [(cl_[0] + Rl_ * math.cos(a), cl_[1] + Rl_ * math.sin(a)) for a in [math.pi - math.pi / 2 * i / 12 for i in range(13)]]
            pts = _resample(wrap + [(x0, ztop + e)], 0.012)[:-1] + pts  # 端はまっすぐ、四角く切る
    if drape:
        thick = min(thick, 0.085)  # 垂れる帯は薄く（床へ曲がる所で厚みが折り重ならないように）
    if lip:
        thick = 0.09  # 左の帯の手前の厚みの面：ref2 16px（0.13 では 24px と厚すぎた）
    rc = thick * 0.28  # 断面の上の角の丸み（小さめ：手前に平らな厚みの面が見えるように）
    rb_ = thick * 0.08  # 下の角はほぼ直角（紙にぴたりと付く。丸いと両脇にすき間ができて浮いて見える）

    def ring(hw):
        """断面（u：帯の幅の向き、v：面から上へ）の輪郭。下の辺 → 右 → 上の辺 → 左"""
        out = []
        nb = 16
        for i in range(nb):
            out.append((-(hw - rb_) + 2 * (hw - rb_) * i / nb, 0.0))
        for i in range(5):  # 右下の角
            t = -math.pi / 2 + math.pi / 2 * i / 5
            out.append((hw - rb_ + rb_ * math.cos(t), rb_ + rb_ * math.sin(t)))
        for i in range(5):  # 右上の角
            t = math.pi / 2 * i / 5
            out.append((hw - rc + rc * math.cos(t), thick - rc + rc * math.sin(t)))
        for i in range(nb):
            out.append(((hw - rc) - 2 * (hw - rc) * i / nb, thick))
        for i in range(5):  # 左上の角
            t = math.pi / 2 + math.pi / 2 * i / 5
            out.append((-(hw - rc) + rc * math.cos(t), thick - rc + rc * math.sin(t)))
        for i in range(5):  # 左下の角
            t = math.pi + math.pi / 2 * i / 5
            out.append((-(hw - rb_) + rb_ * math.cos(t), rb_ + rb_ * math.sin(t)))
        return out

    bm = bmesh.new()
    rows = []
    n_ = len(pts)
    for k, (px, pz) in enumerate(pts):
        qa, qb = pts[max(0, k - 1)], pts[min(n_ - 1, k + 1)]
        tx, tz = qb[0] - qa[0], qb[1] - qa[1]
        L = math.hypot(tx, tz) or 1.0
        nx, nz = -tz / L, tx / L  # 面から上の向き
        hw = width / 2  # 先まで同じ幅（ref2 は広がらない）
        fk = (k - (n_ - 12)) / 11 if (drape and k >= n_ - 12) else 0.0  # 端は丸い波 3 つ（12 列かけてずらす）
        r_ = []
        for u, v in ring(hw):
            dx = 0.07 * (1 - math.cos(2 * math.pi * 3 * (u + hw) / (2 * hw))) / 2 * fk
            r_.append(bm.verts.new((px + nx * v + dx, y + u, pz + nz * v)))
        rows.append(r_)
        # 両端は 3 段かけて丸く閉じる（先へ rc だけ出しながら、断面を中ほどへ縮める）
        if k in (0, n_ - 1):
            sg = -1 if k == 0 else 1
            caps = []
            for t_ in (1, 2, 3):
                th_ = math.pi / 2 * t_ / 3.5
                cr_ = (cap_r if (cap_r and k == n_ - 1) else rc)  # 端の丸み（右の端だけ変えられる）
                adv, sh = cr_ * math.sin(th_), math.cos(th_)
                cr = []
                for u, v in ring(hw):
                    dx = 0.07 * (1 - math.cos(2 * math.pi * 3 * (u + hw) / (2 * hw))) / 2 * fk
                    v2 = thick / 2 + (v - thick / 2) * sh
                    u2 = u * (1 - (1 - sh) * min(cr_, rc) / max(hw, 1e-6))
                    cr.append(bm.verts.new((px + nx * v2 + dx + sg * tx / L * adv, y + u2, pz + nz * v2 + sg * tz / L * adv)))
                caps.append(cr)
            if k == 0:
                rows[:0] = list(reversed(caps))
            else:
                rows.extend(caps)
    m_ = len(rows[0])
    for k in range(len(rows) - 1):
        for j in range(m_):
            bm.faces.new([rows[k][j], rows[k + 1][j], rows[k + 1][(j + 1) % m_], rows[k][(j + 1) % m_]])
    nb_ = 16  # ring() の下の辺の点の数。上の辺は nb_+10 番から始まる
    for rw in (rows[0], rows[-1]):
        top0 = 2 * nb_ + 10
        for i in range(nb_):
            bm.faces.new([rw[i], rw[i + 1], rw[top0 - i - 1], rw[top0 - i]])
        bm.faces.new(rw[nb_:nb_ + 11])  # 右の角の扇
        bm.faces.new(rw[top0:] + [rw[0]])  # 左の角の扇
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me_ = bpy.data.meshes.new(name)
    bm.to_mesh(me_)
    bm.free()
    ob = new_obj(name, me_, mat, paper_rig)
    subsurf(ob, 2)  # 角ばった面にならないよう、なめらかに（端のふたも丸くなる）
    return ob


# 墨消しの帯：上の黒い帯（紙の中ほどから右の縁へ垂れる）と、下の帯（左半分は黒、右半分は紺。紺は右の縁から垂れる）
y_up = LP(1307, 503)[1]
strap2("黒い帯", y_up, LP(1096, 452)[0] + 0.08, PW, M["charcoal"], width=0.42, drape=True)
y_lo = (LP(561, 589)[1] + LP(1115, 762)[1]) / 2
x_mid = LP(842, 668)[0]
strap2("下の黒い帯", y_lo, -PW + 0.0, x_mid + 0.03, M["charcoal"], width=0.4, lip=True, cap_r=0.045)  # 右の端は丸く終わる（ref2）
HEX["strap_navy"] = "#323764"
M["strap_navy"] = material("帯の紺", "strap_navy", rough=0.6, coat=0.0)
strap2("紺の帯", y_lo, x_mid - 0.05, PW, M["strap_navy"], width=0.4, drape=True, thick=0.065)  # 黒の下から段違いで始まる（薄く、黒の下へもぐる）

M["lock_gold_toy"] = M["lock_gold"]
lk1 = padlock(paper_rig, M["lock_gold"], M["shackle"], 0.9)
_l = LP(1307, 512)
lk1.location = (_l[0], y_up, ZT + 0.075)
lk1.rotation_euler = (0, math.radians(20), math.radians(22))  # 時計回り（y -20° は反時計回りだった）
lk2 = padlock(paper_rig, M["lock_gold"], M["shackle"], 1.05)
_l = LP(702, 598)
lk2.location = (_l[0], y_lo, ZT + 0.075)
lk2.rotation_euler = (0, math.radians(20), math.radians(22))


def eye_badge2(parent):
    """盾の形（上は平ら、下がとがる）の藤色の札に、白目と紺の瞳を表に載せる"""
    g = empty("目の札", parent)
    pts = []
    for i in range(9):  # 上の辺（角を丸める）
        a = math.radians(90 + 90 * i / 8)
        pts.append((-0.12 + 0.05 * math.cos(a), 0.1 + 0.05 * math.sin(a)))
    _q = lambda t: ((1 - t) ** 2 * 0.17 + 2 * t * (1 - t) * 0.16 + t * t * 0.0, (1 - t) ** 2 * 0.0 + 2 * t * (1 - t) * -0.16 + t * t * -0.2)
    pts += [(-_q(t)[0], _q(t)[1]) for t in [i / 12 for i in range(13)]]  # 左の辺：上の角から下のとがりへ、なめらかな 2 次の曲線
    pts += [_q(t) for t in [i / 12 for i in range(11, -1, -1)]]  # 右の辺（左右対称、とがりは 1 つ）
    for i in range(9):
        a = math.radians(0 + 90 * i / 8)
        pts.append((0.12 + 0.05 * math.cos(a), 0.1 + 0.05 * math.sin(a)))
    prism_xy("札", pts, 0.12, M["eye_lilac"], g, bev=0.05, seg=7)
    eye = cylinder("白目", 0.12, 0.02, M["white"], g, 40)
    eye.scale = (1.0, 0.5, 1)
    eye.location = (0, 0.02, 0.125)
    pupil = cylinder("黒目", 0.056, 0.02, M["navy"], g, 32)
    pupil.location = (0, 0.02, 0.135)
    hl = cylinder("目の光", 0.014, 0.02, M["white"], g, 16)
    hl.location = (0.018, 0.038, 0.145)
    return g


eb = eye_badge2(paper_rig)
eb.scale = (0.98, 0.98, 0.98)
_l = LP(1031, 752)
eb.location = (_l[0], y_lo - 0.02, ZT + 0.1)
eb.rotation_euler = (math.radians(30), 0, math.radians(0))


# ── まわりの小物 ────────────────────────────────────
def brush2(parent):
    """刷毛：太く短い柄（先は丸く、穴が 1 つ抜けている）、桃色の口金、平たい四角の毛の束（浅い溝 3 本）、毛先は墨で灰色。柄は +x、毛先は -x"""
    g = empty("刷毛", parent)
    pts = [(0.2, -0.3), (0.32, -0.24), (0.44, -0.15), (0.66, -0.14), (0.76, -0.16)]
    pts += [(0.84 + 0.16 * math.cos(math.radians(a)), 0.16 * math.sin(math.radians(a))) for a in range(-80, 81, 8)]
    pts += [(0.76, 0.16), (0.66, 0.14), (0.44, 0.15), (0.32, 0.24), (0.2, 0.3)]
    handle = prism_xy("刷毛の柄", pts, 0.2, M["coral"], g, bev=0.06, seg=6)
    handle.location.z = -0.1
    hole = cylinder("柄の穴", 0.045, 0.6, None, None, 32)
    hole.location = (0.89, 0, 0)
    hole.parent = g
    hole.hide_render = True
    hole.display_type = "WIRE"
    bo = handle.modifiers.new("穴", "BOOLEAN")
    bo.object = hole
    bo.operation = "DIFFERENCE"
    band_ = rounded_box("口金", (0.2, 0.56, 0.33), 0.05, M["ferrule"], g, 5)
    band_.location = (0.15, 0, 0)
    f = rounded_box("毛の根元", (0.2, 0.64, 0.28), 0.06, M["bristle3"], g, 5)  # 口金のそばはひとかたまり
    f.location = (0.0, 0, 0.0)
    for k in range(4):  # ふくらんだ 4 本の指（横どうしは触れて、深い溝が 3 本に見える）
        fk = rounded_box(f"毛の指{k}", (0.36, 0.17, 0.3), 0.045, M["bristle3"], g, 6)  # 溝は浅く（毛はまとまる）
        fk.location = (-0.09, -0.245 + k * 0.163, 0.0)
    t_ = rounded_box("毛先の墨", (0.26, 0.66, 0.27), 0.1, M["ink_tip"], g, 8)  # 先が黒く広がる
    t_.location = (-0.3, 0, -0.03)
    return g


HEX["ferrule"] = "#f08a9a"
M["ferrule"] = material("口金の桃", "ferrule", rough=0.35, coat=0.15)
br = brush2(None)
br.scale = (0.84, 0.84, 0.84)
br.location = P(603, 398, 0.14)
br.rotation_euler = (math.radians(-4), math.radians(-6), math.radians(56))
ink_puddle("墨だまり", *P(522, 492)[:2], 0.13, M["ink_drop"]).scale = (0.9, 1.6, 0.6)
for i, (r_, px, py) in enumerate(((R(8), 505, 440), (R(10), 585, 512))):
    d = mesh_sphere(f"墨のしずく{i}", r_, M["ink_drop"], None)
    d.scale = (1.15, 1.0, 0.5)
    d.location = P(px, py, r_ * 0.45)


def round_lock(name, r, body_mat, sh_mat, hole_mat=None, depth=0.6):
    """丸い錠：厚い円盤の胴（面はこちら。厚みは r*depth）、上に藤色のつる、面に鍵穴"""
    g = empty(name)
    body = cylinder(name + "の胴", r, r * depth, body_mat, g, 48)
    bevel(body, r * 0.22, 6)
    body.rotation_euler = (math.radians(90), 0, 0)
    sh = arc_tube(name + "のつる", r * 0.52, r * 0.16, 0, math.pi, sh_mat, g)
    sh.rotation_euler = (math.radians(90), 0, 0)
    sh.location = (0, r * 0.1, r * 0.75)
    for sgn in (-1, 1):
        leg = cylinder("つるの脚", r * 0.16, r * 0.3, sh_mat, g, 20)
        leg.location = (sgn * r * 0.52, r * 0.1, r * 0.7)
    hole = cylinder("鍵穴", r * 0.2, r * 0.3, hole_mat or M["keyhole"], g, 24)
    hole.rotation_euler = (math.radians(90), 0, 0)
    hole.location = (0, -r * depth / 2, r * 0.08)
    slot = rounded_box("鍵穴の下", (r * 0.12, r * 0.3, r * 0.3), r * 0.04, hole_mat or M["keyhole"], g, 2)
    slot.location = (0, -r * depth / 2, -r * 0.12)
    hole.parent = slot.parent = body.parent
    carve(body, [hole, slot], hole_mat or M["keyhole"])  # 彫り込んだ鍵穴（ref2）
    return g


HEX["keyhole_red"] = "#b0605a"
M["keyhole_red"] = material("鍵穴の赤", "keyhole_red", rough=0.5)
lk3 = round_lock("丸い錠", R(46), M["lock_coral"], M["shackle"], M["keyhole_red"], depth=0.5)  # 平たい円盤（ref2 側面 27px）
lk3.location = P(395, 565, R(46) * 0.75)
lk3.rotation_euler = (math.radians(-72), 0, math.radians(-35))
ky = key(None, M["key_ochre"], 0.98)
ky.location = P(507, 578, 0)
ky.rotation_euler = (0, 0, math.radians(232))
er = empty("消しゴム")
EL, EW, EH, ER = 1.1, 0.44, 0.35, 0.055  # 角の丸み ref2 約8px
xs = -EL / 2 + EL * 0.55
front = rounded_box("消しゴム（珊瑚）", (EL * 0.55 + 0.04, EW, EH), ER, M["eraser_coral"], er, 6)
front.location = ((-EL / 2 + xs + 0.04) / 2, 0, EH / 2)
back = rounded_box("消しゴム（藤）", (EL * 0.45 + 0.04, EW, EH), ER, M["periwinkle"], er, 6)
back.location = ((xs - 0.04 + EL / 2) / 2, 0, EH / 2)
sleeve = rounded_box("紙の帯", (0.2, EW + 0.006, EH + 0.006), ER * 0.8, M["white"], er, 5)
sleeve.location = (xs, 0, EH / 2)
er.location = P(420, 888, 0)
er.rotation_euler = (0, 0, math.radians(40))
okg = empty("✓の丸の札")
ok1 = cylinder("✓の丸", R(40), 0.07, M["check2"], okg, 48)
bevel(ok1, 0.02, 3)
ck1 = check_mark("✓", 0.15, 0.03, M["white"], okg)
ck1.location = (0, 0, 0.04)
okg.location = P(610, 866, 0.035)
okg.rotation_euler = (math.radians(12), 0, math.radians(-10))

# 右：傾けたペンを、重ねた薄い円盤のスタンプ台に押しつける。手前に寝かせたマーカー
stp = empty("スタンプ")
for i, (h0, hh, m) in enumerate(((0.0, 0.03, "pad_yellow"), (0.03, 0.02, "pad_lilac"), (0.05, 0.05, "pad_coral"))):
    dsk = cylinder(f"スタンプ台{i}", R(43), hh, M[m], stp, 48)
    bevel(dsk, 0.015, 3)
    dsk.location.z = h0 + hh / 2
stp.location = P(1505, 723, 0)
stp.rotation_euler = (math.radians(-32), math.radians(24), math.radians(-20))  # ほぼ横から、面は右上へ倒れる（計算で比 0.19・向き 59°）  # ほぼ横から：上の面の楕円の比 約0.32（ref2）
pen = empty("マーカー")
PR, PL = 0.104, 1.26
pt = bpy.data.meshes.new("ペンの先")
bm = bmesh.new()
bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=PR * 0.5, radius2=PR * 0.9, depth=0.24)  # 先は太く切り落とす
bm.to_mesh(pt)
bm.free()
ptip = new_obj("ペンの先", pt, M["pen_navy"], pen)
ptip.location.z = 0.12
bevel(ptip, 0.01, 2)
pbody = capsule("ペンの胴", PL * 0.62, PR, M["pen_navy"], pen)
pbody.rotation_euler = (0, math.radians(90), 0)
pbody.location.z = 0.24 + PL * 0.31
win = rounded_box("ペンの窓", (0.075, 0.04, 0.5), 0.035, M["window"], pen, 4)
win.location = (0.0, -PR + 0.01, 0.24 + PL * 0.4)
HEX["pen_cap"] = "#a2ecd2"
M["pen_cap"] = material("ペンのふた", "pen_cap", rough=0.35, coat=0.15)
pcap = capsule("ペンのふた", PL * 0.22, PR * 1.06, M["pen_cap"], pen)
subsurf(pcap, 1)
subsurf(pbody, 1)  # 継ぎ目のぎざぎざを消す
pcap.rotation_euler = (0, math.radians(90), 0)
pcap.location.z = 0.24 + PL * 0.62 + PL * 0.12
pen.location = P(1512, 690, 0.16)
pen.rotation_euler = (0, math.radians(26), math.radians(6))
mk2 = empty("マーカー（寝かせ）")
LR, LL = 0.165, 1.24
M["mint_matte"] = material("マーカーの緑", "mint", rough=0.6, coat=0.0)
M["cap_matte"] = material("マーカーのふた", "cap_purple", rough=0.6, coat=0.0)
mt_ = bpy.data.meshes.new("マーカーの先")
bm = bmesh.new()
bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=LR * 0.46, radius2=LR * 0.28, depth=0.16)
bm.to_mesh(mt_)
bm.free()
mtip = new_obj("マーカーの先", mt_, M["mint_matte"], mk2)
bevel(mtip, 0.02, 3)
mtip.rotation_euler = (0, math.radians(-90), 0)
mtip.location = (-LL / 2 - 0.02, 0, LR)
mcap = capsule("マーカーのふた", LL * 0.105, LR * 0.6, M["cap_matte"], mk2)  # 細く短い首（ref2）
subsurf(mcap, 1)
mcap.location = (-LL / 2 + 0.06 + LL * 0.065 + LR * 0.4, 0, LR)
mbody = capsule("マーカーの胴", LL * 0.55, LR, M["mint_matte"], mk2)
subsurf(mbody, 1)  # 胴の筋を消す
mbody.location = (LL / 2 - LR - LL * 0.275, 0, LR)
mk2.location = P(1502, 887, 0)
mk2.rotation_euler = (0, 0, math.radians(-40))

# 右上：丸い錠と、丸い金の玉（宙に浮く）
HEX["gold_light"] = "#f7c16a"
HEX["coin_peach"] = "#f6c387"
M["coin_peach"] = material("淡い桃橙", "coin_peach", rough=0.4, coat=0.1)
M["gold_light"] = material("明るい金", "gold_light", rough=0.4, coat=0.1)
lk4 = round_lock("上の丸い錠", R(39), M["gold_light"], M["shackle"])
lk4.location = P(1337, 222, 0.62)
lk4.rotation_euler = (math.radians(-28), math.radians(-8), 0)
coin = empty("金の丸")
cn = cylinder("金の丸の胴", R(37), R(37) * 0.55, M["coin_peach"], coin, 48)
bevel(cn, R(37) * 0.25, 6)
cn.rotation_euler = (math.radians(90), 0, 0)
cn.scale = (0.92, 1.0, 1.05)
coin.location = P(1405, 256, 0.5)
coin.rotation_euler = (math.radians(-28), 0, math.radians(-40))


def bubble2(text, w, h, bg, fg, tail=None, icon=None, thick=0.14, rad=0.42, font=None, tsize=0.55, skew=0.0):
    """字の札：厚い角丸の板。tail：しっぽの場所（'bl' 左下、'b' 下、'br' 右下、'tr' 右上、'bump' 右下の丸いでっぱり、None なし）"""
    g = empty("札:" + text)
    outline = rrect(w, h, h * rad)
    if tail and tail != "bump":  # しっぽは板の輪郭に組み込む（同じ厚み・一続き。ref2）
        r_ = h * rad
        sx = {"bl": -0.25, "b": -0.05, "bc": 0.08, "br": 0.3, "tr": 0.2}[tail] * w
        sx = max(-(w / 2 - r_) + 0.1, min(w / 2 - r_ - 0.1, sx))
        n8 = 9  # rrect の角 1 つの点の数（n=8 → 9 点）
        if tail == "tr":
            ins = [(sx + 0.09, h / 2), (sx + 0.03, h / 2 + 0.07), (sx, h / 2 + 0.2), (sx - 0.04, h / 2 + 0.07), (sx - 0.09, h / 2)]  # 両脇が内へ反る
            outline = outline[:n8] + ins + outline[n8:]
        else:
            k_ = skew  # 画面で真下に見えるよう、先を右へずらす
            ins = [(sx - 0.09, -h / 2), (sx - 0.03 + 0.07 * k_, -h / 2 - 0.07), (sx + 0.2 * k_, -h / 2 - 0.2), (sx + 0.04 + 0.07 * k_, -h / 2 - 0.07), (sx + 0.09, -h / 2)]  # 両脇が内へ反る
            outline = outline[:3 * n8] + ins + outline[3 * n8:]
        outline = rpoly(outline, 0.04, 6)
    prism_xy("札の板", outline, thick, bg, g, bev=min(0.06, thick * 0.4), seg=7)
    if tail:
        if tail == "bump":
            bp = mesh_sphere("札のでっぱり", h * 0.2, bg, g)
            bp.scale = (1.3, 1.0, thick / (h * 0.4))  # 半径を大きくした分、縦の比を合わせて厚みは札と同じに
            bp.location = (w / 2 - h * 0.12, -h / 2 + 0.02, thick / 2)
    cjk = any(ord(ch) > 127 for ch in text)
    t = text3d(text, h * tsize, fg, g, extrude=0.009, bev=0.0, spacing=1.06 if cjk else 1.0, font=font)
    t.visible_shadow = False
    t.location = ((0.08 if icon else 0.0) * w, 0.0, thick + 0.002)
    if icon == "shield":
        pts = [(-0.1, 0.1), (0.1, 0.1), (0.1, 0.0), (0.06, -0.07), (0.0, -0.12), (-0.06, -0.07), (-0.1, 0.0)]
        ic = prism_xy("盾", pts, 0.04, M["red"], g, bev=0.012, seg=3)
        ic.location = (-w / 2 + 0.17, 0, thick)
        ck = check_mark("盾の✓", 0.11, 0.02, M["white"], g)
        ck.location = (-w / 2 + 0.17, 0.0, thick + 0.045)
    return g


def lay(ob, p, rz, tilt=12.0):
    ob.location = p
    ob.rotation_euler = (math.radians(tilt), 0, math.radians(rz))
    return ob


HEX["label_white"] = "#e4e6f2"
M["label_white"] = material("札の白", "label_white", rough=0.4, coat=0.1)
lay(bubble2("黒塗り", 0.78, 0.34, M["label_white"], M["text_gray"], tail="bc", rad=0.2, thick=0.13, skew=0.73), P(1192, 167, 0.75), -36, tilt=22)
lay(bubble2("個人情報", 0.78, 0.36, M["navy"], M["white"], tail="b", rad=0.22, skew=0.62), P(1550, 348, 0.45), -32, tilt=32)
lay(bubble2("墨消し", 0.62, 0.34, M["label_white"], M["text_gray"], tail="bump", thick=0.1, rad=0.48), P(402, 414, 0.1), -32, tilt=12)
lay(bubble2("作った人の名前", 1.58, 0.36, M["label_white"], M["text_gray"], tail="tr", icon="shield", rad=0.35), P(812, 968, 0.06), -38, tilt=4)
M["navy_matte"] = material("札の紺", "navy", rough=0.55, coat=0.0)
lay(bubble2("印鑑", 0.8, 0.31, M["navy_matte"], M["white"], thick=0.09, font=FONT_BOLD, tsize=0.72), P(1380, 965, 0.05), -31, tilt=8)
okb = empty("✓の吹き出し")
_r, _th = R(33), 0.11
_ta, _sg = math.radians(-68), 0.19  # しっぽの向きと太さ（ref2：中心から下やや右、先は半径の約 1.5 倍）
_pts = []
for i in range(160):
    a_ = 2 * math.pi * i / 160
    d_ = math.atan2(math.sin(a_ - _ta), math.cos(a_ - _ta))
    rr = _r * (1 + 0.64 * math.exp(-(d_ / _sg) ** 2))
    _pts.append((rr * math.cos(a_), rr * math.sin(a_)))
c = prism_xy("吹き出しの丸", _pts, _th, M["check_green"], okb, bev=_th * 0.45, seg=8)
c.location.z = -_th / 2
u_ = R(1)
def _stroke(p0, p1, rr):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    st = capsule("吹き出しの✓", math.hypot(dx, dy) * u_, rr * u_, M["white"], okb)
    st.location = ((p0[0] + p1[0]) / 2 * u_, (p0[1] + p1[1]) / 2 * u_, _th / 2 + 0.004)
    st.rotation_euler = (0, 0, math.atan2(dy, dx))
    st.scale = (1, 1, 0.75)
_k = (-10, -17)  # ✓の折れ目（中心からの画素。上が +）
_stroke((-18, -5), _k, 4.8)
_stroke(_k, (8, -1), 4.8)
okb.location = P(1307, 116, 0.95)
okb.rotation_euler = (math.radians(90 - ELEV - 10), 0, math.radians(-8))


# 星・紙吹雪・粒（ref2 の場所に 1 つずつ置く）
def arc_strip(name, length, width, mat):
    """細長い紙片を 1 方向にゆるく反らせたもの（ねじりなし）"""
    Rr = length / 2.3
    n = 24
    bm = bmesh.new()
    rows = []
    for i in range(n + 1):
        a = -1.15 + 2.3 * i / n  # 大きく弧を描く（ref2）
        rows.append([bm.verts.new((Rr * math.sin(a), yy, Rr * (1 - math.cos(a)))) for yy in (-width / 2, width / 2)])
    for i in range(n):
        bm.faces.new([rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]])
    me_ = bpy.data.meshes.new(name)
    bm.to_mesh(me_)
    bm.free()
    ob = new_obj(name, me_, mat)
    so = ob.modifiers.new("厚み", "SOLIDIFY")
    so.thickness = 0.007  # 薄い紙
    bevel(ob, 0.003, 2, 60)
    smooth(ob)
    return ob


def sparkle(name, r, p, mat):
    """ふくらんだ 4 つ角の星：輪郭を中心へ縮めた輪を重ね、高さを丸く上げる（表と裏）"""
    pts = []
    for i in range(96):
        t = 2 * math.pi * i / 96
        c_, sn = math.cos(t), math.sin(t)
        pts.append((r * (0.76 * c_ ** 3 + 0.24 * c_), r * (0.76 * sn ** 3 + 0.24 * sn)))  # 角は太めで先が丸い（ref2）
    H, K = r * 0.3, 10
    bm = bmesh.new()
    rings = {}
    for side in (1, -1):
        rs = []
        for k in range(K):
            s_ = 1 - k / K
            zz = side * H * math.sqrt(max(0.0, 1 - s_ * s_)) if k else 0.0
            if k == 0 and side == -1:
                rs.append(rings[1][0])
                continue
            w_ = 1 - s_  # 中心ほど円へ寄せる（角の筋を残さない）
            ring_ = []
            for (x, y) in pts:
                ang = math.atan2(y, x)
                cx_, cy_ = 0.4 * r * math.cos(ang), 0.4 * r * math.sin(ang)
                ring_.append(bm.verts.new(((x * (1 - w_) + cx_ * w_) * s_, (y * (1 - w_) + cy_ * w_) * s_, zz)))
            rs.append(ring_)
        rings[side] = rs
        top = bm.verts.new((0, 0, side * H))
        for k in range(K - 1):
            a_, b_ = rs[k], rs[k + 1]
            for i in range(len(pts)):
                f = [a_[i], a_[(i + 1) % len(pts)], b_[(i + 1) % len(pts)], b_[i]]
                bm.faces.new(f if side == 1 else list(reversed(f)))
        last = rs[-1]
        for i in range(len(pts)):
            f = [last[i], last[(i + 1) % len(pts)], top]
            bm.faces.new(f if side == 1 else list(reversed(f)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me_ = bpy.data.meshes.new(name)
    bm.to_mesh(me_)
    bm.free()
    s = new_obj(name, me_, mat)
    subsurf(s, 1)
    s.location = p
    s.rotation_euler = (math.radians(90 - ELEV - 15), 0, math.radians(-8))
    return s


for i, (px, py, rp, m) in enumerate(((573, 265, 22, "star_gold"), (735, 228, 22, "star_gold"), (1497, 197, 36, "star_gold"), (1598, 117, 26, "star_gold"))):
    sparkle(f"星{i}", R(rp), P(px, py, 0.35), M[m])
HEX["star5"] = "#f8c87a"
M["star5"] = material("5 つ角の星", "star5", rough=0.35, coat=0.2)
for i, (px, py, rp) in enumerate(((1365, 745, 15), (1345, 860, 12), (1597, 795, 14))):  # 右下は黄色の 5 つ角（ref2）
    st5 = star(f"星5_{i}", R(rp), R(rp) * 0.5, R(rp) * 0.5, M["star5"])
    st5.location = P(px, py, 0.35)
    st5.rotation_euler = (math.radians(90 - ELEV - 15), 0, math.radians(-8 + 17 * i))
for i, (px, py, m, a, ln_) in enumerate(((515, 95, "conf_lilac_deep", 70, 48), (712, 122, "conf_coral", -30, 42), (675, 185, "conf_blue", 50, 44),
                                         (480, 233, "conf_coral", 35, 44), (632, 262, "conf_mint", -65, 46), (443, 715, "conf_pink", 70, 44),
                                         (1503, 575, "conf_pink", -25, 40), (1212, 968, "conf_blue", 30, 38), (1275, 845, "conf_mint", -40, 38))):
    st = arc_strip(f"紙片{i}", R(ln_ * 1.35), R(22), M[m])
    st.location = P(px, py, 0.4)
    st.rotation_mode = "ZYX"
    st.rotation_euler = (math.radians(-ELEV + 45), math.radians(180 + (15 if i % 2 else -15)), math.radians(a))  # 弧を斜め横から、上へふくらむ ⌒（ref2）
for i, (px, py, rp, m) in enumerate(((620, 107, 8, "white"), (585, 170, 13, "yellow"), (770, 175, 8, "white"), (778, 276, 8, "lilac_deep"), (755, 323, 6, "yellow"),
                                      (527, 330, 8, "white"), (1527, 77, 10, "dot_blue"), (1405, 115, 7, "yellow"), (1462, 132, 12, "dot_pink"), (1605, 182, 6, "yellow"),
                                      (1652, 210, 9, "dot_blue"), (1588, 248, 20, "dot_pink"), (1548, 488, 16, "dot_blue"), (1532, 550, 5, "navy"), (1490, 544, 5, "yellow"),
                                      (1585, 725, 7, "magenta"), (1556, 790, 7, "white"), (1584, 762, 6, "dot_teal"), (1310, 770, 11, "white"), (1420, 765, 8, "white"), (1322, 812, 8, "dot_mint"),
                                      (1263, 815, 5, "dot_mint"), (385, 672, 20, "yellow"), (325, 763, 7, "dot_blue"), (355, 775, 6, "dot_pink"), (410, 758, 8, "yellow"),
                                      (460, 763, 8, "dot_pink"), (520, 773, 5, "lilac_deep"), (482, 738, 3, "lilac_deep"))):
    on_floor = py >= 700
    z = 0.3 if not on_floor else R(rp) * 0.65 * 0.85  # 床の粒はつぶれて床に付く（ref2）
    d = mesh_sphere(f"粒{i}", R(rp), M["dot2_" + m], None)
    if on_floor:
        d.scale = (1.1, 1.1, 0.65)
    d.location = P(px, py, z)

# 正方形：まわりの小物と札を、紙の近くへ寄せる（端で切れないように）
if WIDTH <= HEIGHT * 1.2:
    for ob in list(col.objects):
        if ob.parent is None and ob.name != "紙の向き":
            ob.location.x = paper_rig.location.x + (ob.location.x - paper_rig.location.x) * 0.72


# 床：影だけ写す（地の色は、書き出したあとに敷く）
me = bpy.data.meshes.new("床")
bm = bmesh.new()
bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=30)
bm.to_mesh(me)
bm.free()
floor = new_obj("床", me)
floor.is_shadow_catcher = True
if "--no-floor" in argv:  # 物だけを書き出す（縁に影が混ざらないように。影は床ありの絵から取って、あとで敷く）
    floor.hide_render = True

# ── 光：左上からの大きな面の光（影は薄くやわらかく） ──────────────
key_data = bpy.data.lights.new("左上の光", "AREA")
key_data.energy = float(arg("--key", "1200"))
key_data.size = 14
key_data.color = (1.0, 0.98, 0.97)
kl = bpy.data.objects.new("左上の光", key_data)
col.objects.link(kl)
kl.location = (-5.0, 4.0, 7.5)
kl.rotation_euler = Vector((5.0, -4.0, -7.5)).to_track_quat("-Z", "Y").to_euler()
world = bpy.data.worlds.new("空")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.95, 0.96, 1.0, 1.0)
bg.inputs["Strength"].default_value = float(arg("--world", "0.6"))
scene.world = world

# ── カメラ：遠近のない見下ろし ─────────────────────
cam_data = bpy.data.cameras.new("カメラ")
cam_data.type = "ORTHO"
cam_data.ortho_scale = WIDE if WIDTH > HEIGHT * 1.2 else WIDE * 0.6
cam = bpy.data.objects.new("カメラ", cam_data)
col.objects.link(cam)
target = TGT.copy()
elev = math.radians(ELEV)
cam.location = target + Vector((0, -math.cos(elev), math.sin(elev))) * 20
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam

r = scene.render
r.engine = "CYCLES"
r.resolution_x = WIDTH
r.resolution_y = HEIGHT
r.film_transparent = True
r.image_settings.file_format = "PNG"
r.image_settings.color_mode = "RGBA"
r.filepath = OUT
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.cycles.use_adaptive_sampling = True
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
scene.view_settings.exposure = float(arg("--expo", "0.3"))
if not USE_CPU:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.refresh_devices()
            gpus = [d for d in prefs.devices if d.type == kind]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                break
        except TypeError:
            continue
if "--bbox" in argv:
    from bpy_extras.object_utils import world_to_camera_view
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()

    def under(ob, prefixes):
        while ob is not None:
            if any(ob.name == p or (p.endswith("*") and ob.name.startswith(p[:-1])) for p in prefixes):  # 名前が同じか、* で始まりが同じ
                return True
            ob = ob.parent
        return False

    def bbox(prefixes):
        xs, ys = [], []
        for ob in scene.objects:
            if ob.type != "MESH" or not under(ob, prefixes):
                continue
            ev = ob.evaluated_get(dg)
            mw = ev.matrix_world
            for v in ev.data.vertices:
                c = world_to_camera_view(scene, cam, mw @ v.co)
                xs.append(c.x)
                ys.append(1 - c.y)
        return [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)] if xs else None

    import json
    groups = {"paper": ["紙の向き"], "eraser": ["消しゴム"], "brush": ["刷毛", "墨だまり", "墨のしずく*"], "lbl_sumikeshi": ["札:墨消し"],
              "lock_key": [lk3.name, ky.name], "check_lowleft": ["✓の丸の札"], "lbl_author": ["札:作った人の名前"], "lbl_stamp": ["札:スタンプ"],
              "marker_lying": [mk2.name], "pen_stamp": [pen.name, "スタンプ"], "lbl_kojin": ["札:個人情報"], "lbl_kuro": ["札:黒塗り", "✓の吹き出し"],
              "locks_top": [lk4.name, coin.name], "eye": ["目の札"]}
    out = {k: bbox(v) for k, v in groups.items()}
    print("[bbox]", out)
    if "--bbox-out" in argv:
        open(arg("--bbox-out", ""), "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False))
if "--no-render" not in argv:
    bpy.ops.render.render(write_still=True)
    print(f"[3d] 書き出し：{OUT}")
