// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする（sanitize/redact.ts）の読み直しに渡す確かめ（Node：テスト・採点）。
// - 作品の検査（全部のルール）：src/inspect/inspect.ts の inspectAll
// - 検証器（P6）：濃い覆いの下に中身が残っていないか（黒く描いた四角の下を、別の読み方 PDF.js で読み直す）。
//   採点（eval/）と同じく、検証器はコマンドとして呼ぶだけで import しない。片付けた PDF は .tmp/ に一時に書く
// 検証器は Node でだけ動く（ブラウザの画面では、作品の検査と、選んだ場所の確かめだけになる）。

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rulesCheck } from "../../sanitize/redact-check.ts";
import type { RedactCheck, RedactLeftover } from "../../sanitize/types.ts";
import { inspectAll } from "../../src/inspect/inspect";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TMP = path.join(ROOT, ".tmp", "redact-verify");

export const rules: RedactCheck = rulesCheck((b) => inspectAll(b));

type VerifierItem = { page: number; rect: [number, number, number, number] };
let seq = 0;

export const verifierP6: RedactCheck = {
  name: "verifier",
  async run(bytes) {
    mkdirSync(TMP, { recursive: true });
    const file = path.join(TMP, `${process.pid}-${++seq}.pdf`);
    writeFileSync(file, bytes);
    try {
      const r = spawnSync(process.execPath, [path.join(ROOT, "verifier", "cli.mjs"), file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) return [{ check: "verifier", kind: "verifier_error", count: 1, label: "検証器で読み直せませんでした" }];
      const out = JSON.parse(r.stdout) as { status: string; items: VerifierItem[]; skipped_pages: Array<{ page: number }> };
      if (out.status !== "ok") return [{ check: "verifier", kind: "verifier_error", count: 1, label: "検証器で読み直せませんでした" }];
      const left: RedactLeftover[] = out.items.map((it) => ({
        check: "verifier", kind: "verifier_item", pattern: "P6", count: 1, page: it.page, rect: it.rect, label: "検証器が、黒い四角の下に中身が残っていると数えました",
      }));
      for (const s of out.skipped_pages) left.push({ check: "verifier", kind: "verifier_error", count: 1, page: s.page, label: "検証器が、このページを調べられませんでした" });
      return left;
    } finally {
      rmSync(file, { force: true });
    }
  },
};

export const allChecks = [rules, verifierP6];
