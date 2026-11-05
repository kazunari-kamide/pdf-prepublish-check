// SPDX-License-Identifier: AGPL-3.0-only
//
// お問い合わせの送り先（ビルドで作る dist/contact-send.php。もとは server/contact-send.php）を、手元の PHP で動かして確かめる（docs/contact.md）。
// - メールは送らない。設定の send で受け取り、宛先・件名・送信元・本文を見る
// - PHP がない環境では、このファイルのテストを省いたと表示する。PHP の場所は、環境変数 PHP_BIN で渡せる

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactHeaders, cspForContactMeta, cspForMeta } from "../csp.ts";
import { CONTACT_SEND_FILE, OFFICIAL_ORIGIN } from "../htaccess.ts";
import { contactSendPhp } from "../site.ts";
import { CONTACT_BODY_MAX, CONTACT_EMAIL_MAX, CONTACT_KINDS, CONTACT_MESSAGE_MARK, renderContactResults } from "../src/site/pages.ts";
import { escapeHtml } from "../src/site/render.ts";

const PHP = process.env.PHP_BIN ?? "php";
const hasPhp = spawnSync(PHP, ["-r", "echo function_exists('mb_send_mail') ? 'ok' : 'no-mb';"], { encoding: "utf8" }).stdout === "ok";
if (!hasPhp) console.warn(`[contact-php] PHP（mbstring つき）が見つからないため、PHP を動かすテストを省きました（PHP_BIN=${PHP}）`);

const opts = { origin: OFFICIAL_ORIGIN, csp: cspForMeta, cssHref: "/assets/site.css" };
const built = contactSendPhp(renderContactResults(opts));

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
    $result = contact_handle($r['server'], $r['post'], $config, $r['now']);
    $out[] = $result;
}
echo json_encode(['results' => $out, 'sent' => $sent, 'kinds' => KINDS, 'limits' => [BODY_MAX_CHARS, EMAIL_MAX_CHARS]], JSON_UNESCAPED_UNICODE);
`;

let work = "";
let dataDir = "";
const SECRET = "x".repeat(40);
const config = () => ({ to: "owner@example.invalid", from: "form@example.invalid", secret: SECRET, data_dir: dataDir, origin: OFFICIAL_ORIGIN });

type Req = { server?: Record<string, string>; post?: Record<string, unknown>; now?: number };
type Result = { status: number; page: string; message: string; headers: string[] };
type Mail = { to: string; subject: string; body: string; from: string };
const T0 = 1_800_000_000;

function run(requests: Req[], cfg: Record<string, unknown> | null = config(), sendOk = true): { results: Result[]; sent: Mail[]; kinds: Record<string, string>; limits: number[] } {
  const full = requests.map((r) => ({
    server: { REQUEST_METHOD: "POST", HTTP_SEC_FETCH_SITE: "same-origin", HTTP_ORIGIN: OFFICIAL_ORIGIN, REMOTE_ADDR: "192.0.2.10", ...(r.server ?? {}) },
    post: r.post ?? { kind: "question", body: "架空の質問です。", email: "", website: "" },
    now: r.now ?? T0,
  }));
  // 標準入力の JSON では、空の連想配列が PHP の配列になるよう、そのまま渡す
  const p = spawnSync(PHP, ["-d", "display_errors=stderr", path.join(work, "harness.php")], { input: JSON.stringify({ requests: full, config: cfg, sendOk }), encoding: "utf8" });
  if (p.status !== 0) throw new Error(`PHP が止まりました：${p.stderr}${p.stdout}`);
  if (p.stderr.trim()) throw new Error(`PHP の警告：${p.stderr}`);
  return JSON.parse(p.stdout);
}
const ok = (post: Record<string, unknown> = {}) => ({ kind: "question", body: "架空の質問です。", email: "", website: "", ...post });

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
  it("結果のページ（受け付けた・送れなかった）と、お問い合わせのヘッダーが差し込まれ、本物の設定やメールアドレスは入らない", () => {
    expect(built).not.toMatch(/@@(PAGES|HEADERS)@@/);
    expect(built.startsWith("<?php\n")).toBe(true);
    expect(built).not.toMatch(/\?>\s*$/);
    expect(built).toContain("受け付けました");
    expect(built).toContain(CONTACT_MESSAGE_MARK);
    expect(built).toContain(contactHeaders["Content-Security-Policy"]!.replace(/'/g, "\\'"));
    expect(built).not.toMatch(/[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
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
});

describe.skipIf(!hasPhp)("contact-send.php を PHP で動かす", () => {
  it("PHP の文法が正しい（php -l）", () => {
    const p = spawnSync(PHP, ["-l", path.join(work, "public_html", CONTACT_SEND_FILE)], { encoding: "utf8" });
    expect(p.status, p.stdout + p.stderr).toBe(0);
    const s = spawnSync(PHP, ["-l", path.resolve("server/contact-config.sample.php")], { encoding: "utf8" });
    expect(s.status, s.stdout + s.stderr).toBe(0);
  });

  it("種類と長さの上限が、フォーム（pages.ts）と同じ", () => {
    freshData();
    const r = run([]);
    expect(r.kinds).toEqual(Object.fromEntries(CONTACT_KINDS.map((k) => [k.value, k.label])));
    expect(r.limits).toEqual([CONTACT_BODY_MAX, CONTACT_EMAIL_MAX]);
  });

  it("受け付けると、運営者へのメールを 1 通送る。ヘッダーは設定と決まった字だけで、入力は本文にだけ入る", () => {
    freshData();
    const r = run([{ post: ok({ kind: "bug", body: "架空の不具合\r\n2 行目", email: "reply@example.invalid" }) }]);
    expect(r.results[0]).toMatchObject({ status: 200, page: "done" });
    expect(r.sent).toHaveLength(1);
    const m = r.sent[0]!;
    expect(m.to).toBe("owner@example.invalid");
    expect(m.from).toBe("form@example.invalid");
    expect(m.subject).toBe("[お守りPDF] お問い合わせ（不具合）");
    expect(m.body).toContain("種類：不具合");
    expect(m.body).toContain("返事の宛先：reply@example.invalid");
    expect(m.body).toContain("架空の不具合\n2 行目");
    expect(m.body).toMatch(/受け付けた時刻：\d{4}-\d\d-\d\d \d\d:\d\d:\d\d（日本の時刻）/);
    expect(m.body).toContain("90 日");
    expect(m.body).not.toContain("192.0.2.10");
  });

  it("メールのヘッダーに割り込もうとする入力は、受け付けない", () => {
    freshData();
    const r = run([
      { post: ok({ email: "a@example.invalid\r\nBcc: b@example.invalid" }) },
      { post: ok({ email: "a@example.invalid\nX: y" }), server: { REMOTE_ADDR: "192.0.2.11" } },
    ]);
    expect(r.results.map((x) => x.status)).toEqual([400, 400]);
    expect(r.sent).toHaveLength(0);
  });

  it("POST でなければ 405（Allow: POST）", () => {
    freshData();
    const r = run([{ server: { REQUEST_METHOD: "GET" } }]);
    expect(r.results[0]).toMatchObject({ status: 405, page: "error", headers: ["Allow: POST"] });
  });

  it("設定がない・形が違うときは 503 で、メールを出さない", () => {
    freshData();
    expect(run([{}], null).results[0]!.status).toBe(503);
    for (const bad of [{ secret: "short" }, { to: "a@example.invalid\r\nBcc: b@example.invalid" }, { from: "" }, { data_dir: "" }, { origin: "http://x" }]) {
      const r = run([{}], { ...config(), ...bad });
      expect(r.results[0]!.status, JSON.stringify(bad)).toBe(503);
      expect(r.sent).toHaveLength(0);
    }
  });

  it("ほかのサイトから送られたときは 403（CSRF の対策）", () => {
    freshData();
    const cases: Array<Record<string, string>> = [
      { HTTP_SEC_FETCH_SITE: "cross-site" },
      { HTTP_SEC_FETCH_SITE: "same-site" },
      { HTTP_ORIGIN: "https://evil.example.invalid" },
      { HTTP_ORIGIN: "null" },
    ];
    const r = run(cases.map((server, i) => ({ server: { ...server, REMOTE_ADDR: `192.0.2.${20 + i}` } })));
    expect(r.results.map((x) => x.status)).toEqual([403, 403, 403, 403]);
    // Sec-Fetch-Site も Origin もない（古いブラウザ・道具）ときも止める
    const none = spawnLike({ HTTP_SEC_FETCH_SITE: undefined, HTTP_ORIGIN: undefined });
    expect(none.status).toBe(403);
    // Sec-Fetch-Site がない古いブラウザでも、Origin が公式のサイトなら受け付ける
    const old = spawnLike({ HTTP_SEC_FETCH_SITE: undefined });
    expect(old.status).toBe(200);
    expect(r.sent).toHaveLength(0);
  });

  it("人には見えない欄が埋まっていたら、送ったふりをして、メールは出さない", () => {
    freshData();
    const r = run([{ post: ok({ website: "https://spam.example.invalid" }) }, { post: { website: ["x"] }, server: { REMOTE_ADDR: "192.0.2.30" } }]);
    expect(r.results.map((x) => [x.status, x.page])).toEqual([
      [200, "done"],
      [200, "done"],
    ]);
    expect(r.sent).toHaveLength(0);
  });

  it("入力の誤りは 400 で、理由を出す", () => {
    freshData();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: "" }, "種類を選んでください"],
      [{ kind: "spam" }, "種類を選んでください"],
      [{ kind: ["question"] }, "種類を選んでください"],
      [{ body: "  \n " }, "本文を書いてください"],
      [{ body: ["x"] }, "本文を書いてください"],
      [{ body: "あ".repeat(CONTACT_BODY_MAX + 1) }, `${CONTACT_BODY_MAX} 字まで`],
      [{ email: "not-an-address" }, "メールアドレスの形"],
      [{ email: `${"a".repeat(250)}@example.invalid` }, "メールアドレスの形"],
      [{ kind: "security", email: "" }, "メールアドレスを書いてください"],
    ];
    const r = run(cases.map(([post], i) => ({ post: ok(post), server: { REMOTE_ADDR: `192.0.2.${40 + i}` } })));
    r.results.forEach((x, i) => {
      expect(x.status, cases[i]![1]).toBe(400);
      expect(x.message).toContain(cases[i]![1]);
    });
    expect(r.sent).toHaveLength(0);
  });

  it("本文はちょうど上限の字数まで受け付け、制御の字と、字の向きを変える見えない字を除く", () => {
    freshData();
    const r = run([
      { post: ok({ body: "あ".repeat(CONTACT_BODY_MAX) }) },
      { post: ok({ kind: "security", email: "reply@example.invalid", body: "a\u0000b\u202Ec\u2066d\u0007e\tf" }), server: { REMOTE_ADDR: "192.0.2.50" } },
    ]);
    expect(r.results.map((x) => x.status)).toEqual([200, 200]);
    expect(r.sent[1]!.body).toContain("abcde\tf");
    expect(r.sent[1]!.subject).toBe("[お守りPDF] お問い合わせ（セキュリティの弱点）");
  });

  it("同じ接続元から続けて送れない（60 秒に 1 通・1 時間に 5 通）。ほかの接続元は送れる", () => {
    freshData();
    const at = (s: number, ip = "192.0.2.60") => ({ now: T0 + s, server: { REMOTE_ADDR: ip } });
    const r = run([at(0), at(30), at(0, "192.0.2.61"), at(61), at(122), at(183), at(244), at(305), at(3601)]);
    // 0・61・122・183・244 秒の 5 通で 1 時間の上限。305 秒の 6 通目は止まり、3601 秒には 0 秒の分が 1 時間の外に出る
    expect(r.results.map((x) => x.status)).toEqual([200, 429, 200, 200, 200, 200, 200, 429, 200]);
    expect(r.results[1]!.headers).toEqual(["Retry-After: 60"]);
    expect(r.results[1]!.message).toContain("続けて送ることはできません");
  });

  it("IPv6 は前の 64 ビットでまとめる", () => {
    freshData();
    const r = run([{ server: { REMOTE_ADDR: "2001:db8:1:2::1" } }, { server: { REMOTE_ADDR: "2001:db8:1:2::ffff" }, now: T0 + 10 }, { server: { REMOTE_ADDR: "2001:db8:1:3::1" }, now: T0 + 10 }]);
    expect(r.results.map((x) => x.status)).toEqual([200, 429, 200]);
  });

  it("サイト全体で 24 時間に 50 通まで", () => {
    freshData();
    const reqs = Array.from({ length: 51 }, (_, i) => ({ now: T0 + i, server: { REMOTE_ADDR: `198.51.100.${i}` } }));
    reqs.push({ now: T0 + 86_400 + 1, server: { REMOTE_ADDR: "198.51.100.200" } });
    const r = run(reqs);
    expect(r.results.slice(0, 50).every((x) => x.status === 200)).toBe(true);
    expect(r.results[50]).toMatchObject({ status: 429 });
    expect(r.results[50]!.message).toContain("明日以降");
    // 24 時間たつと、古い記録は消え、また受け付ける
    expect(r.results[51]!.status).toBe(200);
    expect(r.sent).toHaveLength(51);
  });

  it("迷惑防止の記録には、IP アドレスそのものを残さず、24 時間より古いものを消す", () => {
    freshData();
    run([{ server: { REMOTE_ADDR: "203.0.113.7" } }, { now: T0 + 86_401, server: { REMOTE_ADDR: "203.0.113.8" } }]);
    const raw = readFileSync(path.join(dataDir, "rate.json"), "utf8");
    expect(raw).not.toContain("203.0.113");
    const entries = JSON.parse(raw) as Array<[string, number]>;
    expect(entries).toHaveLength(1);
    expect(entries[0]![0]).toMatch(/^[0-9a-f]{32}$/);
    expect(entries[0]![1]).toBe(T0 + 86_401);
  });

  it("記録を書けないときと、メールを送れないときは 503", () => {
    freshData();
    const file = path.join(work, "not-a-dir");
    writeFileSync(file, "");
    expect(run([{}], { ...config(), data_dir: file }).results[0]!.status).toBe(503);
    const r = run([{}], config(), false);
    expect(r.results[0]).toMatchObject({ status: 503, page: "error" });
    expect(r.results[0]!.message).toContain("メールを送れませんでした");
  });

  it("本物の入口（php -S）：GET は 405、送ると「受け付けました」のページと、お問い合わせのヘッダー。理由は字として入る", async () => {
    freshData();
    const site = path.join(work, "site");
    mkdirSync(path.join(site, "public_html"), { recursive: true });
    writeFileSync(path.join(site, "public_html", CONTACT_SEND_FILE), built);
    const log = path.join(site, "sent.log");
    writeFileSync(
      path.join(site, "contact-config.php"),
      `<?php return ['to' => 'owner@example.invalid', 'from' => 'form@example.invalid', 'secret' => '${SECRET}', 'data_dir' => __DIR__ . '/contact-data', 'origin' => '${OFFICIAL_ORIGIN}', 'send' => function ($to, $s, $b, $f) { file_put_contents(__DIR__ . '/sent.log', $s . "\\n" . $b); return true; }];`,
    );
    const port = await freePort();
    const server = spawn(PHP, ["-S", `127.0.0.1:${port}`, "-t", path.join(site, "public_html")], { stdio: "ignore" });
    try {
      const url = `http://127.0.0.1:${port}/${CONTACT_SEND_FILE}`;
      let get: Response | null = null;
      for (let i = 0; i < 50 && !get; i++) {
        get = await fetch(url).catch(() => null);
        if (!get) await new Promise((r) => setTimeout(r, 100));
      }
      expect(get!.status).toBe(405);
      const getHtml = await get!.text();
      expect(getHtml).toContain("このページは、お問い合わせのページのフォームから送ったときに使います。");
      expect(getHtml).not.toContain(CONTACT_MESSAGE_MARK);
      for (const [k, v] of Object.entries(contactHeaders)) expect(get!.headers.get(k), k).toBe(v);
      expect(get!.headers.get("cache-control")).toBe("no-store");

      const form = new URLSearchParams({ kind: "other", body: "<b>架空の本文</b>", email: "", website: "" });
      const post = await fetch(url, { method: "POST", body: form, headers: { Origin: OFFICIAL_ORIGIN, "Sec-Fetch-Site": "same-origin" } });
      expect(post.status).toBe(200);
      expect(await post.text()).toContain("<h1>受け付けました</h1>");
      expect(readFileSync(log, "utf8")).toContain("<b>架空の本文</b>");

      const again = await fetch(url, { method: "POST", body: form, headers: { Origin: OFFICIAL_ORIGIN, "Sec-Fetch-Site": "same-origin" } });
      expect(again.status).toBe(429);
      expect(again.headers.get("retry-after")).toBe("60");
      expect(await again.text()).toContain("続けて送ることはできません");
    } finally {
      server.kill();
    }
  }, 20_000);
});

/** Sec-Fetch-Site・Origin を消した 1 回だけの送信（undefined の鍵は送らない） */
function spawnLike(drop: Record<string, string | undefined>): Result {
  freshData();
  const server: Record<string, string> = { REQUEST_METHOD: "POST", HTTP_SEC_FETCH_SITE: "same-origin", HTTP_ORIGIN: OFFICIAL_ORIGIN, REMOTE_ADDR: "192.0.2.99" };
  for (const [k, v] of Object.entries(drop)) {
    if (v === undefined) delete server[k];
    else server[k] = v;
  }
  const p = spawnSync(PHP, [path.join(work, "harness.php")], {
    input: JSON.stringify({ requests: [{ server, post: ok(), now: T0 }], config: config() }),
    encoding: "utf8",
  });
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
