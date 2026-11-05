// SPDX-License-Identifier: AGPL-3.0-only
//
// 見つけた字の中身の出し方（2026-11-05 本人が決めた）。画面の部品に頼らない計算だけを置き、テストで確かめる。
// - 最初は、頭の 2 字（3 字以下なら 1 字）だけを出し、残りは「●」で伏せる（例：「山田●●」）。
// - 「中身を見る」を押すと全部を出す。もう一度押すと伏せる。
// - 中身は画面の中だけで使う。報告書には、保存の前に「中身も入れる」を選んだときだけ入れる。ログ・ファイル名には入れない。
// - PDF から取り出した字は細工されている前提で扱う：見えない制御の字（向きを変える字・幅のない字など）は、見える印に置き換える。
//   長すぎる中身は、決めた字数で切って、残りの字数を添える。画面には textContent でだけ出す（HTML として解釈させない）。

/** 頭に出す字数 */
export const HEAD_CHARS = 2;
/** 全部を出すときの上限の字数（これより長いものは切って、残りの字数を添える） */
export const MAX_SHOWN_CHARS = 200;
/** 伏せるときの「●」の上限（長い中身で行が伸びないように） */
export const MAX_DOTS = 12;
/** 伏せる印 */
export const DOT = "●";

/** 見えない制御の字：C0・C1 の制御字（改行・タブを除く）、向きを変える字、幅のない字、字の向きの印、BOM */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁩﻿]/gu;

/** 字（コードポイント）ごとに分ける。サロゲートペアの字も 1 字に数える */
const chars = (s: string) => [...s];

/** 画面に出せる形にする：見えない制御の字を「�」に、改行・タブを空白に置き換え、前後の空白を落とす */
export function cleanContent(raw: string): string {
  return raw.replace(INVISIBLE, "�").replace(/[\r\n\t]+/g, " ").trim();
}

/** 頭の数文字だけを出し、残りを「●」で伏せる */
export function maskContent(raw: string): string {
  const c = chars(cleanContent(raw));
  if (!c.length) return "";
  const head = c.length <= 3 ? 1 : HEAD_CHARS;
  const rest = c.length - head;
  const dots = DOT.repeat(Math.min(rest, MAX_DOTS));
  return c.slice(0, head).join("") + dots + (rest > MAX_DOTS ? "…" : "");
}

/** 全部を出す（長いものは切って、残りの字数を添える） */
export function fullContent(raw: string): string {
  const c = chars(cleanContent(raw));
  if (c.length <= MAX_SHOWN_CHARS) return c.join("");
  return `${c.slice(0, MAX_SHOWN_CHARS).join("")}…（ほか ${c.length - MAX_SHOWN_CHARS} 字）`;
}

/** 「中身を見る」の近くに出す一言 */
export const REVEAL_NOTE = "画面の共有・のぞき見に気をつけてください。";

/** 「中身を見る」のボタンの字（押した状態は aria-pressed でも示す） */
export const REVEAL_LABEL = { closed: "中身を見る", open: "伏せる" } as const;
