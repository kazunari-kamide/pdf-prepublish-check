// SPDX-License-Identifier: AGPL-3.0-only
//
// PDF のバイト列を、区切り（xref の表と trailer）ごとに手で組み立てる小さな書き手。
// pdf-lib では作れない形（線形化した PDF のように、trailer が 2 つあり、最後の trailer に /Info が無いもの）を合成するのに使う。
// 中身はすべて架空。

export type RawSection = {
  /** このくぎりで書くオブジェクト（番号 → 中身。"<< ... >>" など） */
  objects: Record<number, string>;
  /** trailer の辞書の中身（/Prev は、prev: true のとき、もう一方のくぎりの xref の位置を入れる） */
  trailer: string;
  /** /Prev に入れる、ほかのくぎりの番号（0 から） */
  prevOf?: number;
};

const enc = new TextEncoder();

/** くぎりを順に書く。/Prev の位置は、2 回書いて合わせる */
export function rawPdf(sections: RawSection[]): Uint8Array {
  let xrefAt: number[] = sections.map(() => 0);
  let out = "";
  for (let pass = 0; pass < 2; pass++) {
    out = "%PDF-1.7\n%âãÏÓ\n";
    const next: number[] = [];
    for (const [i, s] of sections.entries()) {
      const offsets: Array<[number, number]> = [];
      for (const [n, body] of Object.entries(s.objects)) {
        offsets.push([Number(n), out.length]);
        out += `${n} 0 obj\n${body}\nendobj\n`;
      }
      next[i] = out.length;
      out += "xref\n";
      if (i === 0) out += "0 1\n0000000000 65535 f \n";
      for (const [n, off] of offsets) out += `${n} 1\n${String(off).padStart(10, "0")} 00000 n \n`;
      const prev = s.prevOf !== undefined ? ` /Prev ${xrefAt[s.prevOf]}` : "";
      out += `trailer\n<< ${s.trailer}${prev} >>\nstartxref\n${next[i]}\n%%EOF\n`;
    }
    xrefAt = next;
  }
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

export const ascii = (s: string) => enc.encode(s);
