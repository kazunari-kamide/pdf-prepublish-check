// SPDX-License-Identifier: AGPL-3.0-only
//
// 通信を数える拡張機能（extension/）の、数える決まりと、拡張機能そのものが外へ送らないことを確かめる。
// 本物の Chrome に入れて動かす確かめは scripts/check-extension.mjs（npm run check:extension）。

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addHeaders, addRequest, badgeText, bodyBytes, classify, formatBytes, isWatchedPage, newTabState, start, view } from "../extension/count.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT = path.join(ROOT, "extension");
const PAGE = "http://127.0.0.1:5173/";

describe("見るページ", () => {
  it("公式と手元だけ", () => {
    expect(isWatchedPage("https://omamoripdf.com/")).toBe(true);
    expect(isWatchedPage("http://localhost:5173/")).toBe(true);
    expect(isWatchedPage("http://127.0.0.1:4173/x")).toBe(true);
    expect(isWatchedPage("http://omamoripdf.com/")).toBe(false);
    expect(isWatchedPage("https://omamoripdf.com.example/")).toBe(false);
    expect(isWatchedPage("https://example.com/")).toBe(false);
    expect(isWatchedPage("chrome://extensions/")).toBe(false);
    expect(isWatchedPage("壊れた URL")).toBe(false);
  });
});

describe("送ったか、読み込んだか", () => {
  const o = "http://127.0.0.1:5173";
  it("同じサイトの ? なし GET は読み込み", () => {
    expect(classify({ url: `${o}/assets/pdf.min.mjs`, method: "GET", type: "script" }, o)).toBe("loaded");
  });
  it("それ以外は送った", () => {
    expect(classify({ url: "https://example.com/a.png", method: "GET", type: "image" }, o)).toBe("sent");
    expect(classify({ url: `${o}/a.png?x=1`, method: "GET", type: "image" }, o)).toBe("sent");
    expect(classify({ url: `${o}/sink`, method: "POST", type: "xmlhttprequest" }, o)).toBe("sent");
    expect(classify({ url: `${o}/sink`, method: "GET", type: "ping" }, o)).toBe("sent");
    expect(classify({ url: `${o}/sink`, method: "GET", type: "other", requestBody: { raw: [] } }, o)).toBe("sent");
    expect(classify({ url: "http://localhost:5173/a.js", method: "GET", type: "script" }, o)).toBe("sent");
  });
});

describe("数える", () => {
  it("数え始める前は数に入れない", () => {
    const s = newTabState(PAGE);
    expect(addRequest(s, { url: "https://example.com/", method: "POST" })).toBeNull();
    expect(s.before).toBe(1);
    expect(s.sent.count).toBe(0);
    expect(view(s).tone).toBe("waiting");
    expect(badgeText(s)).toBe("－");
  });

  it("PDF の合図から数え、本文とヘッダーの大きさを足す", () => {
    const s = newTabState(PAGE);
    expect(start(s, "pdf", 1)).toBe(true);
    expect(view(s)).toMatchObject({ tone: "zero", value: "0 B", detail: "要求 0 件" });
    const body = new TextEncoder().encode("x".repeat(500)).buffer;
    const url = "https://example.com/sink";
    const mark = addRequest(s, { url, method: "POST", type: "xmlhttprequest", requestBody: { raw: [{ bytes: body }] } });
    expect(mark).toEqual({ kind: "sent" });
    const line = "POST".length + 1 + url.length + 11;
    expect(s.sent.bytes).toBe(line + 500);
    addHeaders(s, mark, [{ name: "Content-Type", value: "text/plain" }]);
    expect(s.sent.bytes).toBe(line + 500 + "Content-Type: text/plain\r\n".length);
    expect(view(s).tone).toBe("sent");
    expect(view(s).detail).toBe("要求 1 件");
    expect(s.recent[0]?.where).toBe(url);
  });

  it("2 つめの PDF の合図では数を消さない。手で数え直すと消える", () => {
    const s = newTabState(PAGE);
    start(s, "pdf", 1);
    addRequest(s, { url: "https://example.com/", method: "GET", type: "image" });
    expect(start(s, "pdf", 2)).toBe(false);
    expect(s.sent.count).toBe(1);
    expect(start(s, "manual", 3)).toBe(true);
    expect(s.sent.count).toBe(0);
    expect(s.before).toBe(1);
    expect(view(s).title).toBe("数え直したあとに送ったデータ");
  });

  it("大きさの分からない本文は、分からないと書く", () => {
    expect(bodyBytes({ error: "too large" })).toBeNull();
    const s = newTabState(PAGE);
    start(s, "pdf", 1);
    addRequest(s, { url: "https://example.com/", method: "POST", requestBody: { error: "too large" } });
    expect(view(s).detail).toContain("大きさが分からない本文 1 件");
  });

  it("フォームの本文は名前と値の字を数える", () => {
    expect(bodyBytes({ formData: { a: ["あ"] } })).toBe(1 + 3 + 2);
  });

  it("大きさの書き方（小さい数を 0 に丸めない）", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("バッジは 4 字まで", () => {
    const s = newTabState(PAGE);
    start(s, "pdf", 1);
    for (const n of [0, 999, 5000, 2_000_000, 5_000_000_000]) {
      s.sent.bytes = n;
      expect(badgeText(s).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("拡張機能そのもの", () => {
  const files = readdirSync(EXT)
    .filter((f) => /\.(js|html|css|json)$/.test(f))
    .map((f) => path.join(EXT, f));
  const manifest = JSON.parse(readFileSync(path.join(EXT, "manifest.json"), "utf8"));

  it("外へ送る仕組みを使っていない（確かめのページ test-page/ は除く）", () => {
    const forbidden = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|importScripts|innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|new\s+Function/;
    expect(files.filter((f) => forbidden.test(readFileSync(f, "utf8"))).map((f) => path.basename(f))).toEqual([]);
  });

  it("外の URL を読み込まない", () => {
    const external = /(src|href)\s*=\s*["']https?:/;
    expect(files.filter((f) => external.test(readFileSync(f, "utf8"))).map((f) => path.basename(f))).toEqual([]);
  });

  it("権限は要る分だけ", () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(["storage", "webRequest"]);
    // 別のサイトへの要求を見るには、宛先のサイトの権限も要る（extension/README.md の「権限」）。ページの隅の表示は公式と手元だけ
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    expect(manifest.content_scripts[0].matches).toEqual(["https://omamoripdf.com/*", "http://localhost/*", "http://127.0.0.1/*"]);
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.content_security_policy.extension_pages).toContain("connect-src 'none'");
  });

  it("色は design/tokens.css と同じ", () => {
    const tokens = readFileSync(path.join(ROOT, "design/tokens.css"), "utf8");
    const token = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(tokens)?.[1]?.toLowerCase();
    const allowed = new Set(["base", "accent", "ok", "paper", "line", "muted", "focus", "on-dark", "focus-line", "surface"].map(token));
    const used = new Set(files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase())));
    expect([...used].filter((c) => !allowed.has(c))).toEqual([]);
  });
});
