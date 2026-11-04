// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6 1.10.0 のテスト：白い覆いの上に、あとから描いたもの。
// 形：白黒の画像 → 白い注釈（札） → その中に、札からはみ出す濃い Ink 注釈。
// - 片付けたあと（下の画素は消えていて、Ink の線の形だけが濃く塗ってある）は、漏れではないので出さない
// - 片付ける前（下に中身がある）は、確かなもの（high）のまま
// - 白い札の上に細い線を密に引いても、下の漏れは消えない（check 以上で出る）
// - 上に描いたものの形が上限を超えたページは、1.9.0 と同じ測り方に戻す

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, type PDFRef } from "pdf-lib";
import { detectP6Text, type P6ImageFinding } from "../rules/p6-text/index.ts";
import { DEFAULT_SETTINGS } from "../rules/p6-text/settings.ts";

const IW = 800; // ページの 400pt に 800 画素（144dpi）
const IH = 400;
const S = IW / 400;
const TAG = [100, 60, 300, 140];

type Stroke = { w: number; segs: [number, number, number, number][] };
/** Ink の線（ページの座標）。白い札の中を通り、右と上ではみ出す */
const INK: Stroke[] = [
  { w: 0.75, segs: [[120, 100, 320, 110], [320, 110, 330, 150]] },
  { w: 3, segs: [[150, 80, 280, 130], [280, 130, 290, 160]] },
];

/** 画像の画素。content＝字の行のような中身、paint＝線の形を濃く塗る（片付けのまね。grow 画素だけ外へふくらませる） */
function pixels(o: { content: boolean; paint?: Stroke[]; grow?: number }): Uint8Array {
  const px = new Uint8Array(IW * IH).fill(255);
  const grow = (o.grow ?? 0) / S;
  for (let y = 0; y < IH; y++) {
    for (let x = 0; x < IW; x++) {
      const X = (x + 0.5) / S;
      const Y = (IH - y - 0.5) / S;
      if (o.content && Math.floor(Y) % 20 < 8 && Math.floor(X) % 11 < 2) px[y * IW + x] = 20;
      for (const st of o.paint ?? []) {
        for (const [x0, y0, x1, y1] of st.segs) {
          const dx = x1 - x0;
          const dy = y1 - y0;
          const t = Math.max(0, Math.min(1, ((X - x0) * dx + (Y - y0) * dy) / (dx * dx + dy * dy)));
          if (Math.hypot(X - (x0 + t * dx), Y - (y0 + t * dy)) <= st.w / 2 + grow) px[y * IW + x] = 20;
        }
      }
    }
  }
  return px;
}

/** Ink 注釈の見た目（/AP の /N）。線の端は丸く（1 J） */
function inkAnnot(doc: PDFDocument, strokes: Stroke[]): PDFRef {
  const ops = strokes
    .map((st) => `${st.w} w 1 J 1 j 0 0 0 RG ` + st.segs.map(([a, b, c, d], i) => (i === 0 ? `${a} ${b} m ` : "") + `${c} ${d} l`).join(" ") + " S")
    .join("\n");
  const ap = doc.context.register(doc.context.flateStream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 200] }));
  const inkList = strokes.map((st) => st.segs.flatMap(([a, b, c, d], i) => (i === 0 ? [a, b, c, d] : [c, d])));
  return doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 400, 200], F: 4, InkList: inkList, AP: { N: ap } }));
}

async function makePdf(o: { px: Uint8Array; content?: string; annots?: (doc: PDFDocument) => PDFRef[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 200]);
  const img = doc.context.register(doc.context.flateStream(o.px, { Type: "XObject", Subtype: "Image", Width: IW, Height: IH, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
  page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: { Im0: img } }));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(`q 400 0 0 200 0 0 cm /Im0 Do Q\n${o.content ?? ""}`)));
  if (o.annots) page.node.set(PDFName.of("Annots"), doc.context.obj(o.annots(doc)));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}
const square = (doc: PDFDocument, rect: number[], ic: number[]) => doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: rect, IC: ic, C: ic, F: 4 }));
const whiteTagWithInk = (ink: Stroke[]) => (doc: PDFDocument) => [square(doc, TAG, [1, 1, 1]), inkAnnot(doc, ink)];
const imageHits = (r: Awaited<ReturnType<typeof detectP6Text>>) => r.findings.filter((f): f is P6ImageFinding => f.layer === "image");

describe("P6 1.10.0：白い覆いの上に、あとから描いたもの", () => {
  it("片付けたあと（下は Ink の線の形だけが濃い）は出さない。線の形どおりでも、外へ1画素ふくらませて塗っても", async () => {
    for (const grow of [0, 1]) {
      const r = await detectP6Text(await makePdf({ px: pixels({ content: false, paint: INK, grow }), annots: whiteTagWithInk(INK) }), { explain: true });
      expect(imageHits(r), `grow=${grow}`).toEqual([]);
    }
  });

  it("太さ 1pt 未満の細い線（覆いにはならない線）の形も、数えない形に入る", async () => {
    const thin = [INK[0]!];
    const r = await detectP6Text(await makePdf({ px: pixels({ content: false, paint: thin, grow: 1 }), annots: whiteTagWithInk(thin) }));
    expect(imageHits(r)).toEqual([]);
  });

  it("片付ける前（下に中身がある）は high のまま。ばらつきは Ink がないときとほぼ同じ", async () => {
    const px = pixels({ content: true });
    const withInk = imageHits(await detectP6Text(await makePdf({ px, annots: whiteTagWithInk(INK) }), { explain: true }));
    const noInk = imageHits(await detectP6Text(await makePdf({ px, annots: (doc) => [square(doc, TAG, [1, 1, 1])] })));
    expect(withInk).toHaveLength(1);
    expect(withInk[0]).toMatchObject({ cover: "annotation", tone: "light", confidence: "high" });
    expect(withInk[0]!.metrics!.laterPaintPoints).toBeGreaterThan(0);
    expect(Math.abs(withInk[0]!.spread! - noInk[0]!.spread!)).toBeLessThan(0.01);
  });

  it("白い札のほぼ全部を、あとから黒い注釈で覆った形：黒い注釈で high。白い札は、黒い注釈で見つかるので省く", async () => {
    const r = await detectP6Text(
      await makePdf({ px: pixels({ content: true }), annots: (doc) => [square(doc, TAG, [1, 1, 1]), square(doc, [99, 59, 301, 141], [0, 0, 0])] }),
      { explain: true },
    );
    const hits = imageHits(r);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ cover: "annotation", tone: "dark", confidence: "high" });
    expect(r.excluded?.["image:under_later_cover"]).toBe(1);
  });

  it("白い札の上に細い線を密に引いても、下の漏れは消えない（check 以上で出る）", async () => {
    const dense: Stroke[] = [];
    for (let y = TAG[1]!; y <= TAG[3]!; y += 1) dense.push({ w: 0.5, segs: [[TAG[0]! - 5, y, TAG[2]! + 5, y]] });
    const r = await detectP6Text(await makePdf({ px: pixels({ content: true }), annots: whiteTagWithInk(dense) }), { explain: true });
    const hits = imageHits(r).filter((f) => f.tone === "light");
    expect(hits).toHaveLength(1);
    expect(["check", "high"]).toContain(hits[0]!.confidence);
    expect(hits[0]).toMatchObject({ reason: "under_later_paint", spread: null, confidence: "check" });
  });

  it("細い線を密に引いても、下が一様（何も写っていない）なら出さない", async () => {
    const dense: Stroke[] = [];
    for (let y = TAG[1]!; y <= TAG[3]!; y += 1) dense.push({ w: 0.5, segs: [[TAG[0]! - 5, y, TAG[2]! + 5, y]] });
    const r = await detectP6Text(await makePdf({ px: pixels({ content: false }), annots: whiteTagWithInk(dense) }));
    expect(imageHits(r)).toEqual([]);
  });

  it("ページの中身の白い塗りは、自分自身の形を「あとから描いたもの」として数えない", async () => {
    const r = await detectP6Text(await makePdf({ px: pixels({ content: true }), content: "1 1 1 rg 100 60 200 80 re f" }), { explain: true });
    const hits = imageHits(r);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ cover: "fill", tone: "light", confidence: "high" });
    expect(hits[0]!.metrics!.laterPaintPoints).toBe(0);
  });

  it("上に描いたものの形が上限を超えたページは、1.9.0 と同じ測り方に戻す（片付けたあとの形も出る）", async () => {
    const pdf = await makePdf({ px: pixels({ content: false, paint: INK }), annots: whiteTagWithInk(INK) });
    const r = await detectP6Text(pdf, { explain: true, settings: { ...DEFAULT_SETTINGS, maxOverPaintPerPage: 2 } });
    const hits = imageHits(r);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ cover: "annotation", tone: "light", confidence: "high" });
    expect(hits[0]!.metrics!.laterPaintPoints).toBe(0);
    expect(hits[0]!.spread!).toBeGreaterThan(0.1);
    expect(r.diagnostics?.["image:over_paint_overflow"]).toBe(1);
  });
});
