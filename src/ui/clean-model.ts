// SPDX-License-Identifier: AGPL-3.0-only
//
// 「3 片付ける」「4 読み直す」の結果を、画面に並べる形に直す（画面の部品に頼らない計算だけ。テストで確かめる）。
// - 残っている所の数は、片付けた PDF を検査の入口に最初から入れ直した結果（after）だけで決める。
//   片付けの報告（removed）は「何をしたか」を見せるためだけに使い、「残っていない」の根拠にしない（sanitize/README.md「4 読み直す」）。
// - 「残っていません」は、読み直しで調べた型についてだけ言う（CLAUDE.md §11-5b）。

import type { NotDoneItem, PropertyChange, RemovedItem, SanitizePattern } from "../../sanitize/types.ts";
import type { Rect } from "../inspect/report.ts";
import { CATALOG } from "./coverage.ts";
import { CANDIDATE_PATTERNS } from "./picks.ts";
import { changeLines, chosenFields } from "./tidy-model.ts";
import type { ViewModel } from "./model.ts";

/**
 * 型の名前（docs/glossary.md の言葉）。見た所・見なかった所の一覧（coverage.ts の CATALOG）と同じ名前を、1か所から引く。
 * 片付けの型（P1・P2・P5〜P9・P12）だけでなく、読み直しで調べる型（P4・P10・P11 など）もここで引く
 */
export const PATTERN_NAME: Readonly<Record<string, string>> = {
  ...Object.fromEntries(CATALOG.filter((c) => /^P\d+$/.test(c.key)).map((c) => [c.key, c.name])),
  P13: "個人情報らしい字",
};
/** 「名前（P10）」の形。名前の分からない型は、番号だけにする（「P10（P10）」のように番号を重ねない） */
export const patternWithName = (p: string): string => (PATTERN_NAME[p] ? `${PATTERN_NAME[p]}（${p}）` : p);

const PATTERN_ORDER: SanitizePattern[] = ["P6", "P7", "P5", "P1", "P2", "P8", "P9", "P12"];
/** 自分で黒塗りした所（片付けの redact が返す種類）。見せかけの黒塗りの片付けとは分けて並べる */
const SELF_KINDS: ReadonlySet<RemovedItem["kind"]> = new Set(["redacted_text", "redacted_pixels", "redacted_annotation", "redacted_field", "redaction_box"]);
export const SELF_GROUP_NAME = "自分で選んだ所の黒塗り";

/** 1つの型の中で並べる行の上限。超えた分は数だけ出す */
export const MAX_LINES_PER_GROUP = 30;

/**
 * self＝自分で選んだ所の黒塗り（片付けの redact）。pattern はどちらも片付けの型（自分で選んだ所は P6 の墨消し）。
 * found＝確かめた画面に、この種類の項目が出ていた（seen はその項目の数）。出ていなかった種類は「念のため消したもの」として分けて見せる。
 * 見つかった数と消した数を 1 つの合計にすると、数が合わないように見えるため（2026-11-05 本人の画面のレビュー C2）
 */
export type RemovedGroup = { pattern: SanitizePattern; name: string; self: boolean; found: boolean; seen: number; lines: string[]; total: number };
export type DoneMark = { page: number; rect: Rect; label: string };

/** 本人が選んだ値として「残り」に数えない型（文書情報・XMP・他の団体の名前。欄の名前 field があるもの） */
const CHOSEN_PATTERNS: readonly string[] = ["P1", "P2", "P3"];

export type CleanView = {
  /** 本人が「そのまま」「書き直す」を選んだので、読み直しで「残り」に数えなかった行の数 */
  chosen: number;
  /** 本人が「整えない」を選んだ種類（D168）で、読み直しで見つかった行の数。「残り」に数えない */
  kept: number;
  /** 外した種類ごとの一言（例「注釈・コメント（P8）：2 か所を残しています」）。結果の画面と報告書に必ず並べる */
  keptLines: string[];
  /** 外した種類の名前と数（例「注釈・コメント 2 か所、フォームの入力値 1 か所」）。外した物が残っていなければ空 */
  keptNames: string;
  /** 外した種類のほかにも、言い切れない所（消せなかった所・調べられなかった所）がある */
  alsoUnsure: boolean;
  /** プロパティを項目ごとにどうしたか（値は入れない） */
  propertyLines: string[];
  /** clean＝読み直して残り 0 件で、片付けられなかった所も調べられなかった所もない（「全部緑」）。
   *  left＝読み直して、まだ残っている。unsure＝0 件だが、言い切れない所がある */
  verdict: "clean" | "left" | "unsure";
  headline: string;
  /** 片付ける前に見つかった、見た目では分からない情報の数（見えている候補は入れない。left と同じ物差し） */
  before: number;
  /** 読み直して残っていた所の数。読み直せなかったときは null */
  left: number | null;
  /** 見えている個人情報らしい字（候補）の、整える前と読み直したあとの数。整える前に 0 なら、どちらも出さない。読み直せなかったときの後は null */
  candidatesBefore: number;
  candidatesAfter: number | null;
  removed: RemovedGroup[];
  notDone: string[];
  notes: string[];
  /** 片付けた所のうち、ページの上の場所があるもの（ページの絵に「済」の枠を描く） */
  doneMarks: DoneMark[];
  /** 読み直しで調べた範囲の説明 */
  scope: string;
};

const withPage = (label: string, page: number | undefined) => (page !== undefined ? `${label}（ページ ${page}）` : label);

export function buildCleanView(input: {
  before: ViewModel;
  /** 読み直し（片付けた PDF の検査）の結果。読み直せなかったときは null */
  after: ViewModel | null;
  removed: RemovedItem[];
  notDone: NotDoneItem[];
  decrypted: boolean;
  /** プロパティを書き直したとき、項目ごとに何をしたか（片付けの r.properties）。値そのものは入らない */
  properties?: PropertyChange[];
  /** 本人が「整えない」を選んだ種類（D168。sanitize の keep と同じ一覧） */
  kept?: readonly string[];
}): CleanView {
  const { before, after, removed, notDone, decrypted } = input;

  const groups = new Map<string, RemovedGroup>();
  for (const r of removed) {
    const self = SELF_KINDS.has(r.kind);
    const key = self ? "self" : r.pattern;
    const seen = self ? 0 : before.rows.filter((row) => row.pattern === r.pattern).length;
    const g = groups.get(key) ?? { pattern: r.pattern, name: self ? SELF_GROUP_NAME : (PATTERN_NAME[r.pattern] ?? r.pattern), self, found: seen > 0, seen, lines: [], total: 0 };
    g.total++;
    if (g.lines.length < MAX_LINES_PER_GROUP) g.lines.push(withPage(r.label, r.page));
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.total > g.lines.length) g.lines.push(`ほか ${g.total - g.lines.length} 件`);
  }
  const removedGroups = ["self", ...PATTERN_ORDER].filter((k) => groups.has(k)).map((k) => groups.get(k)!);

  const notDoneLines = notDone.map((n) => withPage(n.label, n.page));
  const doneMarks: DoneMark[] = removed
    .filter((r): r is RemovedItem & { page: number; rect: Rect } => r.page !== undefined && r.rect !== undefined)
    .map((r) => ({ page: r.page, rect: r.rect, label: r.label }));

  const notes: string[] = [];
  if (decrypted) notes.push("パスワードなしで開ける暗号化がかかっていたので、外して書き出しました。");

  // 読み直しで調べた型と、片付けたが読み直しでは調べていない型
  const checked = after
    ? [...new Set(after.groups.filter((g) => g.status === "ok" && !CANDIDATE_PATTERNS.includes(g.pattern)).map((g) => g.pattern))]
    : [];
  const notChecked = [...new Set(removedGroups.map((g) => g.pattern))].filter((p) => !checked.includes(p));
  // 読み直しで調べた種類の一覧は、下の「見た所・見なかった所」と同じなので並べない（2026-11-05 本人の画面のレビュー C3）。
  // ここには、そこに出ないこと（消したが読み直しでは調べていない種類・調べていない層）だけを書く
  const nameOf = (p: string) => PATTERN_NAME[p] ?? p;
  let scope = checked.length ? "" : "読み直しでは、どの種類も調べられませんでした。";
  if (notChecked.length) scope += `${notChecked.map(nameOf).join("・")}は消しましたが、読み直しでは調べていません（調べるルールがまだありません）。`;
  // 調べた型の中でも、調べていない層があれば添える（決め打ちの中身は src/ui/scope.ts の1か所）
  if (after) scope += after.caveats.join("");

  // 黒塗りの候補（P13【仮】、見える文字の個人情報らしい字）は、片付けでは消さない（黒塗りにするかは利用者が決める）ので、
  // 「残っている所」に数えない（2026-11-04 人が決めた）。候補の行だけが残り、ほかに知らせることがなければ「全部緑」にする
  const candidateRows = after ? after.candidates : 0;
  // 本人が「そのまま」「書き直す」を選んだ欄の値（文書情報・XMP）は、本人が選んだ値なので「残っている所」に数えない（2026-11-05）
  const chosen = chosenFields(input.properties);
  const chosenRows = after ? after.rows.filter((r) => CHOSEN_PATTERNS.includes(r.pattern) && r.field !== undefined && chosen.has(r.field)).length : 0;
  // 本人が「整えない」を選んだ種類（D168）の行も、残りに数えない。数えなかった分は、別の行（keptLines）で必ず並べる
  const keptSet = new Set(input.kept ?? []);
  const keptRowsList = after ? after.rows.filter((r) => !r.candidate && keptSet.has(r.pattern) && !(CHOSEN_PATTERNS.includes(r.pattern) && r.field !== undefined && chosen.has(r.field))) : [];
  const keptRows = keptRowsList.length;
  const keptLines = [...keptSet]
    .map((p) => ({ p, n: keptRowsList.filter((r) => r.pattern === p).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${patternWithName(x.p)}：${x.n} か所を残しています（あなたが「整えない」を選んだ種類）`);
  const left = after ? after.rows.length - candidateRows - chosenRows - keptRows : null;
  // 字のないページのお知らせ（no_text）は数えない：整えると見えない字が消えて、字のないページになることがあるため（2026-11-06）
  const afterClean = after ? after.clean || (left === 0 && after.unchecked.length === 0 && after.notices.length - (after.noTextNotices ?? 0) === 0) : false;
  let verdict: CleanView["verdict"];
  let headline: string;
  let alsoUnsure = false;
  const keptNames = [...keptSet]
    .map((p) => ({ p, n: keptRowsList.filter((r) => r.pattern === p).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${PATTERN_NAME[x.p] ?? x.p} ${x.n} か所`)
    .join("、");
  if (left === null) {
    verdict = "unsure";
    headline = "整えた PDF を読み直せませんでした。残っていないとは言えません。";
  } else if (left > 0) {
    verdict = "left";
    headline = `読み直したところ、まだ ${left} か所残っています。`;
  } else if (keptRows > 0) {
    // 外した物が残っているので「全部消えた」とは言わない。保存は、分かったうえでの印を付けてから（confirm）
    verdict = "unsure";
    alsoUnsure = notDone.length > 0 || !afterClean;
    headline =
      `読み直したところ、整えた種類で残っている所は 0 件でした。あなたが外した種類（${keptNames}）は残しています。` +
      (alsoUnsure ? "消せなかった所か、調べられなかった所もあります。" : "") +
      "「全部消えた」ではありません。";
  } else if (notDone.length > 0 || !afterClean) {
    verdict = "unsure";
    alsoUnsure = true;
    headline = "読み直したところ、残っている所は 0 件でしたが、消せなかった所か、調べられなかった所があります。「全部消えた」ではありません。";
  } else {
    verdict = "clean";
    headline = "読み直したところ、調べた項目で残っている所は 0 件でした。";
  }

  if (chosenRows > 0) notes.push(`本人が「そのまま」「書き直す」を選んだプロパティの値（${chosenRows} か所）は、残っている所に数えていません。`);
  return { verdict, headline, before: before.hidden, left, candidatesBefore: before.candidates, candidatesAfter: after ? candidateRows : null, removed: removedGroups, notDone: notDoneLines, notes, doneMarks, scope, chosen: chosenRows, kept: keptRows, keptLines, keptNames: keptRows > 0 ? keptNames : "", alsoUnsure, propertyLines: changeLines(input.properties) };
}

/**
 * 保存のボタンを押せるか（11/5 B の 2）。保存のリンク（Blob の URL）は、読み直しが通ったあとでだけ作る。
 * - ok：読み直しが通った（verdict が clean）。そのまま押せる
 * - confirm：読み直して残りは 0 件だが、片付けられなかった所か、調べきれなかった所がある。
 *   「言い切れない所があると分かったうえで保存する」に印を付けたときだけ押せる
 * - blocked：読み直して残っている所がある、または読み直せなかった。押せない
 */
export type SaveGate = "ok" | "confirm" | "blocked";

export function saveGate(c: Pick<CleanView, "verdict" | "left">): SaveGate {
  if (c.verdict === "clean") return "ok";
  if (c.verdict === "unsure" && c.left === 0) return "confirm";
  return "blocked";
}

/** 確認の印の字（言い切れない所があるとき） */
export const CONFIRM_LABEL = "言い切れない所があると分かったうえで保存する";

/**
 * 保存のボタンの下の一言と、確認の印の字（D168）。確認が要る理由で分ける：
 * - 外した種類だけ：言い切れないのではなく、本人が残した物があるだけ。「外した種類を残したまま保存する」
 * - 言い切れない所もある：今までの文に、外した種類の一文を足す
 */
export function saveTexts(c: Pick<CleanView, "verdict" | "left" | "keptNames" | "alsoUnsure">): { note: string; label: string } {
  const gate = saveGate(c);
  if (gate !== "confirm" || !c.keptNames) return { note: SAVE_NOTE[gate], label: CONFIRM_LABEL };
  const kept = `あなたが外した種類（${c.keptNames}）が残っています。`;
  if (!c.alsoUnsure) return { note: `${kept}残したまま保存するときだけ、印を付けてください。`, label: "外した種類を残したまま保存する" };
  return { note: `${SAVE_NOTE.confirm}${kept}`, label: CONFIRM_LABEL };
}

/** 保存のボタンの下に出す一言 */
export const SAVE_NOTE: Record<SaveGate, string> = {
  ok: "読み直しが通ったので、保存できます。",
  confirm: "読み直して残りは 0 件でしたが、言い切れない所があります。下の一覧を確かめ、分かったうえで保存するときだけ、印を付けてください。",
  blocked: "読み直しが通っていないため、保存できません。残っている所を確かめてください。",
};

/** 保存するファイルの名前。元の名前の後ろに「_片付け済み」をつける */
export function cleanedFileName(original: string): string {
  const stem = original.replace(/\.pdf$/i, "").trim() || "document";
  return `${stem}_整えた.pdf`;
}
