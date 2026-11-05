// SPDX-License-Identifier: AGPL-3.0-only
//
// 「整える」のときに本人が選ぶこと（プロパティの書き直し・PDF/A の印・電子署名）の計算（C の 0.9.0。sanitize/README.md）。
// 画面の部品に頼らない計算だけを置き、テストで確かめる。
// - 8 つの項目は、文書情報と XMP の両方に同じ値で書かれる（sanitize/properties.ts の FIELDS と同じ組み。画面に pdf-lib を入れないため、
//   ここに写しを持ち、テストで突き合わせる）。選べるのは「消す（既定）／そのまま／書き直す」。指定しなかった項目は消える。
// - 「そのまま」「書き直す」を選んだ欄は、本人が選んだ値なので、整えたあとの読み直しで「残り」に数えない（clean-model.ts）。
// - PDF/A の印と電子署名は、整える前に問いかけて、同意を取る。既定は外す。

import type { PropertyChange, PropertyEdit, PropertyEdits, PropertyKey } from "../../sanitize/types.ts";

export const PROPERTY_FIELDS: ReadonlyArray<{ key: PropertyKey; label: string; info: string; xmp: string; date: boolean }> = [
  { key: "title", label: "題", info: "Title", xmp: "dc:title", date: false },
  { key: "author", label: "作成者", info: "Author", xmp: "dc:creator", date: false },
  { key: "subject", label: "サブタイトル", info: "Subject", xmp: "dc:description", date: false },
  { key: "keywords", label: "キーワード", info: "Keywords", xmp: "pdf:Keywords", date: false },
  { key: "creator", label: "作成したアプリ", info: "Creator", xmp: "xmp:CreatorTool", date: false },
  { key: "producer", label: "PDF を作ったアプリ", info: "Producer", xmp: "pdf:Producer", date: false },
  { key: "created", label: "作成日", info: "CreationDate", xmp: "xmp:CreateDate", date: true },
  { key: "modified", label: "更新日", info: "ModDate", xmp: "xmp:ModifyDate", date: true },
];

export type PropertyMode = "remove" | "keep" | "set";
export type PropertyChoice = { mode: PropertyMode; value: string };

export const MODE_LABEL: Record<PropertyMode, string> = { remove: "消す", keep: "そのまま", set: "書き直す" };

/** 日付の書き方（片付けの側でも確かめる。ここでは画面ですぐ知らせるため） */
const DATE_FORM = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/;
export const DATE_HINT = "2026-11-05 か 2026-11-05T10:30 の形で書いてください。";

/** 本人が選んだことを、片付けに渡す形にする。書き直すで空の値は「消す」。日付の形が違うものは、その項目の名前を返す */
export function buildEdits(choices: Partial<Record<PropertyKey, PropertyChoice>>): { edits: PropertyEdits; bad: string[] } {
  const edits: PropertyEdits = {};
  const bad: string[] = [];
  for (const f of PROPERTY_FIELDS) {
    const c = choices[f.key];
    let e: PropertyEdit = "remove";
    if (c?.mode === "keep") e = "keep";
    else if (c?.mode === "set") {
      const v = c.value.trim();
      if (!v) e = "remove";
      else if (f.date && !DATE_FORM.test(v)) {
        bad.push(f.label);
        continue;
      } else e = { set: v };
    }
    edits[f.key] = e;
  }
  return { edits, bad };
}

/** 「そのまま」「書き直す」になった欄の名前（文書情報と XMP の両方）。読み直しで「残り」に数えない */
export function chosenFields(changes: readonly PropertyChange[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const c of changes ?? []) {
    if (c.action !== "kept" && c.action !== "set") continue;
    const f = PROPERTY_FIELDS.find((x) => x.key === c.key);
    if (f) out.add(f.info).add(f.xmp);
  }
  return out;
}

const ACTION_TEXT: Record<PropertyChange["action"], string> = {
  kept: "そのまま残しました（本人が選んだ値）",
  set: "書き直しました（本人が選んだ値）",
  removed: "消しました",
  absent: "もとから空でした",
};

/** 整えた結果と報告書に出す 1 行ずつ（値そのものは入れない） */
export function changeLines(changes: readonly PropertyChange[] | undefined): string[] {
  return (changes ?? [])
    .filter((c) => c.action !== "absent")
    .map((c) => {
      const f = PROPERTY_FIELDS.find((x) => x.key === c.key);
      const name = f ? `${f.label}（${f.info}）` : c.key;
      return `${name}：${ACTION_TEXT[c.action]}${c.differed && c.action === "kept" ? "。文書情報と XMP で値が違っていたので、文書情報の値にそろえました" : ""}`;
    });
}

/** 整える前の問いかけ（C の #89 の案のまま） */
export const CONSENT_TEXT = {
  pdfa: "この PDF には、長期保存用の形式（PDF/A）の印が付いています。整えると形式の決まりを満たさなくなることがあるため、印を外します。よろしいですか？",
  signatures: (n: number) =>
    `この PDF には、電子署名が付いています${n > 1 ? `（${n} 個）` : ""}。整えると中身が変わるため、署名は無効になります。署名の情報と見た目（名前・印影）を外して整えます。よろしいですか？`,
  agree: "上の説明を読み、わかったうえで整える",
} as const;
