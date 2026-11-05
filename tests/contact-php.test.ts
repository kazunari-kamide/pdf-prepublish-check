// SPDX-License-Identifier: AGPL-3.0-only
//
// お問い合わせ（ビルドで作る dist/contact-send.php。もとは server/contact-send.php）を、手元の PHP で動かして確かめる（docs/contact.md）。
// - メールは送らない。設定の send で受け取り、宛先・件名・送信元・本文を見る
// - 攻撃の形ごと（ヘッダー注入・入力を戻すときの HTML・CSRF・送り方・時刻の印・続けての送信・記録の大きさ・エラーの中身）に確かめる
// - PHP がない環境では、PHP を動かすテストを省いたと表示する。PHP の場所は、環境変数 PHP_BIN で渡せる

import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactHeaders, cspForContactMeta, cspForMeta } from "../csp.ts";
import { CONTACT_SEND_FILE, OFFICIAL_ORIGIN } from "../htaccess.ts";
import { contactSendPhp, siteFiles } from "../site.ts";
import {
  CONTACT_BODY_MAX,
  CONTACT_BODY_MIN,
  CONTACT_EMAIL_MAX,
  CONTACT_ERRORS_MARK,
  CONTACT_KINDS,
  CONTACT_MESSAGE_MARK,
  CONTACT_TOKEN_FIELD,
  CONTACT_TRAP_FIELD,
  CONTACT_URL_MAX,
  renderContact,
  renderContactResults,
} from "../src/site/pages.ts";
import { escapeHtml } from "../src/site/render.ts";

const PHP = process.env.PHP_BIN ?? "php";
const hasPhp = spawnSync(PHP, ["-r", "echo function_exists('mb_send_mail') ? 'ok' : 'no-mb';"], { encoding: "utf8" }).stdout === "ok";
if (!hasPhp) console.warn(`[contact-php] PHP（mbstring つき）が見つからないため、PHP を動かすテストを省きました（PHP_BIN=${PHP}）`);

const opts = { origin: OFFICIAL_ORIGIN, csp: cspForMeta, cssHref: "/assets/site.css" };
const built = contactSendPhp({ form: renderContact(opts), ...renderContactResults(opts) });

/** 手元の確かめの入口：定数を決めてから読み込み、contact_handle を直接呼ぶ。標準入力の JSON を受け取り、結果と送ったメールを JSON で返す */
const HARNESS = `<?php
declare(strict_types=1);
define('OMAMORI_CONTACT_TEST', true);
require __DIR__ . '/public_html/contact-send.php';
$in = json_decode(stream_get_contents(STDIN), true);
$sent = [];
$config = $in['config'];
if ($config !== null) {
    $config['send'] = function ($to, $subject, $body, $from) use (&$sent, $in) {
        $sent[] = ['to' => $to, 'subject' => $subject, 'body' => $body, 'from' => $from];
        return $in['sendOk'] ?? true;
    };
}
$out = [];
foreach ($in['requests'] as $r) {
    $result = contact_handle($r['server'], $r['post'], $config, $r['now'], $r['files'] ?? []);
    if ($in['render'] ?? false) {
        $result['html'] = contact_render($result, $PAGES);
    }
    $out[] = $result;
}
echo json_encode(['results' => $out, 'sent' => $sent, 'kinds' => KINDS, 'limits' => [BODY_MIN_CHARS, BODY_MAX_CHARS, EMAIL_MAX_CHARS, URL_MAX]], JSON_UNESCAPED_UNICODE);
`;

let work = "";
let dataDir = "";
const SECRET = "x".repeat(40);
const config = () => ({ to: "owner@example.invalid", from: "form@example.invalid", secret: SECRET, data_dir: dataDir, origin: OFFICIAL_ORIGIN });

type Req = { server?: Record<string, string>; post?: Record<string, unknown>; now?: number; files?: Record<string, unknown> };
type Result = { status: number; page: string; messages: Record<string, string> | string[]; headers: string[]; values: Record<string, string>; token: string; html?: string };
type Mail = { to: string; subject: string; body: string; from: string };
const T0 = 1_800_000_000;

/** PHP と同じ形の、開いた時刻の印 */
const token = (issued: number, secret = SECRET) => `${issued}.${createHmac("sha256", secret).update(`contact-form|${issued}`).digest("hex").slice(0, 32)}`;

let serial = 0;
/** 受け付けられる入力。本文は毎回違う（同じ本文は止まるため） */
const ok = (post: Record<string, unknown> = {}, now = T0) => ({
  kind: "question",
  body: `架空の質問です。画面の使い方を教えてください（${++serial}）。`,
  email: "",
  [CONTACT_TRAP_FIELD]: "",
  t: token(now - 10),
  ...post,
});
const msgs = (r: Result) => Object.values(r.messages).join("\n");

function run(requests: Req[], cfg: Record<string, unknown> | null = config(), extra: { sendOk?: boolean; render?: boolean } = {}) {
  const full = requests.map((r) => {
    const now = r.now ?? T0;
    return {
      server: {
        REQUEST_METHOD: "POST",
        CONTENT_TYPE: "application/x-www-form-urlencoded",
        HTTP_SEC_FETCH_SITE: "same-origin",
        HTTP_ORIGIN: OFFICIAL_ORIGIN,
        REMOTE_ADDR: "192.0.2.10",
        ...(r.server ?? {}),
      },
      post: r.post ?? ok({}, now),
      now,
      files: r.files ?? [],
    };
  });
  const p = spawnSync(PHP, ["-d", "display_errors=stderr", path.join(work, "harness.php")], { input: JSON.stringify({ requests: full, config: cfg, sendOk: extra.sendOk ?? true, render: extra.render ?? false }), encoding: "utf8" });
  if (p.status !== 0) throw new Error(`PHP が止まりました：${p.stderr}${p.stdout}`);
  if (p.stderr.trim()) throw new Error(`PHP の警告：${p.stderr}`);
  return JSON.parse(p.stdout) as { results: Result[]; sent: Mail[]; kinds: Record<string, string>; limits: number[] };
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "omamori-contact-"));
  mkdirSync(path.join(work, "public_html"));
  writeFileSync(path.join(work, "public_html", CONTACT_SEND_FILE), built);
  writeFileSync(path.join(work, "harness.php"), HARNESS);
});
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});
/** 迷惑防止の記録を、テストごとに空にする */
function freshData(): void {
  dataDir = path.join(work, `data-${Math.random().toString(36).slice(2)}`);
}

describe("ビルドで作る contact-send.php", () => {
  it("フォーム・受け付けた・送れなかったのページと、お問い合わせのヘッダーが差し込まれ、本物の設定やメールアドレスは入らない", () => {
    expect(built).not.toMatch(/@@(PAGES|HEADERS)@@/);
    expect(built.startsWith("<?php\n")).toBe(true);
    expect(built).not.toMatch(/\?>\s*$/);
    expect(built).toContain("受け付けました");
    expect(built).toContain(CONTACT_MESSAGE_MARK);
    expect(built).toContain(CONTACT_ERRORS_MARK);
    expect(built).toContain(CONTACT_TOKEN_FIELD);
    expect(built).not.toMatch(/[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
    // CSP などのヘッダーは .htaccess だけが付ける（PHP の header() でも付けると、2 つになるおそれがある）
    expect(built).not.toMatch(/header\(\s*'(Content-Security-Policy|X-Content-Type-Options|Referrer-Policy|X-Frame-Options|Cache-Control)/);
    // 見えない欄の名前は、自動入力が埋めない意味のない名前
    expect(CONTACT_TRAP_FIELD).not.toMatch(/web|site|url|name|mail|phone|tel|address|company/i);
    expect(built).toContain(`const TRAP_FIELD = '${CONTACT_TRAP_FIELD}';`);
  });

  it("フォームのページは、配る contact.html と 1 バイトも違わない（本番は PHP が返すので、check-live が印のほかを照らす）", () => {
    const files = siteFiles();
    const php = files.get(CONTACT_SEND_FILE)!;
    const page = files.get("contact.html")!;
    expect(php).toContain(page.replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
  });

  it("結果のページは、お問い合わせの CSP で、検索に載せない", () => {
    const pages = renderContactResults(opts);
    for (const html of [pages.done, pages.error]) {
      expect(html).toContain(`content="${escapeHtml(cspForContactMeta)}"`);
      expect(html).toContain('<meta name="robots" content="noindex" />');
      expect(html).toContain('<meta name="referrer" content="same-origin" />');
      expect(html).not.toMatch(/<script\b|<form\b/);
    }
  });

  it("書き置かせない（no-store）", () => {
    expect(contactHeaders["Cache-Control"]).toBe("no-store");
  });
});

describe.skipIf(!hasPhp)("contact-send.php を PHP で動かす", () => {
  it("PHP の文法が正しい（php -l）", () => {
    for (const f of [path.join(work, "public_html", CONTACT_SEND_FILE), path.resolve("server/contact-config.sample.php"), path.resolve("server/contact-send.php")]) {
      const p = spawnSync(PHP, ["-l", f], { encoding: "utf8" });
      expect(p.status, p.stdout + p.stderr).toBe(0);
    }
  });

  it("種類と、字数・URL の上限が、画面（pages.ts）と同じ", () => {
    freshData();
    const r = run([]);
    expect(r.kinds).toEqual(Object.fromEntries(CONTACT_KINDS.map((k) => [k.value, k.label])));
    expect(r.limits).toEqual([CONTACT_BODY_MIN, CONTACT_BODY_MAX, CONTACT_EMAIL_MAX, CONTACT_URL_MAX]);
  });

  it("受け付けると、運営者へのメールを 1 通送る。ヘッダーは設定と決まった字だけで、入力は本文にだけ入る", () => {
    freshData();
    const r = run([{ post: ok({ kind: "bug", body: "架空の不具合です。\r\n2 行目もあります。", email: "reply@example.invalid" }) }]);
    expect(r.results[0]).toMatchObject({ status: 200, page: "done" });
    expect(r.sent).toHaveLength(1);
    const m = r.sent[0]!;
    expect(m.to).toBe("owner@example.invalid");
    expect(m.from).toBe("form@example.invalid");
    expect(m.subject).toBe("[お守りPDF] お問い合わせ（不具合）");
    expect(m.body).toContain("返事の宛先：reply@example.invalid");
    expect(m.body).toContain("架空の不具合です。\n2 行目もあります。");
    expect(m.body).toMatch(/受け付けた時刻：\d{4}-\d\d-\d\d \d\d:\d\d:\d\d（日本の時刻）/);
    expect(m.body).not.toContain("192.0.2.10");
  });

  describe("攻撃の形ごと", () => {
    it("ヘッダー注入：メールアドレス・種類に改行を入れても受け付けず、件名は決まった字のまま", () => {
      freshData();
      const r = run([
        { post: ok({ email: "a@example.invalid\r\nBcc: b@example.invalid" }) },
        { post: ok({ email: "a@example.invalid\nX: y" }), server: { REMOTE_ADDR: "192.0.2.11" } },
        { post: ok({ kind: "question\r\nBcc: b@example.invalid" }), server: { REMOTE_ADDR: "192.0.2.12" } },
      ]);
      expect(r.results.map((x) => x.status)).toEqual([400, 400, 400]);
      expect(r.sent).toHaveLength(0);
    });

    it("入力を戻すときの HTML：本文・メールアドレスに書いたタグは、字としてエスケープして戻す", () => {
      freshData();
      const evilBody = '</textarea><script>alert(1)</script>"\'&';
      const evilMail = '"><img src=x onerror=alert(1)>';
      const r = run([{ post: ok({ body: evilBody, email: evilMail }) }], config(), { render: true });
      const html = r.results[0]!.html!;
      expect(r.results[0]).toMatchObject({ status: 400, page: "form" });
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#039;&amp;</textarea>");
      expect(html).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
      // textarea はページに 1 つだけ（中身で閉じられていない）
      expect(html.match(/<\/textarea>/g)).toHaveLength(1);
      expect(r.sent).toHaveLength(0);
    });

    it("CSRF：ほかのサイト・送り元の分からない送信は 403", () => {
      freshData();
      const cases: Array<Record<string, string>> = [{ HTTP_SEC_FETCH_SITE: "cross-site" }, { HTTP_SEC_FETCH_SITE: "same-site" }, { HTTP_ORIGIN: "https://evil.example.invalid" }, { HTTP_ORIGIN: "null" }];
      const r = run(cases.map((server, i) => ({ server: { ...server, REMOTE_ADDR: `192.0.2.${20 + i}` } })));
      expect(r.results.map((x) => x.status)).toEqual([403, 403, 403, 403]);
      expect(single({ HTTP_SEC_FETCH_SITE: undefined, HTTP_ORIGIN: undefined }).status).toBe(403);
      // Sec-Fetch-Site を付けない古いブラウザでも、Origin が公式のサイトなら受け付ける
      expect(single({ HTTP_SEC_FETCH_SITE: undefined }).status).toBe(200);
      expect(r.sent).toHaveLength(0);
    });

    it("送り方：POST・GET・HEAD 以外は 405。フォームの送り方でないもの・ファイルつきは 400。大きすぎるものは 413", () => {
      freshData();
      const r = run([
        { server: { REQUEST_METHOD: "PUT" } },
        { server: { REQUEST_METHOD: "DELETE" } },
        { server: { CONTENT_TYPE: "application/json" } },
        { server: { CONTENT_TYPE: "multipart/form-data; boundary=x" } },
        { files: { f: { name: "a.pdf" } } },
        { server: { CONTENT_LENGTH: String(65_537) } },
      ]);
      expect(r.results.map((x) => x.status)).toEqual([405, 405, 400, 400, 400, 413]);
      expect(r.results[0]!.headers).toEqual(["Allow: GET, HEAD, POST"]);
      expect(r.sent).toHaveLength(0);
    });

    it("開いたとき（GET）は、署名した時刻の印つきのフォームを返す。設定がなければ印は空", () => {
      freshData();
      const r = run([{ server: { REQUEST_METHOD: "GET" } }], config(), { render: true });
      expect(r.results[0]).toMatchObject({ status: 200, page: "form", token: token(T0) });
      expect(r.results[0]!.html).toContain(`name="t" value="${token(T0)}"`);
      expect(r.results[0]!.html).not.toContain("contact-errors");
      expect(run([{ server: { REQUEST_METHOD: "GET" } }], null).results[0]!.token).toBe("");
    });

    it("時刻の印：ない・偽物・別の鍵・早すぎる（4 秒より前）・古すぎる（2 時間より後）は送らず、書いた中身つきでフォームを返す", () => {
      freshData();
      const cases: Array<[unknown, string]> = [
        [undefined, "確かめられませんでした"],
        ["", "確かめられませんでした"],
        [`${T0 - 10}.${"0".repeat(32)}`, "確かめられませんでした"],
        [token(T0 - 10, "y".repeat(40)), "確かめられませんでした"],
        [["x"], "確かめられませんでした"],
        [token(T0 - 3), "早すぎました"],
        [token(T0 + 100), "早すぎました"],
        [token(T0 - 7201), "時間がたちました"],
      ];
      const r = run(cases.map(([t], i) => ({ post: { ...ok(), t }, server: { REMOTE_ADDR: `192.0.2.${30 + i}` } })));
      r.results.forEach((x, i) => {
        expect(x, String(cases[i]![0])).toMatchObject({ status: 400, page: "form" });
        expect(msgs(x)).toContain(cases[i]![1]);
        expect(x.values.body).toContain("架空の質問です");
        // 新しい印を入れ直す（もう一度押せば送れる）
        expect(x.token).toBe(token(T0));
      });
      expect(r.sent).toHaveLength(0);
      // ちょうど 4 秒・ちょうど 2 時間は受け付ける
      const edge = run([{ post: { ...ok(), t: token(T0 - 4) } }, { post: { ...ok(), t: token(T0 - 7200) }, server: { REMOTE_ADDR: "192.0.2.49" } }]);
      expect(edge.results.map((x) => x.status)).toEqual([200, 200]);
    });

    it("人には見えない欄が埋まっていたら、送ったふりをして、メールは出さない（続けての数には入れる）", () => {
      freshData();
      const r = run([{ post: ok({ [CONTACT_TRAP_FIELD]: "https://spam.example.invalid" }) }, { post: ok({ [CONTACT_TRAP_FIELD]: ["x"] }), server: { REMOTE_ADDR: "192.0.2.30" } }, { now: T0 + 10 }]);
      expect(r.results.map((x) => [x.status, x.page])).toEqual([
        [200, "done"],
        [200, "done"],
        [429, "error"],
      ]);
      expect(r.sent).toHaveLength(0);
    });

    it("記録の大きさ：記録が多すぎても、種類ごとに上限（1000 件）までに縮める。壊れた記録は読み飛ばす", () => {
      freshData();
      mkdirSync(dataDir, { recursive: true });
      const many = Array.from({ length: 5000 }, (_, i) => [i.toString(16).padStart(32, "0"), T0 - 100 + (i % 50)]);
      writeFileSync(path.join(dataDir, "rate.json"), JSON.stringify({ c: [], b: [...many, ["short", T0], "x", [1, 2]] }));
      run([{}]);
      const saved = JSON.parse(readFileSync(path.join(dataDir, "rate.json"), "utf8")) as { c: unknown[]; b: unknown[] };
      expect(saved.b.length).toBeLessThanOrEqual(1000);
      expect(saved.c).toHaveLength(1);
      writeFileSync(path.join(dataDir, "rate.json"), "{not json");
      expect(run([{ server: { REMOTE_ADDR: "192.0.2.77" } }]).results[0]!.status).toBe(200);
    });

    it("エラーのときに、設定・ファイルの場所・記録の置き場を画面に出さない", () => {
      freshData();
      const file = path.join(work, "not-a-dir");
      writeFileSync(file, "");
      const results = [
        ...run([{}], null).results,
        ...run([{}], { ...config(), secret: "short" }).results,
        ...run([{}], { ...config(), data_dir: file }).results,
        ...run([{}], config(), { sendOk: false }).results,
      ];
      expect(results.map((x) => x.status)).toEqual([503, 503, 503, 503]);
      for (const x of results) expect(msgs(x)).not.toMatch(/contact-config|secret|data_dir|rate\.json|[A-Za-z]:\\|\/tmp|\.php/);
    });
  });

  describe("入力の確かめ", () => {
    it("誤りは 400 で、どの欄をどう直すかを、欄ごとに出す（いくつあっても全部）", () => {
      freshData();
      const cases: Array<[Record<string, unknown>, string, string]> = [
        [{ kind: "" }, "kind", "種類：4 つの中から 1 つ選んでください"],
        [{ kind: "spam" }, "kind", "種類："],
        [{ kind: ["question"] }, "kind", "種類："],
        [{ body: "  \n " }, "body", `本文：${CONTACT_BODY_MIN} 字以上`],
        [{ body: "短すぎる本文" }, "body", "いまは 6 字です"],
        [{ body: ["x"] }, "body", "本文：読めない字"],
        [{ body: "あ".repeat(CONTACT_BODY_MAX + 1) }, "body", `本文：${CONTACT_BODY_MAX} 字まで`],
        [{ body: "見てください https://a.example.invalid と http://b.example.invalid と www.c.example.invalid" }, "body", "URL は 2 つまで"],
        [{ body: "全角でも数える ｈｔｔｐｓ：／／ａ と https://b と http://c です" }, "body", "いまは 3 つです"],
        [{ email: "not-an-address" }, "email", "メールアドレス：形が正しくありません"],
        [{ email: `${"a".repeat(250)}@example.invalid` }, "email", "メールアドレス：形"],
        [{ email: ["a@example.invalid"] }, "email", "メールアドレス：形"],
        [{ kind: "security", email: "" }, "email", "セキュリティの弱点のときは"],
      ];
      const r = run(cases.map(([post], i) => ({ post: ok(post), server: { REMOTE_ADDR: `192.0.2.${100 + i}` } })));
      r.results.forEach((x, i) => {
        const [, field, text] = cases[i]!;
        expect(x.status, text).toBe(400);
        expect(x.page).toBe("form");
        expect((x.messages as Record<string, string>)[field], text).toContain(text);
      });
      // 誤りが 3 つあれば、3 つとも出す
      const all = run([{ post: ok({ kind: "x", body: "短い", email: "bad" }) }]).results[0]!;
      expect(Object.keys(all.messages).sort()).toEqual(["body", "email", "kind"]);
      expect(r.sent).toHaveLength(0);
    });

    it("ちょうど上限の字数・URL 2 つまでは受け付け、制御の字と、見えない字を除く", () => {
      freshData();
      const r = run([
        { post: ok({ body: "あ".repeat(CONTACT_BODY_MAX) }) },
        { post: ok({ body: "参考 https://a.example.invalid と https://b.example.invalid です" }), server: { REMOTE_ADDR: "192.0.2.51" } },
        { post: ok({ kind: "security", email: "reply@example.invalid", body: "a\u0000b\u202Ec\u2066d\u0007e\u200Bf\u0085g\tここまで十字以上" }), server: { REMOTE_ADDR: "192.0.2.50" } },
      ]);
      expect(r.results.map((x) => x.status)).toEqual([200, 200, 200]);
      expect(r.sent[2]!.body).toContain("abcdefg\tここまで十字以上");
      expect(r.sent[2]!.subject).toBe("[お守りPDF] お問い合わせ（セキュリティの弱点）");
    });

    it("送れなかったとき、フォームを、書いた中身・選んだ種類・誤りの一覧・誤りのある欄の印つきで返す", () => {
      freshData();
      const r = run([{ post: ok({ kind: "bug", body: "短い", email: "reply@example.invalid" }) }], config(), { render: true });
      const html = r.results[0]!.html!;
      expect(html).toContain('<p class="site-form-warn" role="alert"><a href="#contact-errors">送れませんでした。');
      expect(html).toMatch(/<div class="site-form-warn site-form-errors" id="contact-errors"><p>送れませんでした。次の所を直してから[^<]*<\/p><ul><li>本文：10 字以上書いてください（いまは 2 字です）。<\/li><\/ul><\/div>/);
      expect(html).toContain('value="bug" required checked />');
      expect(html).not.toContain('value="question" required checked');
      expect(html).toMatch(/<textarea id="contact-body" aria-invalid="true"[^>]*>\n短い<\/textarea>/);
      expect(html).toContain('<input id="contact-email" value="reply@example.invalid" name="email"');
      expect(html).not.toMatch(/<input id="contact-email"[^>]*aria-invalid/);
      expect(html).toContain(`name="t" value="${token(T0)}"`);
    });
  });

  describe("続けての送信", () => {
    it("同じ本文は、ほかの接続元からでも、24 時間は続けて送れない（空白・英字の大きさの違いも同じとみなす）", () => {
      freshData();
      const body = "架空の質問です。Same Body を送ります。";
      const r = run([
        { post: ok({ body }) },
        { post: ok({ body: "架空の質問です。 same   body を送ります。" }), server: { REMOTE_ADDR: "192.0.2.61" }, now: T0 + 120 },
        { post: ok({ body }, T0 + 86_401), server: { REMOTE_ADDR: "192.0.2.62" }, now: T0 + 86_401 },
      ]);
      expect(r.results.map((x) => x.status)).toEqual([200, 409, 200]);
      expect(msgs(r.results[1]!)).toContain("同じ本文は、すでに受け付けています");
      expect(r.sent).toHaveLength(2);
    });

    it("同じ接続元から続けて送れない（60 秒に 1 通・1 時間に 5 通）。ほかの接続元は送れる", () => {
      freshData();
      const at = (s: number, ip = "192.0.2.60") => ({ now: T0 + s, post: ok({}, T0 + s), server: { REMOTE_ADDR: ip } });
      const r = run([at(0), at(30), at(0, "192.0.2.61"), at(61), at(122), at(183), at(244), at(305), at(3601)]);
      // 0・61・122・183・244 秒の 5 通で 1 時間の上限。305 秒の 6 通目は止まり、3601 秒には 0 秒の分が 1 時間の外に出る
      expect(r.results.map((x) => x.status)).toEqual([200, 429, 200, 200, 200, 200, 200, 429, 200]);
      expect(r.results[1]!.headers).toEqual(["Retry-After: 60"]);
      expect(msgs(r.results[1]!)).toContain("続けて送ることはできません");
    });

    it("IPv6 は前の 64 ビットでまとめる", () => {
      freshData();
      const r = run([
        { server: { REMOTE_ADDR: "2001:db8:1:2::1" } },
        { server: { REMOTE_ADDR: "2001:db8:1:2::ffff" }, now: T0 + 10, post: ok({}, T0 + 10) },
        { server: { REMOTE_ADDR: "2001:db8:1:3::1" }, now: T0 + 10, post: ok({}, T0 + 10) },
      ]);
      expect(r.results.map((x) => x.status)).toEqual([200, 429, 200]);
    });

    it("IPv4 が IPv6 の形（::ffff:…）で来ても、IPv4 ごとに分ける（全員が同じ鍵にならない）", () => {
      freshData();
      const r = run([
        { server: { REMOTE_ADDR: "::ffff:192.0.2.1" } },
        { server: { REMOTE_ADDR: "::ffff:192.0.2.2" }, now: T0 + 10, post: ok({}, T0 + 10) },
        { server: { REMOTE_ADDR: "192.0.2.1" }, now: T0 + 20, post: ok({}, T0 + 20) },
      ]);
      // 1 つ目と 2 つ目は別の接続元。3 つ目は 1 つ目と同じ接続元（同じ IPv4）なので止まる
      expect(r.results.map((x) => x.status)).toEqual([200, 200, 429]);
    });

    it("1 日の上限（ふつうは 50 通）は、実際に送れた分だけを数える。上限のとき Retry-After は、いちばん古い分が 24 時間の外に出るまで", () => {
      freshData();
      const reqs: Req[] = Array.from({ length: 51 }, (_, i) => ({ now: T0 + i, post: ok({}, T0 + i), server: { REMOTE_ADDR: `198.51.100.${i}` } }));
      reqs.push({ now: T0 + 86_400 + 1, post: ok({}, T0 + 86_401), server: { REMOTE_ADDR: "198.51.100.200" } });
      const r = run(reqs);
      expect(r.results.slice(0, 50).every((x) => x.status === 200)).toBe(true);
      expect(r.results[50]).toMatchObject({ status: 429 });
      expect(msgs(r.results[50]!)).toContain("明日以降");
      // T0 の分が外に出るのは T0 + 86400。いまは T0 + 50 なので、86350 秒
      expect(r.results[50]!.headers).toEqual(["Retry-After: 86350"]);
      expect(r.results[51]!.status).toBe(200);
      // 51 通のうち、1 通は上限の知らせ（中身を入れない）
      expect(r.sent.filter((m) => m.subject.includes("上限に達しました"))).toHaveLength(1);
      expect(r.sent.filter((m) => m.subject.startsWith("[お守りPDF] お問い合わせ（"))).toHaveLength(51);
    });

    it("上限の知らせは、24 時間に 1 通だけ", () => {
      freshData();
      const reqs: Req[] = Array.from({ length: 53 }, (_, i) => ({ now: T0 + i, post: ok({}, T0 + i), server: { REMOTE_ADDR: `198.51.100.${i}` } }));
      const r = run(reqs);
      expect(r.results.slice(50).map((x) => x.status)).toEqual([429, 429, 429]);
      expect(r.sent.filter((m) => m.subject.includes("上限に達しました"))).toHaveLength(1);
      expect(r.sent.find((m) => m.subject.includes("上限"))!.body).not.toContain("架空");
    });

    it("ボットの送信（見えない欄）・URL が多すぎる・同じ本文・印のない送信は、1 日の上限に数えない", () => {
      freshData();
      const noise: Req[] = Array.from({ length: 60 }, (_, i) => {
        const server = { REMOTE_ADDR: `198.51.100.${i}` };
        const now = T0 + i;
        if (i % 4 === 0) return { now, server, post: ok({ [CONTACT_TRAP_FIELD]: "x" }, now) };
        if (i % 4 === 1) return { now, server, post: ok({ body: "https://a と https://b と https://c を見て" }, now) };
        if (i % 4 === 2) return { now, server, post: { ...ok({}, now), t: "" } };
        return { now, server, post: ok({ body: "同じ架空の本文です。十字以上。" }, now) };
      });
      const r = run([...noise, { now: T0 + 100, post: ok({}, T0 + 100), server: { REMOTE_ADDR: "203.0.113.99" } }]);
      // 同じ本文は最初の 1 通だけ送れる。あとは 409。最後の正しい送信は、上限に止められない
      expect(r.results.at(-1)!.status).toBe(200);
      expect(r.sent.filter((m) => m.subject.includes("上限"))).toHaveLength(0);
      expect(r.sent).toHaveLength(2);
    });

    it("「セキュリティの弱点」は別の枠（ふつうの上限に達していても、届く）", () => {
      freshData();
      const reqs: Req[] = Array.from({ length: 50 }, (_, i) => ({ now: T0 + i, post: ok({}, T0 + i), server: { REMOTE_ADDR: `198.51.100.${i}` } }));
      reqs.push({ now: T0 + 60, post: ok({}, T0 + 60), server: { REMOTE_ADDR: "203.0.113.1" } });
      reqs.push({ now: T0 + 61, post: ok({ kind: "security", email: "reply@example.invalid" }, T0 + 61), server: { REMOTE_ADDR: "203.0.113.2" } });
      const r = run(reqs);
      expect(r.results.at(-2)!.status).toBe(429);
      expect(r.results.at(-1)!.status).toBe(200);
      expect(r.sent.at(-1)!.subject).toBe("[お守りPDF] お問い合わせ（セキュリティの弱点）");
    });

    it("メールを送れなかった送信は、1 日の上限にも、同じ本文にも数えない（その接続元の続けての数には入る）", () => {
      freshData();
      const body = "送れなかった架空の本文です。";
      const failed = run([{ post: ok({ body }) }], config(), { sendOk: false });
      expect(failed.results[0]!.status).toBe(503);
      const saved = JSON.parse(readFileSync(path.join(dataDir, "rate.json"), "utf8")) as Record<string, unknown[]>;
      expect(saved.s).toHaveLength(0);
      expect(saved.b).toHaveLength(0);
      expect(saved.c).toHaveLength(1);
      // ほかの接続元から同じ本文を送り直せる
      expect(run([{ post: ok({ body }), server: { REMOTE_ADDR: "192.0.2.200" } }]).results[0]!.status).toBe(200);
    });

    it("記録には、IP アドレスも本文もそのまま残さず、24 時間より古いものを消す", () => {
      freshData();
      run([{ server: { REMOTE_ADDR: "203.0.113.7" } }, { now: T0 + 86_401, post: ok({ body: "二通目の架空の質問の本文です。" }, T0 + 86_401), server: { REMOTE_ADDR: "203.0.113.8" } }]);
      const raw = readFileSync(path.join(dataDir, "rate.json"), "utf8");
      expect(raw).not.toContain("203.0.113");
      expect(raw).not.toContain("架空");
      const saved = JSON.parse(raw) as { c: Array<[string, number]>; b: Array<[string, number]> };
      expect(saved.c).toHaveLength(1);
      expect(saved.b).toHaveLength(1);
      expect(saved.c[0]![0]).toMatch(/^[0-9a-f]{32}$/);
      expect(saved.c[0]![1]).toBe(T0 + 86_401);
    });
  });

  it("本物の入口（php -S）：開くとフォームと印、送ると「受け付けました」。ヘッダーはお問い合わせの決まり。設定が壊れていても中身を出さない", async () => {
    freshData();
    const site = path.join(work, "site");
    mkdirSync(path.join(site, "public_html"), { recursive: true });
    writeFileSync(path.join(site, "public_html", CONTACT_SEND_FILE), built);
    const cfg = path.join(site, "contact-config.php");
    const good = `<?php return ['to' => 'owner@example.invalid', 'from' => 'form@example.invalid', 'secret' => '${SECRET}', 'data_dir' => __DIR__ . '/contact-data', 'origin' => '${OFFICIAL_ORIGIN}', 'send' => function ($to, $s, $b, $f) { file_put_contents(__DIR__ . '/sent.log', $s . "\\n" . $b); return true; }];`;
    writeFileSync(cfg, good);
    const port = await freePort();
    const server = spawn(PHP, ["-S", `127.0.0.1:${port}`, "-t", path.join(site, "public_html")], { stdio: "ignore" });
    try {
      const url = `http://127.0.0.1:${port}/${CONTACT_SEND_FILE}`;
      let get: Response | null = null;
      for (let i = 0; i < 50 && !get; i++) {
        get = await fetch(url).catch(() => null);
        if (!get) await new Promise((r) => setTimeout(r, 100));
      }
      expect(get!.status).toBe(200);
      const form = await get!.text();
      const t = form.match(/name="t" value="(\d+\.[0-9a-f]{32})"/)?.[1];
      expect(t).toBeDefined();
      // php -S には .htaccess がない。PHP は CSP などを付けない（本番では .htaccess が 1 つずつ付ける。check-live が確かめる）。版も名乗らない
      for (const k of Object.keys(contactHeaders)) expect(get!.headers.get(k), k).toBeNull();
      expect(get!.headers.get("x-powered-by")).toBeNull();
      expect(get!.headers.get("content-type")).toBe("text/html; charset=UTF-8");

      // 印は 4 秒より前のものなので、時刻を戻した印を自分で作って送る（鍵は手元の設定と同じ）
      const issued = Math.floor(Date.now() / 1000) - 10;
      const body = new URLSearchParams({ kind: "other", body: "<b>架空の本文です。十字以上。</b>", email: "", [CONTACT_TRAP_FIELD]: "", t: token(issued) });
      const headers = { Origin: OFFICIAL_ORIGIN, "Sec-Fetch-Site": "same-origin" };
      const post = await fetch(url, { method: "POST", body, headers });
      expect(post.status).toBe(200);
      expect(await post.text()).toContain("<h1>受け付けました</h1>");
      expect(readFileSync(path.join(site, "sent.log"), "utf8")).toContain("<b>架空の本文です。十字以上。</b>");

      // 開いた直後の印（早すぎる）は、送らずにフォームを返す
      const fast = await fetch(url, { method: "POST", body: new URLSearchParams({ kind: "other", body: "別の架空の本文です。十字以上。", email: "", [CONTACT_TRAP_FIELD]: "", t: t! }), headers });
      expect(fast.status).toBe(400);
      expect(await fast.text()).toContain("送るのが早すぎました");

      // 設定のファイルが壊れていても、ファイルの場所や中身を出さない
      writeFileSync(cfg, "<?php return [ 'to' => ;");
      const broken = await fetch(url, { method: "POST", body, headers });
      const text = await broken.text();
      expect(broken.status).toBe(503);
      expect(text).toContain("いまは、お問い合わせを受け付けられません");
      expect(text).not.toMatch(/contact-config|Parse error|syntax error|\.php on line|[A-Za-z]:\\/i);
    } finally {
      server.kill();
    }
  }, 30_000);
});

/** Sec-Fetch-Site・Origin を消した 1 回だけの送信（undefined の鍵は送らない） */
function single(drop: Record<string, string | undefined>): Result {
  freshData();
  const server: Record<string, string> = { REQUEST_METHOD: "POST", CONTENT_TYPE: "application/x-www-form-urlencoded", HTTP_SEC_FETCH_SITE: "same-origin", HTTP_ORIGIN: OFFICIAL_ORIGIN, REMOTE_ADDR: "192.0.2.99" };
  for (const [k, v] of Object.entries(drop)) {
    if (v === undefined) delete server[k];
    else server[k] = v;
  }
  const p = spawnSync(PHP, [path.join(work, "harness.php")], { input: JSON.stringify({ requests: [{ server, post: ok(), now: T0 }], config: config() }), encoding: "utf8" });
  return JSON.parse(p.stdout).results[0];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? resolve(a.port) : reject(new Error("空いた番号がありません"))));
    });
  });
}
