// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P5（旧版の残存）の、前の版と今の版の比べ（1.4.0 から）。
// 前の版に残っている字が、今の版のどこかにすべてあれば「同じ」（前の版から新しく分かることはない）、
// 1つでも今の版にない字があれば「違う」とする。字そのものは返さない（比べた結果だけ）。

/** 字の並びとして比べる、ページの中身の字。BT〜ET ごとに、字を描く命令の文字列をつないだもの（字間の調整の数は無視する） */
export function contentBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur = "";
  let i = 0;
  const n = text.length;
  const isDelim = (c: string | undefined) => c === undefined || /[\s()<>[\]{}/%]/.test(c);
  const flush = () => {
    if (cur !== "") blocks.push(cur);
    cur = "";
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "%") {
      // 注釈（行の終わりまで）
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
      continue;
    }
    if (c === "(") {
      // 文字列。入れ子のかっこと \ の逃がしを解く
      let depth = 1;
      i++;
      let s = "";
      while (i < n && depth > 0) {
        const d = text[i]!;
        if (d === "\\") {
          const e = text[i + 1];
          if (e === undefined) break;
          if (/[0-7]/.test(e)) {
            let oct = e;
            let j = i + 2;
            while (oct.length < 3 && j < n && /[0-7]/.test(text[j]!)) oct += text[j++];
            s += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i = j;
            continue;
          }
          const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
          if (e === "\r") {
            i += text[i + 2] === "\n" ? 3 : 2; // 行の続き
            continue;
          }
          if (e === "\n") {
            i += 2;
            continue;
          }
          s += map[e] ?? e;
          i += 2;
          continue;
        }
        if (d === "(") depth++;
        if (d === ")") {
          depth--;
          if (depth === 0) break;
        }
        s += d;
        i++;
      }
      i++;
      cur += s;
      continue;
    }
    if (c === "<") {
      if (text[i + 1] === "<") {
        i += 2;
        continue;
      }
      const end = text.indexOf(">", i + 1);
      if (end < 0) break;
      const hex = text.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, "");
      const padded = hex.length % 2 ? hex + "0" : hex;
      let s = "";
      for (let k = 0; k < padded.length; k += 2) s += String.fromCharCode(parseInt(padded.slice(k, k + 2), 16));
      cur += s;
      i = end + 1;
      continue;
    }
    if (!isDelim(c) && isDelim(text[i - 1])) {
      // 命令の名前
      let j = i;
      while (j < n && !isDelim(text[j])) j++;
      const word = text.slice(i, j);
      if (word === "ET" || word === "BT") flush();
      else if (word === "ID") {
        // 埋め込み画像の中身（EI まで）は字ではない
        const m = /\sEI(?=[\s]|$)/.exec(text.slice(j));
        j = m ? j + m.index + m[0].length : n;
      }
      i = j;
      continue;
    }
    i++;
  }
  flush();
  return blocks;
}

/** XMP の中の字の値（日付・識別子・数だけの値を除く）。作り直すたびに変わる値は、比べに使わない */
export function xmpTokens(xml: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const t = raw
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
    if (t === "") return;
    if (/^\d{4}-\d{2}(-\d{2})?(T[\d:.+\-Z]*)?$/.test(t)) return; // 日付
    if (/^(uuid|xmp\.(iid|did)|adobe:docid)[:\w-]*/i.test(t)) return; // 識別子
    if (/^[\d\s.,:+\-/]+$/.test(t)) return; // 数だけ
    if (/^[0-9A-Fa-f-]{16,}$/.test(t)) return; // 16進の識別子
    out.push(t);
  };
  const body = xml.replace(/<\?xpacket[\s\S]*?\?>/g, "");
  for (const m of body.matchAll(/>([^<]+)</g)) add(m[1]!);
  for (const m of body.matchAll(/\s[\w:]+="([^"]*)"/g)) {
    // 名前空間の宣言（xmlns）の値は除く
    const head = m[0].trim();
    if (head.startsWith("xmlns")) continue;
    add(m[1]!);
  }
  return out;
}

/** 前の版の字（tokens）が、今の版の字（set か、つないだ文字列）にすべてあるか（1つずつ探す。小さな比べ・テスト用） */
export function allPresent(tokens: string[], set: Set<string>, joined: string): boolean {
  return tokens.every((t) => set.has(t) || joined.includes(t));
}

/** 一度に探す字の合計の上限（文字の数）。超えたら探さない（null を返す） */
export const MAX_NEEDLE_CHARS = 2_000_000;

/**
 * needles のうち、haystack の中に（部分として）現れるものの集まりを返す（1.4.1 から）。
 * 1つずつ haystack.includes で探すと、needles の数 × haystack の長さの時間がかかるので、
 * 全部の needles から1つの自動機械（Aho–Corasick）を作り、haystack を頭から1回だけなめる。
 * かかる時間は、needles の字の合計と haystack の長さにほぼ比例する。結果は includes で1つずつ探したときと同じ。
 * needles の字の合計が maxChars を超えたら null（探さない）
 */
export function findPresent(needles: Iterable<string>, haystack: string, maxChars = MAX_NEEDLE_CHARS): Set<string> | null {
  const list = [...new Set(needles)];
  const found = new Set<string>();
  let total = 0;
  for (const n of list) total += n.length;
  if (total > maxChars) return null;
  // 木を作る。go の鍵は「節の番号 × 65536 ＋ 字の符号（UTF-16 の単位）」
  const go = new Map<number, number>();
  const out: number[][] = [[]]; // 節ごとに、そこで終わる needle の番号
  const step = (node: number, c: number) => go.get(node * 65536 + c);
  let nodes = 1;
  list.forEach((n, id) => {
    if (n === "") {
      found.add(n);
      return;
    }
    let node = 0;
    for (let i = 0; i < n.length; i++) {
      const key = node * 65536 + n.charCodeAt(i);
      let next = go.get(key);
      if (next === undefined) {
        next = nodes++;
        go.set(key, next);
        out.push([]);
      }
      node = next;
    }
    out[node]!.push(id);
  });
  // 失敗のつなぎ（幅優先）と、出力のつなぎ（そこから失敗をたどって最初に出会う、needle の終わる節）
  const fail = new Int32Array(nodes);
  const outLink = new Int32Array(nodes).fill(-1);
  const children: Array<Array<[number, number]>> = Array.from({ length: nodes }, () => []);
  for (const [key, child] of go) children[Math.floor(key / 65536)]!.push([key % 65536, child]);
  const queue: number[] = [];
  for (const [, child] of children[0]!) {
    fail[child] = 0;
    queue.push(child);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const node = queue[qi]!;
    for (const [c, child] of children[node]!) {
      let f = fail[node]!;
      while (f !== 0 && step(f, c) === undefined) f = fail[f]!;
      const g = step(f, c);
      fail[child] = g !== undefined && g !== child ? g : 0;
      const fc = fail[child]!;
      outLink[child] = out[fc]!.length ? fc : outLink[fc]!;
      queue.push(child);
    }
  }
  // haystack を1回なめる。出力をたどるのは、まだ印を付けていない節だけ（同じ節を何度もたどらない）
  const marked = new Uint8Array(nodes);
  let node = 0;
  for (let i = 0; i < haystack.length; i++) {
    const c = haystack.charCodeAt(i);
    let next = step(node, c);
    while (next === undefined && node !== 0) {
      node = fail[node]!;
      next = step(node, c);
    }
    node = next ?? 0;
    for (let v = node; v > 0 && !marked[v]; v = outLink[v]!) {
      marked[v] = 1;
      for (const id of out[v]!) found.add(list[id]!);
      if (outLink[v]! < 0) break;
    }
    if (found.size === list.length) break;
  }
  return found;
}
