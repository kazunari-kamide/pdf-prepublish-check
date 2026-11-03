// SPDX-License-Identifier: AGPL-3.0-only
//
// 正解データの expected_error（開けないことが正しい入力）を採点する。決まりは fixtures/p6/README.md・fixtures/p5/README.md と、
// 検証器の selfcheck（verifier/selfcheck.mjs・verifier/p5-selfcheck.mjs）と同じ：報告が status: "error" で、error.code が同じなら「合っている」。
// 合っていれば、読めなかった合成 PDF には数えず、不合格にもしない（PR #26 の決めてほしいことの 1）。
// 合っていなければ（開けてしまった・別のエラー）、不合格にする。

/** 採点に使う所だけ（検出ルールの報告をそろえたもの、または検証器の出力） */
export type ErrorShapedReport = { status: "ok" | "error"; error?: { code: string } };

export type ExpectedErrorResult = {
  file: string;
  expected: string;
  /** 報告が返したエラーの code。開けてしまったときは null */
  got: string | null;
  ok: boolean;
};

export function checkExpectedError(file: string, expectedError: string, report: ErrorShapedReport): ExpectedErrorResult {
  const got = report.status === "error" ? (report.error?.code ?? "") : null;
  return { file, expected: expectedError, got, ok: got === expectedError };
}

/** 結果の1行（eval の出力に使う） */
export function describeExpectedErrors(results: ExpectedErrorResult[]): string[] {
  const ok = results.filter((r) => r.ok).length;
  const lines = [`期待するエラー（expected_error）：${results.length} 件中 ${ok} 件で合った（合っていれば、読めなかった PDF にも不合格にも数えない）`];
  for (const r of results.filter((x) => !x.ok)) {
    lines.push(`  ${r.file}：期待するエラー ${r.expected} を返さなかった（${r.got === null ? "開けてしまった" : `エラー ${r.got || "（code なし）"}`}）`);
  }
  return lines;
}
