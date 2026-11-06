// SPDX-License-Identifier: AGPL-3.0-only
//
// 本文の書体（Noto Sans JP）に入れる字と、その分け方（塊）を決める。build.mjs・ui-chars.mjs・scripts/check-dist.mjs・テストで共通に使う。
// - 入れる字：Shift_JIS で書ける字（JIS X 0208 の字・半角の英数と記号・半角カナ・NEC と IBM の拡張の字）と、画面で使う記号（EXTRA）
// - 分け方（2026-11-06 本人が決定。案 A）：
//   ①画面の字の塊（design/fonts/ui-chars.txt の字と EXTRA）
//   ②全部の字を、字の番号（Unicode）の順に並べて同じ字の数ずつ REST_CHUNKS 個に区切り、そこから①の字を除いた塊
//   塊どうしで字は重ならない。CSS の unicode-range は、塊の字だけを並べる（ほかの塊の字を含めない）
// 決まった順に作るので、同じ一覧からは、いつも同じ分け方になる。通信はしない。

/** Shift_JIS にない、画面で使う記号（状態の印・矢印など）。いつも画面の字の塊に入れる（CSS の content の書き方によっては、集め損ねるため）。
 * ▶ は「見た所・見なかった所」の開け閉めの印（src/style.css の .coverage-summary .group-head::before）。見出しの書体（Zen Maru Gothic）にない字なので、
 * ここに入れないと OS の書体で出ていた（2026-11-06 に足した） */
export const EXTRA = "✓▲▶■●◐○－⊘？→…・「」『』（）〜※";

/** 残りの字を分ける数（2026-11-06 に測って決めた。design/fonts/README.md） */
export const REST_CHUNKS = 12;

const byCodePoint = (a, b) => a.codePointAt(0) - b.codePointAt(0);

/** Shift_JIS で書ける字と EXTRA を、決まった順に集める */
export function shiftJisChars() {
  const dec = new TextDecoder("shift_jis", { fatal: false });
  const out = new Set();
  for (let b = 0x20; b <= 0x7e; b++) out.add(String.fromCharCode(b));
  for (let b = 0xa1; b <= 0xdf; b++) out.add(dec.decode(new Uint8Array([b])));
  const leads = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xef; b++) leads.push(b);
  for (const lead of leads) {
    for (let t = 0x40; t <= 0xfc; t++) {
      if (t === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([lead, t]));
      if (ch.length === 1 && ch !== "�") out.add(ch);
    }
  }
  for (const ch of EXTRA) out.add(ch);
  return [...out].sort(byCodePoint).join("");
}

/**
 * 塊に分ける。uiChars は画面の字の一覧（書体にない字は外す）。
 * 返すのは [{ id: "ui" | "r01"…, chars: "…" }]（字は番号の順）
 */
export function notoChunks(uiChars, restCount = REST_CHUNKS) {
  const all = [...shiftJisChars()];
  const font = new Set(all);
  const ui = new Set([...uiChars].filter((ch) => font.has(ch)));
  for (const ch of EXTRA) ui.add(ch);
  // 区切りは、画面の字を除く前の全部の字で決める（画面の字が 1 字増えても、変わる塊は、画面の字の塊とその字があった塊の 2 つだけにするため）
  const per = Math.ceil(all.length / restCount);
  const chunks = [{ id: "ui", chars: [...ui].sort(byCodePoint).join("") }];
  for (let i = 0; i < restCount; i++) {
    const part = all.slice(i * per, (i + 1) * per).filter((ch) => !ui.has(ch));
    if (part.length) chunks.push({ id: `r${String(i + 1).padStart(2, "0")}`, chars: part.join("") });
  }
  return chunks;
}

/** 字の集まりを、CSS の unicode-range の値にする（続いた番号はまとめる。例：U+20-7E,U+A5） */
export function unicodeRange(chars) {
  const cps = [...new Set([...chars].map((ch) => ch.codePointAt(0)))].sort((a, b) => a - b);
  const parts = [];
  const hex = (n) => n.toString(16).toUpperCase();
  for (let i = 0; i < cps.length; ) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    parts.push(i === j ? `U+${hex(cps[i])}` : `U+${hex(cps[i])}-${hex(cps[j])}`);
    i = j + 1;
  }
  return parts.join(",");
}

/**
 * 塊ごとの unicode-range の値を決める（{ [id]: "U+…" }）。
 * CSS を短くするため、書体にない字の番号（どの塊にも入らない番号。字と字の間のすき間）も、どこかの塊の範囲に含める。
 * その字がページにあると、その塊を読むが、形がないので端末の書体で出る。そこで、すき間は次の順で決める（塊どうしは重ならない）：
 *   ①両どなりが同じ塊なら、その塊　②どちらかが画面の字の塊（ui）なら ui（どのページでも先に読むので、余分に読まない）　③それ以外は、前の塊
 * 例：改行しない空白（U+00A0）は書体にないが、両どなり（~ と §）が ui なので ui に入る（前は、前の塊に含める決まりで r01 になり、結果の欄を出すたびに r01 を余分に読んでいた）。
 * 2026-11-06 に測った値：塊の字だけを並べると design/fonts.css が約 45KB、すき間を含めると約 16KB（README に今の値）
 */
export function chunkRanges(chunks) {
  const owner = new Map();
  for (const c of chunks) for (const ch of c.chars) owner.set(ch.codePointAt(0), c.id);
  const cps = [...owner.keys()].sort((a, b) => a - b);
  // [始め, 終わり, 塊] を番号の順に並べ、同じ塊が続く所をまとめる
  const segs = [];
  const push = (a, b, id) => {
    const last = segs[segs.length - 1];
    if (last && last[2] === id && last[1] === a - 1) last[1] = b;
    else segs.push([a, b, id]);
  };
  for (let i = 0; i < cps.length; i++) {
    const p = cps[i];
    push(p, p, owner.get(p));
    const q = cps[i + 1];
    if (q === undefined || q === p + 1) continue;
    const a = owner.get(p);
    const b = owner.get(q);
    push(p + 1, q - 1, a === b ? a : a === "ui" || b === "ui" ? "ui" : a);
  }
  const runs = new Map(chunks.map((c) => [c.id, []]));
  for (const [a, b, id] of segs) runs.get(id).push([a, b]);
  const hex = (n) => n.toString(16).toUpperCase();
  return Object.fromEntries([...runs].map(([k, rs]) => [k, rs.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(",")]));
}

/** unicode-range の値を、番号の集まりに戻す（テストと確かめ用） */
export function parseUnicodeRange(value) {
  const out = new Set();
  for (const part of value.split(",")) {
    const m = /^\s*U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?\s*$/.exec(part);
    if (!m) throw new Error(`unicode-range の書き方が違います：${part}`);
    const a = parseInt(m[1], 16);
    const b = m[2] ? parseInt(m[2], 16) : a;
    for (let c = a; c <= b; c++) out.add(c);
  }
  return out;
}
