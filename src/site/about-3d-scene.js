// SPDX-License-Identifier: AGPL-3.0-only
//
// about の最初の画面の 3D（q47 の場面を three.js で描く。2026-11-06 本人が承認）。
// - 形と色は about-3d-data.js（design/3d/export_about3d.py で、Blender の場面から書き出したもの）。頂点の色は物の色だけ。
//   光は q47 と同じ向きの柔らかい光（左上から）と空の光、物どうしの影は three.js の影で付ける。地と床の影は、下に敷く絵（data-plate）が受け持つ。
// - site-3d.js（読み込み役）が、ページを読み終えて手が空いたあとに import() で読む。描けなかったら false を返し、q47 の絵のまま。
// - 通信をしない。three.js の読み込み（Loader）の仕組みも使わない（scripts/check-dist.mjs が通信の仕組みを探す）。
//   形は JS の中の字（base64）から、ブラウザの中で伸ばす（DecompressionStream）。
// - 動きはゆっくり浮くのと、指（マウス）の位置で少し傾くだけ。カメラは回さない（裏側は作っていない）。画面の外・裏のタブでは止める。

import {
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PMREMGenerator,
  VSMShadowMap,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
// 映り込みの元にする部屋の明かり（three.js に付いてくるもの。コードで箱を並べて作る。ファイルは読まない）
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DATA, META } from "./about-3d-data.js";

/** base64 → raw deflate を伸ばしたバイト列（通信はしない。Blob とストリームはブラウザの中だけ） */
async function inflate(b64) {
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** 書き出した並び（位置 x・y・z、色 r・g・b、三角の番号の差分）から、three.js の形を組む */
function geometryFrom(bytes) {
  const nv = META.vertices;
  const nt = META.triangles;
  const need = nv * 6 + nv * 3 + nt * 12;
  if (bytes.length !== need) throw new Error("形の大きさが合いません");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pos = new Float32Array(nv * 3);
  for (let a = 0; a < 3; a++) {
    const base = a * nv * 2;
    const lo = META.lo[a];
    const sp = META.span[a] / 65535;
    for (let i = 0; i < nv; i++) pos[i * 3 + a] = lo + dv.getUint16(base + i * 2, true) * sp;
  }
  // 色は sRGB の 8 ビットで来る。three.js の頂点の色は直線の値なので、ここで直す
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    // 暗い所を少し持ち上げ、明るい所を少し抑える（q47 の書き出しと、物ごとに色を測って合わせた。黒い帯・淡い緑など）
    lut[i] = 0.035 + 0.88 * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  }
  const col = new Float32Array(nv * 3);
  const cbase = nv * 6;
  for (let ch = 0; ch < 3; ch++) for (let i = 0; i < nv; i++) col[i * 3 + ch] = lut[bytes[cbase + ch * nv + i]];
  const ibase = nv * 9;
  const index = new Uint32Array(nt * 3);
  let prev = 0;
  for (let i = 0; i < nt * 3; i++) {
    const z = dv.getUint32(ibase + i * 4, true);
    prev += z & 1 ? -((z + 1) >>> 1) : z >>> 1;
    if (prev < 0 || prev >= nv) throw new Error("三角の番号が範囲の外です");
    index[i] = prev;
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("color", new BufferAttribute(col, 3));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeVertexNormals(); // 角の立った所は、書き出しのときに頂点を分けてある
  g.computeBoundingBox();
  return g;
}

function loadImage(src) {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  return img.decode().then(() => img);
}

/**
 * box（中に q47 の絵 <img>。data-plate に、物を除いた地と影の絵）に 3D を描く。描けたら true。
 * 絵と同じ 16:9 の枠に、同じカメラ（遠近のない見下ろし）で描くので、はじめの姿は q47 の絵と重なる。
 */
export async function mount(box) {
  const shot = box.querySelector("img");
  const plateSrc = box.getAttribute("data-plate") || "";
  if (!shot || !/^\/assets\/about-hero-bg-[0-9a-f]{10}\.webp$/.test(plateSrc)) return false;
  if (typeof DecompressionStream !== "function") return false;
  let renderer;
  try {
    const [bytes, plate] = await Promise.all([inflate(DATA), loadImage(plateSrc)]);
    const geo = geometryFrom(bytes);

    const canvas = document.createElement("canvas");
    canvas.className = "lp-hero-canvas";
    canvas.setAttribute("aria-hidden", "true");
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = VSMShadowMap; // ぼかせる影（q47 の影は淡くやわらかい）

    const scene = new Scene();
    const hw = META.halfWidth;
    const hh = hw * META.aspect;
    const cam = new OrthographicCamera(-hw, hw, hh, -hh, 0.01, 200);
    // q47（Cycles）は、明るい空がつやのある面に映り込み、暗い物や横の面も灰色寄りに明るく見える。部屋の明かりを映り込みの元にして寄せる
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.38;
    pmrem.dispose();
    const mesh = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // 傾ける中心は形の真ん中（紙の束のあたり）
    const c = geo.boundingBox.getCenter(mesh.position.clone());
    mesh.position.set(-c.x, -c.y, -c.z);
    const pivot = new Group();
    pivot.position.copy(c);
    pivot.add(mesh);
    scene.add(pivot);

    // 光：空（上からの白っぽい光と、下からの藤色の照り返し）と、左上から差す面の光（q47 の光の向き）
    const ex = META.exposure;
    const up = new Vector3(...META.up);
    const sky = new HemisphereLight(0xfaf8f6, 0xe2d6e6, 1.2 * ex);
    sky.position.copy(up);
    scene.add(sky);
    const key = new DirectionalLight(0xfff8f2, 1.7 * ex);
    const kd = new Vector3(...META.key);
    key.position.copy(c).addScaledVector(kd, 30);
    key.target.position.copy(c);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    const R = Math.max(...META.span) * 0.75;
    sc.left = -R;
    sc.right = R;
    sc.top = R;
    sc.bottom = -R;
    sc.near = 1;
    sc.far = 60;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.04; // 丸い物に自分の影の縞が出ないように
    key.shadow.radius = 10; // ぼかしの広さ
    key.shadow.blurSamples = 16;
    key.shadow.intensity = 0.55; // 影の濃さ（1 で真っ暗）。q47 の影は淡い
    scene.add(key, key.target);

    const size = () => {
      const w = Math.max(1, box.clientWidth);
      const h = Math.max(1, Math.round(w * META.aspect));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
    };
    size();

    // 動き：ゆっくり浮く（紙の束の高さの 1% ほど）、指の位置で ±2.5° 傾く（ゆっくり追う）
    const target = { x: 0, y: 0 };
    const now = { x: 0, y: 0 };
    const onMove = (ev) => {
      const r = box.getBoundingClientRect();
      target.y = ((ev.clientX - r.left) / Math.max(1, r.width) - 0.5) * 0.087;
      target.x = ((ev.clientY - r.top) / Math.max(1, r.height) - 0.5) * 0.087;
    };
    const onLeave = () => {
      target.x = 0;
      target.y = 0;
    };
    let running = false;
    let visible = true;
    let raf = 0;
    const t0 = performance.now();
    const frame = (t) => {
      raf = 0;
      if (!running) return;
      const s = (t - t0) / 1000;
      now.x += (target.x - now.x) * 0.06;
      now.y += (target.y - now.y) * 0.06;
      pivot.rotation.set(now.x, now.y, 0);
      pivot.position.y = c.y + Math.sin(s * 0.9) * hh * 0.012;
      renderer.render(scene, cam);
      raf = requestAnimationFrame(frame);
    };
    const update = () => {
      const want = visible && document.visibilityState === "visible";
      if (want && !running) {
        running = true;
        if (!raf) raf = requestAnimationFrame(frame);
      } else if (!want) running = false;
    };

    // はじめの 1 枚を描いてから、絵を地と影の絵に替える（物が消える一瞬を作らない）
    renderer.render(scene, cam);
    box.append(canvas);
    // 絵は srcset で出し分けているので、src だけでなく srcset も外す（残すと srcset の方が出たまま）
    const original = { src: shot.getAttribute("src"), srcset: shot.getAttribute("srcset") };
    shot.removeAttribute("srcset");
    shot.src = plate.src;
    box.classList.add("is-3d");

    const io = new IntersectionObserver((ents) => {
      visible = ents.some((e) => e.isIntersecting);
      update();
    });
    io.observe(box);
    document.addEventListener("visibilitychange", update);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerleave", onLeave);
    new ResizeObserver(() => {
      size();
      renderer.render(scene, cam);
    }).observe(box);
    canvas.addEventListener("webglcontextlost", (ev) => {
      // 描けなくなったら、q47 の絵に戻す
      ev.preventDefault();
      running = false;
      io.disconnect();
      canvas.remove();
      if (original.srcset) shot.setAttribute("srcset", original.srcset);
      shot.src = original.src;
      box.classList.remove("is-3d");
    });
    update();
    return true;
  } catch {
    if (renderer) renderer.dispose();
    return false;
  }
}
