// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けの入出力の形。画面（src/）は、この形だけを見てつなぐ（sanitize/README.md）。
// 取り出した字・名前・ファイル名などの中身は、ここには入れない（件数・場所・種類だけ）。

export type Rect = [number, number, number, number];

/** 漏洩パターンの番号（docs/glossary.md）。P2＝XMP、P8＝注釈、P12＝スクリプト */
export type SanitizePattern = "P1" | "P2" | "P5" | "P6" | "P7" | "P8" | "P9" | "P12";

export type RemovedKind =
  | "covered_text" // P6：覆いの下の字
  | "covered_pixels" // P6：覆いの下の画像の画素
  | "redaction_applied" // P6：適用していなかった墨消し注釈を適用した（黒い四角を描き込んだ）
  | "hidden_text" // P7：見えない字
  | "docinfo" // P1：文書情報の欄
  | "xmp" // P2：XMP
  | "previous_versions" // P5：前の版（増分更新）
  | "unused_objects" // P5：どこからも使われていない中身
  | "attachment" // P9：添付ファイル
  | "comment_annotation" // P8：付箋の注釈（まるごと外した）
  | "annotation_content" // P8：注釈のコメント・作者名
  | "popup" // P8：コメントの吹き出し
  | "javascript" // P12：JavaScript
  | "actual_text" // P7：字の読み替え（/ActualText。構造ツリー・マーク付きの中身）
  | "thumbnail" // P5：ページの縮小画像（/Thumb。古い見た目が残っていることがある）
  | "piece_info"; // P2：アプリの独自データ（/PieceInfo・/LastModified）

export type RemovedItem = {
  pattern: SanitizePattern;
  kind: RemovedKind;
  /** 何を取り除いたか（画面にそのまま出せる、平易な日本語。中身そのものは入れない） */
  label: string;
  /** 取り除いた数（字の数・画素の数・欄の数・ファイルの数など。単位は label に書く） */
  count: number;
  /** ページの番号（1から）。文書全体のものはなし */
  page?: number;
  /** ページの既定の座標（ポイント、左下が原点、/Rotate はかけない） */
  rect?: Rect;
  /** P7 の理由（hidden_layer・off_page など） */
  reason?: string;
};

export type NotDoneReason =
  | "unsupported_image" // JPEG 2000・JBIG2 など（JPEG の道具を渡さなかったときの JPEG も）で、画素を塗れない
  | "image_too_large" // 画像が大きすぎて、画素を塗れない（画素の数が上限を超える。Flate 以外の圧縮で、展開した大きさが上限を超える）
  | "inline_image" // ページの中に埋め込んだ画像があり、書き換えられない
  | "uncertain_cover" // 画像の上の白い塗りが、下を隠さない重ね方（Multiply など）・半透明・表示しないレイヤーの中にあり、塗らなかった
  | "too_many_operations" // 命令が多すぎるページ（重いページ）
  | "unreadable_page"; // ページの中身を読めない

export type NotDoneItem = {
  pattern: SanitizePattern;
  reason: NotDoneReason;
  label: string;
  page?: number;
  rect?: Rect;
};

export type SanitizeResult =
  | {
      status: "ok";
      bytes: Uint8Array;
      pages: number;
      removed: RemovedItem[];
      /** 片付けられなかった所。画面で「片付けられなかった所」として出す。0 件でなければ「全部消えた」と言わない */
      notDone: NotDoneItem[];
      /** パスワードなしで開ける暗号化を外して書き出したか */
      decrypted: boolean;
    }
  | { status: "error"; code: "empty" | "unreadable" | "encrypted" | "too_large"; message: string };

export type SanitizeOptions = {
  /** 1ページの命令の数の上限（検出ルールと同じ 300 万が既定） */
  maxOperationsPerPage?: number;
  /** 丸ごと解く画像の大きさの上限（バイト）。超えた Flate の画像は、流して塗る */
  maxImageBytes?: number;
  /** 塗る画像の画素の数の上限（既定は 7,200 万。600dpi の A3 まで。検出ルールと同じ） */
  maxImagePixels?: number;
  /**
   * pdf-lib で解けない画像（JPEG・CCITT・JBIG2）を解いて書き直す道具（2026-11-04 から）。渡さないと、覆いの下のそれらの画像は塗れない（notDone の unsupported_image）。
   * ブラウザ：sanitize/image-codec.ts の createPdfjsImageCodec(PDF.js, offscreenCanvasJpegEncoder, { wasmUrl })。Node：sanitize/node/image-codec.ts
   */
  codec?: ImageCodec;
  /**
   * 確かめの道具（2026-11-04 から。画面では使わない）。ページごとに、画像・黒でない塗り・塗った結果を、数と名前だけで渡す。
   * 字・名前・画素などの中身は入れない。実物で「なぜ塗らなかったか」を、中身を見ずに調べるため
   */
  trace?: (e: SanitizeTraceEvent) => void;
};

type TraceRect = [number, number, number, number];

/** 確かめの道具に渡す記録（数と名前だけ） */
export type SanitizeTraceEvent =
  | { type: "page"; page: number; operations: number; images: number; inlineImages: number; darkCovers: number; lightCovers: number; lightSkipped: number; fillLog: number }
  | { type: "page_error"; page: number; error: "too_many_operations" | "unreadable_page" }
  | {
      type: "image"; page: number; seq: number; box: TraceRect; ctm: number[];
      width: number | null; height: number | null; bpc: number | null; filter: string | null; inForm: boolean;
    }
  | {
      type: "fill"; page: number; seq: number; rect: TraceRect; luminance: number | null; alpha: number; blend: string; hidden: boolean; annotation: boolean;
      decision: string; overImages: number[];
    }
  | {
      type: "burn"; page: number; imageSeq: number; ok: boolean; via?: string; pixels?: number; reason?: string;
      covers: Array<{ seq: number; tone: string; kind: string; rect: TraceRect; painted: number; reached: boolean; expected: number }>;
    };

/** 解いた画像の画素。rgb は 1画素 3 バイト。gray1 は 1画素 1 ビット（1 行は (幅 + 7) / 8 バイト、1 が白） */
export type DecodedImage =
  | { kind: "rgb"; width: number; height: number; data: Uint8Array }
  | { kind: "gray1"; width: number; height: number; data: Uint8Array };

/** 画像を解いて書き直す道具。中身は呼ぶ側が渡す（片付けのコードは PDF.js・描く道具を読み込まない） */
export type ImageCodec = {
  /** CCITT・JBIG2 を解けるか（解く部品の置き場所を渡されたか） */
  bitonal: boolean;
  /**
   * 画像1つだけを描いた小さな PDF（1×1 のページに /I を描く）から、その画像の画素を取り出す（Decode などをかけたあとの色）。
   * maxPixels を超える画像・取り出せないときは null
   */
  decode(pdf: Uint8Array, maxPixels: number): Promise<DecodedImage | null>;
  /** RGB の画素を JPEG に書く（quality は 0〜1） */
  encodeJpeg(rgb: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array | null>;
};
