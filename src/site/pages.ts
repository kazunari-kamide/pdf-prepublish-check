// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトの案内のページ（ライセンス・利用規約・お問い合わせ・よくある質問・公開前の自己点検）の中身と、HTML の作り方。
// ビルドの時に site.ts が呼ぶ。ブラウザでは動かさない。
// - 枠（CSP・題・説明・canonical・上下の帯）は render.ts の layout を使う。字は、すべて escapeHtml を通す。
// - 外を指すリンクは、GitHub のリポジトリ（RenderOptions.repoUrl）だけ。ここには URL を書かない（tests/no-network.test.ts）。
// - ライセンスの一覧の中身は、ビルドの時に site-licenses.ts が package-lock.json・docs/licenses.md から作って渡す。
// - 記事の中身（articles.ts）と、記事のページの作り方（render.ts の記事の部分）は、ここでは扱わない。

import {
  ARTICLES_PATH,
  CHECKLIST_PATH,
  CONTACT_PATH,
  FAQ_PATH,
  LICENSES_PATH,
  PRIVACY_PATH,
  TERMS_PATH,
  escapeHtml,
  fileFor,
  layout,
  renderSection,
  type RenderOptions,
} from "./render.ts";
import type { PageMeta, Section } from "./types.ts";

const e = escapeHtml;

/** 節の最後に置くリンク。href はサイトの中（/ で始まる）か、GitHub のリポジトリの中（repo: で始まる。repoUrl につなぐ） */
interface Link {
  href: string;
  label: string;
}
type Block = Section & { links?: Link[] };

/** repo: で始まるリンクを、GitHub のリポジトリの場所につなぐ。repoUrl が分からなければ null（リンクを出さない） */
function resolve(href: string, o: RenderOptions): string | null {
  if (!href.startsWith("repo:")) return href;
  return o.repoUrl ? `${o.repoUrl}${href.slice("repo:".length)}` : null;
}

function renderBlock(b: Block, o: RenderOptions): string {
  const html = renderSection(b);
  const links = (b.links ?? [])
    .map((l) => ({ href: resolve(l.href, o), label: l.label }))
    .map((l) => (l.href ? `          <li><a href="${e(l.href)}">${e(l.label)}</a></li>` : `          <li>${e(l.label)}（場所は、公式のサイトのこのページで示します）</li>`));
  if (!links.length) return html;
  return html.replace(/\n {6}<\/section>$/, `\n        <ul class="site-links-list">\n${links.join("\n")}\n        </ul>\n      </section>`);
}

function simplePage(meta: PageMeta, lead: string, blocks: Block[], o: RenderOptions, extraClass = ""): string {
  const body = [
    `      <div class="site-page${extraClass ? ` ${extraClass}` : ""}">`,
    `      <h1>${e(meta.title)}</h1>`,
    `      <p class="site-lead">${e(lead)}</p>`,
    ...blocks.map((b) => renderBlock(b, o)),
    `      <p class="site-back"><a href="/">検査のページへ</a></p>`,
    `      </div>`,
  ].join("\n");
  return layout(meta, body, o);
}

// ---------------------------------------------------------------- 利用規約

export const TERMS_META: PageMeta = {
  path: TERMS_PATH,
  title: "利用規約",
  description: "お守りPDF の利用規約です。無料・登録なしで、PDF はブラウザの中だけで読むこと、見つけられる範囲に限りがあること、禁止すること、変え方を書いています。",
};

export const TERMS_BLOCKS: Block[] = [
  {
    heading: "1. この規約について",
    paragraphs: [
      "この規約は、お守りPDF（以下「当サービス」）を使うときの決まりです。当サービスを使った時点で、この規約に同意したものとします。",
      "運営者：KK",
    ],
  },
  {
    heading: "2. 当サービスがすること",
    list: [
      "無料で使えます。登録やログインは要りません。",
      "PDF は、利用者のパソコンのブラウザの中だけで読みます。PDF の中身やファイルの名前を、運営者のサーバーやほかの場所へ送る仕組みは入れていません。",
      "見た目では分からない情報（黒塗りの下に残った字・作成者の名前・前の版の残り・添付ファイルなど）を探し、片付けた PDF を作ります。",
    ],
  },
  {
    heading: "3. 見つけられる範囲には限りがあります",
    list: [
      "当サービスが調べるのは、検査のページに並べた種類だけです。すべての漏れを見つけられるわけではありません。",
      "「見つかりませんでした」という結果は、調べた種類の中で見つからなかったという意味です。漏れがないことを保証するものではありません。",
      "片付けたあとの「残っていません」も、読み直して調べた項目についての結果です。",
      "PDF を公開・提出する前の最後の確かめは、利用者自身がしてください。",
    ],
  },
  {
    heading: "4. 責任について",
    paragraphs: [
      "運営者は、当サービスの結果に誤りや見落としがないことを約束しません。当サービスを使ったこと、または使えなかったことで利用者や第三者に生じた損害について、運営者に故意または重大な過失がある場合を除き、責任を負いません。",
      "当サービスは、予告なく変えたり、止めたりすることがあります。",
    ],
  },
  {
    heading: "5. 禁止すること",
    list: [
      "他人の権利（著作権・プライバシー・名誉など）を害する使い方。",
      "自分に扱う権限のない PDF を、持ち主の許しなく調べること。",
      "法令や公の秩序に反する使い方。",
      "このサイトや配信先のサーバーに、過大な負担をかけること。",
      "公式のサイトや運営者になりすますこと。",
    ],
  },
  {
    heading: "6. ソースコードと公式のサイト",
    paragraphs: [
      "当サービスのソースコードは、GNU Affero General Public License 3.0（AGPL-3.0-only）で公開しています。このライセンスの範囲で、誰でも読み、改変し、配ることができます。",
      "公式のサイトは omamoripdf.com だけです。ほかの場所で動いているものは、改変されている可能性があります。",
      "「お守りPDF」の名前とロゴは、改変版には使えません。改変して公開するときは、別の名前にしてください。",
    ],
    links: [
      { href: LICENSES_PATH, label: "ライセンスのページ（使っている部品と、当サービスのライセンス）" },
      { href: "repo:", label: "ソースコード（GitHub）" },
    ],
  },
  {
    heading: "7. 規約の変え方",
    paragraphs: [
      "この規約は、必要に応じて変えることがあります。変えるときは、このページに新しい規約と、変えた日を載せます。変えた中身は、GitHub のリポジトリの履歴でも確かめられます。",
      "変えたあとに当サービスを使った場合は、変えたあとの規約に同意したものとします。",
    ],
  },
  {
    heading: "8. 定めた日",
    paragraphs: ["2026年11月5日"],
  },
];

// ---------------------------------------------------------------- お問い合わせ

export const CONTACT_META: PageMeta = {
  path: CONTACT_PATH,
  title: "お問い合わせ",
  description: "お守りPDF への質問・不具合の知らせは、GitHub の Issues で受け付けています。PDF や個人情報は貼らないでください。",
};

export const CONTACT_BLOCKS: Block[] = [
  {
    heading: "知らせ方",
    paragraphs: ["質問・不具合・直してほしい所は、GitHub の Issues に書いてください。メールでは受け付けていません。"],
    links: [{ href: "repo:/issues", label: "GitHub の Issues を開く" }],
  },
  {
    heading: "書く前に、必ず読んでください",
    list: [
      "業務の PDF や、実在の人名・団体名が入った PDF を、添付しないでください。Issues は誰でも読めます。",
      "見つかった字の中身（黒塗りの下の字・名前・番号など）を、そのまま書かないでください。種類と数だけで十分です。",
      "再現のための PDF が要るときは、架空の名前と番号で作った PDF を使ってください。",
      "ブラウザの種類と版、どの手順で何が起きたかを書いてもらえると、調べやすくなります。",
    ],
    note: "個人情報らしいものが貼られていたときは、見つけしだい見えないようにします。",
  },
  {
    heading: "脆弱性（セキュリティの弱点）を見つけたとき",
    paragraphs: ["公開の Issues には書かず、GitHub の非公開の報告（private vulnerability reporting）で知らせてください。"],
    links: [{ href: "repo:/security/advisories/new", label: "非公開で報告する（GitHub）" }],
  },
];

// ---------------------------------------------------------------- よくある質問

export const FAQ_META: PageMeta = {
  path: FAQ_PATH,
  title: "よくある質問",
  description: "本当に PDF を送らないのか、何を調べるのか、黒塗りの直し方、「見つかりませんでした」の意味など、お守りPDF についてよく聞かれることをまとめました。",
};

export const FAQ_BLOCKS: Block[] = [
  {
    heading: "PDF を、本当にどこにも送らないのですか？",
    paragraphs: [
      "検査も片付けも、あなたのパソコンのブラウザの中だけで動きます。PDF の中身やファイルの名前を外へ送る仕組みは、入れていません。",
      "それを確かめるために、次のことをしています。",
    ],
    list: [
      "ページに、通信先を絞る決まり（CSP）を付けています。外への通信（connect-src）は、すべて止める設定です。ただし CSP は被害を減らす層の1つで、送れないことの保証ではありません。",
      "配信のたびに、本物のブラウザで公式のサイトを開き、合成した PDF を入れて、外への要求を数えています。最初の表示でも、PDF を入れた後でも、0 件であることを確かめてから公開しています。",
      "ソースコードを公開しているので、誰でも同じ確かめができます。",
    ],
  },
  {
    heading: "サイトを開いた記録は、どこかに残りますか？",
    paragraphs: [
      "アクセス解析のスクリプトや Cookie は使っていません。開いた回数などは、配信先のサーバーがふつうに残す記録（IP アドレス・参照元・ブラウザの種類・時刻・開いたページ）だけで数えます。PDF の中身・ファイル名・画面の操作は、サーバーに届きません。",
    ],
    links: [{ href: PRIVACY_PATH, label: "プライバシーについて" }],
  },
  {
    heading: "何を調べるのですか？",
    paragraphs: [
      "見た目では分からない情報を、型ごとに調べます。たとえば、黒い四角を重ねただけの黒塗り（P6）、作成者などの文書情報（P1）、前の版の残り（P5）、白い字やページの外の字（P7）、注釈とコメント（P8）、添付ファイル（P9）などです。",
      "いま検査のページで調べられる種類は、結果の画面の「種類ごとの結果」に並びます。",
    ],
    links: [{ href: ARTICLES_PATH, label: "型ごとの解説（記事の一覧）" }],
  },
  {
    heading: "黒塗りの下の字が残っていると出ました。どう直せばよいですか？",
    paragraphs: [
      "検査のページの「片付ける」で、黒い四角の下の字を消した PDF を作れます。片付けたあと、作った PDF を最初から読み直して、残っていないかを確かめます。",
      "元のファイル（Word など）から作り直す場合は、黒い四角を重ねるのではなく、字そのものを消すか、墨消しの機能を使ってから PDF にしてください。",
    ],
    links: [
      { href: `${ARTICLES_PATH}p6-fake-redaction.html`, label: "見せかけの黒塗り（P6）の解説" },
      { href: `${ARTICLES_PATH}guide-acrobat-redaction.html`, label: "墨消しの手順" },
    ],
  },
  {
    heading: "「見つかりませんでした」と出れば、もう大丈夫ですか？",
    paragraphs: [
      "そうとは言えません。当サービスが調べるのは、決めた種類だけです。調べていない種類の情報や、当サービスがまだ知らない残り方は、見つけられません。",
      "また、見える字そのもの（本文に書いた名前など）が公開してよいものかどうかは、当サービスでは決められません。公開・提出の前の最後の確かめは、ご自身でしてください。",
    ],
    links: [{ href: CHECKLIST_PATH, label: "公開前の自己点検" }],
  },
  {
    heading: "片付けた PDF の見た目は変わりますか？",
    paragraphs: [
      "見えている字や絵は、そのまま残すようにしています。黒い四角の下の字や、見えない字・注釈・添付ファイル・文書情報などを取り除きます。",
      "片付けたあとは、作った PDF を開いて、見た目と中身をご自身でも確かめてください。",
    ],
  },
  {
    heading: "スキャンした PDF も調べられますか？",
    paragraphs: [
      "調べられます。スキャンの画像の上に黒い図形を重ねただけの黒塗りや、文字認識（OCR）で付いた字の層を見つけます。文字認識の層があるページは、お知らせとして示します。",
    ],
    links: [{ href: `${ARTICLES_PATH}guide-scan.html`, label: "スキャンの書類の手順" }],
  },
  {
    heading: "PDF 以外のファイル（Word・Excel・写真）も調べられますか？",
    paragraphs: [
      "検査のページで調べられるのは、PDF だけです。手元で動かすコマンドの道具では、写真（JPEG・PNG・WebP）と今の Office（docx・xlsx・pptx）に残った情報を知らせるところまでできます（消すところは、まだできません）。",
      "Word などの元のファイルは、PDF にする前に、ファイルの情報（プロパティ）やコメント・変更の履歴を確かめてください。",
    ],
    links: [{ href: `${ARTICLES_PATH}guide-word.html`, label: "Word から PDF にするときの手順" }],
  },
  {
    heading: "ファイルを小さく（圧縮）できますか？",
    paragraphs: [
      "いまの検査のページには、ファイルを小さくする機能はありません。提出先の容量の上限に合わせて小さくする機能を、片付けの部品として作っているところです。小さくしたあとも、片付けで消したものが戻らないことを確かめる作りにしています。",
    ],
  },
  {
    heading: "暗号化された PDF や、とても大きい PDF はどうなりますか？",
    paragraphs: [
      "開くのにパスワードが要る PDF は、調べられないことを表示します。図形がとても多いページは、ブラウザが止まらないように調べるのを省き、省いたページの番号を表示します。省いたページは「見つからなかった」には数えません。",
    ],
  },
  {
    heading: "お金はかかりますか？ 登録は要りますか？",
    paragraphs: ["無料で、登録もログインも要りません。"],
    links: [{ href: TERMS_PATH, label: "利用規約" }],
  },
  {
    heading: "誤りを見つけました。どこに知らせればよいですか？",
    paragraphs: ["GitHub の Issues で受け付けています。PDF や個人情報は貼らないでください。"],
    links: [{ href: CONTACT_PATH, label: "お問い合わせ" }],
  },
];

// ---------------------------------------------------------------- 公開前の自己点検

export const CHECKLIST_META: PageMeta = {
  path: CHECKLIST_PATH,
  title: "公開前の自己点検",
  description: "PDF を公開・提出する前に、作る時・書き出す時・出す前の3つの段で確かめることを、型の番号（P1〜P12）に沿って並べました。印刷して使えます。",
};

export const CHECKLIST_BLOCKS: Block[] = [
  {
    heading: "使い方",
    paragraphs: [
      "上から順に確かめ、済んだら □ に印を付けてください。（ ）の中は型の番号で、記事の一覧に解説があります。",
      "この点検は、見落としを減らすための目安です。ここに無い残り方もあります。",
    ],
  },
  {
    heading: "1. 作る時（元のファイル）",
    list: [
      "ほかの団体の様式を流用したときは、題・ヘッダー・ファイルの情報に、元の団体の名前が残っていないか（P3）",
      "ファイルの情報（作成者・会社名・題など）に、出してよくない名前が入っていないか（P1・P2）",
      "コメント・変更の履歴・メモを、消すか、すべて確定したか（P8）",
      "白い字・小さい字・隠した行や列・ページの外に置いた字がないか（P7）",
      "フォームの欄に、記入例のつもりで本物の値を入れていないか（P11）",
      "貼った写真に、撮影した場所などの情報が残っていないか（P10）",
    ],
  },
  {
    heading: "2. 書き出す時（PDF にする時）",
    list: [
      "黒塗りは、黒い四角を重ねるのではなく、字そのものを消すか、墨消しの機能で消したか（P6）",
      "スキャンした書類の黒塗りは、紙の上で塗ってから読み取ったか、画像そのものを塗ったか（P6）",
      "PDF の書き出しの設定で、ファイルの情報・コメント・しおりを含めない設定にしたか（P1・P2・P8）",
      "元の Excel・Word などを、PDF に添付していないか（P9）",
      "直した PDF を、上書きの保存ではなく、新しいファイルとして保存したか（P5）",
    ],
  },
  {
    heading: "3. 出す前（できあがった PDF）",
    list: [
      "検査のページで調べ、見つかったものを片付けたか",
      "片付けた PDF を開き、見た目が崩れていないか、消した所の下の字が選べないかを確かめたか（P6・P7）",
      "PDF の中にファイルの保存先（パソコンの利用者名・職場のサーバーの場所）が残っていないか（P4）",
      "開いたときに動くスクリプトや、外のプログラムを開く動作が入っていないか（P12）",
      "本文に見えている名前・番号・住所が、出してよいものかを読み直したか（当サービスでは決められません）",
      "出すファイルが、確かめたファイルと同じものか（名前と日付）",
    ],
  },
];

// ---------------------------------------------------------------- ライセンス

/** ライセンスの一覧の1行 */
export interface LicenseEntry {
  name: string;
  /** 版。分からないときは "—" */
  version: string;
  license: string;
  /** ライセンスの文にある著作権の表示（そのまま写したもの）。ないときは空 */
  copyright: string[];
  /** ライセンスの全文（dist/ に置いた写し。/licenses/... ）。ないときは null */
  textHref: string | null;
  /** 全文を置いていないときの理由 */
  noText?: string;
  /** 出典（GitHub のリポジトリの場所だけ。ほかの場所は出さない）。ないときは null */
  source: string | null;
}

export interface LicenseData {
  /** この作品のライセンスの全文（/licenses/AGPL-3.0.txt） */
  ownTextHref: string;
  /** 配るもの（dist/）に入る部品（画面が読み込むライブラリと、その依存） */
  shipped: LicenseEntry[];
  /** 配るもの（dist/）に入る書体（画面の書体） */
  fonts: LicenseEntry[];
}

export const LICENSES_META: PageMeta = {
  path: LICENSES_PATH,
  title: "ライセンス",
  description: "お守りPDF のライセンス（AGPL-3.0）とソースの場所、使っている部品・書体の名前・版・ライセンス・著作権の表示と、ライセンスの全文です。",
};

function licenseTable(rows: LicenseEntry[], caption: string): string {
  const cell = (r: LicenseEntry) => {
    const copy = r.copyright.length
      ? r.copyright.map((c) => `<span class="site-copy">${e(c)}</span>`).join("")
      : r.textHref
        ? `<span class="site-copy-none">ライセンスの文に著作権の行がありません（全文を見てください）</span>`
        : "—";
    const text = r.textHref ? `<a href="${e(r.textHref)}">全文</a>` : `<span class="site-copy-none">${e(r.noText ?? "—")}</span>`;
    const name = r.source ? `<a href="${e(r.source)}">${e(r.name)}</a>` : e(r.name);
    return `            <tr><th scope="row">${name}</th><td>${e(r.version)}</td><td>${e(r.license)}</td><td>${copy}</td><td>${text}</td></tr>`;
  };
  return [
    `        <div class="site-table-wrap">`,
    `          <table class="site-table">`,
    `            <caption>${e(caption)}</caption>`,
    `            <thead><tr><th scope="col">名前</th><th scope="col">版</th><th scope="col">ライセンス</th><th scope="col">著作権の表示</th><th scope="col">ライセンスの全文</th></tr></thead>`,
    `            <tbody>`,
    ...rows.map(cell),
    `            </tbody>`,
    `          </table>`,
    `        </div>`,
  ].join("\n");
}

export function renderLicenses(o: RenderOptions, d: LicenseData): string {
  const section = (heading: string, inner: string[]) => [`      <section class="site-section">`, `        <h2>${e(heading)}</h2>`, ...inner, `      </section>`].join("\n");
  const p = (t: string) => `        <p>${t}</p>`;
  const repo = o.repoUrl ? `<a href="${e(o.repoUrl)}">GitHub のリポジトリ</a>` : "GitHub のリポジトリ";
  const body = [
    `      <div class="site-page">`,
    `      <h1>${e(LICENSES_META.title)}</h1>`,
    `      <p class="site-lead">${e(LICENSES_META.description)}</p>`,
    section("当サービスのライセンス", [
      p(`当サービスのソースコードは、GNU Affero General Public License 3.0（AGPL-3.0-only）です。<a href="${e(d.ownTextHref)}">ライセンスの全文</a>`),
      p(`ソースコードは ${repo} で公開しています。公開しているサイトのファイルは、公開しているソースから同じ手順で作ったものです。`),
      p(e("「お守りPDF」の名前とロゴは、改変版には使えません。コードのライセンスは、名前とロゴの使用までは許していません。")),
    ]),
    section("配るものに入る部品", [
      p(e("このサイトのファイルに入っていて、あなたのブラウザで動く部品です（検査・片付け・ページの絵を描くのに使います）。")),
      licenseTable(d.shipped, "配るものに入る部品"),
    ]),
    section("書体", [
      p(e("画面の書体は、使う字だけに絞って同梱しています（外から読み込みません）。字を絞るのは改変にあたるため、元と同じライセンスのまま配り、ライセンスの全文も一緒に置いています。")),
      licenseTable(d.fonts, "書体"),
    ]),
    section("この一覧の作り方", [
      p(e("この一覧には、このサイトのファイルに入り、あなたのブラウザで動く部品と書体だけを並べています。開発・テスト・配信にだけ使う道具は、このサイトのファイルに入らないので並べていません（ソースのリポジトリの docs/licenses.md に一覧があります）。")),
      p(e("この一覧は、ビルドの時に package-lock.json と docs/licenses.md から作っています。著作権の表示とライセンスの全文は、それぞれの部品に付いているライセンスの文から、そのまま写しています。")),
    ]),
    `      <p class="site-back"><a href="/">検査のページへ</a></p>`,
    `      </div>`,
  ].join("\n");
  return layout(LICENSES_META, body, o);
}

// ---------------------------------------------------------------- 見つからないとき（404）

/** 見つからないときに返すページ（.htaccess の ErrorDocument 404。htaccess.ts の NOT_FOUND_PAGE）。sitemap には入れない */
export const NOT_FOUND_META: PageMeta = {
  path: "/404.html",
  title: "ページが見つかりません",
  description: "お探しのページは見つかりませんでした。場所が変わったか、なくなった可能性があります。検査のページや記事の一覧から探してください。",
};

export const NOT_FOUND_BLOCKS: Block[] = [
  {
    heading: "探し方",
    paragraphs: [
      "入力した場所（URL）に、まちがいがないかを確かめてください。",
      "公式のサイトは omamoripdf.com だけです。ほかの場所で、このページに似たものが出たときは、改変されている可能性があります。",
    ],
    links: [
      { href: "/", label: "検査のページ" },
      { href: ARTICLES_PATH, label: "記事の一覧" },
      { href: FAQ_PATH, label: "よくある質問" },
    ],
  },
];

// ---------------------------------------------------------------- まとめ

/** サイトの案内のページの場所（sitemap に足す） */
export const GUIDE_PATHS = [CHECKLIST_PATH, FAQ_PATH, TERMS_PATH, LICENSES_PATH, CONTACT_PATH];

/** サイトの案内のページを全部作る。鍵は dist/ の中のファイルの名前 */
export function renderGuidePages(o: RenderOptions, licenses: LicenseData): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set(fileFor(CHECKLIST_PATH), simplePage(CHECKLIST_META, CHECKLIST_META.description, CHECKLIST_BLOCKS, o, "site-checklist"));
  pages.set(fileFor(FAQ_PATH), simplePage(FAQ_META, FAQ_META.description, FAQ_BLOCKS, o));
  pages.set(fileFor(TERMS_PATH), simplePage(TERMS_META, TERMS_META.description, TERMS_BLOCKS, o));
  pages.set(fileFor(CONTACT_PATH), simplePage(CONTACT_META, CONTACT_META.description, CONTACT_BLOCKS, o));
  pages.set(fileFor(LICENSES_PATH), renderLicenses(o, licenses));
  pages.set(fileFor(NOT_FOUND_META.path), simplePage(NOT_FOUND_META, NOT_FOUND_META.description, NOT_FOUND_BLOCKS, o));
  return pages;
}
