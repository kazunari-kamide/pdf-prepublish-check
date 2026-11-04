// SPDX-License-Identifier: AGPL-3.0-only
//
// コマンドの道具が返す結果の形。画面の形（src/inspect/report.ts）の Item・Notice をもとに、
// PDF 以外の形式（formats/）も同じ形で並べられるようにしたもの。
// 字の中身・欄の値・中のファイル名は入れない（数と場所だけ）。

import type { Pattern, Rect, Severity } from "../src/inspect/report.ts";

export type { Pattern, Rect, Severity };

/** 調べたファイルの形式 */
export type FileFormat = "pdf" | "jpeg" | "png" | "webp" | "heic" | "docx" | "xlsx" | "pptx" | "unknown";

/** 見つけた所1つ */
export type Finding = {
  /** どのルールが見つけたか（PDF は rules/ の id、ほかの形式は formats/ の id） */
  ruleId: string;
  ruleVersion: string;
  /** PDF の漏洩パターンの番号。PDF 以外の形式では null */
  pattern: Pattern | null;
  /** 型の名前（PDF 以外の形式の、細かい種類。例：image.gps）。PDF では pattern と同じ */
  type: string;
  severity: Severity;
  title: string;
  why: string;
  detail: string;
  /** PDF のページ、スライドの番号など（1 から）。ないときは null */
  page: number | null;
  /** ページの上の箱（PDF のポイント、左下が原点）。ないときは null */
  rect: Rect | null;
  /** ページの番号で言えない場所（例：「2枚目のシート B3」「12番目の段落」）。中身は入れない */
  where?: string;
};

/** 知らせること。unchecked が true のものは「調べられなかった所」として段階に数える */
export type FileNotice = {
  ruleId: string | null;
  kind: string;
  message: string;
  pages: number[];
  unchecked: boolean;
};

/** 1つのファイルの結果 */
export type FileReport = {
  format: FileFormat;
  items: Finding[];
  notices: FileNotice[];
};

/** 段階（終了コードの数と同じ順）。none＝見つからない、review＝確認してほしい所だけ、high＝高い危険、unchecked＝調べられなかった所がある */
export type Stage = "none" | "review" | "high" | "unchecked";
