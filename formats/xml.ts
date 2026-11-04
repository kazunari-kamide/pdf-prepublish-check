// SPDX-License-Identifier: AGPL-3.0-only
//
// XML を頭から順に読む小さな部品。開く・閉じる・字の3つを知らせる。
// - 名前は、名前空間の前置き（w: など）を外した名前（local）でも渡す。前置きは作ったソフトによって違うことがあるため
// - DOCTYPE・実体の定義は読み飛ばし、実体を広げない（&lt; などの決まった5つと、&#…; の数字の形だけを解く）
// - 壊れた XML でも止まらずに、読めた所まで知らせる

export type XmlEl = { name: string; local: string; attrs: Map<string, string> };

export type XmlHandler = {
  open?(el: XmlEl, stack: XmlEl[]): void;
  close?(el: XmlEl, stack: XmlEl[]): void;
  text?(text: string, stack: XmlEl[]): void;
};

const localOf = (name: string) => {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
};

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ENTITY[body] ?? all;
  });
}

const ATTR = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseAttrs(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of body.matchAll(ATTR)) {
    const name = a[1]!;
    const v = decodeEntities(a[3] ?? a[4] ?? "");
    m.set(name, v);
    const l = localOf(name);
    if (l !== name && !m.has(l)) m.set(l, v);
  }
  return m;
}

/** 属性を、前置きを外した名前で引く（w:val も val も） */
export const attr = (el: XmlEl, local: string): string | undefined => el.attrs.get(local);

export function walkXml(xml: string, h: XmlHandler): void {
  const stack: XmlEl[] = [];
  let at = 0;
  const n = xml.length;
  while (at < n) {
    const lt = xml.indexOf("<", at);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > at && h.text && stack.length) h.text(decodeEntities(xml.slice(at, textEnd)), stack);
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      at = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      const end = e < 0 ? n : e;
      if (h.text && stack.length) h.text(xml.slice(lt + 9, end), stack);
      at = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const e = xml.indexOf("?>", lt + 2);
      at = e < 0 ? n : e + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // DOCTYPE（中の [ … ] も含めて読み飛ばす。実体は広げない）
      let depth = 0;
      let i = lt + 2;
      for (; i < n; i++) {
        const c = xml[i];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      at = i + 1;
      continue;
    }
    // タグ。属性の値の中の > は飛ばす
    let i = lt + 1;
    let quote: string | null = null;
    for (; i < n; i++) {
      const c = xml[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (i >= n) break;
    const inner = xml.slice(lt + 1, i);
    at = i + 1;
    if (inner[0] === "/") {
      const name = inner.slice(1).trim();
      // 閉じるタグに合う開いたタグまで戻る（壊れた入れ子でも止まらない）
      const idx = stack.map((s) => s.name).lastIndexOf(name);
      if (idx < 0) continue;
      while (stack.length > idx) {
        const el = stack.pop()!;
        h.close?.(el, stack);
      }
      continue;
    }
    const self = inner.endsWith("/");
    const body = self ? inner.slice(0, -1) : inner;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    if (!name) continue;
    const el: XmlEl = { name, local: localOf(name), attrs: sp < 0 ? new Map() : parseAttrs(body.slice(sp)) };
    h.open?.(el, stack);
    if (self) h.close?.(el, stack);
    else stack.push(el);
  }
  while (stack.length) {
    const el = stack.pop()!;
    h.close?.(el, stack);
  }
}

/** 字の数（空白を数えない。サロゲートの組は1字） */
export function countChars(s: string): number {
  let n = 0;
  for (const c of s) if (!/\s/.test(c)) n++;
  return n;
}
