// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器：P7（隠れたテキスト）。PDF を入れると、取り出せるのに画面では見えない字を返す。
//
// 見えない理由（reason）。1字ごとに、上から順に最初に当たったもの1つにする（rubric/p7.md §2）：
//   hidden_layer   表示しないレイヤー（オプションの中身、OCG）の中にある
//   off_page       ページの見える範囲（CropBox。なければ MediaBox）の外にある
//   clipped        切り抜き（クリップ）の外にある
//   invisible      描き方が「見えない」（Tr 3・7）か、字が透明（不透明さが下限より小さい）
//   tiny           字の高さが下限より小さい
//   same_color     字の色が、下の色（ページの白・先に塗った塗り・画像）とほぼ同じ
//   covered_light  字のあとに、濃くない不透明な塗りを重ねて隠した（白い四角など）
// 字のあとに濃い塗り・濃い画像を重ねて隠した字は P6（見せかけの黒塗り）で数えるので、ここでは出さない（excluded_p6 に数だけ）。
// 文字認識の層（描き方 3 の字を、画像の上に置いたもの）は、漏れでないので出さない（ocr_layer に数だけ）。
//
// 検査器から独立させるため、pdf-lib は使わない。PDF.js（pdfjs-dist）の描画命令の列（getOperatorList）を読む。
// 注釈の中の字は P8 の範囲なので見ない（annotationMode: DISABLE）。

import { createHash } from "node:crypto";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const VERIFIER = { name: "omamori-verifier-p7", version: "0.1.0" };

export const THRESHOLDS = Object.freeze({
  /** 字が「見えない」とみなす不透明さの上限 */
  invisibleAlpha: 0.1,
  /** 字が「とても小さい」とみなす、字の高さ（ポイント）の上限 */
  tinyHeight: 1.0,
  /** 字の色と下の色が「ほぼ同じ」とみなす、明るさの差の上限 */
  sameColorDelta: 0.1,
  /** 塗りを「濃い」とみなす明るさの上限（P6 の検証器と同じ値。濃い覆いは P6 で数える） */
  darkLuminance: 0.3,
  /** 塗りを「隠している」とみなす不透明さの下限 */
  coverAlpha: 0.9,
  /** 字の箱が、範囲の外・覆いの下にあるとみなす割合 */
  outsideFraction: 0.5,
  /** 塗りを「四角に近い」とみなす割合（P6 の検証器と同じ） */
  polygonFillRatio: 0.9,
});

export const LIMITS = Object.freeze({
  maxBytes: 200 * 1024 * 1024,
  maxPages: 2000,
  maxOpsPerPage: 300_000,
});

const OPS = pdfjs.OPS;
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
const FILL_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const IDENTITY = [1, 0, 0, 1, 0, 0];

// ---------- 幾何 ----------

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const boxOfPoints = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
const boxOfRect = (m, x0, y0, x1, y1) => boxOfPoints([apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)]);
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const inside = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const round2 = (b) => b.map((v) => Math.round(v * 100) / 100);

function luminanceOfHex(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 点が多角形の中にあるか（偶奇） */
function pointInPolygon(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const bez = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
};

/** 道（パス）の箱と、四角らしさ（1つの部分の面積 ÷ 箱の面積）と、形（曲線は分けた点。地の色を見るのに使う） */
function analysePath(ctm, data) {
  const ops = data?.[0] ?? data;
  if (!ops || typeof ops.length !== "number") return null;
  const pts = [];
  let subpaths = 0;
  let curved = false;
  for (let i = 0; i < ops.length; ) {
    const op = ops[i++];
    if (op === DRAW.moveTo) {
      subpaths++;
      pts.push(apply(ctm, ops[i], ops[i + 1]));
      i += 2;
    } else if (op === DRAW.lineTo) {
      pts.push(apply(ctm, ops[i], ops[i + 1]));
      i += 2;
    } else if (op === DRAW.curveTo) {
      curved = true;
      const p3 = apply(ctm, ops[i + 4], ops[i + 5]);
      const p0 = pts[pts.length - 1] ?? p3;
      const p1 = apply(ctm, ops[i], ops[i + 1]);
      const p2 = apply(ctm, ops[i + 2], ops[i + 3]);
      for (const t of [0.25, 0.5, 0.75, 1]) pts.push(bez(p0, p1, p2, p3, t));
      i += 6;
    } else if (op === DRAW.quadraticCurveTo) {
      curved = true;
      pts.push(apply(ctm, ops[i + 2], ops[i + 3]));
      i += 4;
    } else if (op === DRAW.closePath) {
      // 何もしない
    } else break;
  }
  if (pts.length < 2) return null;
  const box = boxOfPoints(pts);
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[(k + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  const fillRatio = subpaths === 1 && !curved && area(box) > 0 ? Math.abs(a) / 2 / area(box) : 0;
  return { box, fillRatio, poly: pts, rectLike: fillRatio >= THRESHOLDS.polygonFillRatio };
}

// ---------- 画像の明るさ ----------

function getObj(store, id) {
  return new Promise((resolve) => {
    try {
      if (store.has(id)) return resolve(store.get(id));
      store.get(id, (v) => resolve(v));
    } catch {
      resolve(null);
    }
  });
}

/** 画像の明るさの平均（0〜1）。読めなければ null */
function meanLuminance(img) {
  const data = img?.data;
  const w = img?.width;
  const h = img?.height;
  if (!data || !w || !h) return null;
  const n = w * h;
  const step = Math.max(1, Math.floor(n / 65536));
  let sum = 0;
  let cnt = 0;
  const kind = img.kind;
  for (let p = 0; p < n; p += step) {
    let l;
    if (kind === pdfjs.ImageKind.RGBA_32BPP) l = (0.299 * data[p * 4] + 0.587 * data[p * 4 + 1] + 0.114 * data[p * 4 + 2]) / 255;
    else if (kind === pdfjs.ImageKind.RGB_24BPP) l = (0.299 * data[p * 3] + 0.587 * data[p * 3 + 1] + 0.114 * data[p * 3 + 2]) / 255;
    else if (kind === pdfjs.ImageKind.GRAYSCALE_1BPP) l = (data[p >> 3] >> (7 - (p & 7))) & 1;
    else return null;
    sum += l;
    cnt++;
  }
  return cnt ? sum / cnt : null;
}

// ---------- 1ページを読む ----------

function newState() {
  return {
    ctm: IDENTITY,
    fillLum: 0,
    strokeLum: 0,
    fillAlpha: 1,
    strokeAlpha: 1,
    blendNormal: true,
    clip: null,
    pendingClip: false,
    font: null,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
    textMatrix: IDENTITY,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
  };
}
const cloneState = (s) => ({ ...s });

async function readPage(page, ocConfig) {
  const opList = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
  const { fnArray, argsArray } = opList;
  if (fnArray.length > LIMITS.maxOpsPerPage) return { skipped: "too_many_operations" };

  const paints = []; // { seq, box, lum, opaque, kind: "fill"|"image" }
  const glyphs = []; // { seq, run, box, unicode, lum, alpha, mode, hiddenLayer, clip }
  let st = newState();
  const stack = [];
  const mcStack = []; // マーク付きの中身。true ＝ 表示しないレイヤーの中
  const fontCache = new Map();
  let run = 0;

  const hiddenNow = () => mcStack.some((x) => x);
  const loadFont = async (id) => {
    if (fontCache.has(id)) return fontCache.get(id);
    const f = await getObj(id.startsWith("g_") ? page.commonObjs : page.objs, id);
    const fm = f?.fontMatrix && f.fontMatrix.length === 6 ? Array.from(f.fontMatrix) : [0.001, 0, 0, 0.001, 0, 0];
    let asc = 0.8;
    let desc = -0.2;
    const bb = f?.bbox;
    if (bb && bb.length === 4 && Math.abs(fm[3]) > 0) {
      const a = bb[3] * Math.abs(fm[3]);
      const d = bb[1] * Math.abs(fm[3]);
      if (Number.isFinite(a)) asc = Math.min(1.5, Math.max(0.5, a));
      if (Number.isFinite(d)) desc = Math.max(-0.5, Math.min(0, d));
    }
    const info = { fm, asc, desc };
    fontCache.set(id, info);
    return info;
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
        const bb = args?.[1];
        if (bb && bb.length === 4) {
          const b = boxOfRect(st.ctm, bb[0], bb[1], bb[2], bb[3]);
          st.clip = st.clip ? intersect(st.clip, b) : b;
        }
        break;
      }
      case OPS.paintFormXObjectEnd:
        if (stack.length) st = stack.pop();
        break;
      case OPS.beginMarkedContent:
        mcStack.push(false);
        break;
      case OPS.beginMarkedContentProps: {
        let hidden = false;
        if (args?.[0] === "OC" && args?.[1]) {
          try {
            hidden = !ocConfig.isVisible(args[1]);
          } catch {
            hidden = false;
          }
        }
        mcStack.push(hidden);
        break;
      }
      case OPS.endMarkedContent:
        mcStack.pop();
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
        st.fillAlpha = 0;
        break;
      case OPS.setGState:
        for (const [k, v] of args?.[0] ?? []) {
          if (k === "ca") st.fillAlpha = Number(v);
          else if (k === "CA") st.strokeAlpha = Number(v);
          else if (k === "BM") st.blendNormal = !v || v === "source-over" || v === "Normal";
        }
        break;
      case OPS.clip:
      case OPS.eoClip:
        st.pendingClip = true;
        break;
      case OPS.constructPath: {
        const renderOp = args?.[0];
        const info = analysePath(st.ctm, args?.[1]);
        if (st.pendingClip) {
          st.pendingClip = false;
          // 切り抜きの範囲は、道の箱で近似する（四角でない切り抜きは、外枠の箱）
          const mm = args?.[2];
          const b = mm && mm.length === 4 ? boxOfRect(st.ctm, mm[0], mm[1], mm[2], mm[3]) : info?.box;
          if (b) st.clip = st.clip ? intersect(st.clip, b) : b;
        }
        if (!info || !FILL_OPS.has(renderOp) || hiddenNow()) break;
        // 不透明かどうかは形を問わない。上に重ねた覆いとして数えるのは、四角に近い形だけ（rectLike）。
        // 地の色（字の下にあるもの）は、形の中に字の中心があるかで見る（楕円の上の白い字など）
        const opaque = st.fillAlpha >= THRESHOLDS.coverAlpha && st.blendNormal;
        let box = info.box;
        if (st.clip) box = intersect(box, st.clip);
        if (area(box) > 0) paints.push({ seq, box, lum: st.fillLum, opaque, kind: "fill", rectLike: info.rectLike, poly: info.poly });
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        if (hiddenNow()) break;
        let img = null;
        if (fn === OPS.paintInlineImageXObject) img = args?.[0];
        else if (typeof args?.[0] === "string") img = await getObj(args[0].startsWith("g_") ? page.commonObjs : page.objs, args[0]);
        let box = boxOfRect(st.ctm, 0, 0, 1, 1);
        if (st.clip) box = intersect(box, st.clip);
        const lum = meanLuminance(img);
        if (area(box) > 0) paints.push({ seq, box, lum: lum ?? 0.5, opaque: st.fillAlpha >= THRESHOLDS.coverAlpha && st.blendNormal, kind: "image", rectLike: true });
        break;
      }
      // ---- 字 ----
      case OPS.beginText:
        st.textMatrix = IDENTITY;
        st.x = st.y = st.lineX = st.lineY = 0;
        break;
      case OPS.setFont:
        st.font = await loadFont(String(args?.[0]));
        st.fontSize = Number(args?.[1]) || 0;
        break;
      case OPS.setCharSpacing:
        st.charSpacing = Number(args?.[0]) || 0;
        break;
      case OPS.setWordSpacing:
        st.wordSpacing = Number(args?.[0]) || 0;
        break;
      case OPS.setHScale:
        st.hScale = (Number(args?.[0]) || 100) / 100;
        break;
      case OPS.setLeading:
        st.leading = -(Number(args?.[0]) || 0);
        break;
      case OPS.setTextRise:
        st.rise = Number(args?.[0]) || 0;
        break;
      case OPS.setTextRenderingMode:
        st.renderMode = Number(args?.[0]) || 0;
        break;
      case OPS.setTextMatrix: {
        const m = args?.[0] && args[0].length === 6 ? Array.from(args[0]) : Array.from(args ?? []);
        if (m.length === 6) {
          st.textMatrix = m;
          st.x = st.y = st.lineX = st.lineY = 0;
        }
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
        st.x = st.lineX;
        st.y = st.lineY += st.leading;
        break;
      case OPS.showText:
      case OPS.showSpacedText: {
        run++;
        const font = st.font ?? { fm: [0.001, 0, 0, 0.001, 0, 0], asc: 0.8, desc: -0.2 };
        const size = st.fontSize;
        const base = mul(mul(st.ctm, st.textMatrix), [st.hScale, 0, 0, 1, st.x, st.y + st.rise]);
        const widthScale = size * font.fm[0];
        const strokeOnly = st.renderMode === 1 || st.renderMode === 5;
        let x = 0;
        for (const g of args?.[0] ?? []) {
          if (typeof g === "number") {
            x -= (g * size) / 1000;
            continue;
          }
          if (!g) continue;
          const spacing = (g.isSpace ? st.wordSpacing : 0) + st.charSpacing;
          const w = (Number(g.width) || 0) * widthScale;
          const visible = !g.isSpace && typeof g.unicode === "string" && g.unicode.trim() !== "";
          if (visible && w !== 0 && size !== 0) {
            glyphs.push({
              seq,
              run,
              box: boxOfRect(base, x, font.desc * size, x + w, font.asc * size),
              unicode: g.unicode,
              lum: strokeOnly ? st.strokeLum : st.fillLum,
              alpha: strokeOnly ? st.strokeAlpha : st.fillAlpha,
              mode: st.renderMode,
              hiddenLayer: hiddenNow(),
              clip: st.clip,
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
  return { paints, glyphs };
}

/** 1字の見えない理由。見える字は null。P6 で数える字は "p6"、文字認識の層は "ocr" */
function reasonOf(g, view, paints) {
  if (g.hiddenLayer) return "hidden_layer";
  const a = area(g.box);
  if (a <= 0) return null;
  const outsideFrac = (b) => 1 - area(intersect(g.box, b)) / a;
  if (outsideFrac(view) >= THRESHOLDS.outsideFraction) return "off_page";
  if (g.clip && outsideFrac(g.clip) >= THRESHOLDS.outsideFraction) return "clipped";
  const cx = (g.box[0] + g.box[2]) / 2;
  const cy = (g.box[1] + g.box[3]) / 2;
  // 下にあるもの：字より先に描いた、字の中心を含む、いちばん新しい不透明な塗り・画像
  let under = null;
  for (const p of paints) if (p.seq < g.seq && p.opaque && inside(p.box, cx, cy) && (p.rectLike || pointInPolygon(p.poly, cx, cy))) under = p;
  if (g.mode === 3 || g.mode === 7 || g.alpha < THRESHOLDS.invisibleAlpha) return under?.kind === "image" ? "ocr" : "invisible";
  if (g.box[3] - g.box[1] < THRESHOLDS.tinyHeight) return "tiny";
  const bg = under ? under.lum : 1; // ページの地は白
  // 上に重ねたもの：字のあとに描いた、不透明で、字の箱の半分以上を隠すもの
  for (const p of paints) {
    if (p.seq <= g.seq || !p.opaque || !p.rectLike) continue;
    if (area(intersect(g.box, p.box)) / a < THRESHOLDS.outsideFraction) continue;
    return p.lum <= THRESHOLDS.darkLuminance ? "p6" : "covered_light";
  }
  if (Math.abs(g.lum - bg) < THRESHOLDS.sameColorDelta) return "same_color";
  return null;
}

/**
 * PDF のバイト列 → 結果（形は p7-schema.json）
 * @param {Uint8Array} bytes
 * @param {{ includeText?: boolean }} [options]
 */
export async function verifyP7(bytes, options = {}) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = {
    verifier: VERIFIER,
    checked: ["P7"],
    input: { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex"), pages: null },
    status: "ok",
    items: [],
    skipped_pages: [],
    excluded: { p6: 0, ocr_layer: 0 },
  };
  const fail = (code, message) => ({ ...result, status: "error", error: { code, message }, items: [] });
  if (buf.byteLength === 0) return fail("empty", "ファイルが空です");
  if (buf.byteLength > LIMITS.maxBytes) return fail("too_large", "ファイルが大きすぎます");

  let task;
  let doc;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
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
    const ocConfig = await doc.getOptionalContentConfig();
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      let page;
      let read;
      try {
        page = await doc.getPage(pageNo);
        read = await readPage(page, ocConfig);
      } catch {
        result.skipped_pages.push({ page: pageNo, reason: "unreadable_page" });
        continue;
      }
      if (read.skipped) {
        result.skipped_pages.push({ page: pageNo, reason: read.skipped });
        continue;
      }
      const view = Array.from(page.view);
      // 同じ「字を描く命令」の中で、同じ理由で続く字を1件にまとめる
      let cur = null;
      const flush = () => {
        if (!cur) return;
        const item = { pattern: "P7", page: pageNo, reason: cur.reason, rect: round2(cur.box), chars: cur.chars };
        if (options.includeText) item.text = cur.text;
        result.items.push(item);
        cur = null;
      };
      for (const g of read.glyphs) {
        const r = reasonOf(g, view, read.paints);
        if (r === "p6") result.excluded.p6++;
        if (r === "ocr") result.excluded.ocr_layer++;
        if (!r || r === "p6" || r === "ocr") {
          flush();
          continue;
        }
        if (cur && cur.reason === r && cur.run === g.run) {
          cur.box = union(cur.box, g.box);
          cur.chars++;
          cur.text += g.unicode;
        } else {
          flush();
          cur = { reason: r, run: g.run, box: g.box, chars: 1, text: g.unicode };
        }
      }
      flush();
      page.cleanup();
    }
    return result;
  } finally {
    await task.destroy().catch(() => {});
  }
}
