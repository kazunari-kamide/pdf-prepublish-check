// SPDX-License-Identifier: AGPL-3.0-only
//
// 今の Office（docx・xlsx・pptx）に残った情報を見つける。値・ファイル名・シートの名前は返さない（数と場所だけ）。
//
// 共通：作成者・最後に保存した人・会社名などのプロパティ、独自のプロパティ、ひな形の場所、外のファイルへのつながり、
//       埋め込まれたファイル、中の写真の EXIF など（image.ts）、コメント
// docx：変更履歴、隠し文字、字と同じ色の網掛け・蛍光ペン（見せかけの黒塗り）、白い字、本文の上の濃い図形
// xlsx：隠したシート・行・列、字と同じ色の塗り（見せかけの黒塗り）、白い字、値を見せない書式（;;;）、共有ブックの変更履歴
// pptx：表示しないスライド、発表者のメモ、字のある図形の上に重ねた濃い図形、字と同じ色の図形、スライドの外の字
//
// 場所は「段落の番号」「何枚目のシートのどのセル」「何枚目のスライドの、左上から何 pt」で返す。
// グループにした図形の中・図形の中の写真・グラフの中は、いまは見ていない（README の「調べていないこと」）。

import { formatSize, safeExt } from "./bytes.ts";
import { detectFormat } from "./detect.ts";
import { inspectImage } from "./image.ts";
import type { FormatFinding, FormatKind, FormatNotice, FormatReport, Severity } from "./types.ts";
import { attr, countChars, walkXml, type XmlEl } from "./xml.ts";
import { ZipBudget, readEntry, readZip, type ZipArchive } from "./zip.ts";

/** 中の写真を調べる数の上限 */
const MAX_IMAGES = 200;
/** 埋め込まれた Office のファイルを、中まで調べる深さ */
const MAX_DEPTH = 1;
/** XML の部分の大きさの上限（字に直す前のバイト） */
const MAX_XML_BYTES = 64 * 1024 * 1024;
/** 場所として並べる数の上限（それより多いときは「ほか N か所」） */
const MAX_PLACES = 5;
/** 「濃い色」の明るさの上限（0〜1） */
const DARK_MAX = 0.25;
/** 「白っぽい」の明るさの下限 */
const LIGHT_MIN = 0.92;
/** 同じ色とみなす、色の成分ごとの違いの上限（0〜255） */
const SAME_COLOR_MAX = 24;
/** 図形の重なり：覆いの面積のこの割合以上が、字のある図形に重なれば「上に重ねた」とみなす */
const COVER_OVERLAP_MIN = 0.8;
/** EMU（Office の長さの単位）を pt に直す */
const EMU_PER_PT = 12700;

type Ctx = {
  bytes: Uint8Array;
  zip: ZipArchive;
  budget: ZipBudget;
  findings: FormatFinding[];
  notices: FormatNotice[];
  depth: number;
  /** 読めなかった部分の数（理由ごと） */
  unread: Map<string, number>;
};

// ---------------------------------------------------------------- 色

type Rgb = [number, number, number];

function hexRgb(hex: string | undefined | null): Rgb | null {
  if (!hex) return null;
  const h = hex.replace(/^#/, "");
  const six = h.length === 8 ? h.slice(2) : h; // ARGB は A を外す
  if (!/^[0-9a-fA-F]{6}$/.test(six)) return null;
  return [parseInt(six.slice(0, 2), 16), parseInt(six.slice(2, 4), 16), parseInt(six.slice(4, 6), 16)];
}
const lum = (c: Rgb) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const sameColor = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) <= SAME_COLOR_MAX;

/** Word の蛍光ペンの色の名前 */
const HIGHLIGHT: Record<string, string> = {
  black: "000000", blue: "0000FF", cyan: "00FFFF", green: "00FF00", magenta: "FF00FF", red: "FF0000", yellow: "FFFF00", white: "FFFFFF",
  darkBlue: "000080", darkCyan: "008080", darkGreen: "008000", darkMagenta: "800080", darkRed: "800000", darkYellow: "808000",
  darkGray: "808080", lightGray: "C0C0C0",
};
/** DrawingML の決まった色の名前（よく使う濃い色だけ） */
const PRESET: Record<string, string> = { black: "000000", white: "FFFFFF", darkGray: "A9A9A9", dimGray: "696969", navy: "000080" };

// ---------------------------------------------------------------- 読み出し

async function readText(ctx: Ctx, name: string): Promise<string | null> {
  const e = ctx.zip.entries.get(name);
  if (!e) return null;
  const r = await readEntry(ctx.bytes, e, ctx.budget, MAX_XML_BYTES);
  if (!r.ok) {
    ctx.unread.set(r.reason, (ctx.unread.get(r.reason) ?? 0) + 1);
    return null;
  }
  const d = r.data;
  if (d[0] === 0xff && d[1] === 0xfe) return new TextDecoder("utf-16le").decode(d.subarray(2));
  if (d[0] === 0xfe && d[1] === 0xff) return new TextDecoder("utf-16be").decode(d.subarray(2));
  return new TextDecoder("utf-8").decode(d);
}

const names = (ctx: Ctx, re: RegExp) => [...ctx.zip.entries.keys()].filter((n) => re.test(n)).sort(naturalCompare);

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/** .rels の中身：Id → { target, type, external } */
async function readRels(ctx: Ctx, relsName: string): Promise<Map<string, { target: string; type: string; external: boolean }>> {
  const out = new Map<string, { target: string; type: string; external: boolean }>();
  const xml = await readText(ctx, relsName);
  if (!xml) return out;
  walkXml(xml, {
    open(el) {
      if (el.local !== "Relationship") return;
      const id = attr(el, "Id");
      const target = attr(el, "Target");
      if (id && target !== undefined) out.set(id, { target, type: attr(el, "Type") ?? "", external: attr(el, "TargetMode") === "External" });
    },
  });
  return out;
}

/** 部分の名前（word/document.xml）から見た .rels の名前（word/_rels/document.xml.rels） */
function relsOf(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

/** 部分の中の相対の場所（../media/x.png）を、ZIP の中の名前にする */
function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = from.slice(0, from.lastIndexOf("/") + 1).split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") base.pop();
    else if (seg !== "." && seg !== "") base.push(seg);
  }
  return base.join("/");
}

function places(list: string[]): string {
  if (list.length <= MAX_PLACES) return list.join("・");
  return `${list.slice(0, MAX_PLACES).join("・")} ほか ${list.length - MAX_PLACES} か所`;
}

function add(ctx: Ctx, f: Omit<FormatFinding, "page" | "where"> & { page?: number | null; where?: string | null }) {
  ctx.findings.push({ page: null, where: null, ...f });
}

// ---------------------------------------------------------------- 共通：プロパティ

const CORE_PERSON: Record<string, string> = { creator: "作成者", lastModifiedBy: "最後に保存した人" };
const CORE_OTHER: Record<string, string> = { title: "タイトル", subject: "件名", keywords: "キーワード", description: "説明", category: "分類", contentStatus: "状態" };

async function properties(ctx: Ctx) {
  const core = await readText(ctx, "docProps/core.xml");
  if (core) {
    const filled = new Map<string, number>();
    walkXml(core, {
      text(t, stack) {
        const top = stack[stack.length - 1];
        if (stack.length === 2 && top) filled.set(top.local, (filled.get(top.local) ?? 0) + countChars(t));
      },
    });
    for (const [k, label] of Object.entries(CORE_PERSON)) {
      const n = filled.get(k);
      if (n) add(ctx, { type: "office.person", severity: "medium", title: `プロパティの「${label}」に値が入っています`, why: "ファイルのプロパティを開くと、誰でも見られます。個人の名前やログイン名が入っていることがあります。", detail: `${n}字` });
    }
    const other = Object.entries(CORE_OTHER).filter(([k]) => filled.get(k)).map(([, l]) => l);
    if (other.length) add(ctx, { type: "office.property", severity: "low", title: "プロパティに値が入っています", why: "ファイルのプロパティを開くと、誰でも見られます。意図したものでなければ消してください。", detail: other.join("・") });
  }
  const app = await readText(ctx, "docProps/app.xml");
  if (app) {
    const filled = new Map<string, string>();
    walkXml(app, {
      text(t, stack) {
        const top = stack[stack.length - 1];
        if (stack.length === 2 && top) filled.set(top.local, (filled.get(top.local) ?? "") + t);
      },
    });
    const org = [["Company", "会社名"], ["Manager", "管理者"]].filter(([k]) => (filled.get(k!) ?? "").trim()).map(([, l]) => l!);
    if (org.length) add(ctx, { type: "office.organization", severity: "medium", title: "プロパティに、会社名・管理者が入っています", why: "ファイルのプロパティを開くと、誰でも見られます。", detail: org.join("・") });
    const template = (filled.get("Template") ?? "").trim();
    if (/[\\/:]/.test(template)) templatePath(ctx, [template]);
    const base = (filled.get("HyperlinkBase") ?? "").trim();
    if (base) add(ctx, { type: "office.link_base", severity: "medium", title: "リンクの基準の場所が入っています", why: "社内のサーバーやフォルダの場所が分かることがあります。", detail: userFolder(base) ? "使った人のフォルダを含む" : `${countChars(base)}字` });
  }
  const custom = await readText(ctx, "docProps/custom.xml");
  if (custom) {
    let props = 0;
    let filled = 0;
    let inProp = false;
    let has = false;
    walkXml(custom, {
      open(el) {
        if (el.local === "property") {
          props++;
          inProp = true;
          has = false;
        }
      },
      text(t) {
        if (inProp && t.trim()) has = true;
      },
      close(el) {
        if (el.local === "property") {
          if (has) filled++;
          inProp = false;
        }
      },
    });
    if (filled) add(ctx, { type: "office.custom_property", severity: "medium", title: "独自のプロパティに値が入っています", why: "ファイルのプロパティの「詳細」で見られます。管理番号や担当者が入っていることがあります。", detail: `${filled} 個（全部で ${props} 個）` });
  }
}

const userFolder = (s: string) => /[\\/](Users|Documents and Settings|home)[\\/]/i.test(s);

function templatePath(ctx: Ctx, paths: string[]) {
  const user = paths.filter(userFolder).length;
  add(ctx, {
    type: "office.template_path",
    severity: "medium",
    title: "ひな形の場所（パス）が残っています",
    why: "パスに、作った人のフォルダの名前や、社内のサーバーの名前が入っていることがあります。",
    detail: [`${paths.length} か所`, user ? `使った人のフォルダを含むもの ${user}` : ""].filter(Boolean).join("／"),
  });
}

// ---------------------------------------------------------------- 共通：外へのつながり・埋め込み・中の写真

const LINK_KIND: Record<string, string> = {
  attachedTemplate: "ひな形",
  oleObject: "リンクした部品",
  package: "リンクした部品",
  image: "リンクした画像",
  externalLinkPath: "外のブック",
  xlExternalLinkPath: "外のブック",
  subDocument: "外の文書",
  frame: "外の文書",
  video: "リンクした動画",
  audio: "リンクした音",
};

async function externalLinks(ctx: Ctx) {
  const kinds = new Map<string, number>();
  const templates: string[] = [];
  let user = 0;
  let total = 0;
  for (const rels of names(ctx, /(^|\/)_rels\/[^/]*\.rels$/)) {
    const m = await readRels(ctx, rels);
    for (const r of m.values()) {
      if (!r.external) continue;
      const type = r.type.slice(r.type.lastIndexOf("/") + 1);
      let kind: string | null;
      if (type === "hyperlink") kind = /^(file:|\\\\|[A-Za-z]:[\\/])/i.test(r.target) ? "手元のファイルへのリンク" : null; // ウェブのリンクは数えない
      else kind = LINK_KIND[type] ?? "そのほか";
      if (!kind) continue;
      if (type === "attachedTemplate") {
        templates.push(r.target);
        continue;
      }
      total++;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (userFolder(r.target)) user++;
    }
  }
  if (templates.length) templatePath(ctx, templates);
  if (total) {
    add(ctx, {
      type: "office.external_link",
      severity: "medium",
      title: "外のファイルへのつながりが残っています",
      why: "つながり先のパスに、社内のサーバーやフォルダの名前、使った人の名前が入っていることがあります。",
      detail: [[...kinds].map(([k, n]) => `${k} ${n}`).join("・"), user ? `使った人のフォルダを含むもの ${user}` : ""].filter(Boolean).join("／"),
    });
  }
}

const OOXML_EXT = new Set(["docx", "docm", "xlsx", "xlsm", "pptx", "pptm"]);

async function embeddings(ctx: Ctx) {
  const list = names(ctx, /^(word|xl|ppt)\/embeddings\/[^/]+$/);
  if (!list.length) return;
  const exts = new Map<string, number>();
  let size = 0;
  for (const n of list) {
    const ext = safeExt(n) ?? "不明";
    exts.set(ext, (exts.get(ext) ?? 0) + 1);
    size += ctx.zip.entries.get(n)?.size ?? 0;
  }
  add(ctx, {
    type: "office.embedded",
    severity: "medium",
    title: "中にファイルが埋め込まれています",
    why: "受け取った人が、埋め込まれた元のファイル（表・文書など）をそのまま取り出せます。",
    detail: [`${list.length} 個`, [...exts].map(([e, k]) => (e === "不明" ? `種類不明 ${k}` : `.${e} ${k}`)).join("・"), formatSize(size)].join("／"),
  });
  // 埋め込まれた Office のファイルは、中まで調べる（深さ 1 まで）
  if (ctx.depth >= MAX_DEPTH) return;
  let i = 0;
  for (const n of list) {
    i++;
    if (!OOXML_EXT.has(safeExt(n) ?? "")) continue;
    const e = ctx.zip.entries.get(n)!;
    const r = await readEntry(ctx.bytes, e, ctx.budget);
    if (!r.ok) {
      ctx.unread.set(r.reason, (ctx.unread.get(r.reason) ?? 0) + 1);
      continue;
    }
    const inner = await inspectOffice(r.data, ctx.depth + 1);
    for (const f of inner.findings) ctx.findings.push({ ...f, where: [`埋め込まれたファイル ${i} 個目`, f.where].filter(Boolean).join("　") });
    for (const nt of inner.notices) ctx.notices.push({ ...nt, message: `埋め込まれたファイル ${i} 個目：${nt.message}` });
  }
}

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);

async function media(ctx: Ctx) {
  const list = names(ctx, /^(word|xl|ppt)\/media\/[^/]+$/).filter((n) => IMAGE_EXT.has(safeExt(n) ?? ""));
  if (!list.length) return;
  // 型ごとにまとめる（写真が多いと、同じ見出しが並んで読みにくいため）
  const byType = new Map<string, { f: FormatFinding; at: number[] }>();
  let skipped = 0;
  for (const [i, n] of list.entries()) {
    if (i >= MAX_IMAGES) {
      skipped = list.length - MAX_IMAGES;
      break;
    }
    const r = await readEntry(ctx.bytes, ctx.zip.entries.get(n)!, ctx.budget);
    if (!r.ok) {
      ctx.unread.set(r.reason, (ctx.unread.get(r.reason) ?? 0) + 1);
      continue;
    }
    const kind = detectFormat(r.data);
    if (kind !== "jpeg" && kind !== "png" && kind !== "webp" && kind !== "heic") continue;
    const rep = await inspectImage(r.data, kind);
    for (const f of rep.findings) {
      const cur = byType.get(f.type);
      if (!cur) byType.set(f.type, { f, at: [i + 1] });
      else {
        cur.at.push(i + 1);
        if (rank(f.severity) < rank(cur.f.severity)) cur.f = f;
      }
    }
    if (rep.notices.some((x) => x.unchecked)) ctx.unread.set("image", (ctx.unread.get("image") ?? 0) + 1);
  }
  for (const { f, at } of byType.values()) {
    ctx.findings.push({ ...f, detail: [`画像 ${at.length} 個`, f.detail].filter(Boolean).join("／"), where: `中の画像 ${places(at.map((n) => `${n}`))} 個目` });
  }
  if (skipped) ctx.notices.push({ kind: "partial", message: `中の画像が多いため、先の ${MAX_IMAGES} 個だけを調べました（${skipped} 個は調べていません）。`, unchecked: true });
}

const rank = (s: Severity) => (s === "high" ? 0 : s === "medium" ? 1 : 2);

// ---------------------------------------------------------------- docx

type Run = { vanish: boolean | null; color: Rgb | null; shd: Rgb | null; highlight: Rgb | null; rStyle: string | null; chars: number };

async function docxStyles(ctx: Ctx): Promise<{ hiddenChar: Set<string>; hiddenPara: Set<string> }> {
  const hiddenChar = new Set<string>();
  const hiddenPara = new Set<string>();
  const xml = await readText(ctx, "word/styles.xml");
  if (!xml) return { hiddenChar, hiddenPara };
  let style: { id: string; type: string } | null = null;
  walkXml(xml, {
    open(el, stack) {
      if (el.local === "style") style = { id: attr(el, "styleId") ?? "", type: attr(el, "type") ?? "" };
      // 書式の変更の記録（rPrChange）の中は、前の書式なので見ない
      if (el.local === "vanish" && style && !stack.some((s) => s.local === "rPrChange") && stack[stack.length - 1]?.local === "rPr" && on(el)) {
        if (style.type === "character") hiddenChar.add(style.id);
        if (style.type === "paragraph") hiddenPara.add(style.id);
      }
    },
    close(el) {
      if (el.local === "style") style = null;
    },
  });
  return { hiddenChar, hiddenPara };
}

/** 切り替えの属性（w:val が false・0・off でなければ入） */
const on = (el: XmlEl) => !["false", "0", "off"].includes((attr(el, "val") ?? "true").toLowerCase());

const DOCX_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;

async function docx(ctx: Ctx) {
  const styles = await docxStyles(ctx);
  const hidden = { chars: 0, at: new Set<string>() };
  const fake = { chars: 0, at: new Set<string>() };
  const white = { chars: 0, at: new Set<string>() };
  const changes = { ins: 0, del: 0, move: 0, format: 0, delChars: 0, insChars: 0, at: new Set<string>() };
  const shapes = { n: 0, at: new Set<string>() };
  for (const part of names(ctx, DOCX_PARTS)) {
    const xml = await readText(ctx, part);
    if (!xml) continue;
    const isBody = part === "word/document.xml";
    const label = (para: number) => (isBody ? `段落 ${para}` : part.includes("header") || part.includes("footer") ? "ヘッダー・フッター" : part.includes("comments") ? "コメントの中" : "脚注・文末脚注");
    let para = 0;
    let pStyle: string | null = null;
    let pShd: Rgb | null = null;
    let page: Rgb | null = null;
    let run: Run | null = null;
    let anchor: { behind: boolean; dark: boolean } | null = null;
    walkXml(xml, {
      open(el, stack) {
        const parent = stack[stack.length - 1];
        const grand = stack[stack.length - 2];
        switch (el.local) {
          case "background":
            page = hexRgb(attr(el, "color"));
            break;
          case "p":
            if (el.name.startsWith("w:") || el.name === "p") {
              para++;
              pStyle = null;
              pShd = null;
            }
            break;
          case "pStyle":
            if (parent?.local === "pPr") pStyle = attr(el, "val") ?? null;
            break;
          case "r":
            if (!el.name.startsWith("a:") && !el.name.startsWith("m:")) run = { vanish: null, color: null, shd: null, highlight: null, rStyle: null, chars: 0 };
            break;
          case "ins":
            changes.ins++;
            changes.at.add(label(para));
            break;
          case "del":
            changes.del++;
            changes.at.add(label(para));
            break;
          case "moveFrom":
          case "moveTo":
            changes.move++;
            changes.at.add(label(para));
            break;
          case "rPrChange":
          case "pPrChange":
          case "sectPrChange":
          case "tblPrChange":
            changes.format++;
            changes.at.add(label(para));
            break;
          case "anchor":
            anchor = { behind: attr(el, "behindDoc") === "1" || attr(el, "behindDoc") === "true", dark: false };
            break;
          case "srgbClr":
          case "prstClr":
            if (anchor && stack.some((s) => s.local === "spPr") && parent?.local === "solidFill" && !stack.some((s) => s.local === "ln")) {
              const c = hexRgb(el.local === "srgbClr" ? attr(el, "val") : PRESET[attr(el, "val") ?? ""]);
              if (c && lum(c) <= DARK_MAX) anchor.dark = true;
            }
            break;
          case "rect":
          case "shape":
          case "roundrect":
            // 古い形の図形（VML）。濃い色で塗ってあり、本文の後ろに置いていないもの
            if (el.name.startsWith("v:")) {
              const c = hexRgb(attr(el, "fillcolor") ?? (attr(el, "fillcolor") === "black" ? "000000" : null));
              const filled = attr(el, "filled") !== "f" && attr(el, "filled") !== "false";
              const behind = /z-index:\s*-/.test(attr(el, "style") ?? "");
              const isBlack = (attr(el, "fillcolor") ?? "").toLowerCase() === "black";
              if (filled && !behind && ((c && lum(c) <= DARK_MAX) || isBlack)) {
                shapes.n++;
                shapes.at.add(label(para));
              }
            }
            break;
        }
        // 段落の網掛け
        if (el.local === "shd" && parent?.local === "pPr") pShd = fillOf(el);
        // 字の書式（字の書式の変更の記録の中は見ない）
        if (run && parent?.local === "rPr" && grand?.local === "r") {
          if (el.local === "vanish") run.vanish = on(el);
          else if (el.local === "color") run.color = attr(el, "val") === "auto" ? null : hexRgb(attr(el, "val"));
          else if (el.local === "shd") run.shd = fillOf(el);
          else if (el.local === "highlight") run.highlight = hexRgb(HIGHLIGHT[attr(el, "val") ?? ""]);
          else if (el.local === "rStyle") run.rStyle = attr(el, "val") ?? null;
        }
      },
      text(t, stack) {
        const top = stack[stack.length - 1];
        if (!top) return;
        if (top.local === "delText") changes.delChars += countChars(t);
        if (top.local === "t" && stack.some((s) => s.local === "ins")) changes.insChars += countChars(t);
        if (run && (top.local === "t" || top.local === "delText") && top.name !== "a:t") run.chars += countChars(t);
      },
      close(el) {
        if (el.local === "anchor" && anchor) {
          if (anchor.dark && !anchor.behind) {
            shapes.n++;
            shapes.at.add(label(para));
          }
          anchor = null;
        }
        if (el.local !== "r" || !run || el.name.startsWith("a:") || el.name.startsWith("m:")) return;
        const r: Run = run;
        run = null;
        if (r.chars === 0) return;
        const isHidden = r.vanish ?? ((r.rStyle !== null && styles.hiddenChar.has(r.rStyle)) || (pStyle !== null && styles.hiddenPara.has(pStyle)));
        if (isHidden) {
          hidden.chars += r.chars;
          hidden.at.add(label(para));
          return;
        }
        const bg = r.shd ?? r.highlight ?? pShd;
        if (r.color && bg && sameColor(r.color, bg)) {
          fake.chars += r.chars;
          fake.at.add(label(para));
        } else if (r.color && !bg && lum(r.color) >= LIGHT_MIN && (!page || sameColor(r.color, page))) {
          white.chars += r.chars;
          white.at.add(label(para));
        }
      },
    });
  }
  if (changes.ins + changes.del + changes.move + changes.format) {
    const parts = [
      changes.del ? `削除 ${changes.del} か所（${changes.delChars}字）` : "",
      changes.ins ? `挿入 ${changes.ins} か所（${changes.insChars}字）` : "",
      changes.move ? `移動 ${changes.move} か所` : "",
      changes.format ? `書式の変更 ${changes.format} か所` : "",
    ];
    const onlyFormat = !changes.ins && !changes.del && !changes.move;
    add(ctx, {
      type: "office.tracked_changes",
      severity: onlyFormat ? "medium" : "high",
      title: "変更履歴が残っています",
      why: "変更履歴を表示すると、消したはずの字や、直す前の字が読めます。",
      detail: parts.filter(Boolean).join("／"),
      where: places([...changes.at]),
    });
  }
  if (hidden.chars) add(ctx, { type: "office.hidden_text", severity: "high", title: "隠し文字が残っています", why: "画面と印刷では見えませんが、設定を変えるか字をコピーすると読めます。", detail: `${hidden.chars}字`, where: places([...hidden.at]) });
  if (fake.chars) add(ctx, { type: "office.fake_redaction", severity: "high", title: "字と同じ色で塗りつぶしています（見せかけの黒塗り）", why: "字は残っているので、選んでコピーするか、塗りの色を変えると読めます。", detail: `${fake.chars}字`, where: places([...fake.at]) });
  if (white.chars) add(ctx, { type: "office.same_color_text", severity: "high", title: "背景と同じ色（白）の字があります", why: "画面では見えませんが、選んでコピーすると読めます。", detail: `${white.chars}字`, where: places([...white.at]) });
  if (shapes.n) add(ctx, { type: "office.cover_shape", severity: "medium", title: "本文の上に、濃い色で塗った図形があります", why: "図形で字を隠しているなら、図形を動かすか消すと下の字が読めます。", detail: `${shapes.n} 個`, where: places([...shapes.at]) });

  // コメント
  const comments = await readText(ctx, "word/comments.xml");
  if (comments) {
    let n = 0;
    const authors = new Set<string>();
    walkXml(comments, {
      open(el) {
        if (el.local === "comment") {
          n++;
          authors.add(attr(el, "author") ?? "");
        }
      },
    });
    if (n) commentFinding(ctx, n, authors.size);
  }
}

function fillOf(el: XmlEl): Rgb | null {
  const fill = attr(el, "fill");
  if (fill && fill !== "auto") return hexRgb(fill);
  // 柄の網掛け（solid）は、柄の色で塗る
  if (attr(el, "val") === "solid") {
    const c = attr(el, "color");
    return c && c !== "auto" ? hexRgb(c) : hexRgb("000000");
  }
  return null;
}

function commentFinding(ctx: Ctx, n: number, authors: number) {
  add(ctx, {
    type: "office.comments",
    severity: "medium",
    title: "コメントが残っています",
    why: "受け取った人が、やり取りの中身と、書いた人の名前を読めます。",
    detail: `${n} 件${authors ? `・書いた人 ${authors} 人` : ""}`,
  });
}

// ---------------------------------------------------------------- xlsx

type Xf = { numFmtId: number; fontId: number; fillId: number };

async function xlsxStyles(ctx: Ctx) {
  const theme: Array<Rgb | null> = [];
  const themeXml = await readText(ctx, "xl/theme/theme1.xml");
  if (themeXml) {
    const scheme = new Map<string, Rgb | null>();
    let cur: string | null = null;
    walkXml(themeXml, {
      open(el, stack) {
        if (stack[stack.length - 1]?.local === "clrScheme") cur = el.local;
        else if (cur && (el.local === "srgbClr" || el.local === "sysClr")) scheme.set(cur, hexRgb(el.local === "srgbClr" ? attr(el, "val") : attr(el, "lastClr")));
      },
      close(el, stack) {
        if (stack[stack.length - 1]?.local === "clrScheme") cur = null;
        void el;
      },
    });
    // 表の色の番号は、lt1・dk1・lt2・dk2 の順（テーマの並びと入れ替わる）
    for (const k of ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]) theme.push(scheme.get(k) ?? null);
  }
  const INDEXED: Record<number, string> = { 0: "000000", 1: "FFFFFF", 8: "000000", 9: "FFFFFF", 64: "000000" };
  const colorOf = (el: XmlEl): Rgb | null | undefined => {
    if (attr(el, "tint") && Number(attr(el, "tint")) !== 0) return undefined; // 明るさを変えた色は、いまは比べない
    if (attr(el, "rgb")) return hexRgb(attr(el, "rgb"));
    if (attr(el, "theme") !== undefined) return theme[Number(attr(el, "theme"))] ?? undefined;
    if (attr(el, "indexed") !== undefined) return hexRgb(INDEXED[Number(attr(el, "indexed"))]) ?? undefined;
    if (attr(el, "auto")) return hexRgb("000000");
    return undefined;
  };
  const fonts: Array<Rgb | null | undefined> = [];
  const fills: Array<Rgb | null | undefined> = [];
  const xfs: Xf[] = [];
  const hiddenFmt = new Set<number>();
  const xml = await readText(ctx, "xl/styles.xml");
  if (xml) {
    let fontColor: Rgb | null | undefined = null;
    let fill: { solid: boolean; fg: Rgb | null | undefined } | null = null;
    let fmt: { id: number; code: string } | null = null;
    walkXml(xml, {
      open(el, stack) {
        const parent = stack[stack.length - 1];
        if (el.local === "font" && parent?.local === "fonts") fontColor = hexRgb("000000"); // 色の指定がなければ黒
        else if (el.local === "color" && parent?.local === "font") fontColor = colorOf(el);
        else if (el.local === "fill" && parent?.local === "fills") fill = { solid: false, fg: null };
        else if (el.local === "patternFill" && fill) fill.solid = attr(el, "patternType") === "solid";
        else if (el.local === "fgColor" && fill) fill.fg = colorOf(el);
        else if (el.local === "gradientFill" && fill) fill.fg = undefined;
        else if (el.local === "numFmt") fmt = { id: Number(attr(el, "numFmtId")), code: attr(el, "formatCode") ?? "" };
        else if (el.local === "xf" && parent?.local === "cellXfs") {
          xfs.push({ numFmtId: Number(attr(el, "numFmtId") ?? 0), fontId: Number(attr(el, "fontId") ?? 0), fillId: Number(attr(el, "fillId") ?? 0) });
        }
        if (fmt && /^;;;$/.test(fmt.code.replace(/\s/g, ""))) hiddenFmt.add(fmt.id);
      },
      close(el, stack) {
        const parent = stack[stack.length - 1];
        if (el.local === "font" && parent?.local === "fonts") fonts.push(fontColor);
        else if (el.local === "fill" && parent?.local === "fills" && fill) {
          const f: { solid: boolean; fg: Rgb | null | undefined } = fill;
          fills.push(f.solid ? f.fg : null);
          fill = null;
        } else if (el.local === "numFmt") fmt = null;
      },
    });
  }
  return { fonts, fills, xfs, hiddenFmt };
}

/** A1 の形のセルの番地（"B3"）。番地はセルの場所で、中身ではない */
const cellRef = (s: string | undefined) => (s && /^[A-Z]{1,3}[0-9]{1,7}$/.test(s) ? s : "");

async function xlsx(ctx: Ctx) {
  const wb = await readText(ctx, "xl/workbook.xml");
  const rels = await readRels(ctx, "xl/_rels/workbook.xml.rels");
  const sheets: Array<{ index: number; state: string; part: string | null }> = [];
  if (wb) {
    walkXml(wb, {
      open(el) {
        if (el.local !== "sheet") return;
        const rid = el.attrs.get("r:id") ?? attr(el, "id");
        const t = rid ? rels.get(rid) : undefined;
        sheets.push({ index: sheets.length + 1, state: attr(el, "state") ?? "visible", part: t && !t.external ? resolvePart("xl/workbook.xml", t.target) : null });
      },
    });
  }
  const hiddenSheets = sheets.filter((s) => s.state === "hidden" || s.state === "veryHidden");
  if (hiddenSheets.length) {
    const very = hiddenSheets.filter((s) => s.state === "veryHidden").length;
    add(ctx, {
      type: "office.hidden_sheet",
      severity: "medium",
      title: "隠したシートがあります",
      why: "シートの「再表示」で、誰でも中身を見られます。",
      detail: [`${hiddenSheets.length} 枚`, very ? `うち ${very} 枚は、ふつうの操作では再表示できない形（中身は取り出せます）` : ""].filter(Boolean).join("／"),
      where: places(hiddenSheets.map((s) => `${s.index} 枚目のシート`)),
    });
  }
  const st = await xlsxStyles(ctx);
  const rowsAt: string[] = [];
  const fakeAt: string[] = [];
  const whiteAt: string[] = [];
  const fmtAt: string[] = [];
  let hiddenRows = 0;
  let hiddenCols = 0;
  let fake = 0;
  let white = 0;
  let fmt = 0;
  for (const s of sheets) {
    if (!s.part) continue;
    const xml = await readText(ctx, s.part);
    if (!xml) continue;
    let rows = 0;
    let cols = 0;
    let cell: { ref: string; s: number; has: boolean } | null = null;
    walkXml(xml, {
      open(el) {
        if (el.local === "row" && /^(1|true)$/.test(attr(el, "hidden") ?? "")) rows++;
        else if (el.local === "col" && /^(1|true)$/.test(attr(el, "hidden") ?? "")) cols += Math.max(1, Number(attr(el, "max") ?? 1) - Number(attr(el, "min") ?? 1) + 1);
        else if (el.local === "c") cell = { ref: cellRef(attr(el, "r")), s: Number(attr(el, "s") ?? 0), has: false };
      },
      text(t, stack) {
        const top = stack[stack.length - 1];
        if (cell && t.trim() && (top?.local === "v" || top?.local === "t")) cell.has = true;
      },
      close(el) {
        if (el.local !== "c" || !cell) return;
        const c: { ref: string; s: number; has: boolean } = cell;
        cell = null;
        if (!c.has) return;
        const xf = st.xfs[c.s];
        if (!xf) return;
        const place = `${s.index} 枚目のシート${c.ref ? " " + c.ref : ""}`;
        if (st.hiddenFmt.has(xf.numFmtId)) {
          fmt++;
          fmtAt.push(place);
          return;
        }
        const font = st.fonts[xf.fontId];
        const fill = st.fills[xf.fillId];
        if (!font) return; // 色が分からない字は比べない
        if (fill) {
          if (sameColor(font, fill)) {
            fake++;
            fakeAt.push(place);
          }
        } else if (fill === null && lum(font) >= LIGHT_MIN) {
          white++;
          whiteAt.push(place);
        }
      },
    });
    if (rows || cols) rowsAt.push(`${s.index} 枚目のシート`);
    hiddenRows += rows;
    hiddenCols += cols;
  }
  if (hiddenRows || hiddenCols) {
    add(ctx, {
      type: "office.hidden_rows",
      severity: "medium",
      title: "隠した行・列があります",
      why: "行や列の「再表示」で、誰でも中身を見られます。",
      detail: [hiddenRows ? `行 ${hiddenRows}` : "", hiddenCols ? `列 ${hiddenCols}` : ""].filter(Boolean).join("・"),
      where: places(rowsAt),
    });
  }
  if (fake) add(ctx, { type: "office.fake_redaction", severity: "high", title: "字と同じ色で塗りつぶしたセルがあります（見せかけの黒塗り）", why: "値は残っているので、セルを選ぶか、塗りの色を変えると読めます。", detail: `${fake} セル`, where: places(fakeAt) });
  if (white) add(ctx, { type: "office.same_color_text", severity: "high", title: "背景と同じ色（白）の字のセルがあります", why: "画面では見えませんが、セルを選ぶと値が読めます。", detail: `${white} セル`, where: places(whiteAt) });
  if (fmt) add(ctx, { type: "office.hidden_value", severity: "high", title: "値を見せない書式（;;;）のセルがあります", why: "画面では空に見えますが、セルを選ぶと値が読めます。", detail: `${fmt} セル`, where: places(fmtAt) });

  // コメント（古い形のメモと、スレッドのコメント）
  let n = 0;
  let authors = 0;
  for (const p of names(ctx, /^xl\/comments\d*\.xml$/)) {
    const xml = await readText(ctx, p);
    if (!xml) continue;
    walkXml(xml, {
      open(el) {
        if (el.local === "comment") n++;
        if (el.local === "author") authors++;
      },
    });
  }
  let threaded = 0;
  for (const p of names(ctx, /^xl\/threadedComments\/[^/]+\.xml$/)) {
    const xml = await readText(ctx, p);
    if (xml) walkXml(xml, { open: (el) => void (el.local === "threadedComment" && threaded++) });
  }
  let persons = 0;
  for (const p of names(ctx, /^xl\/persons\/[^/]+\.xml$/)) {
    const xml = await readText(ctx, p);
    if (xml) walkXml(xml, { open: (el) => void (el.local === "person" && persons++) });
  }
  if (n || threaded) commentFinding(ctx, Math.max(n, threaded), Math.max(authors, persons));

  // 共有ブックの変更履歴
  const revisions = names(ctx, /^xl\/revisions\/revisionLog\d*\.xml$/);
  if (revisions.length) {
    add(ctx, { type: "office.tracked_changes", severity: "high", title: "共有ブックの変更履歴が残っています", why: "変更履歴を表示すると、直す前の値が読めます。", detail: `記録 ${revisions.length} 個` });
  }
}

// ---------------------------------------------------------------- pptx

type Shape = { rect: [number, number, number, number] | null; fill: Rgb | null; noFill: boolean; chars: number; textColors: Rgb[]; seq: number };

function readSlideShapes(xml: string): { shapes: Shape[]; hidden: boolean; groups: number } {
  const shapes: Shape[] = [];
  let hidden = false;
  let groups = 0;
  let sp: Shape | null = null;
  let seq = 0;
  walkXml(xml, {
    open(el, stack) {
      const parent = stack[stack.length - 1];
      if (el.local === "sld" && /^(0|false)$/.test(attr(el, "show") ?? "")) hidden = true;
      if (el.local === "grpSp" && stack.some((s) => s.local === "spTree")) groups++;
      // spTree の直下の図形だけ（グループの中は座標の直しが要るので、いまは見ない）
      if (el.local === "sp" && parent?.local === "spTree") sp = { rect: null, fill: null, noFill: false, chars: 0, textColors: [], seq: seq++ };
      if (!sp) return;
      const inSpPr = stack.some((s) => s.local === "spPr");
      const inXfrm = parent?.local === "xfrm" && inSpPr;
      if (inXfrm && el.local === "off") {
        const x = Number(attr(el, "x"));
        const y = Number(attr(el, "y"));
        sp.rect = [x, y, x + (sp.rect ? sp.rect[2] - sp.rect[0] : 0), y + (sp.rect ? sp.rect[3] - sp.rect[1] : 0)];
      } else if (inXfrm && el.local === "ext") {
        const x = sp.rect?.[0] ?? 0;
        const y = sp.rect?.[1] ?? 0;
        sp.rect = [x, y, x + Number(attr(el, "cx")), y + Number(attr(el, "cy"))];
      } else if (el.local === "noFill" && parent?.local === "spPr") sp.noFill = true;
      else if ((el.local === "srgbClr" || el.local === "prstClr" || el.local === "sysClr") && parent?.local === "solidFill") {
        const c = hexRgb(el.local === "srgbClr" ? attr(el, "val") : el.local === "sysClr" ? attr(el, "lastClr") : PRESET[attr(el, "val") ?? ""]);
        if (!c) return;
        const grand = stack[stack.length - 2];
        if (grand?.local === "spPr") sp.fill = c;
        else if (grand?.local === "rPr" || grand?.local === "defRPr" || grand?.local === "endParaRPr") {
          if (grand.local === "rPr") sp.textColors.push(c);
        }
      }
    },
    text(t, stack) {
      if (sp && stack[stack.length - 1]?.local === "t" && stack.some((s) => s.local === "txBody")) sp.chars += countChars(t);
    },
    close(el, stack) {
      if (el.local === "sp" && stack[stack.length - 1]?.local === "spTree" && sp) {
        shapes.push(sp);
        sp = null;
      }
    },
  });
  return { shapes, hidden, groups };
}

const areaOf = (r: [number, number, number, number]) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const overlap = (a: [number, number, number, number], b: [number, number, number, number]) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const pt = (emu: number) => Math.round(emu / EMU_PER_PT);

async function pptx(ctx: Ctx) {
  const pres = await readText(ctx, "ppt/presentation.xml");
  const rels = await readRels(ctx, "ppt/_rels/presentation.xml.rels");
  const slides: string[] = [];
  const sizeBox: { v: [number, number] | null } = { v: null };
  if (pres) {
    walkXml(pres, {
      open(el) {
        if (el.local === "sldSz") sizeBox.v = [Number(attr(el, "cx")), Number(attr(el, "cy"))];
        if (el.local === "sldId") {
          const rid = el.attrs.get("r:id") ?? attr(el, "id");
          const t = rid ? rels.get(rid) : undefined;
          if (t && !t.external) slides.push(resolvePart("ppt/presentation.xml", t.target));
        }
      },
    });
  }
  const slideNo = new Map(slides.map((p, i) => [p, i + 1]));
  const hiddenSlides: number[] = [];
  const covers: string[] = [];
  let coverChars = 0;
  const sameAt: string[] = [];
  let sameChars = 0;
  const offAt: string[] = [];
  let offChars = 0;
  let groups = 0;
  for (const [i, part] of slides.entries()) {
    const xml = await readText(ctx, part);
    if (!xml) continue;
    const no = i + 1;
    const s = readSlideShapes(xml);
    groups += s.groups;
    if (s.hidden) hiddenSlides.push(no);
    for (const sh of s.shapes) {
      if (!sh.rect || areaOf(sh.rect) <= 0) continue;
      // 字と同じ色の図形
      if (sh.chars > 0 && sh.fill && !sh.noFill && sh.textColors.length && sh.textColors.every((c) => sameColor(c, sh.fill!))) {
        sameChars += sh.chars;
        sameAt.push(`${no} 枚目のスライド（左から ${pt(sh.rect[0])} pt・上から ${pt(sh.rect[1])} pt）`);
      }
      // スライドの外の字
      if (sh.chars > 0 && sizeBox.v) {
        const [w, h] = sizeBox.v;
        if (sh.rect[2] <= 0 || sh.rect[3] <= 0 || sh.rect[0] >= w || sh.rect[1] >= h) {
          offChars += sh.chars;
          offAt.push(`${no} 枚目のスライド`);
        }
      }
      // 字のある図形の上に重ねた、字のない濃い図形
      if (sh.chars === 0 && sh.fill && !sh.noFill && lum(sh.fill) <= DARK_MAX) {
        const under = s.shapes.filter((t) => t.seq < sh.seq && t.chars > 0 && t.rect && overlap(t.rect, sh.rect!) / areaOf(sh.rect!) >= COVER_OVERLAP_MIN);
        if (under.length) {
          coverChars += Math.max(...under.map((t) => t.chars));
          covers.push(`${no} 枚目のスライド（左から ${pt(sh.rect[0])} pt・上から ${pt(sh.rect[1])} pt）`);
        }
      }
    }
  }
  if (hiddenSlides.length) add(ctx, { type: "office.hidden_slide", severity: "medium", title: "表示しないスライドがあります", why: "スライドショーでは出ませんが、ファイルを開けば誰でも見られます。", detail: `${hiddenSlides.length} 枚`, where: places(hiddenSlides.map((n) => `${n} 枚目のスライド`)) });
  if (covers.length) add(ctx, { type: "office.cover_shape", severity: "high", title: "字のある図形の上に、濃い色の図形を重ねています", why: "上の図形を動かすか消すと、下の字が読めます。", detail: `${covers.length} か所・下の図形の字 最大 ${coverChars}字`, where: places(covers) });
  if (sameChars) add(ctx, { type: "office.fake_redaction", severity: "high", title: "字と同じ色で塗った図形があります（見せかけの黒塗り）", why: "字は残っているので、選んでコピーするか、塗りの色を変えると読めます。", detail: `${sameChars}字`, where: places(sameAt) });
  if (offChars) add(ctx, { type: "office.off_slide_text", severity: "high", title: "スライドの外に置いた字があります", why: "スライドショーや印刷では見えませんが、編集の画面やコピーで読めます。", detail: `${offChars}字`, where: places(offAt) });
  if (groups) ctx.notices.push({ kind: "partial", message: `グループにした図形（${groups} 個）の中は、重ねた図形・同じ色の字を調べていません。`, unchecked: true });

  // 発表者のメモ
  let notes = 0;
  let noteChars = 0;
  const noteSlides: number[] = [];
  for (const p of names(ctx, /^ppt\/notesSlides\/notesSlide\d+\.xml$/)) {
    const xml = await readText(ctx, p);
    if (!xml) continue;
    let chars = 0;
    let isBody = false;
    walkXml(xml, {
      open(el) {
        if (el.local === "sp") isBody = false;
        if (el.local === "ph" && (attr(el, "type") ?? "body") === "body") isBody = true;
      },
      text(t, stack) {
        if (isBody && stack[stack.length - 1]?.local === "t" && !stack.some((s) => s.local === "fld")) chars += countChars(t);
      },
    });
    if (!chars) continue;
    notes++;
    noteChars += chars;
    const nrels = await readRels(ctx, relsOf(p));
    for (const r of nrels.values()) {
      if (!r.external && r.type.endsWith("/slide")) {
        const n = slideNo.get(resolvePart(p, r.target));
        if (n) noteSlides.push(n);
      }
    }
  }
  if (notes) add(ctx, { type: "office.notes", severity: "medium", title: "発表者のメモが残っています", why: "スライドショーでは出ませんが、ファイルを開けば誰でも読めます。", detail: `スライド ${notes} 枚・${noteChars}字`, where: noteSlides.length ? places(noteSlides.sort((a, b) => a - b).map((n) => `${n} 枚目のスライド`)) : null });

  // コメント（古い形と新しい形）
  let n = 0;
  for (const p of names(ctx, /^ppt\/comments\/[^/]+\.xml$/)) {
    const xml = await readText(ctx, p);
    if (xml) walkXml(xml, { open: (el) => void (el.local === "cm" && n++) });
  }
  let authors = 0;
  for (const p of ["ppt/commentAuthors.xml", "ppt/authors.xml"]) {
    const xml = await readText(ctx, p);
    if (xml) walkXml(xml, { open: (el) => void ((el.local === "cmAuthor" || el.local === "author") && authors++) });
  }
  if (n) commentFinding(ctx, n, authors);
}

// ---------------------------------------------------------------- 入口

const UNREAD_MESSAGE: Record<string, string> = {
  encrypted: "暗号化された部分",
  unsupported: "知らない圧縮の部分",
  too_large: "大きすぎる部分",
  broken: "壊れた部分",
  image: "読めなかった画像",
};

function officeKind(zip: ZipArchive): Extract<FormatKind, "docx" | "xlsx" | "pptx"> | null {
  if (zip.entries.has("word/document.xml")) return "docx";
  if (zip.entries.has("xl/workbook.xml")) return "xlsx";
  if (zip.entries.has("ppt/presentation.xml")) return "pptx";
  return null;
}

export async function inspectOffice(bytes: Uint8Array, depth = 0): Promise<FormatReport> {
  const zip = readZip(bytes);
  if ("error" in zip) {
    const message =
      zip.error === "zip64" ? "とても大きな ZIP の形（ZIP64）は、いまは調べられません。" : "ZIP（Office のファイルの入れ物）として読めませんでした。";
    return { format: "zip", findings: [], notices: [{ kind: zip.error === "zip64" ? "unsupported" : "broken", message, unchecked: true }] };
  }
  const kind = officeKind(zip);
  if (!kind) {
    return { format: "zip", findings: [], notices: [{ kind: "unsupported", message: "今の Office（docx・xlsx・pptx）でない ZIP は、調べていません。", unchecked: true }] };
  }
  const ctx: Ctx = { bytes, zip, budget: new ZipBudget(), findings: [], notices: [], depth, unread: new Map() };
  await properties(ctx);
  if (kind === "docx") await docx(ctx);
  else if (kind === "xlsx") await xlsx(ctx);
  else await pptx(ctx);
  await externalLinks(ctx);
  await embeddings(ctx);
  await media(ctx);
  if (zip.truncated) ctx.notices.push({ kind: "partial", message: "中のファイルが多すぎるため、途中までしか調べていません。", unchecked: true });
  for (const [reason, n] of ctx.unread) {
    ctx.notices.push({ kind: reason === "encrypted" ? "encrypted" : reason === "too_large" ? "too_large" : "partial", message: `${UNREAD_MESSAGE[reason] ?? "読めなかった部分"}（${n} 個）は、調べていません。`, unchecked: true });
  }
  return { format: kind, findings: ctx.findings, notices: ctx.notices };
}
