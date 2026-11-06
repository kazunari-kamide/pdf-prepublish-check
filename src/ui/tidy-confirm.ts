// SPDX-License-Identifier: AGPL-3.0-only
//
// 「整える」を押したあとの文（7。2026-11-06 本人が案 A を選び、押す前の確かめは画面全体のポップアップにした）。
// - 押す前：何を消すかを、ふだんの言い方の 3 行（見つかった所・プロパティ・見えない所にしまわれた情報）で出す。
//   専門の名前（XMP メタデータ・JavaScript など）は「専門の名前で見る」の中だけに出す（2026-11-07 本人が承認した結果の画面の案 A）。
// - 処理中：帯そのものに、段階（整える → 読み直す）と、読み直しの数（調べる種類 n/m）を出す。
//   整える段は、整える処理の中から進み具合が来ないので、動いていることだけを出す。
// 画面の部品に頼らない計算だけを置き、テストで確かめる（tests/tidy-confirm.test.ts）。

import type { TierKey } from "./model";
import type { PropertyMode } from "./tidy-model";

/**
 * プロパティをどうするかの一文（実際の選びの数を出す。「整える内容」の欄の下と、押す前の確かめの両方で使う）。
 * 例：「プロパティは、8 項目のうち 6 項目を消し、1 項目を書き直し、1 項目をそのまま残します（「整える内容」で変えられます）。」
 * modes は 8 項目それぞれの選び（選んでいない項目は消す）
 */
export function propertySummary(modes: readonly PropertyMode[]): string {
  const n = (m: PropertyMode) => modes.filter((x) => x === m).length;
  const remove = n("remove");
  const set = n("set");
  const keep = n("keep");
  const where = "（「詳しく見る」の「整える内容」で変えられます）";
  if (remove === modes.length) return `プロパティは、${modes.length} 項目とも消します${where}。`;
  const parts = [remove ? `${remove} 項目を消し` : "", set ? `${set} 項目を書き直し` : "", keep ? `${keep} 項目をそのまま残し` : ""].filter(Boolean);
  // 最後の「〜し」を「〜します」にする
  const last = parts.pop()!;
  const tail = last.replace(/し$/, "します");
  return `プロパティは、${modes.length} 項目のうち、${[...parts, tail].join("、")}${where}。ほかの欄（独自の欄・履歴など）は消します。`;
}

export type TidyConfirmInput = {
  /** 段ごとの数（見つかった段だけ。並びは TIER_ORDER） */
  tiers: ReadonlyArray<{ key: TierKey; label: string; count: number }>;
  /** 自分で選んだ黒塗りの所の数（個人情報の候補の「黒塗りに加える」も入る） */
  picks: number;
  /** プロパティをどうするかの一文（renderTidySummary と同じ文）。プロパティを調べられなかったときは空 */
  properties: string;
  /** 提出のために小さくする入口から来たときの上限（例：「10MB」） */
  shrink?: string;
  /** 本人が「整えない」を選んだ種類（D168）。count は、その種類の見つかった数。整える数から除き、確かめに 1 行で並べる */
  kept?: ReadonlyArray<{ pattern: string; name: string; count: number }>;
  /** 見つかった種類ごとの名前と数（見えない情報だけ。並びは結果の一覧と同じ） */
  kinds?: ReadonlyArray<{ name: string; count: number }>;
  /** プロパティ（文書情報と XMP）で値の入っていた欄の数。読めなかったときは null */
  propsFilled?: number | null;
};

export type TidyConfirm = {
  title: string;
  /** 何を作るか（1 文） */
  lead: string;
  /** 消すもの（ふだんの言い方。見出しと 1 文） */
  items: Array<{ head: string; text: string }>;
  /** 専門の名前との対応（「専門の名前で見る」の中に出す） */
  tech: string;
  /** そのほかに伝えること（外す種類・自分で選んだ所・候補・小さくすること） */
  notes: string[];
  /** 押すボタンの左の一言 */
  hint: string;
  /** 押すボタンの字 */
  run: string;
};

/** 見つかった数に入らずに消すもの。外せる種類（D168）は、本人が外したときに並べない。null は外せないもの */
const ALSO_REMOVED: ReadonlyArray<[string, string | null]> = [
  ["XMP メタデータ", null],
  ["前の版の残り", null],
  ["添付ファイル", "P9"],
  ["注釈とコメント", "P8"],
  ["JavaScript", "P12"],
];

/** 押す前の確かめでの、ふだんの言い方（ALSO_REMOVED と同じ並び。[ふだんの言い方, 専門の名前]） */
const PLAIN_NAME: Record<string, [string, string]> = {
  "XMP メタデータ": ["作ったときの記録", "XMP メタデータ"],
  "前の版の残り": ["前の版の残り", "増分更新"],
  "添付ファイル": ["添付ファイル", "埋め込みファイル"],
  "注釈とコメント": ["書き込みのメモ", "注釈とコメント"],
  JavaScript: ["開くと動く仕掛け", "JavaScript と外の動作"],
};

/** いつも消すものの一言（本人が外した種類は除く）。「整える内容」の欄と同じ言葉 */
export function alwaysRemovedText(kept: ReadonlySet<string> = new Set()): string {
  return `${ALSO_REMOVED.filter(([, p]) => p === null || !kept.has(p)).map(([t]) => t).join("・")} なども消します。`;
}

/** 何も外さないときの一言 */
export const ALWAYS_REMOVED = alwaysRemovedText();

/** 「整える内容」の、消すものの一覧（本人が外した種類は除く） */
export function sanitizeListText(kept: ReadonlySet<string> = new Set()): string {
  const items: ReadonlyArray<[string, string | null]> = [
    ["黒塗りの下の字", null],
    ["見えない字", null],
    ["作成者などの欄", null],
    ...ALSO_REMOVED,
  ];
  return `${items.filter(([, p]) => p === null || !kept.has(p)).map(([t]) => t).join("・")} などを消します。`;
}

export function buildTidyConfirm(input: TidyConfirmInput): TidyConfirm {
  const hiddenTiers = input.tiers.filter((t) => t.key !== "candidate" && t.count > 0);
  const kept = (input.kept ?? []).filter((k) => k.count > 0);
  const keptN = kept.reduce((n, k) => n + k.count, 0);
  const hidden = hiddenTiers.reduce((n, t) => n + t.count, 0) - keptN;
  const candidates = input.tiers.find((t) => t.key === "candidate")?.count ?? 0;
  const lead = hidden
    ? "次のものを消した PDF を、新しく作ります。元の PDF は、そのまま残ります。"
    : "見つかった所はありませんが、次のものを消した PDF を、新しく作ります。元の PDF は、そのまま残ります。";
  const items: TidyConfirm["items"] = [];
  if (hiddenTiers.length) {
    const tiersText = hiddenTiers.map((t) => `${t.label} ${t.count}`).join("・");
    const kinds = (input.kinds ?? []).filter((k) => k.count > 0).map((k) => `${k.name} ${k.count} か所`).join("・");
    items.push({
      head: `見つかった ${hidden} か所`,
      text: `${kinds ? `${kinds}（${tiersText}）` : tiersText}${keptN > 0 ? `。うち外す ${keptN} か所は消しません` : ""}。`,
    });
  }
  if (input.properties) {
    items.push({
      head: "プロパティ（作った人の名前などを書く欄）",
      text: input.propsFilled === 0 ? "今回は、どの欄も空でした。" : input.properties,
    });
  }
  const keptSet = new Set(kept.map((k) => k.pattern));
  const also = ALSO_REMOVED.filter(([, p]) => p === null || !keptSet.has(p)).map(([t]) => PLAIN_NAME[t]!);
  items.push({ head: "見えない所にしまわれた情報", text: `${also.map(([plain]) => plain).join("・")}。あれば、まとめて消します。` });
  const tech = `${also.map(([plain, name]) => `${plain}＝${name}`).join("、")}。`;
  const notes: string[] = [];
  if (kept.length) notes.push(`外す（整えずに残す）：${kept.map((k) => `${k.name} ${k.count} か所`).join("・")}。整えた PDF に残ります。`);
  if (input.picks > 0) notes.push(`自分で選んだ ${input.picks} か所も、黒塗りにします。`);
  if (candidates > 0) {
    notes.push(
      input.picks > 0
        ? "個人情報の候補（見えている字）は、「黒塗りに加える」を押した所だけを黒塗りにします。"
        : `個人情報の候補（見えている字）${candidates} か所は、黒塗りにしません（「詳しく見る」の中の「黒塗りに加える」で加えられます）。`,
    );
  }
  if (input.shrink) notes.push(`整えて読み直したあとに、選んだ上限（${input.shrink}）まで小さくします。`);
  const total = hidden + input.picks;
  return {
    title: "整える前に確かめてください",
    lead,
    items,
    tech,
    notes,
    hint: "消すのは、新しく作る PDF だけです。",
    run: total ? `${total} か所を整える` : "整える",
  };
}

/** 処理中の帯の字。stage＝今の段階、verify＝読み直しの進み具合（調べる種類の数） */
export function bandProgressText(stage: "tidy" | "verify", verify?: { done: number; total: number }): string {
  if (stage === "tidy") return "1 整えています… → 2 読み直す";
  const n = verify && verify.total > 0 ? `（調べる種類 ${Math.min(verify.done + 1, verify.total)}/${verify.total}）` : "";
  return `1 整えた ✓ → 2 読み直しています${n}`;
}

/** 帯の進み具合の割合（0〜1）。整える段は 0〜半分、読み直しで半分〜全部（整える段は中から進み具合が来ないので、半分の手前で止める） */
export function bandProgressRatio(stage: "tidy" | "verify", verify?: { done: number; total: number }): number {
  if (stage === "tidy") return 0.1;
  if (!verify || verify.total <= 0) return 0.5;
  return 0.5 + 0.5 * Math.min(1, Math.max(0, verify.done / verify.total));
}
