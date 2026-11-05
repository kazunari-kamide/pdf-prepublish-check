// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面に返す結果の形。検出ルールごとの報告を、この1つの形にそろえてから Worker の外へ出す。
// 覆われた字・欄の値・添付のファイル名など、中身そのものはこの形に入れない（数と場所だけ。docs/prd.md §3-5）。

/** [x0, y0, x1, y1]。ページの既定の座標（ポイント、左下が原点、/Rotate はかけない） */
export type Rect = [number, number, number, number];

/** 深刻度（用語集 §3）。高・中・低の3段 */
export type Severity = "high" | "medium" | "low";

/** 漏洩パターンの番号（用語集 §1）。P13（見える文字の個人情報らしい字）は【仮】の番号（rules/pii） */
export type Pattern = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10" | "P11" | "P12" | "P13";

/** 見つけた所1つ */
export type Item = {
  pattern: Pattern;
  severity: Severity;
  /** 一覧の見出し（何が残っているか） */
  title: string;
  /** なぜ危ないか（1文） */
  why: string;
  /** 数や種類の補足（中身そのものは入れない）。例：「12字」 */
  detail: string;
  /**
   * 見つけた字の中身（覆われた字・欄の値・ファイル名など）。呼ぶ側が頼んだとき（RunContext の withContents）だけ入る。
   * 画面の中だけで使い、頭の数文字だけを出して伏せる（src/ui/reveal.ts）。報告書・ログ・保存するファイル名には入れない
   */
  content?: string;
  /**
   * 文書情報・XMP の欄の値のとき、その欄の名前（文書情報は Title など、XMP は dc:title など）。中身は入らない。
   * 整えるときに本人が「そのまま」「書き直す」を選んだ欄を、読み直しの「残り」に数えないために使う
   */
  field?: string;
  /** ページの上の場所があるときだけ */
  page: number | null;
  rect: Rect | null;
  /**
   * 確からしさ。check＝ルールが「確かめてください」とした所（P6 の confidence: check・画像を解けなかった所など）。
   * 画面では、断定しない言葉で出す。省いたときは、ふつうの見つけた所
   */
  confidence?: "check";
  /**
   * ルールの中の型の名前（P6 の層 text・image・vector、P8 の欄・hidden、部品の情報の種類など）。中身は入らない。
   * 画面で、その型の出どころ（見つける段から来た型か）の札を出すのに使う（src/ui/rule-origin.ts）。ないルールもある
   */
  kind?: string;
};

/** 知らせること（漏れではないが、利用者に伝えること） */
/** info＝漏れとは言い切れず、知らせるだけのもの（XFA のフォーム・C2PA の来歴など。11/5 D） */
export type NoticeKind = "decrypted" | "unchecked_images" | "skipped_pages" | "partial" | "info";
/**
 * reason は、省いたページ（skipped_pages）と調べなかった画像（unchecked_images）のときだけ。
 * heavy＝図形が多すぎる（ページの絵も描かない）、unreadable＝読めなかった、
 * too_large＝解くと大きすぎる中身がある（圧縮の爆弾など）。省いたページなら、ページの絵も描かない。画像なら、大きすぎる画像
 */
export type Notice = { kind: NoticeKind; message: string; pages: number[]; reason?: "heavy" | "unreadable" | "too_large" };

/** 検出ルール1つの結果 */
export type RuleResult = {
  ruleId: string;
  ruleVersion: string;
  /** 画面で見せる名前（用語集の言葉） */
  label: string;
  pattern: Pattern;
  status: "ok" | "error";
  /** status が error のとき、利用者に見せる文（ファイルの中身は入れない） */
  message?: string;
  items: Item[];
  notices: Notice[];
};

/** ページの形。画面でページの枠を描き、赤い枠の場所を決めるのに使う */
export type PageBox = {
  page: number;
  /** 見える範囲（CropBox を MediaBox で切ったもの）。既定の座標 */
  view: Rect;
  /** /Rotate（0・90・180・270） */
  rotate: 0 | 90 | 180 | 270;
};

/** 1つのファイルの検査の結果 */
export type InspectSummary = {
  /**
   * プロパティの一覧（文書情報と XMP のすべての欄。値つき）。値を画面に出してよいのは、この一覧だけ（11/5 B の 8）。
   * 読めなかったときは null。古い形の結果にはない
   */
  properties?: import("./properties.ts").PropertyList | null;
  pages: PageBox[];
  /** ページの形を読めなかったとき true（一覧は出せるが、ページの上には描けない） */
  pagesUnreadable: boolean;
  rules: RuleResult[];
};
