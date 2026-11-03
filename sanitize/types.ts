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
  | "unsupported_image" // JPEG などで、画素を塗れない
  | "inline_image" // ページの中に埋め込んだ画像があり、書き換えられない
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
  /** 解く画像の大きさの上限（バイト） */
  maxImageBytes?: number;
};
