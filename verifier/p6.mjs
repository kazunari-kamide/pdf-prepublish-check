// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器：P6（見せかけの黒塗り）
//
// PDF を1つ受け取り、「覆っているもの（濃い塗り・濃い画像・注釈）の下に、まだ中身が残っている所」を返す。
// - 検査器（src/）・検出ルール（rules/）のコードは import しない。読み方も変える（PDF.js の描画命令の列を使う）。
// - 片付けた側の報告は受け取らない。ファイルだけを見て、ゼロから判定する。
// - 残っている中身そのもの（字）は、既定では返さない。
//
// 考え方：ページは描く命令の並び。あとに描いたものが上に重なる。
//   字の層   … 先に描いた字の上に、あとから濃いものが重なっていれば「字が残っている」
//   画像の層 … 先に描いた画像の上に、あとから濃いものが重なり、その下の画素に
//              「紙の色」と「インクの色」が両方あれば「画像の中身が残っている」
//              （全部が濃ければ、画像の画素そのものが塗られている＝正しく消してある）
//              （全部が紙の色なら、もともと何も書かれていない）

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// 手元の pdfjs-dist に入っている Adobe の字の対応表（cmaps/）の場所（2026-11-06 から。ファイルを読むだけで、通信はしない）。
// 渡さないと、決まった字の対応表（90ms-RKSJ-H・UniJIS-UCS2-H など）や ToUnicode のない Adobe-Japan1 の書体の字を、PDF.js が黙って 0 個にする
const CMAP_URL = (() => {
  try {
    const build = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")));
    return `${path.join(build, "..", "..", "cmaps").split(path.sep).join("/")}/`;
  } catch {
    return undefined;
  }
})();

export const VERIFIER_NAME = "omamori-verifier-p6";
export const VERIFIER_VERSION = "0.3.0";

// 判定に使う値。合成 PDF（fixtures/p6/）で測って決めた（proposals/p6/verifier/README.md に測った値を書く）。
export const THRESHOLDS = Object.freeze({
  // 塗りを「濃い」とみなす明るさ（0＝黒、1＝白）の上限
  darkLuminance: 0.3,
  // 塗りを「覆っている」とみなす不透明さの下限
  minAlpha: 0.9,
  // 字の箱のうち、この割合以上が覆われていれば「覆われた字」
  glyphCoverRatio: 0.5,
  // 線で描いた図形（四角など）を、外枠の箱とみなせる面積の割合の下限。
  // これより小さい図形（楕円・回した四角・角の丸い四角など）は、箱でなく形そのもので、字や画素が中にあるかを見る
  polygonFillRatio: 0.9,
  // 画像を「覆うもの」とみなす：濃い画素の割合の下限
  coverImageDarkRatio: 0.95,
  // 画像の層：インク（濃い画素）とみなす明るさの上限 / 紙の色とみなす明るさの下限
  inkLuminance: 0.5,
  paperLuminance: 0.5,
  // 画像の層：覆われた範囲で、インクの画素・紙の画素がこの割合以上あれば「中身が残っている」
  minInkRatio: 0.005,
  minPaperRatio: 0.02,
});

// 壊れた・巨大な PDF で止まらないための上限
export const LIMITS = Object.freeze({
  maxBytes: 200 * 1024 * 1024,
  maxPages: 2000,
  maxOpsPerPage: 300_000,
  maxImagePixels: 40_000_000,
  maxSampledPixelsPerRegion: 4_000_000,
});

const OPS = pdfjs.OPS;
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
const FILL_OPS = new Set([
  OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
]);
const STROKE_OPS = new Set([
  OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
]);
// 偶奇の決まりで塗る命令（f* など）。ほかは、巻き数が 0 でない所を塗る
const EO_FILL_OPS = new Set([OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke]);
// 曲線を、何本の直線に分けて形を近似するか
const CURVE_STEPS = 8;
// 形で見る覆いで、字の箱の中に置く点の数（1辺あたり）。点のうち形の中にある割合を「覆われた割合」とする
const GLYPH_SAMPLES = 8;

// ---------- 行列と箱 ----------
const IDENTITY = [1, 0, 0, 1, 0, 0];
function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}
function boxOfPoints(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
function boxOfRect(m, x0, y0, x1, y1) {
  return boxOfPoints([apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)]);
}
function area(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}
function intersect(a, b) {
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}
function round2(b) {
  return b.map((v) => Math.round(v * 100) / 100);
}
// 3次・2次のベジエ曲線の、t の位置の点
function bez3(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}
function bez2(p0, p1, p2, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}
// 点 (x, y) が、多角形の集まり（閉じた部分ごと）の塗られる所にあるか。
// 右へ伸ばした半直線と辺の交わりを数える。偶奇なら交わりの数、そうでなければ巻き数（向きつきの数）で決める
function insideShape(polys, evenOdd, x, y) {
  let winding = 0;
  let crossings = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yj <= y === yi <= y) continue;
      const xc = xj + ((y - yj) * (xi - xj)) / (yi - yj);
      if (x < xc) {
        crossings++;
        winding += yi > yj ? 1 : -1;
      }
    }
  }
  return evenOdd ? (crossings & 1) === 1 : winding !== 0;
}
// 覆いが点 (x, y) を覆っているか。形を持たない覆い（四角に近いもの）は箱で見る
function coverContains(c, x, y) {
  if (!c.polys) return x >= c.box[0] && x <= c.box[2] && y >= c.box[1] && y <= c.box[3];
  return insideShape(c.polys, c.evenOdd, x, y);
}
// 字の箱のうち、覆いに隠れている割合。四角に近い覆いは面積で、形で見る覆いは字の箱の中に置いた点で測る
function coveredRatio(gbox, c) {
  const ov = intersect(gbox, c.box);
  if (!ov) return 0;
  if (!c.polys) return area(ov) / area(gbox);
  const w = gbox[2] - gbox[0];
  const h = gbox[3] - gbox[1];
  let hit = 0;
  for (let i = 0; i < GLYPH_SAMPLES; i++) {
    for (let j = 0; j < GLYPH_SAMPLES; j++) {
      const x = gbox[0] + ((i + 0.5) * w) / GLYPH_SAMPLES;
      const y = gbox[1] + ((j + 0.5) * h) / GLYPH_SAMPLES;
      if (insideShape(c.polys, c.evenOdd, x, y)) hit++;
    }
  }
  return hit / (GLYPH_SAMPLES * GLYPH_SAMPLES);
}
// 行列が「回転なし・裏返しなし」か（または 90 度単位か）。斜めのものは箱で近似できないので覆いにしない
function isAxisAligned(m) {
  const eps = 1e-6;
  return (Math.abs(m[1]) < eps && Math.abs(m[2]) < eps) || (Math.abs(m[0]) < eps && Math.abs(m[3]) < eps);
}

// ---------- 色 ----------
function luminanceOfHex(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function luminanceOfRgbBytes(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// ---------- 描く状態 ----------
function newState() {
  return {
    ctm: IDENTITY,
    fillLum: 0, // 既定の塗りの色は黒
    strokeLum: 0,
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    // 字の状態
    font: null,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    textMatrix: IDENTITY,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
  };
}
function cloneState(s) {
  return { ...s };
}

// 道の中身から、外枠の箱（ページの座標）と「箱をどれだけ埋めているか」を出す。
// flatten のときは、曲線を CURVE_STEPS 本の直線に分けて形（polys）を作り、面積もその形で測る。
// flatten でないときは、曲線の面積を端の点を結んだ弦で近似する（形は作らない。重いページで軽く読むため）
function analysePath(ctm, data, flatten = false) {
  const pts = [];
  let polyArea = 0;
  let hasCurve = false;
  let segments = 0;
  const lines = []; // 直線の線分（始点・終点）。同じ点への moveTo が続いても、線分だけを数える
  const polys = []; // 閉じた部分ごとの点の並び（flatten のときだけ）
  for (const sub of data ?? []) {
    if (!sub || typeof sub.length !== "number") continue;
    let i = 0;
    let poly = [];
    const flush = () => {
      if (poly.length >= 3) {
        let a = 0;
        for (let k = 0; k < poly.length; k++) {
          const [x1, y1] = poly[k];
          const [x2, y2] = poly[(k + 1) % poly.length];
          a += x1 * y2 - x2 * y1;
        }
        polyArea += Math.abs(a) / 2;
        if (flatten) polys.push(poly);
      }
      poly = [];
    };
    while (i < sub.length) {
      const op = sub[i++];
      if (op === DRAW.moveTo) {
        flush();
        const p = apply(ctm, sub[i], sub[i + 1]); i += 2;
        poly.push(p); pts.push(p);
      } else if (op === DRAW.lineTo) {
        const p = apply(ctm, sub[i], sub[i + 1]); i += 2;
        if (poly.length) lines.push([poly[poly.length - 1], p]);
        poly.push(p); pts.push(p); segments++;
      } else if (op === DRAW.curveTo) {
        // 曲線は、制御点を箱に入れる。面積は、flatten なら分けた直線で、そうでなければ端点を結んだ弦で近似する
        const c1 = apply(ctm, sub[i], sub[i + 1]);
        const c2 = apply(ctm, sub[i + 2], sub[i + 3]);
        pts.push(c1, c2);
        const p = apply(ctm, sub[i + 4], sub[i + 5]); i += 6;
        if (flatten && poly.length) {
          const p0 = poly[poly.length - 1];
          for (let k = 1; k < CURVE_STEPS; k++) poly.push(bez3(p0, c1, c2, p, k / CURVE_STEPS));
        }
        poly.push(p); pts.push(p); hasCurve = true; segments++;
      } else if (op === DRAW.quadraticCurveTo) {
        const c1 = apply(ctm, sub[i], sub[i + 1]);
        pts.push(c1);
        const p = apply(ctm, sub[i + 2], sub[i + 3]); i += 4;
        if (flatten && poly.length) {
          const p0 = poly[poly.length - 1];
          for (let k = 1; k < CURVE_STEPS; k++) poly.push(bez2(p0, c1, p, k / CURVE_STEPS));
        }
        poly.push(p); pts.push(p); hasCurve = true; segments++;
      } else if (op === DRAW.closePath) {
        flush();
      } else {
        break; // 知らない命令。ここで読むのをやめる
      }
    }
    flush();
  }
  if (pts.length === 0) return null;
  const box = boxOfPoints(pts);
  const a = area(box);
  return { box, fillRatio: a > 0 ? polyArea / a : 0, polyArea, hasCurve, segments, lines, polys };
}

// ---------- 画像の画素 ----------
function getObj(store, id) {
  return new Promise((resolve) => {
    try {
      store.get(id, (v) => resolve(v));
    } catch {
      resolve(null);
    }
  });
}

// pdfjs の画像データを「明るさを返す関数」にする
function pixelReader(img) {
  if (!img || !img.data || !img.width || !img.height) return null;
  const { width, height, data, kind } = img;
  if (width * height > LIMITS.maxImagePixels) return null;
  if (kind === pdfjs.ImageKind.RGBA_32BPP) {
    return { width, height, lum: (px, py) => {
      const o = (py * width + px) * 4;
      return luminanceOfRgbBytes(data[o], data[o + 1], data[o + 2]);
    } };
  }
  if (kind === pdfjs.ImageKind.RGB_24BPP) {
    return { width, height, lum: (px, py) => {
      const o = (py * width + px) * 3;
      return luminanceOfRgbBytes(data[o], data[o + 1], data[o + 2]);
    } };
  }
  if (kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    return { width, height, lum: (px, py) => {
      const byte = data[py * rowBytes + (px >> 3)];
      return (byte >> (7 - (px & 7))) & 1 ? 1 : 0;
    } };
  }
  return null;
}

// 画像の全体で、濃い画素の割合（覆う画像かどうかを見るため。粗く間引いて数える）
function darkRatioOfImage(reader) {
  const step = Math.max(1, Math.floor(Math.sqrt((reader.width * reader.height) / 250_000)));
  let n = 0, dark = 0;
  for (let y = 0; y < reader.height; y += step) {
    for (let x = 0; x < reader.width; x += step) {
      n++;
      if (reader.lum(x, y) <= THRESHOLDS.darkLuminance) dark++;
    }
  }
  return n ? dark / n : 0;
}

// 画像（行列 m で単位正方形に置かれたもの）のうち、ページ上の箱 region に入る画素を数える。
// contains を渡したときは、画素の中心がその形の中にあるものだけを数える（四角でない覆い）
function sampleRegion(reader, m, region, contains = null) {
  const inv = invert(m);
  if (!inv) return null;
  // region の四隅を画像の座標（0〜1）に戻し、画素の範囲を出す
  const corners = [
    apply(inv, region[0], region[1]), apply(inv, region[2], region[1]),
    apply(inv, region[2], region[3]), apply(inv, region[0], region[3]),
  ];
  const ub = boxOfPoints(corners);
  const W = reader.width, H = reader.height;
  // 画像の行 0 が上（v=1）
  const px0 = Math.max(0, Math.floor(ub[0] * W));
  const px1 = Math.min(W - 1, Math.ceil(ub[2] * W));
  const py0 = Math.max(0, Math.floor((1 - ub[3]) * H));
  const py1 = Math.min(H - 1, Math.ceil((1 - ub[1]) * H));
  if (px1 < px0 || py1 < py0) return null;
  const count = (px1 - px0 + 1) * (py1 - py0 + 1);
  const step = Math.max(1, Math.ceil(Math.sqrt(count / LIMITS.maxSampledPixelsPerRegion)));
  let total = 0, ink = 0, paper = 0;
  for (let py = py0; py <= py1; py += step) {
    for (let px = px0; px <= px1; px += step) {
      // 画素の中心がページ上で region に入っているか
      const [x, y] = apply(m, (px + 0.5) / W, 1 - (py + 0.5) / H);
      if (x < region[0] || x > region[2] || y < region[1] || y > region[3]) continue;
      if (contains && !contains(x, y)) continue;
      total++;
      const l = reader.lum(px, py);
      if (l <= THRESHOLDS.inkLuminance) ink++;
      if (l >= THRESHOLDS.paperLuminance) paper++;
    }
  }
  const scale = step * step;
  return { total: total * scale, ink: ink * scale, paper: paper * scale, sampled: total };
}

// ---------- 1ページの読み取り ----------
async function readPage(page, { includeText }) {
  const opList = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  const { fnArray, argsArray } = opList;
  if (fnArray.length > LIMITS.maxOpsPerPage) {
    return { skipped: "too_many_operations" };
  }

  const covers = []; // { seq, box, cover: "fill"|"image"|"annotation" }
  const glyphs = []; // { seq, box, unicode }
  const images = []; // { seq, m, reader }

  let st = newState();
  const stack = [];
  let annotationDepth = 0;
  const fontCache = new Map();
  // 読めなかった書体（PDF.js の書体の読み込みの失敗）で、字を描く命令があったか（2026-11-06 から。そのページは skipped_pages に unreadable_text として入れる）
  let unreadableText = false;

  const loadFont = async (id) => {
    if (fontCache.has(id)) return fontCache.get(id);
    const store = id.startsWith("g_") ? page.commonObjs : page.objs;
    const f = await getObj(store, id);
    const fm = Array.isArray(f?.fontMatrix) || ArrayBuffer.isView(f?.fontMatrix) ? Array.from(f.fontMatrix) : [0.001, 0, 0, 0.001, 0, 0];
    let asc = 0.8, desc = -0.2;
    const bb = f?.bbox;
    if (bb && bb.length === 4 && Math.abs(fm[3]) > 0) {
      const a = bb[3] * Math.abs(fm[3]);
      const d = bb[1] * Math.abs(fm[3]);
      if (Number.isFinite(a)) asc = Math.min(1.5, Math.max(0.5, a));
      if (Number.isFinite(d)) desc = Math.max(-0.5, Math.min(0, d));
    }
    // PDF.js は書体を読めないとき、書体の代わりにエラーの文字列を置き、その書体の字を黙って 0 個にする（cMapUrl がないときの「Ensure that the `cMapUrl` …」など）
    const info = { fm, asc, desc, vertical: !!f?.vertical, failed: typeof f === "string" };
    fontCache.set(id, info);
    return info;
  };

  // shape：四角でない覆いのとき { polys, evenOdd }。ないときは箱そのものを覆いとみなす
  const addCover = (seq, box, kind, shape = null) => {
    if (area(box) <= 0) return;
    covers.push({ seq, box, cover: kind, polys: shape?.polys ?? null, evenOdd: shape?.evenOdd ?? false });
  };

  for (let seq = 0; seq < fnArray.length; seq++) {
    const fn = fnArray[seq];
    const args = argsArray[seq];
    switch (fn) {
      case OPS.save:
        stack.push(cloneState(st));
        break;
      case OPS.restore:
        if (stack.length) st = stack.pop();
        break;
      case OPS.transform:
        st.ctm = mul(st.ctm, args);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(cloneState(st));
        const m = args?.[0];
        if (m && m.length === 6) st.ctm = mul(st.ctm, Array.from(m));
        break;
      }
      case OPS.paintFormXObjectEnd:
        if (stack.length) st = stack.pop();
        break;
      case OPS.beginAnnotation: {
        stack.push(cloneState(st));
        annotationDepth++;
        const t = args?.[2], m = args?.[3];
        if (t && t.length === 6) st.ctm = mul(st.ctm, Array.from(t));
        if (m && m.length === 6) st.ctm = mul(st.ctm, Array.from(m));
        break;
      }
      case OPS.endAnnotation:
        annotationDepth = Math.max(0, annotationDepth - 1);
        if (stack.length) st = stack.pop();
        break;
      case OPS.setFillRGBColor: {
        const l = luminanceOfHex(args?.[0]);
        if (l !== null) st.fillLum = l;
        break;
      }
      case OPS.setStrokeRGBColor: {
        const l = luminanceOfHex(args?.[0]);
        if (l !== null) st.strokeLum = l;
        break;
      }
      case OPS.setFillTransparent:
        st.fillLum = 1; st.fillAlpha = 0;
        break;
      case OPS.setLineWidth:
        st.lineWidth = Number(args?.[0]) || 0;
        break;
      case OPS.setGState: {
        for (const [k, v] of args?.[0] ?? []) {
          if (k === "ca") st.fillAlpha = Number(v);
          else if (k === "CA") st.strokeAlpha = Number(v);
          else if (k === "LW") st.lineWidth = Number(v) || 0;
        }
        break;
      }
      case OPS.constructPath: {
        const renderOp = args?.[0];
        const darkFill = FILL_OPS.has(renderOp) && st.fillLum <= THRESHOLDS.darkLuminance && st.fillAlpha >= THRESHOLDS.minAlpha;
        // 形を作るのは、覆いになりうる濃い塗りのときだけ（重いページで、線だけの図形に手間をかけない）
        const info = analysePath(st.ctm, args?.[1], darkFill);
        if (!info) break;
        const kind = annotationDepth > 0 ? "annotation" : "fill";
        // 塗りの覆い。四角に近いものは箱で、そうでないもの（楕円・回した四角・角の丸い四角など）は形で見る
        if (darkFill) {
          if (info.fillRatio >= THRESHOLDS.polygonFillRatio) addCover(seq, info.box, kind);
          else if (info.polys.length && info.polyArea > 0) {
            addCover(seq, info.box, kind, { polys: info.polys, evenOdd: EO_FILL_OPS.has(renderOp) });
          }
        }
        // 太い線の覆い（マーカーで塗りつぶしたような線）。直線1本だけを扱う
        if (STROKE_OPS.has(renderOp) && !FILL_OPS.has(renderOp) && st.strokeLum <= THRESHOLDS.darkLuminance &&
            st.strokeAlpha >= THRESHOLDS.minAlpha && info.segments === 1 && !info.hasCurve && info.lines.length === 1) {
          const [[ax, ay], [bx, by]] = info.lines[0];
          const lw = st.lineWidth * Math.sqrt(Math.abs(st.ctm[0] * st.ctm[3] - st.ctm[1] * st.ctm[2]));
          const half = lw / 2;
          if (Math.abs(ay - by) < 1e-6) addCover(seq, [Math.min(ax, bx), ay - half, Math.max(ax, bx), ay + half], kind);
          else if (Math.abs(ax - bx) < 1e-6) addCover(seq, [ax - half, Math.min(ay, by), ax + half, Math.max(ay, by)], kind);
          else {
            // 斜めの線は、線の幅の分だけ広げた、回した四角の形で見る（線の端の形は見ない）
            const len = Math.hypot(bx - ax, by - ay);
            if (len > 0 && half > 0) {
              const nx = (-(by - ay) / len) * half;
              const ny = ((bx - ax) / len) * half;
              const poly = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
              addCover(seq, boxOfPoints(poly), kind, { polys: [poly], evenOdd: false });
            }
          }
        }
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        let img = null;
        if (fn === OPS.paintInlineImageXObject) img = args?.[0];
        else {
          const id = args?.[0];
          if (typeof id === "string") img = await getObj(id.startsWith("g_") ? page.commonObjs : page.objs, id);
        }
        const reader = pixelReader(img);
        if (!reader) break;
        const m = st.ctm;
        const box = boxOfRect(m, 0, 0, 1, 1);
        const kind = annotationDepth > 0 ? "annotation" : "image";
        if (st.fillAlpha >= THRESHOLDS.minAlpha && isAxisAligned(m) && darkRatioOfImage(reader) >= THRESHOLDS.coverImageDarkRatio) {
          addCover(seq, box, kind);
        }
        images.push({ seq, m, box, reader });
        break;
      }
      // ---- 字 ----
      case OPS.beginText:
        st.textMatrix = IDENTITY; st.x = st.y = st.lineX = st.lineY = 0;
        break;
      case OPS.setFont: {
        st.font = await loadFont(String(args?.[0]));
        st.fontSize = Math.abs(Number(args?.[1]) || 0);
        break;
      }
      case OPS.setCharSpacing: st.charSpacing = Number(args?.[0]) || 0; break;
      case OPS.setWordSpacing: st.wordSpacing = Number(args?.[0]) || 0; break;
      case OPS.setHScale: st.hScale = (Number(args?.[0]) || 100) / 100; break;
      case OPS.setLeading: st.leading = -(Number(args?.[0]) || 0); break;
      case OPS.setTextRise: st.rise = Number(args?.[0]) || 0; break;
      case OPS.setTextMatrix: {
        const m = Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0]) ? Array.from(args[0]) : Array.from(args ?? []);
        if (m.length === 6) { st.textMatrix = m; st.x = st.y = st.lineX = st.lineY = 0; }
        break;
      }
      case OPS.moveText:
        st.x = st.lineX += Number(args?.[0]) || 0;
        st.y = st.lineY += Number(args?.[1]) || 0;
        break;
      case OPS.setLeadingMoveText:
        st.leading = Number(args?.[1]) || 0;
        st.x = st.lineX += Number(args?.[0]) || 0;
        st.y = st.lineY += Number(args?.[1]) || 0;
        break;
      case OPS.nextLine:
        st.x = st.lineX += 0;
        st.y = st.lineY += st.leading;
        break;
      case OPS.showText:
      case OPS.showSpacedText: {
        const font = st.font ?? { fm: [0.001, 0, 0, 0.001, 0, 0], asc: 0.8, desc: -0.2 };
        const size = st.fontSize;
        // 読めなかった書体で字を描く命令（PDF.js は字を黙って 0 個にする）。位置の数だけの命令・中身のない Tj・空白では当たらない（2026-11-06 から）
        if (font.failed) unreadableText = true;
        const base = mul(mul(st.ctm, st.textMatrix), [st.hScale, 0, 0, 1, st.x, st.y + st.rise]);
        let x = 0;
        const widthScale = size * font.fm[0];
        for (const g of args?.[0] ?? []) {
          if (typeof g === "number") { x -= (g * size) / 1000; continue; }
          if (!g) continue;
          const spacing = (g.isSpace ? st.wordSpacing : 0) + st.charSpacing;
          const w = (Number(g.width) || 0) * widthScale;
          const visible = !g.isSpace && typeof g.unicode === "string" && g.unicode.trim() !== "";
          if (visible && size > 0 && w > 0) {
            glyphs.push({
              seq,
              box: boxOfRect(base, x, font.desc * size, x + w, font.asc * size),
              unicode: g.unicode,
            });
          }
          x += w + spacing;
        }
        st.x += x * st.hScale;
        break;
      }
      default:
        break;
    }
  }

  // 未適用の墨消し注釈（見た目の命令がないことが多い）。注釈はページの中身より上にあるので、最後に描いたものとして扱う
  try {
    const annots = await page.getAnnotations({ intent: "display" });
    for (const a of annots) {
      if (a?.subtype === "Redact" && a.rect?.length === 4) {
        const r = Array.from(a.rect);
        addCover(fnArray.length, [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])], "annotation");
      }
    }
  } catch {
    // 注釈が読めなくても、ページの中身の判定は続ける
  }

  return { covers, glyphs, images, unreadableText };
}

// 覆いごとに、下に残っているものをまとめる
function judgePage(pageNo, { covers, glyphs, images }, { includeText }) {
  const items = [];

  // 字の層：字ごとに、あとから描かれた覆いのうち、いちばん大きく重なるものに割り当てる
  const byCover = new Map();
  for (const g of glyphs) {
    const ga = area(g.box);
    if (ga <= 0) continue;
    let best = null, bestRatio = 0;
    for (const c of covers) {
      if (c.seq <= g.seq) continue;
      const ratio = coveredRatio(g.box, c);
      if (ratio > bestRatio) { bestRatio = ratio; best = c; }
    }
    if (best && bestRatio >= THRESHOLDS.glyphCoverRatio) {
      if (!byCover.has(best)) byCover.set(best, []);
      byCover.get(best).push(g);
    }
  }
  for (const [c, gs] of byCover) {
    const item = {
      pattern: "P6",
      layer: "text",
      cover: c.cover,
      page: pageNo,
      rect: round2(c.box),
      remaining: { chars: gs.length },
    };
    if (includeText) item.text = gs.map((g) => g.unicode).join("");
    items.push(item);
  }

  // 画像の層：覆いごとに、先に描かれた画像の下の画素を数える
  for (const c of covers) {
    let total = 0, ink = 0, paper = 0;
    for (const im of images) {
      if (im.seq >= c.seq) continue;
      const region = intersect(im.box, c.box);
      if (!region) continue;
      const s = sampleRegion(im.reader, im.m, region, c.polys ? (x, y) => coverContains(c, x, y) : null);
      if (!s || s.sampled === 0) continue;
      total += s.total; ink += s.ink; paper += s.paper;
    }
    if (total > 0 && ink / total >= THRESHOLDS.minInkRatio && paper / total >= THRESHOLDS.minPaperRatio) {
      items.push({
        pattern: "P6",
        layer: "image",
        cover: c.cover,
        page: pageNo,
        rect: round2(c.box),
        remaining: { pixels: total, ink_pixels: ink },
      });
    }
  }

  items.sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0] || a.layer.localeCompare(b.layer));
  return items;
}

// ---------- 入口 ----------
export async function verifyP6(bytes, { includeText = false } = {}) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = {
    verifier: { name: VERIFIER_NAME, version: VERIFIER_VERSION },
    checked: ["P6"],
    input: { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex"), pages: null },
    status: "ok",
    items: [],
    skipped_pages: [],
  };
  const fail = (code, message) => {
    result.status = "error";
    result.error = { code, message };
    result.items = [];
    return result;
  };
  if (buf.byteLength === 0) return fail("empty", "ファイルが空です");
  if (buf.byteLength > LIMITS.maxBytes) return fail("too_large", "ファイルが大きすぎます");

  let doc, task;
  try {
    task = pdfjs.getDocument({
      // pdfjs は渡した配列を手放す。また Node の Buffer は受け付けないので、純粋な Uint8Array の写しを渡す
      data: new Uint8Array(buf),
      isEvalSupported: false,
      ...(CMAP_URL ? { cMapUrl: CMAP_URL, cMapPacked: true } : {}),
      disableFontFace: true,
      useSystemFonts: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (e) {
    await task?.destroy().catch(() => {});
    if (e?.name === "PasswordException") return fail("encrypted", "パスワードで守られていて開けません");
    return fail("unreadable", "PDF として読めません");
  }
  try {
    result.input.pages = doc.numPages;
    if (doc.numPages > LIMITS.maxPages) return fail("too_many_pages", "ページが多すぎます");
    for (let p = 1; p <= doc.numPages; p++) {
      let page;
      try {
        page = await doc.getPage(p);
        const read = await readPage(page, { includeText });
        if (read.skipped) { result.skipped_pages.push({ page: p, reason: read.skipped }); continue; }
        result.items.push(...judgePage(p, read, { includeText }));
        // 読めた字の結果は items に入れたうえで、読めない字があったことを知らせる（「残っていない」と言い切らない）
        if (read.unreadableText) result.skipped_pages.push({ page: p, reason: "unreadable_text" });
      } catch {
        result.skipped_pages.push({ page: p, reason: "unreadable_page" });
      } finally {
        page?.cleanup();
      }
    }
  } finally {
    await task.destroy();
  }
  return result;
}
