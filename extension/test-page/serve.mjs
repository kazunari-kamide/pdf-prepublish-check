// SPDX-License-Identifier: AGPL-3.0-only
//
// 確かめのページを出す、手元だけのサーバー（127.0.0.1）。受け取った要求の中身は読まずに捨てる。
//   node extension/test-page/serve.mjs        … http://127.0.0.1:8787/ で出す（手で確かめるとき）
// scripts/check-extension.mjs からも使う（番号は空いているものを選ぶ）。

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;

export function startTestServer(port = 0) {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    req.resume();
    if (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/test.js") {
      const file = u.pathname === "/test.js" ? "test.js" : "index.html";
      res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
      res.end(readFileSync(path.join(HERE, file)));
    } else {
      // /sink（POST・beacon）・/pixel.png・/part.txt など。中身は返さない
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startTestServer(8787);
  console.log(`確かめのページ：http://127.0.0.1:${server.address().port}/（止めるときは Ctrl+C）`);
}
