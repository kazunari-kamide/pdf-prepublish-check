// SPDX-License-Identifier: AGPL-3.0-only
//
// PDF 以外の形式（写真・今の Office）を調べた結果の形。画面からもコマンドの道具からも使う（Node の API を使わない）。
// 字の中身・欄の値・中のファイル名・シートの名前は入れない（数と場所だけ）。

export type Severity = "high" | "medium" | "low";

/** 見分けた形式。cfb＝古い Office・一太郎・パスワードのかかった Office（中は調べない） */
export type FormatKind = "pdf" | "jpeg" | "png" | "webp" | "heic" | "docx" | "xlsx" | "pptx" | "cfb" | "zip" | "unknown";

export type FormatFinding = {
  /** 型の名前（例：image.gps、office.tracked_changes）。docs/glossary.md の言葉と合わせる */
  type: string;
  severity: Severity;
  title: string;
  /** なぜ危ないか（1文） */
  why: string;
  /** 数や種類の補足（中身そのものは入れない） */
  detail: string;
  /** スライドの番号など（1 から）。ないときは null */
  page: number | null;
  /** ページの番号で言えない場所（例：「2 枚目のシート B3」「段落 12」）。シートの名前・ファイル名は入れない */
  where: string | null;
};

export type FormatNotice = {
  kind: "unsupported" | "partial" | "too_large" | "encrypted" | "broken";
  message: string;
  /** 調べられなかった所として数えるか */
  unchecked: boolean;
};

export type FormatReport = {
  format: FormatKind;
  findings: FormatFinding[];
  notices: FormatNotice[];
};

export const FORMATS_VERSION = "0.1.0";
