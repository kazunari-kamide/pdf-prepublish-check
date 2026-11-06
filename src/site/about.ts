// SPDX-License-Identifier: AGPL-3.0-only
//
// サービスの紹介のページ（LP。/about）。構成は、本人が承認した案（2026-11-05）の区画の順：
// ファーストビュー → 見た目では分からない残り方 → 4 つの手順 → 送らない仕組み → 調べる型 → 良くし続ける仕組み → こんな場面で → よくある質問 → 最後の案内。
// ビルドの時に site.ts が呼ぶ。ブラウザでは動かさない。
// - 枠（CSP・題・説明・canonical・上下の帯）は render.ts の layout を使う。見た目は、このページだけの about.css（サイトの CSS の後に読む）。
// - スクリプトは入れない。動きは about.css の CSS だけ（動きを減らす設定では止める）。
// - 字は、すべて escapeHtml を通す。飾りの絵（紙の束・線の絵）は、このファイルに書いた SVG と CSS だけで描く（外から読み込まない）。
// - 言い方の決まり：件数は「18万件以上」。言い切り（seo.ts の BANNED_WORDS）を使わない。実在の団体名・個人名を出さない。
//   測っていない数字は書かない（文ごと外し、PR に一覧で書く）。使った人の声の区画は、許可のある声がそろうまで出さない。

import { ARTICLES } from "./articles.ts";
import {
  ABOUT_PATH,
  ARTICLES_PATH,
  CHECKLIST_PATH,
  FAQ_PATH,
  INSPECTOR_PATH,
  PRIVACY_PATH,
  articlePath,
  escapeHtml,
  layout,
  type RenderOptions,
} from "./render.ts";
import type { PageMeta } from "./types.ts";

const e = escapeHtml;

export const ABOUT_META: PageMeta = {
  path: ABOUT_PATH,
  title: "お守りPDFとは",
  description:
    "PDF を公開・提出する前に、見た目では分からない情報を見つけ、消した PDF を作り、消えたことを読み直して確かめます。処理はすべてお使いのブラウザの中で行い、選んだ PDF はどこにも送信しません。",
};

/** 「架空の見本で試す」の行き先（検査のページが ?sample=1 で見本を読み込む。検査のページの側は別に作る） */
export const SAMPLE_HREF = `${INSPECTOR_PATH}?sample=1`;

/** 記事の slug から場所を作る（記事の一覧にない slug なら、ビルドを止める） */
function articleHref(slug: string): string {
  const a = ARTICLES.find((x) => x.slug === slug);
  if (!a) throw new Error(`紹介のページが指す記事が見つかりません：${slug}`);
  return articlePath(a);
}

// ---------------------------------------------------------------- 中身（字だけ）

/** 見た目では分からない残り方（6 枚のカード） */
export const REMAINS: ReadonlyArray<{ pattern: string; title: string; text: string; slug: string }> = [
  { pattern: "P6", title: "見せかけの黒塗り", text: "黒い四角を重ねただけで、下の字が残っています。選んでコピーすると、字が出てきます。", slug: "p6-fake-redaction" },
  { pattern: "P1", title: "文書の情報", text: "作った人の名前や、作ったソフトの名前が、ファイルの情報（プロパティ）に残ります。", slug: "p1-docinfo" },
  { pattern: "P5", title: "前の版", text: "上書きで保存すると、直す前の字やページが、ファイルの中に残ることがあります。", slug: "p5-revisions" },
  { pattern: "P9", title: "添付ファイル", text: "PDF の中に、元の表や文書のファイルが入ったままになっています。", slug: "p9-attachment" },
  { pattern: "P8", title: "注釈・コメント", text: "確かめのときの書き込みと、書いた人の名前が残ります。", slug: "p8-annotation" },
  { pattern: "P10", title: "写真の情報", text: "貼った写真に、撮った場所や機種、撮った日時が残ります。", slug: "p10-image-exif" },
];

/** 4 つの手順（検査のページの 4 段と同じ言葉） */
export const STEPS: ReadonlyArray<{ name: string; text: string }> = [
  { name: "選ぶ", text: "PDF を選びます（パソコンでは、画面に落としてもかまいません）。" },
  { name: "確かめる", text: "残り方の型ごとに、どこに・何が残っているかを日本語で示します。見つけた字は頭の数文字だけを見せ、残りは伏せます。" },
  { name: "整える", text: "見つけたものを消した PDF を作ります。自分で黒塗りする所を選ぶこともできます。" },
  {
    name: "読み直す",
    text: "整えた PDF を最初から検査し直し、消えたことを確かめてから保存できます。処理の報告書（前後の SHA-256・消した所と字数。ファイル名は載せません）も残せます。",
  },
];

/** 送らない仕組みの図の、箱の中の札 */
export const FLOW = ["PDF", "確かめる", "整える", "読み直す", "保存"];

/** 送らないことの確かめ方 */
export const VERIFY_STEPS = [
  "ブラウザの開発者ツールを開き、「ネットワーク」の画面を出します。",
  "検査のページで、PDF を入れます。",
  "外への通信が増えないことを見ます。",
];

/** 調べる型（P1〜P12。名前は用語集 docs/glossary.md の言葉をやさしくしたもの。説明は 1 文） */
export const PATTERNS: ReadonlyArray<{ no: string; name: string; text: string; slug: string }> = [
  { no: "P1", name: "文書の情報", text: "作成者・作成ソフト・題などのプロパティ。", slug: "p1-docinfo" },
  { no: "P2", name: "編集の履歴（XMP）", text: "ファイルに埋め込まれた、編集の履歴や元のファイルの情報。", slug: "p2-xmp" },
  { no: "P3", name: "ほかの団体の名前", text: "流用した様式に残った、別の団体の名前。", slug: "p3-foreign-org" },
  { no: "P4", name: "作ったパソコンの保存先", text: "ファイルの置き場所や、中のサーバーの名前。", slug: "p4-internal-path" },
  { no: "P5", name: "前の版", text: "上書きの保存で残った、直す前の字やページ。", slug: "p5-revisions" },
  { no: "P6", name: "見せかけの黒塗り", text: "黒い四角の下に、字のまま残った情報。", slug: "p6-fake-redaction" },
  { no: "P7", name: "見えない文字", text: "白い字・ページの外の字など、見えないのにコピーできる字。", slug: "p7-hidden-text" },
  { no: "P8", name: "注釈・コメント", text: "書き込みの中身と、書いた人の名前。", slug: "p8-annotation" },
  { no: "P9", name: "添付ファイル", text: "PDF の中に入ったままの、別のファイル。", slug: "p9-attachment" },
  { no: "P10", name: "写真の情報", text: "写真に残った、撮った場所・機種・日時。", slug: "p10-image-exif" },
  { no: "P11", name: "フォームの値", text: "入力欄に入ったままの値。", slug: "p11-form-value" },
  { no: "P12", name: "スクリプト", text: "開くと動くプログラムや、外へつなぐ動き（受け取る人のための注意）。", slug: "p12-active-content" },
];

/** 良くし続ける仕組み（4 段） */
export const LOOP = [
  { name: "読む", text: "Claude が、事前に集めた 18万件以上の公開 PDF を、少しずつ読みます。" },
  { name: "ルールにする", text: "今のルールで見つからない残り方を見つけ、見つけるルールと、架空の PDF で作ったテストを書きます。" },
  { name: "測る", text: "検証の道具で、見つけた数と、誤って警告した数を測ります。" },
  { name: "人が確かめる", text: "人が確かめて取り込んだルールだけが、この検査に届きます。" },
];

/** こんな場面で */
export const SCENES: ReadonlyArray<{ icon: keyof typeof ICONS; title: string; text: string }> = [
  { icon: "publish", title: "資料をウェブに公開する前に", text: "会議の資料やお知らせを載せる前に、見えない所に何が残っているかを確かめます。" },
  { icon: "submit", title: "申請書・報告書を提出する前に", text: "作った人の名前や、前の版の字が残っていないかを確かめます。" },
  { icon: "redact", title: "黒塗りした書類を渡す前に", text: "黒い四角の下の字が、本当に消えているかを確かめます。" },
  { icon: "receive", title: "受け取った PDF の中を知りたいとき", text: "添付ファイルやスクリプトが入っていないかを、開く前の目安にできます。" },
];

/** よくある質問（5 問。残りは /faq） */
export const QUESTIONS: ReadonlyArray<{ q: string; a: string[]; link?: { href: string; label: string } }> = [
  {
    q: "本当に PDF を送らないのですか？",
    a: [
      "検査も、整えるのも、お使いのブラウザの中だけで動きます。PDF の中身やファイルの名前を外へ送る仕組みは入れていません。",
      "開発者ツールで、ご自分でも確かめられます（このページの「送らない仕組み」の確かめ方）。",
    ],
    link: { href: "#lp-trust", label: "確かめ方へ" },
  },
  {
    q: "お金はかかりますか？ 登録は要りますか？",
    a: ["無料で、登録もログインも要りません。ソースコードは AGPL-3.0 で公開しています。"],
  },
  {
    q: "整えた PDF は、元の見た目のままですか？",
    a: [
      "見えている字や絵は、そのまま残すようにしています。黒い四角の下の字や、見えない字・注釈・添付ファイル・文書の情報などを取り除きます。",
      "整えたあとは、作った PDF を開いて、見た目と中身をご自身でも確かめてください。",
    ],
  },
  {
    q: "すべての漏れを見つけられますか？",
    a: [
      "いいえ。調べるのは、並べた型だけです。まだ知らない残り方や、見える字そのものを公開してよいかどうかは、決められません。",
      "公開・提出の前の最後の確かめは、使う方ご自身でしてください。",
    ],
    link: { href: CHECKLIST_PATH, label: "公開前の自己点検" },
  },
  {
    q: "Word や写真のファイルも調べられますか？",
    a: [
      "検査のページで調べられるのは PDF だけです。手元で動かすコマンドの道具では、写真と今の Office のファイルに残った情報を知らせるところまでできます。",
    ],
  },
];

// ---------------------------------------------------------------- 線だけの絵（自作。色は currentColor）

const svg = (body: string) =>
  `<svg class="lp-icon" viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const ICONS = {
  publish: svg(`<rect x="6" y="9" width="36" height="26" rx="3"/><path d="M6 16h36M18 41h12M24 35v6"/><path d="M24 30V20m-5 5 5-5 5 5"/>`),
  submit: svg(`<path d="M12 6h18l8 8v28H12z"/><path d="M30 6v8h8M18 24h14M18 30h14M18 36h8"/>`),
  redact: svg(`<path d="M10 6h20l8 8v28H10z"/><rect x="15" y="20" width="18" height="5" fill="currentColor"/><path d="M15 31h12M15 37h16"/>`),
  receive: svg(`<path d="M6 22 24 8l18 14v18H6z"/><path d="M6 22l18 12 18-12"/><path d="M20 18h8"/>`),
} as const;

// ---------------------------------------------------------------- HTML

const button = (href: string, label: string, kind: "primary" | "secondary" = "primary") =>
  `<a class="lp-button lp-button-${kind}" href="${e(href)}">${e(label)}</a>`;

/** 見出しの字を escapeHtml に通し、読点・句点・「、」の後ろと、「｜」の印の所に <wbr> を置く（語の途中で折らないため。about.css の keep-all） */
const wbr = (s: string) => e(s).replace(/([、。，])/g, "$1<wbr />").replace(/｜/g, "<wbr />");

/** 区画の頭（小さな和文のラベルと見出し） */
const head = (id: string, label: string, title: string, lead?: string) =>
  [
    `        <p class="lp-label">${e(label)}</p>`,
    `        <h2 id="${id}-title">${wbr(title)}</h2>`,
    ...(lead ? [`        <p class="lp-lead">${e(lead)}</p>`] : []),
  ].join("\n");

/** 紙の束（飾り）。いちばん上の紙に黒い帯、下の紙に薄い字の行と「作成者」の札。字は意味のない線で描く */
function paperStack(variant: "open" | "closed"): string {
  const lines = (n: number) => Array.from({ length: n }, () => `<span class="lp-paper-line"></span>`).join("");
  return [
    `<div class="lp-stack lp-stack-${variant}" aria-hidden="true">`,
    `  <div class="lp-paper lp-paper-under">${lines(6)}<span class="lp-paper-tag">作成者</span></div>`,
    `  <div class="lp-paper lp-paper-top">${lines(2)}<span class="lp-paper-bar"></span>${lines(2)}<span class="lp-paper-bar lp-paper-bar-short"></span>${lines(1)}</div>`,
    `</div>`,
  ].join("\n");
}

/** 最初の画面の絵（q47）と、あとから 3D に入れ替える仕組みの場所（2026-11-06 本人が承認。site.ts の aboutHero） */
export interface AboutHero {
  /** q47 の絵（1920×1080 の webp。2 倍の画面のため） */
  img: string;
  /** q47 の絵（960×540。1 倍の画面のため） */
  img960: string;
  /** 3D のときに下に敷く、物を除いた地と影の絵 */
  plate: string;
  /** 3D の描画（about-3d-scene.js を three.js と束ねたもの） */
  scene: string;
  /** 読み込み役（site-3d.js） */
  loader: string;
}

/** 右の列の絵。はじめは q47 の絵。読み込み役が手の空いたときに 3D の描画を読み、描けたら入れ替える。飾りなので読み上げない */
function heroArt(h: AboutHero | undefined): string {
  if (!h) return paperStack("open");
  return [
    `<div class="lp-hero-3d" data-plate="${e(h.plate)}">`,
    `  <img src="${e(h.img)}" srcset="${e(h.img960)} 960w, ${e(h.img)} 1920w" sizes="(max-width: 56rem) calc(100vw - 2rem), 31rem" width="1920" height="1080" alt="" decoding="async" fetchpriority="high" />`,
    `</div>`,
  ].join("\n");
}

function hero(h?: AboutHero): string {
  return `      <section class="lp-hero" aria-labelledby="lp-hero-title">
        <div class="lp-wrap lp-hero-grid">
          <div class="lp-hero-text">
            <p class="lp-label">公開・提出の前に</p>
            <h1 id="lp-hero-title">出す前に、<wbr />見えない所まで<wbr />確かめる。</h1>
            <p class="lp-hero-sub">PDF を公開・提出する前に、見た目では分からない情報を見つけ、消した PDF を作り、消えたことを読み直して確かめます。処理はすべてお使いのブラウザの中。選んだ PDF はどこにも送信しません。</p>
            <ul class="lp-chips" aria-label="3 つの約束">
              <li>送らない（ブラウザの中だけ）</li>
              <li>無料・登録なし</li>
              <li>ソースを公開（AGPL-3.0）</li>
            </ul>
            <p class="lp-actions">${button(INSPECTOR_PATH, "PDF を確かめる")} ${button(SAMPLE_HREF, "架空の見本で試す", "secondary")}</p>
          </div>
          <div class="lp-hero-art"${h ? ` aria-hidden="true" data-scene="${e(h.scene)}"` : ""}>
${heroArt(h)}
          </div>
        </div>${h ? `
        <script type="module" src="${e(h.loader)}"></script>` : ""}
      </section>`;
}

function remains(): string {
  const types = ARTICLES.filter((a) => a.pattern).length;
  const guides = ARTICLES.filter((a) => !a.pattern).length;
  const cards = REMAINS.map(
    (r) => `          <li class="lp-card">
            <p class="lp-card-no">${e(r.pattern)}</p>
            <h3><a href="${e(articleHref(r.slug))}">${e(r.title)}</a></h3>
            <p>${e(r.text)}</p>
          </li>`,
  ).join("\n");
  return `      <section class="lp-section" id="lp-remains" aria-labelledby="lp-remains-title">
        <div class="lp-wrap">
${head("lp-remains", "残り方", "画面では消えて見えても、残っていることがあります", "書類を作るときの、ふつうの操作で起こります。よくある 6 つの残り方です。")}
        <ul class="lp-cards">
${cards}
        </ul>
        <p class="lp-more"><a href="${ARTICLES_PATH}">ほかの型は記事の一覧へ（型の解説 ${types} 本・手順 ${guides} 本）</a></p>
        </div>
      </section>`;
}

function steps(): string {
  const items = STEPS.map(
    (s, i) => `          <li class="lp-step">
            <span class="lp-step-no" aria-hidden="true">${i + 1}</span>
            <h3><span class="site-sr">${i + 1}. </span>${e(s.name)}</h3>
            <p>${e(s.text)}</p>
          </li>`,
  ).join("\n");
  return `      <section class="lp-section lp-section-sunken" id="lp-how" aria-labelledby="lp-how-title">
        <div class="lp-wrap">
${head("lp-how", "手順", "選んで、確かめて、整えて、読み直す。", "見つけるだけで終わらせず、消えたことを確かめるところまで、検査のページ 1 枚で進みます。")}
        <ol class="lp-steps">
${items}
        </ol>
        <p class="lp-more"><a href="${INSPECTOR_PATH}">検査のページで試す</a></p>
        </div>
      </section>`;
}

function trust(): string {
  const flow = FLOW.map((f) => `<li>${e(f)}</li>`).join("");
  const verify = VERIFY_STEPS.map((v) => `            <li>${e(v)}</li>`).join("\n");
  return `      <section class="lp-section" id="lp-trust" aria-labelledby="lp-trust-title">
        <div class="lp-wrap lp-trust-grid">
          <div>
${head("lp-trust", "送らない", "選んだ PDF は、あなたのパソコンから｜出ません")}
            <p>ページを開くときに、画面と検査のプログラムを、このサイトから読み込みます。PDF を入れたあとに、外へ通信する仕組みは入れていません。</p>
            <p>アクセス解析・広告・Cookie は使っていません。開いた回数は、配信するサーバーの記録で数えます。</p>
            <h3>自分で確かめる方法</h3>
            <ol class="lp-verify">
${verify}
            </ol>
            <ul class="lp-facts">
              <li>ソースコードを公開しています（AGPL-3.0）。</li>
              <li>公開の前に、本物のブラウザで外への要求が 0 件であることを、自動で確かめています。</li>
              <li>ページの通信の決まり（CSP）で、外への通信を許していません。</li>
            </ul>
            <p class="site-note">どんな場合にも送れないことを保証するものではありません。くわしくは<a href="${PRIVACY_PATH}">プライバシーについて</a>。公式のサイトは omamoripdf.com だけです。</p>
          </div>
          <figure class="lp-diagram" aria-labelledby="lp-diagram-cap">
            <div class="lp-diagram-site">omamoripdf.com</div>
            <p class="lp-diagram-arrow">ページとプログラムを読み込む（開くときだけ）</p>
            <div class="lp-diagram-box">
              <p class="lp-diagram-name">あなたのパソコン（ブラウザ）</p>
              <ol class="lp-flow">${flow}</ol>
            </div>
            <p class="lp-diagram-none">PDF・ファイル名・結果は送らない</p>
            <figcaption id="lp-diagram-cap" class="site-sr">図：サイトからは、ページとプログラムをブラウザに読み込むだけ。ブラウザの中で、PDF を確かめ、整え、読み直し、保存する。ブラウザから外へ送る矢印はない。</figcaption>
          </figure>
        </div>
      </section>`;
}

function scope(): string {
  const chips = PATTERNS.map(
    (p) => `          <li class="lp-pattern">
            <a href="${e(articleHref(p.slug))}"><span class="lp-pattern-no">${e(p.no)}</span><span class="lp-pattern-name">${e(p.name)}</span></a>
            <p class="lp-pattern-text">${e(p.text)}</p>
          </li>`,
  ).join("\n");
  return `      <section class="lp-section lp-section-sunken" id="lp-scope" aria-labelledby="lp-scope-title">
        <div class="lp-wrap">
${head("lp-scope", "範囲", "見つけるもの、まだ見つけられないもの", "並べた型を、毎回同じ順で調べます。結果の画面でも、型ごとに「調べた・調べられなかった」を示します。")}
        <ul class="lp-patterns">
${chips}
        </ul>
        <div class="lp-cannot">
          <h3>見つけられないもの</h3>
          <ul>
            <li>ここに並べていない型や、まだ知らない残り方。</li>
            <li>画像の中に写っている字の中身（写真やスキャンの絵の中の字は読みません）。</li>
            <li>見える字そのものを、公開してよいかどうか。</li>
          </ul>
          <p>最後に確かめるのは、使う方ご自身です。<a href="${CHECKLIST_PATH}">公開前の自己点検</a>の一覧も使えます。</p>
        </div>
        </div>
      </section>`;
}

function loop(o: RenderOptions): string {
  const items = LOOP.map(
    (l, i) => `          <li class="lp-loop-item${i === LOOP.length - 1 ? " lp-loop-human" : ""}">
            <span class="lp-loop-no" aria-hidden="true">${i + 1}</span>
            <h3><span class="site-sr">${i + 1}. </span>${e(l.name)}</h3>
            <p>${e(l.text)}</p>
          </li>`,
  ).join("\n");
  const source = o.repoUrl
    ? `<a href="${e(`${o.repoUrl}/blob/main/docs/evolution.md`)}">改善の記録（docs/evolution.md）</a>`
    : "改善の記録（ソースコードの docs/evolution.md）";
  return `      <section class="lp-section" id="lp-loop" aria-labelledby="lp-loop-title">
        <div class="lp-wrap lp-loop-grid">
          <div>
${head("lp-loop", "育て方", "実物の PDF から、見つけ方を｜増やしていきます", "日本の書類で実際に起きている残り方と、ふつうの書類を誤って警告する原因を、実物で確かめてルールにしています。")}
            <p>ルールと数字は公開しています。${source}をご覧ください。</p>
            <p class="site-note">あなたが検査のページで選んだ PDF は、この仕組みに使いません（どこにも送らないので、使いようがありません）。</p>
          </div>
          <div class="lp-loop-art">
            <span class="lp-loop-ring" aria-hidden="true"><span class="lp-loop-dot"></span></span>
            <ol class="lp-loop">
${items}
            </ol>
          </div>
        </div>
      </section>`;
}

function scenes(): string {
  const cards = SCENES.map(
    (s) => `          <li class="lp-scene">
            ${ICONS[s.icon]}
            <h3>${e(s.title)}</h3>
            <p>${e(s.text)}</p>
          </li>`,
  ).join("\n");
  return `      <section class="lp-section lp-section-sunken" id="lp-scenes" aria-labelledby="lp-scenes-title">
        <div class="lp-wrap">
${head("lp-scenes", "使う場面", "出す前の、もうひと手間に", "書類を作った本人が、自分で確かめるための道具です。")}
        <ul class="lp-scenes">
${cards}
        </ul>
        <p class="lp-dev">開発する方へ：Claude Code のスキルからも、手元で同じ検査を使えます。Claude に伝えるのは型・数・場所だけで、PDF の中身や字は渡しません。</p>
        </div>
      </section>`;
}

function faq(): string {
  const items = QUESTIONS.map((q) => {
    const link = q.link ? `\n              <p><a href="${e(q.link.href)}">${e(q.link.label)}</a></p>` : "";
    return `          <details class="lp-faq-item">
            <summary>${e(q.q)}</summary>
            <div class="lp-faq-body">
${q.a.map((p) => `              <p>${e(p)}</p>`).join("\n")}${link}
            </div>
          </details>`;
  }).join("\n");
  return `      <section class="lp-section" id="lp-faq" aria-labelledby="lp-faq-title">
        <div class="lp-wrap lp-narrow">
${head("lp-faq", "質問", "よくある質問")}
${items}
        <p class="lp-more"><a href="${FAQ_PATH}">ほかの質問は、よくある質問のページへ</a></p>
        </div>
      </section>`;
}

function closing(): string {
  return `      <section class="lp-closing" aria-labelledby="lp-closing-title">
        <div class="lp-wrap lp-closing-grid">
          <div>
            <h2 id="lp-closing-title">出す前に、<wbr />一度だけ<wbr />確かめる。</h2>
            <p>無料・登録なし。選んだ PDF はどこにも送信しません。</p>
            <p class="lp-actions">${button(INSPECTOR_PATH, "PDF を確かめる")} <a class="lp-closing-link" href="${e(SAMPLE_HREF)}">架空の見本で試す</a></p>
          </div>
${paperStack("closed")}
        </div>
      </section>`;
}

export function renderAbout(o: RenderOptions, cssHref: string, h?: AboutHero): string {
  const body = [hero(h), remains(), steps(), trust(), scope(), loop(o), scenes(), faq(), closing()].join("\n");
  return layout(ABOUT_META, body, o, { bodyClass: "site-lp", extraCssHref: cssHref });
}
