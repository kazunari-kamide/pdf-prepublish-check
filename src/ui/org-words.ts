// SPDX-License-Identifier: AGPL-3.0-only
//
// 団体名らしい語に色を付けるため、値を「団体名らしい所」と「それ以外」に分ける（11/5 B の 8。プロパティの一覧だけで使う）。
// 判定ではない。目に留まりやすくするための目印で、見落としも、関係のない語に付くこともある（画面にもそう書く）。
// 見るのは語の形だけ：漢字・カタカナの並びのあとに、団体の名前の終わりによく来る語（市・町・課・株式会社など）が続くもの。

const NAME = "[\\p{Script=Han}\\p{Script=Katakana}ー々ヶ]";
const SUFFIX = [
  "株式会社", "有限会社", "合同会社", "協同組合", "社団法人", "財団法人", "法人",
  "委員会", "協議会", "協会", "事務所", "役所", "役場", "センター", "大学", "学校", "病院",
  "都", "道", "府", "県", "市", "区", "町", "村", "省", "庁", "局", "部", "課", "係", "室",
].join("|");
const ORG = new RegExp(`(?:株式会社|有限会社|合同会社)${NAME}{1,12}|${NAME}{1,12}?(?:${SUFFIX})(?!${NAME})`, "gu");

export type Segment = { text: string; org: boolean };

export function orgSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(ORG)) {
    const at = m.index ?? 0;
    // 1字だけの語（「市」だけ・「部」だけ）は、団体名らしいとは見ない
    if ([...m[0]].length < 2) continue;
    if (at > last) out.push({ text: text.slice(last, at), org: false });
    out.push({ text: m[0], org: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), org: false });
  return out;
}
