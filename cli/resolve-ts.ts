// SPDX-License-Identifier: AGPL-3.0-only
//
// Node で、画面のコード（src/）をそのまま読むためのフック。
// 画面のコードは Vite で動かすので、相対の import に拡張子を書いていない（例：import … from "./limits"）。
// Node はそれを探せないので、拡張子のない相対の import で見つからないときだけ、".ts" を足して探し直す。
// ほかの import（パッケージ・拡張子のあるもの）は変えない。通信はしない（ファイルの場所を決めるだけ）。

import { registerHooks } from "node:module";

let registered = false;

export function registerTsResolve(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (e) {
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        const hasExt = /\.[A-Za-z0-9]+$/.test(specifier.split("/").pop() ?? "");
        if (!relative || hasExt || (e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw e;
        return nextResolve(specifier + ".ts", context);
      }
    },
  });
}
