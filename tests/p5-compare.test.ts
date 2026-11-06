// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P5 1.4.0：前の版の残りを今の版と比べ、画面の深刻度を決める（2026-11-05）。
// 実物の公開 PDF で、今の版と同じ中身の残り（保存し直しただけ・日付だけが変わった版）が「高」で多く出た。
// その型をテストの中で合成して再現する。名前・字はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { detectP5Revisions } from "../rules/p5-revisions/index.ts";
import { allPresent, contentBlocks, findPresent, xmpTokens } from "../rules/p5-revisions/compare.ts";
import { RULES } from "../src/inspect/rules.ts";

const p5Rule = RULES.find((r) => r.id === "p5-revisions")!;
const enc = (s: string) => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

type Base = { bytes: Uint8Array; root: number; info: number; page: number; contents: number; size: number };

async function makeBase(extra?: (doc: PDFDocument) => void | Promise<void>): Promise<Base> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  page.drawText("Hello", { x: 10, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  doc.setAuthor("Yamada Taro");
  doc.setTitle("Kaigi shiryo");
  await extra?.(doc);
  const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const t = latin1(bytes);
  return {
    bytes,
    root: doc.context.trailerInfo.Root!.toString().split(" ").map(Number)[0]!,
    info: Number(/\/Info (\d+) 0 R/.exec(t)![1]),
    page: page.ref.objectNumber,
    contents: Number(/\/Contents \[?\s*(\d+) 0 R/.exec(t)![1]),
    size: Number(/\/Size (\d+)/.exec(t)![1]),
  };
}

/** 増分更新を1つ書き足す */
function append(base: Uint8Array, opts: { objects?: Array<[number, string]>; free?: number[]; root: number; info?: number | null; size: number }): Uint8Array {
  const prev = Number([...latin1(base).matchAll(/startxref\s+(\d+)/g)].pop()![1]);
  let body = "\n";
  const entries: Array<[number, string]> = [];
  for (const [n, text] of opts.objects ?? []) {
    entries.push([n, `${String(base.length + body.length).padStart(10, "0")} 00000 n \n`]);
    body += `${n} 0 obj\n${text}\nendobj\n`;
  }
  for (const n of opts.free ?? []) entries.push([n, "0000000000 00001 f \n"]);
  entries.sort((a, b) => a[0] - b[0]);
  const xrefAt = base.length + body.length;
  body += "xref\n";
  for (const [n, line] of entries) body += `${n} 1\n${line}`;
  // info を渡さなければ、前の trailer の /Info をそのまま引き継ぐ（保存し直したときと同じ）
  const infoNum = opts.info === undefined ? Number(/\/Info (\d+) 0 R/.exec(latin1(base))?.[1] ?? 0) || null : opts.info;
  const info = infoNum ? ` /Info ${infoNum} 0 R` : "";
  body += `trailer\n<< /Size ${opts.size} /Root ${opts.root} 0 R${info} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const out = new Uint8Array(base.length + body.length);
  out.set(base);
  out.set(enc(body), base.length);
  return out;
}

const stream = (content: string, dict = "") => `<< /Length ${content.length}${dict} >>\nstream\n${content}\nendstream`;

async function run(bytes: Uint8Array) {
  const r = await detectP5Revisions(bytes);
  const ui = await p5Rule.run(bytes);
  return { r, severities: ui.items.filter((i) => i.title.includes("修正する前の版") || i.title.includes("描かれない部品")).map((i) => i.severity) };
}

describe("比べの部品", () => {
  it("ページの中身の字は、BT〜ET ごとにつなぎ、字間の調整の数・逃がし・16進の書き方の違いを無視する", () => {
    expect(contentBlocks("BT /F1 12 Tf [(Hel) -20 (lo)] TJ ET")).toEqual(["Hello"]);
    expect(contentBlocks("BT <48656C6C6F> Tj ET BT (a\\(b\\)) Tj ET")).toEqual(["Hello", "a(b)"]);
    expect(contentBlocks("BT (\\110ello) Tj ET")).toEqual(["Hello"]);
    // 埋め込み画像の中身と、<< >> の辞書は字にしない
    expect(contentBlocks("BI /W 1 /H 1 ID (x) EI BT /P <</MCID 0>> BDC (A) Tj EMC ET")).toEqual(["A"]);
  });

  it("XMP の字の値から、日付・識別子・数を除く", () => {
    const xml =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description xmp:ModifyDate="2026-01-02T03:04:05+09:00" xmpMM:InstanceID="uuid:1234-abcd">' +
      "<dc:creator>Yamada &amp; Co</dc:creator><pdf:Producer>Tool 1.0</pdf:Producer><xmp:Count>12</xmp:Count></rdf:Description></x:xmpmeta>";
    expect(xmpTokens(xml)).toEqual(["Yamada & Co", "Tool 1.0"]);
  });

  it("すべての字が今の版にあるときだけ、そろっているとする", () => {
    expect(allPresent(["ab", "cd"], new Set(["ab"]), "xxcdxx")).toBe(true);
    expect(allPresent(["ab", "zz"], new Set(["ab"]), "xxcdxx")).toBe(false);
  });
});

describe("文書情報の前の版", () => {
  it("日付だけを変えて保存し直した版（作成者・タイトルは同じ）は「同じ」で、画面では「低」", async () => {
    const b = await makeBase();
    const bytes = append(b.bytes, {
      objects: [[b.info, "<< /Author (Yamada Taro) /Title (Kaigi shiryo) /ModDate (D:20261105000000) >>"]],
      root: b.root,
      info: b.info,
      size: b.size,
    });
    const { r, severities } = await run(bytes);
    expect(r.findings.map((f) => `${f.kind}:${f.compare}`)).toEqual(["info:same"]);
    expect(severities).toEqual(["low"]);
  });

  it("作成者を書き換えた版（前の版の作成者が今の版にない）は「違う」で、画面では「高」", async () => {
    const b = await makeBase();
    const bytes = append(b.bytes, { objects: [[b.info, "<< /Author (Somu-ka) /Title (Kaigi shiryo) >>"]], root: b.root, info: b.info, size: b.size });
    const { r, severities } = await run(bytes);
    expect(r.findings.map((f) => `${f.kind}:${f.compare}`)).toEqual(["info:differs"]);
    expect(severities).toEqual(["high"]);
  });

  it("文書情報を消した版は、前の版の字が今の版にないので「高」", async () => {
    const b = await makeBase();
    const bytes = append(b.bytes, { free: [b.info], root: b.root, info: null, size: b.size });
    const { r, severities } = await run(bytes);
    expect(r.findings.map((f) => `${f.kind}:${f.where}:${f.compare}`)).toEqual(["info:free:differs"]);
    expect(severities).toEqual(["high"]);
  });
});

describe("ページの中身の前の版", () => {
  it("同じ字を、字間の調整を変えて書き直した版は「同じ」で、画面では「低」", async () => {
    const b = await makeBase();
    const bytes = append(b.bytes, { objects: [[b.contents, stream("BT /F1 12 Tf 10 100 Td [(Hel) -15 (lo)] TJ ET")]], root: b.root, size: b.size });
    const { r, severities } = await run(bytes);
    expect(r.findings.map((f) => `${f.kind}:${f.where}:${f.compare}`)).toEqual(["content:superseded:same"]);
    expect(severities).toEqual(["low"]);
  });

  it("字を差し替えた版（前の版の字が今の版にない）は「違う」で、画面では「高」", async () => {
    const b = await makeBase();
    const bytes = append(b.bytes, { objects: [[b.contents, stream("BT /F1 12 Tf 10 100 Td (World) Tj ET")]], root: b.root, size: b.size });
    const { r, severities } = await run(bytes);
    expect(r.findings.map((f) => `${f.kind}:${f.compare}`)).toEqual(["content:differs"]);
    expect(severities).toEqual(["high"]);
  });

  it("ページの中身を別の番号に移し、字を足しただけの版（前の字はすべて今もある）は「同じ」", async () => {
    const b = await makeBase();
    const n = b.size;
    const pageText = latin1(b.bytes).match(new RegExp(`\\n${b.page} 0 obj\\n([\\s\\S]*?)\\nendobj`))![1]!;
    const bytes = append(b.bytes, {
      objects: [
        [n, stream("BT /F1 12 Tf 10 100 Td (Hello) Tj ET BT /F1 12 Tf 10 80 Td (Sekai) Tj ET")],
        [b.page, pageText.replace(/\/Contents \[?\s*\d+ 0 R\s*\]?/, `/Contents ${n} 0 R`)],
      ],
      root: b.root,
      size: n + 1,
    });
    const { r, severities } = await run(bytes);
    expect(r.findings.map((f) => `${f.kind}:${f.where}:${f.compare}`)).toEqual(["content:unreferenced:same"]);
    expect(severities).toEqual(["low"]);
  });
});

describe("画像・作成の記録・注釈の前の版", () => {
  it("同じ画像を書き直しただけなら「同じ」、画素を差し替えたら「違う」", async () => {
    const img = (px: string) => stream(px, " /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8");
    let n = 0;
    const b = await makeBase((doc) => {
      const ctx = doc.context;
      const ref = ctx.register(ctx.stream(enc("AB"), { Type: "XObject", Subtype: "Image", Width: 2, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      n = ref.objectNumber;
      doc.getPage(0).node.Resources()!.set(PDFName.of("XObject"), ctx.obj({ Im0: ref }));
    });
    const same = append(b.bytes, { objects: [[n, img("AB")]], root: b.root, size: b.size });
    const differs = append(b.bytes, { objects: [[n, img("CD")]], root: b.root, size: b.size });
    expect((await run(same)).r.findings.filter((f) => f.kind === "image").map((f) => f.compare)).toEqual(["same"]);
    expect((await run(differs)).r.findings.filter((f) => f.kind === "image").map((f) => f.compare)).toEqual(["differs"]);
  });

  it("XMP の日付と識別子だけが変わった版は「同じ」、作成者が変わった版は「違う」", async () => {
    const xmp = (who: string, date: string, id: string) =>
      `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmp:ModifyDate="${date}" xmpMM:InstanceID="uuid:${id}"><dc:creator>${who}</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const meta = (s: string) => stream(s, " /Type /Metadata /Subtype /XML");
    const b = await makeBase();
    const n = b.size;
    const rootText = latin1(b.bytes).match(new RegExp(`\\n${b.root} 0 obj\\n([\\s\\S]*?)\\nendobj`))![1]!;
    const v1 = append(b.bytes, {
      objects: [[n, meta(xmp("Somu-ka", "2026-01-01T00:00:00Z", "aaaa-1111"))], [b.root, rootText.replace("<<", `<< /Metadata ${n} 0 R`)]],
      root: b.root,
      size: n + 1,
    });
    const same = append(v1, { objects: [[n, meta(xmp("Somu-ka", "2026-11-05T00:00:00Z", "bbbb-2222"))]], root: b.root, size: n + 1 });
    const differs = append(v1, { objects: [[n, meta(xmp("Kikaku-ka", "2026-11-05T00:00:00Z", "bbbb-2222"))]], root: b.root, size: n + 1 });
    expect((await run(same)).r.findings.filter((f) => f.kind === "metadata").map((f) => f.compare)).toEqual(["same"]);
    expect((await run(differs)).r.findings.filter((f) => f.kind === "metadata").map((f) => f.compare)).toEqual(["differs"]);
  });

  it("消した注釈のメモ（今の版にない字）は「高」", async () => {
    const b = await makeBase();
    const n = b.size;
    const v1 = append(b.bytes, { objects: [[n, "<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (Naibu memo) >>"]], root: b.root, size: n + 1 });
    const v2 = append(v1, { free: [n], root: b.root, size: n + 1 });
    const { r, severities } = await run(v2);
    expect(r.findings.map((f) => `${f.kind}:${f.compare}`)).toEqual(["annotation:differs"]);
    expect(severities).toEqual(["high"]);
  });
});

describe("描かれない部品", () => {
  it("前の版との違いを比べられないので、画面では「中」", async () => {
    const b = await makeBase((doc) => {
      const ctx = doc.context;
      const form = ctx.flateStream("BT /F1 12 Tf (Kakushi) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] });
      const ref = ctx.register(form);
      const page = doc.getPage(0);
      const res = page.node.Resources()!;
      res.set(PDFName.of("XObject"), ctx.obj({ Unused: ref }));
    });
    const { r, severities } = await run(b.bytes);
    expect(r.findings.map((f) => `${f.kind}:${f.compare ?? "-"}`)).toEqual(["unused_form:-"]);
    expect(severities).toEqual(["medium"]);
  });
});

describe("比べる処理の速さ（1.4.1）", () => {
  it("まとめて探した結果は、1つずつ includes で探した結果と同じ", () => {
    // 決まった種から作る、ばらばらの字（短い字・重なる字・ほかの字の頭や尻にあたる字・日本語を混ぜる）
    let seed = 12345;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
    const alphabet = ["a", "b", "c", "ab", "あ", "い", "\u0000", "\n"];
    const word = (len: number) => Array.from({ length: len }, () => alphabet[rand(alphabet.length)]).join("");
    for (let round = 0; round < 200; round++) {
      const hay = word(rand(60));
      const needles = Array.from({ length: 1 + rand(12) }, () => word(rand(6)));
      const got = findPresent(needles, hay)!;
      for (const n of needles) expect(got.has(n), `${JSON.stringify(n)} in ${JSON.stringify(hay)}`).toBe(hay.includes(n));
    }
  });

  it("探す字の合計が上限を超えたら探さない", () => {
    expect(findPresent(["abcd", "efgh"], "xxabcdxx", 7)).toBeNull();
    expect([...findPresent(["abcd", "efgh"], "xxabcdxx", 8)!]).toEqual(["abcd"]);
  });

  it("塊の多い前の版と、大きな今の版を比べても、時間が延びない（結果は変わらない）", async () => {
    const block = (prefix: string, i: number) => `BT (${prefix}${String(i).padStart(6, "0")}zz) Tj ET`;
    const range = (n: number) => Array.from({ length: n }, (_, i) => i);
    const b = await makeBase();
    /** 前の版の塊 n 個と、今の版（大きな中身 10n 個のあとに、前の版の字がすべてある）の 2 つの版を足した PDF */
    const build = (n: number) => {
      const old = range(n).map((i) => block("Q", i)).join("\n");
      const current = [...range(n * 10).map((i) => block("R", i)), ...range(n).reverse().map((i) => block("Q", i))].join("\n");
      const v1 = append(b.bytes, { objects: [[b.contents, stream(old)]], root: b.root, size: b.size });
      return append(v1, { objects: [[b.contents, stream(current)]], root: b.root, size: b.size });
    };
    /** times 回測って、いちばん短い時間（ほかの処理の負荷で延びた回を除く） */
    const fastest = async (bytes: Uint8Array, times: number) => {
      let best = Infinity;
      let report: Awaited<ReturnType<typeof detectP5Revisions>> | null = null;
      for (let k = 0; k < times; k++) {
        const t0 = performance.now();
        report = await detectP5Revisions(bytes);
        best = Math.min(best, performance.now() - t0);
      }
      return { ms: best, report: report! };
    };
    const small = await fastest(build(10_000), 3);
    const large = await fastest(build(40_000), 2);
    for (const { report } of [small, large]) {
      const content = report.findings.filter((f) => f.kind === "content").sort((x, y) => x.revision! - y.revision!);
      // 1番目の版（Hello）は今の版にないので「違う」、2番目の版は字がすべて今の版にあるので「同じ」
      expect(content.map((f) => f.compare)).toEqual(["differs", "same"]);
    }
    // 大きさを 4 倍にしたときの時間の比で見る（機械の速さ・ほかの処理の負荷に左右されにくい。2026-11-06 から）。
    // 1つずつ探す作り（1.4.0）は、塊の数 × 今の版の長さに比例するので、4 倍にすると約 16 倍になる。今の作りは約 4 倍
    const ratio = large.ms / small.ms;
    console.log(`p5 の比べ：1 万塊 ${Math.round(small.ms)} ms、4 万塊 ${Math.round(large.ms)} ms、比 ${ratio.toFixed(1)}`);
    expect(ratio).toBeLessThan(8);
  }, 120_000);
});
