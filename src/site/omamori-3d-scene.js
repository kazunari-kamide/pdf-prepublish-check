// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のページの見出しまわりの 3D の飾り（three.js で描く）。形はすべてコードで組み立てる：
//   傾けて重ねた PDF の紙 3 枚・いちばん上の紙の行と黒塗りの帯・緑の「✓」の札。外のモデルのファイル・画像・書体は読み込まない。
// - site-3d.js（読み込み役）が、ページを読み終えて手が空いたあとに import() で読む。読み込みに失敗しても、CSS の版（A）が残る。
// - 通信をしない。three.js の部品のうち、読み込み（Loader）の仕組みは使わない（scripts/check-dist.mjs が通信の仕組みを探す）。
// - 動きはゆっくり上下に浮くだけ。画面の外・裏のタブでは止める（電池と CPU を使わないため）。

import {
  AmbientLight,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Shape,
  ExtrudeGeometry,
  SRGBColorSpace,
  WebGLRenderer,
  CircleGeometry,
  MeshBasicMaterial,
} from "three";

// 色は design/tokens.css・design/sheet.css の値（墨・紙・行・紅の薄い地・緑）
const C = {
  ink: 0x2b2a28,
  paper: 0xffffff,
  paperBack: 0xf7f5f1,
  edge: 0xd9d4ca,
  line: 0xe2ded6,
  ok: 0x2f6f5e,
  okLight: 0xffffff,
};

function sheet(z, color) {
  const m = new Mesh(new BoxGeometry(1.2, 1.5, 0.03), [
    new MeshStandardMaterial({ color: C.edge, roughness: 0.9 }),
    new MeshStandardMaterial({ color: C.edge, roughness: 0.9 }),
    new MeshStandardMaterial({ color: C.edge, roughness: 0.9 }),
    new MeshStandardMaterial({ color: C.edge, roughness: 0.9 }),
    new MeshStandardMaterial({ color, roughness: 0.85 }),
    new MeshStandardMaterial({ color: C.paperBack, roughness: 0.9 }),
  ]);
  m.position.z = z;
  return m;
}

function bar(x, y, w, h, color, z) {
  const m = new Mesh(new BoxGeometry(w, h, 0.012), new MeshStandardMaterial({ color, roughness: 0.6 }));
  m.position.set(x, y, z);
  return m;
}

/** 緑の丸い札に、白の「✓」を浮かせる */
function badge() {
  const g = new Group();
  const disc = new Mesh(new CylinderGeometry(0.28, 0.28, 0.08, 48), new MeshStandardMaterial({ color: C.ok, roughness: 0.45, metalness: 0.05 }));
  disc.rotation.x = Math.PI / 2;
  g.add(disc);
  const s = new Shape();
  s.moveTo(-0.13, 0.0);
  s.lineTo(-0.04, -0.09);
  s.lineTo(0.14, 0.1);
  s.lineTo(0.1, 0.14);
  s.lineTo(-0.04, -0.01);
  s.lineTo(-0.09, 0.04);
  s.closePath();
  const check = new Mesh(new ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: false }), new MeshStandardMaterial({ color: C.okLight, roughness: 0.5 }));
  check.position.z = 0.04;
  g.add(check);
  return g;
}

/**
 * container の中に canvas を置いて描く。描けなければ false を返す（呼んだ側は CSS の版を残す）。
 * @param {HTMLElement} container
 */
export function mount(container) {
  let renderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return false;
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "site-hero-canvas";

  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 0.1, 4.4);

  scene.add(new AmbientLight(0xffffff, 1.6));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(-2, 3, 4);
  scene.add(sun);

  // 紙の束：傾けて、少しずつずらして重ねる
  const stack = new Group();
  stack.add(sheet(0, C.paperBack), sheet(0.12, C.paper), sheet(0.24, C.paper));
  const top = 0.24 + 0.016;
  stack.add(bar(-0.08, 0.5, 0.8, 0.05, C.line, top));
  stack.add(bar(-0.08, 0.3, 0.8, 0.11, C.ink, top)); // 黒塗りの帯
  stack.add(bar(-0.08, 0.1, 0.8, 0.05, C.line, top));
  stack.add(bar(-0.2, -0.08, 0.56, 0.05, C.line, top));
  stack.add(bar(-0.08, -0.26, 0.8, 0.05, C.line, top));
  const b = badge();
  b.position.set(0.55, 0.72, 0.5);
  stack.add(b);
  stack.rotation.set(-0.95, 0, -0.62);
  scene.add(stack);

  // 下に落ちるやわらかい影（丸い薄い墨。光の計算はしない）
  const shadow = new Mesh(new CircleGeometry(1.0, 48), new MeshBasicMaterial({ color: C.ink, transparent: true, opacity: 0.08 }));
  shadow.scale.set(0.8, 0.28, 1);
  shadow.position.set(0.05, -0.95, -0.6);
  scene.add(shadow);

  container.append(canvas);

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  new ResizeObserver(resize).observe(container);

  let visible = true;
  new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
  }).observe(container);

  const start = performance.now();
  renderer.setAnimationLoop(() => {
    if (!visible || document.hidden) return;
    const t = (performance.now() - start) / 1000;
    stack.position.y = Math.sin(t * 0.9) * 0.06; // ゆっくり浮く
    stack.rotation.z = -0.62 + Math.sin(t * 0.45) * 0.04;
    b.rotation.y = Math.sin(t * 1.2) * 0.25;
    shadow.material.opacity = 0.08 - stack.position.y * 0.25;
    renderer.render(scene, camera);
  });
  return true;
}
