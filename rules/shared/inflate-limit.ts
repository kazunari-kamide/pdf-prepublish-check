// SPDX-License-Identifier: AGPL-3.0-only
//
// 圧縮を解く大きさの上限（2026-11-05 本人が値を決めた）。展開すると巨大になる PDF（圧縮の爆弾）で、
// 利用者のタブや PC のメモリが足りなくならないようにする（CLAUDE.md §5・§11-3）。
//
// - 上限は、この下の INFLATE_LIMITS の 1 か所だけで決める。1 つの流れ（ストリーム）で 256MB、1 つのファイルの合計で 1GB。
// - 途中で止める：pdf-lib の解く部品（FlateDecode・LZW・ASCII85・ASCIIHex・RunLength）は、解いた字を入れる入れ物を
//   広げながら解く。その「広げる所」（DecodeStream の ensureBuffer）で上限を見て、超える前に止める。
//   全部解いてから大きさを見るのでは、もうメモリを使ったあとなので遅い。
// - pdf-lib が読み込みのときに自分で解くもの（オブジェクトストリーム・xref ストリーム）も、同じ所で止まる。
//   pdf-lib はその失敗を飲み込んで、中のオブジェクトを黙って落とすので、読み込みの間に止まったかを数え、loadPdf が知らせる。
// - 「1 つのファイル」は、読み込んだ 1 つの PDF（pdf-lib の PDFContext）。同じ流れを何度解いても、数えるのは 1 回だけ。
// - 止めたときは InflateLimitError を投げる。呼ぶ側は「大きすぎるため調べていません」として、調べられなかった所に数える
//   （「見つかりませんでした」にしない）。
// - DecompressionStream（ブラウザと Node の標準）で解く所（formats/・rules/p2-parts・sanitize/images.ts）は、
//   流しながら数を数えて止める。上限には inflateCap() で、この値を合わせる。

import { PDFArray, PDFContext, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from "pdf-lib";

export const INFLATE_LIMITS = {
  /** 1 つの流れを解いた大きさの上限（バイト） */
  streamBytes: 256 * 1024 * 1024,
  /** 1 つのファイル（読み込んだ 1 つの PDF）で、解いた大きさの合計の上限（バイト） */
  fileBytes: 1024 * 1024 * 1024,
} as const;

/** 解いた大きさが上限を超えたので、途中で止めた。scope：stream＝1 つの流れの上限、file＝1 つのファイルの合計の上限 */
export class InflateLimitError extends Error {
  readonly scope: "stream" | "file";
  constructor(scope: "stream" | "file") {
    super(scope === "stream" ? "inflate_stream_limit" : "inflate_file_limit");
    this.name = "InflateLimitError";
    this.scope = scope;
  }
}

export const isInflateLimitError = (e: unknown): e is InflateLimitError => e instanceof InflateLimitError;

/** 上限で止めたのでなければ、何もしない。止めたのなら投げ直す（「読めない」として飲み込まないため） */
export function rethrowIfInflateLimit(e: unknown): void {
  if (e instanceof InflateLimitError) throw e;
}

/** 画面・報告に出す言葉（用語集の言葉。中身は出さない） */
export const INFLATE_LIMIT_MESSAGE = "解くと大きすぎる所があるため、この項目は調べていません。";

/** DecompressionStream で解く所の上限：呼ぶ側の上限と、1 つの流れの上限の小さい方 */
export const inflateCap = (max: number = Infinity): number => Math.min(max, INFLATE_LIMITS.streamBytes);

// ---------------------------------------------------------------- pdf-lib の解く部品に、上限を付ける

/** 数える箱：used＝広げた入れ物の大きさの合計、limit＝上限 */
type Meter = { used: number; limit: number };

/** いま数えている箱（読み込みの間・1 つの流れを解く間） */
const meters = new Set<Meter>();
/** いま効いている 1 つの流れの上限（呼ぶ側の上限があれば、それとの小さい方） */
let streamCap: number = INFLATE_LIMITS.streamBytes;
/** 止めた回数（読み込みの間に止まったかを見分けるため） */
let trips = 0;
/** 呼ぶ側の上限（INFLATE_LIMITS より小さいもの）で止めたことを、中で見分ける印 */
class CallerCapError extends Error {}

type DecodeStreamLike = {
  buffer: Uint8Array;
  minBufferLength: number;
  ensureBuffer(requested: number): Uint8Array;
};

function installGuard(): void {
  // FlateStream などの親（DecodeStream）は pdf-lib から書き出されていないので、解く部品を 1 つ作って、その親をたどる
  // （FlateStream は作るときに頭を読むので、空でも作れる ASCIIHex の部品を使う）
  const ctx = PDFContext.create();
  const probe = decodePDFRawStream(PDFRawStream.of(ctx.obj({ Filter: "ASCIIHexDecode" }), new Uint8Array(0)));
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(probe)) as DecodeStreamLike & { __omamoriInflateGuard?: true };
  if (typeof proto?.ensureBuffer !== "function" || proto.__omamoriInflateGuard) return;
  const original = proto.ensureBuffer;
  proto.ensureBuffer = function (this: DecodeStreamLike, requested: number): Uint8Array {
    const have = this.buffer.byteLength;
    if (requested <= have) return this.buffer;
    if (requested > streamCap) {
      // 呼ぶ側の上限で止めたときは数えない（読み込みの間に止まったかの見分けに混ぜない）
      if (streamCap < INFLATE_LIMITS.streamBytes) throw new CallerCapError();
      trips++;
      throw new InflateLimitError("stream");
    }
    // pdf-lib と同じ決め方で、広げたあとの大きさを先に出し、箱の上限を超えるなら広げる前に止める
    let size = this.minBufferLength || 512;
    while (size < requested) size *= 2;
    const grow = size - have;
    for (const m of meters) {
      if (m.used + grow > m.limit) {
        trips++;
        throw new InflateLimitError("file");
      }
    }
    for (const m of meters) m.used += grow;
    return original.call(this, requested);
  };
  proto.__omamoriInflateGuard = true;
}

installGuard();

// ---------------------------------------------------------------- 1 つのファイルの合計

type FileBudget = { meter: Meter; counted: WeakSet<PDFRawStream>; tooLarge: WeakSet<PDFRawStream> };
const budgets = new WeakMap<PDFContext, FileBudget>();

function budgetOf(ctx: PDFContext): FileBudget {
  let b = budgets.get(ctx);
  if (!b) {
    b = { meter: { used: 0, limit: INFLATE_LIMITS.fileBytes }, counted: new WeakSet(), tooLarge: new WeakSet() };
    budgets.set(ctx, b);
  }
  return b;
}

/** 読み込みの間に解いた分を数える箱を作る（loadPdf が使う） */
export function beginLoadMeter(): { end(): { used: number; tripped: boolean } } {
  const meter: Meter = { used: 0, limit: INFLATE_LIMITS.fileBytes };
  const t0 = trips;
  meters.add(meter);
  return {
    end() {
      meters.delete(meter);
      return { used: meter.used, tripped: trips !== t0 };
    },
  };
}

/** 読み込みの間に解いた分を、読み込んだ PDF の合計に足す */
export function chargeLoad(ctx: PDFContext, used: number): void {
  budgetOf(ctx).meter.used += used;
}

/** 合計に数えた大きさ（確かめのため） */
export function inflatedBytes(ctx: PDFContext): number {
  return budgets.get(ctx)?.meter.used ?? 0;
}

// ---------------------------------------------------------------- 解く入口

const FILTER = PDFName.of("Filter");

function decodeRaw(s: PDFRawStream, cap: number): Uint8Array {
  const budget = budgetOf(s.dict.context);
  if (budget.tooLarge.has(s)) throw new InflateLimitError("stream");
  const first = !budget.counted.has(s);
  const prevCap = streamCap;
  streamCap = Math.min(cap, INFLATE_LIMITS.streamBytes);
  const before = budget.meter.used;
  if (first) meters.add(budget.meter);
  try {
    const out = decodePDFRawStream(s).decode();
    if (first) budget.counted.add(s);
    return out;
  } catch (e) {
    // 途中で止めた・壊れていた流れは、解いた分を持ち続けないので、合計から戻す
    budget.meter.used = before;
    if (e instanceof InflateLimitError && e.scope === "stream") budget.tooLarge.add(s);
    throw e;
  } finally {
    streamCap = prevCap;
    if (first) meters.delete(budget.meter);
  }
}

/**
 * 流れを解いた中身。1 つの流れの上限・1 つのファイルの合計の上限を超えたら、途中で止めて InflateLimitError を投げる。
 * 壊れているなどで解けないときは、pdf-lib の例外をそのまま投げる（これまでどおり）。
 */
export function decodeStream(s: PDFStream): Uint8Array {
  return s instanceof PDFRawStream ? decodeRaw(s, INFLATE_LIMITS.streamBytes) : s.getContents();
}

/**
 * 呼ぶ側の上限 max（バイト）までだけ解く。max を超えたら途中で止めて null を返す（これまでの「大きすぎる」の扱いのまま）。
 * max が 1 つの流れの上限より大きいとき・ファイルの合計を超えるときは、InflateLimitError を投げる。
 */
export function decodeStreamUpTo(s: PDFStream, max: number): Uint8Array | null {
  if (!(s instanceof PDFRawStream)) {
    const c = s.getContents();
    return c.length > max ? null : c;
  }
  if (s.contents.length > max && !s.dict.has(FILTER)) return null;
  try {
    const out = decodeRaw(s, max);
    return out.length > max ? null : out;
  } catch (e) {
    if (e instanceof CallerCapError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------- PDF.js に渡す画像

/** pdf-lib で解ける圧縮（略した名前は pdf-lib が解けないので入れない） */
const PEELABLE = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);
const DECODE_PARMS = PDFName.of("DecodeParms");

/**
 * PDF.js に渡す前に、外側の圧縮（[/FlateDecode /DCTDecode] の FlateDecode など）を、上限つきでこちらで解いた流れにする。
 * PDF.js には解く大きさの上限を渡せず、JPEG などは流れを終わりまで読むので、外側の圧縮が爆弾なら上限なしに膨らむため。
 * - 解くのは、最後の 1 つより前の、pdf-lib で解ける・設定（DecodeParms）のない圧縮だけ。最後の 1 つは PDF.js に任せる
 *   （Flate だけの画像は、PDF.js が要る大きさだけを読むので、ここでは解かない）。
 * - 上限を超えたら InflateLimitError を投げる（呼ぶ側は「大きすぎる」とする）。外せないときは、元の流れをそのまま返す。
 */
export function peelOuterFilters(s: PDFStream): PDFStream {
  if (!(s instanceof PDFRawStream)) return s;
  const ctx = s.dict.context;
  const f = s.dict.lookup(FILTER);
  if (!(f instanceof PDFArray) || f.size() < 2) return s;
  const names = f.asArray().map((x) => {
    const v = ctx.lookup(x);
    return v instanceof PDFName ? v.decodeText() : null;
  });
  const parms = s.dict.lookup(DECODE_PARMS);
  const hasParms = (i: number): boolean => {
    if (parms instanceof PDFArray) {
      const p = i < parms.size() ? ctx.lookup(parms.get(i)) : undefined;
      return p !== undefined && p !== PDFNull;
    }
    return parms !== undefined && parms !== PDFNull;
  };
  let k = 0;
  while (k < names.length - 1 && PEELABLE.has(names[k] ?? "") && !hasParms(k)) k++;
  if (k === 0) return s;
  const head = s.dict.clone(ctx);
  head.set(FILTER, ctx.obj(names.slice(0, k) as string[]));
  head.delete(DECODE_PARMS);
  const decoded = decodeStream(PDFRawStream.of(head, s.contents));
  const rest = s.dict.clone(ctx);
  const left = names.slice(k) as string[];
  rest.set(FILTER, left.length === 1 ? PDFName.of(left[0]!) : ctx.obj(left));
  if (parms instanceof PDFArray) {
    const p = parms.asArray().slice(k);
    if (p.length === 1) rest.set(DECODE_PARMS, p[0]!);
    else rest.set(DECODE_PARMS, ctx.obj(p));
  } else rest.delete(DECODE_PARMS);
  rest.set(PDFName.of("Length"), PDFNumber.of(decoded.length));
  return PDFRawStream.of(rest, decoded);
}
