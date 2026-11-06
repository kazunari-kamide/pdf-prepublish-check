// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けの入出力の形。画面（src/）は、この形だけを見てつなぐ（sanitize/README.md）。
// 取り出した字・名前・ファイル名などの中身は、ここには入れない（件数・場所・種類だけ）。

export type Rect = [number, number, number, number];

/** 漏洩パターンの番号（docs/glossary.md）。P2＝XMP、P8＝注釈、P10＝画像の Exif、P11＝フォームの値、P12＝スクリプト・外部動作 */
export type SanitizePattern = "P1" | "P2" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10" | "P11" | "P12";

/**
 * 本人が「整えない」を選べる種類（2026-11-06 本人が決定。D168）。ほかの種類は外せない：
 * P6・P7 はページの字と画像の 1 回の読みの中で分けて片付けていて、ルールの P6・P7 と分け方が食い違う所があるため（白や画像の覆いの下の字など）。
 * P2・P1 はプロパティと XMP（XMP は丸ごと外す）。P5 は書き直すと必ず消える
 */
export const KEEPABLE_PATTERNS = ["P8", "P9", "P10", "P11", "P12"] as const;
export type KeepablePattern = (typeof KEEPABLE_PATTERNS)[number];

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
  | "piece_info" // P2：アプリの独自データ（/PieceInfo・/LastModified）
  // 0.7.0 から
  | "external_action" // P12：外のプログラム・ファイルを開く動作（Launch、file: の URI、ほかのファイルへ移る動作）
  | "image_exif" // P10：写真（JPEG）の中の Exif・撮影の情報・縮小画像・コメント
  | "outline" // P7：しおり（/Outlines）
  | "struct_title" // P7：構造要素の題（/T）・フォームの欄の書き出し用の名前（/TM）
  | "field_value" // P11：見えない欄（見た目のない欄・隠した見た目の欄）の値
  | "hidden_image" // P7：ページの外・切り抜きの外に隠れた画像（描く命令を外す、隠れた所の画素を白く塗る）
  | "unused_xobject" // P5：資源にあるが描かれない部品・画像
  // 0.8.0 から
  | "font_glyphs" // P7：書体の中の、どこにも描かれていない字形（TrueType の字形の中身、Type3 の字の描き方）
  | "pattern_repainted" // P6：中に字のある模様で塗った覆いや、覆いの下の字の入った模様を、黒一色で塗り直した
  | "unused_unicode" // P7：書体の字の対応表（/ToUnicode）の、どこにも描かれていない字の行
  | "covered_vector" // P6：白い不透明な注釈の下の道（パスで描いた字など）を、注釈の箱の中だけ消した（0.10.0 から）
  | "glyph_cover_box" // P7：横につぶして並べた黒い四角の形の字を、同じ所の黒い四角に描き直した（見た目は同じ）
  // 自分で黒塗りする（redact.ts）。pattern は P6（墨消し）にそろえる
  | "redacted_text" // 選んだ所の字
  | "redacted_pixels" // 選んだ所の画像の画素
  | "redacted_annotation" // 選んだ所に掛かる注釈
  | "redacted_field" // 選んだ所に掛かるフォームの欄（値ごと）
  | "font_unicode" // 消した字だけで使っていた、字の対応表（/ToUnicode）の行
  | "redaction_box" // 選んだ所に描いた黒い四角
  // 0.9.0 から（プロパティを書き直す・整える前に知らせるもの）
  | "property_rewritten" // P1：本人が書き直したプロパティの欄（文書情報と XMP にそろえて書いた）
  | "pdfa_mark" // P2：長期保存用の形式（PDF/A）の印
  | "signature"; // P11：電子署名（署名の辞書・署名の見た目・署名の決まり）

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
  | "unreadable_page" // ページの中身を読めない
  | "stream_too_large" // 解くと大きすぎる中身（圧縮の爆弾など）があり、ページを書き換えられない（0.7.1 から）
  | "field_shared" // 選んだ所のフォームの欄が、ほかの所にも見た目を持っていて、欄ごとは外せない（redact.ts）
  // 0.7.0 から
  | "accessibility_text" // 読み上げ用の説明（/Alt・/E・/TU）。読み上げに使うので消さない
  | "field_visible" // 見えている欄の値。提出のための記入かもしれないので消さない
  | "overdrawn_text" // 同じ所に違う字が重ねて描かれている。どちらが隠れた字か決められない
  | "annotation_text" // 注釈（スタンプなど）の見た目の中だけにある字。ページに見えているので消さない
  // 0.8.0 から
  | "font_not_pruned" // 書体の中の描かれていない字形を外せなかった（CFF・Type1 の形、使う字を数えきれなかった）
  // 0.9.0 から
  | "pdfa_mark_kept" // 本人が PDF/A の印を残すと選んだ。整えたあとの PDF は、形式の決まりを満たさない恐れがある
  | "signature_kept" // 本人が電子署名を残すと選んだ。整えると署名は無効になる
  // 0.10.0 から
  | "vector_partial" // 白い不透明な注釈にまたがる道（曲線・破線）。切ると見えている所の形が変わるので消していない
  | "hidden_image_kept"; // ページの外にはみ出した画像を切り詰められなかった（画像を読めない・大きすぎる）。見えない所の中身が残っている

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
      /**
       * プロパティを書き直したとき（options.properties を渡したとき）だけ。項目ごとに何をどうしたか（値そのものは入れない）。
       * "kept"・"set" は本人が選んだ値なので、画面では「残り」に数えず「残した（本人が選んだ）」として分けて出す
       */
      properties?: PropertyChange[];
    }
  | {
      status: "error";
      /** properties_left：書き直した・消したプロパティの古い値が、書き出した PDF に残っていた（バイト列は返さない） */
      code: "empty" | "unreadable" | "encrypted" | "too_large" | "bad_properties" | "properties_left";
      message: string;
    };

// ---------------------------------------------------------------- プロパティを書き直す（properties.ts。0.9.0 から）

/** 書き直せるプロパティ。文書情報（Info）と XMP の欄の組みは properties.ts の FIELDS */
export type PropertyKey = "title" | "author" | "subject" | "keywords" | "creator" | "producer" | "created" | "modified";

/**
 * 項目ごとの指定。"keep"＝元の値のまま（文書情報の値を優先し、無ければ XMP の値）、"remove"＝消す、{ set }＝書き直す。
 * 日付（created・modified）の set は Date か、"2026-11-05"・"2026-11-05T10:30"・"2026-11-05T10:30:00+09:00" の形の字。
 * 時差のない字と Date は、その環境の時差で書く。空の字の set は "remove" と同じ
 */
export type PropertyEdit = "keep" | "remove" | { set: string | Date };

/** 指定しなかった項目は "remove"。文書情報の 8 項目以外の欄（独自の欄・Trapped）と、XMP のほかの項目（履歴・文書の番号・ほかのアプリの項目）は、いつも消す */
export type PropertyEdits = Partial<Record<PropertyKey, PropertyEdit>>;

export type PropertyChange = {
  key: PropertyKey;
  /** kept＝元の値のまま書いた、set＝書き直した、removed＝元の値を消した、absent＝元から無く、何も書かなかった */
  action: "kept" | "set" | "removed" | "absent";
  /** 整える前に、文書情報・XMP のどちらに値があったか */
  before: { info: boolean; xmp: boolean };
  /** 整える前に、文書情報と XMP の値が食い違っていたか（"keep" では文書情報の値にそろえた） */
  differed: boolean;
};

/** 整える前に知らせること（preflightTidy の結果） */
export type TidyPreflight =
  | {
      status: "ok";
      /** 今の値（画面の「そのまま」の欄に見せる。Worker の中だけで使い、外へは出さない。長すぎる値は切る） */
      properties: Array<{ key: PropertyKey; info: string | null; xmp: string | null; truncated: boolean }>;
      /** 長期保存用の形式（PDF/A）の印。無ければ null */
      pdfa: { part: string; conformance: string | null } | null;
      /** 署名した電子署名の欄の数（0 でなければ、整える前に同意を取る） */
      signatures: number;
      decrypted: boolean;
    }
  | { status: "error"; code: "empty" | "unreadable" | "encrypted" | "too_large"; message: string };

export type SanitizeOptions = {
  /**
   * 整えない種類（D168。外せるのは KEEPABLE_PATTERNS だけ。ほかの値は無視する）。渡さないときは、今までどおり全部を片付ける。
   * - P8：注釈を外さず、コメント・作者名も消さない（適用した墨消しの注釈は、P6 の片付けなので外す）
   * - P9：添付ファイルを残す
   * - P10：写真の中の撮影の情報（EXIF など）を残す（XMP にある分は、XMP の丸ごとの片付けで消える）
   * - P11：見えない欄の値と、欄の書き出し用の名前（/TM）を残す（電子署名は signatures で決める）
   * - P12：JavaScript と、外のプログラム・ファイルを開く動作を残す
   */
  keep?: readonly string[];
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
   * プロパティを書き直す（0.9.0 から）。渡さないときは、今までどおり文書情報も XMP も全部消す。
   * 渡すと、文書情報と XMP の両方に同じ値を書き、書き出したあとに古い値が残っていないかを読み直して確かめる
   */
  properties?: PropertyEdits;
  /**
   * PDF/A の印をどうするか（0.9.0 から。既定 "remove"）。画面は preflightTidy の pdfa を見て、整える前に同意を取る。
   * "keep" のときは、印を新しい XMP に書き、notDone に pdfa_mark_kept（形式の決まりを満たさない恐れ）を出す
   */
  pdfaMark?: "remove" | "keep";
  /**
   * 電子署名をどうするか（0.9.0 から。既定 "remove"）。整えると、どちらを選んでも署名は無効になる。
   * "remove"：署名の値・署名の見た目・署名の決まり（/Perms・/DSS）を外す。"keep"：残し、notDone に signature_kept を出す
   */
  signatures?: "remove" | "keep";
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
  | { type: "page_error"; page: number; error: "too_many_operations" | "unreadable_page" | "stream_too_large" }
  /** ページの外にはみ出した画像を切り詰めたか（0.10.0 から） */
  | { type: "crop"; page: number; imageSeq: number; ok: boolean; reason?: string }
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

// ---------------------------------------------------------------- 自分で黒塗りする（redact.ts）

/** 利用者が選んだ場所1つ。page は 1 から。rect はページの既定の座標（ポイント、左下が原点、/Rotate はかけない。removed の rect と同じ） */
export type RedactArea = { page: number; rect: Rect };

/** 読み直しで見つかった残り（中身は入れない。種類・数・場所だけ） */
export type RedactLeftover = {
  /** どの確かめで見つかったか。area＝選んだ場所の確かめ、rules＝作品の検査（全部のルール）、verifier＝検証器、not_done＝片付けられなかった所 */
  check: "area" | "rules" | "verifier" | "not_done";
  kind: "text" | "pixels" | "unchecked_image" | "inline_image" | "pattern_text" | "annotation" | "unreadable_page" | "rule_item" | "rule_error" | "verifier_item" | "verifier_error" | "not_done";
  /** 画面にそのまま出せる文 */
  label: string;
  count: number;
  page?: number;
  rect?: Rect;
  /** ルール・検証器の型の番号（P6 など） */
  pattern?: string;
  /** 文書情報・XMP の欄の値のとき、その欄の名前（Title・dc:title など。中身は入れない）。本人が選んだ値を見分けるために使う */
  field?: string;
};

/** 読み直しの確かめを1つ足す（作品の検査・検証器など。片付けた PDF のバイト列だけを受け取る） */
export type RedactCheck = {
  name: "rules" | "verifier";
  run(bytes: Uint8Array, areas: RedactArea[]): Promise<RedactLeftover[]>;
};

export type RedactOptions = SanitizeOptions & {
  /**
   * 保存の前の読み直しに足す確かめ。選んだ場所の確かめ（字・画素・注釈）は、渡さなくても必ず行う。
   * 画面：作品の検査（src/inspect/rules.ts の RULES）を渡す。Node（テスト・採点）：さらに検証器（P6）を渡す
   */
  checks?: RedactCheck[];
};

export type RedactResult =
  | {
      status: "ok";
      bytes: Uint8Array;
      pages: number;
      removed: RemovedItem[];
      /** 保存させるのは残りが 0 件のときだけなので、いつも空 */
      notDone: NotDoneItem[];
      decrypted: boolean;
      /** 読み直しで行った確かめ（"area" と、渡した checks の name） */
      checked: string[];
      /** プロパティを書き直したとき（options.properties を渡したとき）だけ。整えるほうの報告（SanitizeResult の properties）と同じ形 */
      properties?: PropertyChange[];
      /**
       * options.properties を渡したときだけ。読み直しで見つかったうち、本人が「そのまま」「書き直す」を選んだ欄の値（P1・P2・P3 で欄の名前があるもの）として、
       * 残りに数えなかった数。それ以外の残りは、今までどおり保存させない
       */
      chosen?: number;
    }
  | {
      /** 残りがあるので、保存させない（バイト列は返さない） */
      status: "blocked";
      pages: number;
      removed: RemovedItem[];
      notDone: NotDoneItem[];
      leftovers: RedactLeftover[];
      decrypted: boolean;
      checked: string[];
      properties?: PropertyChange[];
      chosen?: number;
    }
  | { status: "error"; code: "empty" | "unreadable" | "encrypted" | "too_large" | "bad_areas" | "bad_properties" | "properties_left"; message: string };

// ---------------------------------------------------------------- ファイルを小さくする（compress.ts）

export type CompressOptions = {
  /** 画像を解く・JPEG に書く道具（片付けと同じもの）。無いと小さくできない */
  codec: ImageCodec;
  /** 画像の細かさの上限（dpi。50〜600、既定 150）。いちばん大きく描かれた所でこれを超える画像だけを縮める */
  maxDpi?: number;
  /** JPEG の質（0.3〜0.95、既定 0.75） */
  jpegQuality?: number;
  /** 解く画像の画素の数の上限（既定は片付けと同じ） */
  maxImagePixels?: number;
  /**
   * 小さくする前と後の両方にかける確かめ。種類ごとの残りが増えたら保存させない（blocked）。
   * 画面：rulesCheck((b) => inspectAll(b))。Node（テスト・採点）：さらに検証器（P6）
   */
  checks?: RedactCheck[];
};

/** 書き直さなかった画像の理由 */
export type CompressSkip = {
  reason: "within_dpi" | "not_smaller" | "bitonal" | "mask" | "used_elsewhere" | "not_placed" | "too_large" | "unreadable";
  count: number;
  /** 画面にそのまま出せる短い文 */
  label: string;
};

export type CompressImages = {
  /** 縮めて JPEG に書き直した画像の数 */
  changed: number;
  /** 画像で減ったバイト数 */
  savedBytes: number;
  skipped: CompressSkip[];
};

/** 小さくしたあとの読み直しで増えた残り（中身は入れない。種類と数だけ） */
export type CompressIncrease = {
  check: RedactLeftover["check"];
  kind: RedactLeftover["kind"];
  pattern?: string;
  label: string;
  before: number;
  after: number;
};

export type CompressResult =
  | {
      status: "ok";
      /** 小さくした PDF。小さくならなかったときは、入れたバイト列のまま（changed: false） */
      bytes: Uint8Array;
      sizeBefore: number;
      sizeAfter: number;
      changed: boolean;
      images: CompressImages;
      /** 読み直しにかけた確かめの名前（changed: false のときは空） */
      checked: string[];
    }
  | { status: "blocked"; sizeBefore: number; sizeAfter: number; increased: CompressIncrease[]; checked: string[] }
  | { status: "error"; code: "empty" | "unreadable" | "encrypted" | "too_large" | "bad_options" | "no_codec"; message: string };
