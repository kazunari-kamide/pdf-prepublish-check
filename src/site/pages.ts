// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトの案内のページ（ライセンス・利用規約・お問い合わせ・よくある質問・公開前の自己点検）の中身と、HTML の作り方。
// ビルドの時に site.ts が呼ぶ。ブラウザでは動かさない。
// - 枠（CSP・題・説明・canonical・上下の帯）は render.ts の layout を使う。字は、すべて escapeHtml を通す。
// - 外を指すリンクは、GitHub のリポジトリ（RenderOptions.repoUrl）だけ。ここには URL を書かない（tests/no-network.test.ts）。
// - ライセンスの一覧の中身は、ビルドの時に site-licenses.ts が package-lock.json・docs/licenses.md から作って渡す。
// - 記事の中身（articles.ts）と、記事のページの作り方（render.ts の記事の部分）は、ここでは扱わない。

import { CONTACT_REFERRER, withFormActionSelf } from "../../csp.ts";
import {
  ARTICLES_PATH,
  CHECKLIST_PATH,
  CONTACT_PATH,
  CONTACT_SEND_PATH,
  FAQ_PATH,
  LICENSES_PATH,
  PRIVACY_PATH,
  TERMS_PATH,
  escapeHtml,
  fileFor,
  layout,
  renderSection,
  renderSectionAt,
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
function resolve(href: string, o: Pick<RenderOptions, "repoUrl">): string | null {
  if (!href.startsWith("repo:")) return href;
  return o.repoUrl ? `${o.repoUrl}${href.slice("repo:".length)}` : null;
}

function renderBlock(b: Block, o: Pick<RenderOptions, "repoUrl">, level: 2 | 3 = 2): string {
  const html = renderSectionAt(b, level);
  const links = (b.links ?? [])
    .map((l) => ({ href: resolve(l.href, o), label: l.label }))
    .map((l) => (l.href ? `          <li><a href="${e(l.href)}">${e(l.label)}</a></li>` : `          <li>${e(l.label)}（場所は、公式のサイトのこのページで示します）</li>`));
  if (!links.length) return html;
  return html.replace(/\n {6}<\/section>$/, `\n        <ul class="site-links-list">\n${links.join("\n")}\n        </ul>\n      </section>`);
}

/**
 * 点検の一覧の段（デザインシートの「点検の一覧」の形。design/sheet.md）。
 * 項目は本物のチェックボックスにし、字（label）を押しても印が付く。印は保存しない・どこにも送らない（スクリプトも使わない）。
 * 見出しの「1. 」の番号は丸い札にするが、読み上げでは「1.」のまま読む。見える字は変えない。
 * 項目のない段（使い方など）は、知らせのお知らせの形にする。
 */
function renderChecklistBlock(b: Block, o: RenderOptions): string {
  if (!b.list?.length) return renderBlock(b, o).replace(`<section class="site-section">`, `<section class="site-section site-notice" data-kind="info">`);
  const m = /^(\d+)\.\s*(.*)$/.exec(b.heading);
  const head = m
    ? `<span class="site-step-no">${e(m[1] ?? "")}<span class="site-sr">.</span></span><span>${e(m[2] ?? "")}</span>`
    : `<span>${e(b.heading)}</span>`;
  const out = [
    `      <section class="site-section site-steps-card">`,
    `        <h2 class="site-steps-head">${head}</h2>`,
    ...(b.paragraphs ?? []).map((p) => `        <p>${e(p)}</p>`),
    `        <ul class="site-checks">`,
    ...b.list.map((li) => `          <li><label><input type="checkbox" /><span>${e(li)}</span></label></li>`),
    `        </ul>`,
    ...(b.note ? [`        <p class="site-note">${e(b.note)}</p>`] : []),
    `      </section>`,
  ];
  return out.join("\n");
}

function simplePage(
  meta: PageMeta,
  lead: string,
  blocks: Block[],
  o: RenderOptions,
  extraClass = "",
  block: (b: Block, o: RenderOptions) => string = renderBlock,
): string {
  const body = [
    `      <div class="site-page${extraClass ? ` ${extraClass}` : ""}">`,
    `      <h1>${e(meta.title)}</h1>`,
    `      <p class="site-lead">${e(lead)}</p>`,
    ...blocks.map((b) => block(b, o)),
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
      "見た目では分からない情報（黒塗りの下に残った字・作成者の名前・前の版の残り・添付ファイルなど）を探し、整えた PDF を作ります。",
    ],
  },
  {
    heading: "3. 見つけられる範囲には限りがあります",
    list: [
      "当サービスが調べるのは、検査のページに並べた種類だけです。すべての漏れを見つけられるわけではありません。",
      "「見つかりませんでした」という結果は、調べた種類の中で見つからなかったという意味です。漏れがないことを保証するものではありません。",
      "整えたあとの「残っていません」も、読み直して調べた項目についての結果です。",
      "PDF を公開・提出する前の最後の確かめは、利用者自身がしてください。",
    ],
  },
  {
    heading: "4. 責任について",
    paragraphs: [
      "運営者は、当サービスの結果に誤りや見落としがないことを約束しません。当サービスを使ったこと、または使えなかったことで利用者に損害が生じたときは、運営者に故意または重大な過失がある場合は、法律に従って責任を負います。運営者に故意または重大な過失がない場合（軽い過失の場合を含みます）は、責任を負いません。",
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
      "この規約は、次のどちらかに当たるときに限り、変えることがあります。(1) 変えることが利用者の利益になるとき。(2) 当サービスの目的に反せず、変える必要があり、変えた中身が妥当なとき。",
      "変えるときは、変えた後の規約と、それが効き始める日を、効き始める日より前に、このページで知らせます。変えた中身は、GitHub のリポジトリの履歴でも確かめられます。",
      "効き始める日より後は、変えた後の規約が当てはまります。",
    ],
  },
  {
    heading: "8. 準拠法",
    paragraphs: ["この規約は、日本の法律に従って解釈します。"],
  },
  {
    heading: "9. 定めた日",
    paragraphs: ["2026年11月5日（変えたときは、ここに、変えた日と効き始める日を足します）"],
  },
];

// ---------------------------------------------------------------- お問い合わせ

// お問い合わせは、このページのフォームだけで受け付ける（2026-11-05 本人が決定。GitHub の Issues・非公開の報告の案内は出さない）。
// フォームは、同じサイトの PHP（server/contact-send.php。site.ts が dist/contact-send.php にする）へ、ブラウザのふつうの送信で送る。スクリプトは使わない。
// このページと送り先だけ、CSP の form-action を 'self' にする（csp.ts の withFormActionSelf）。

export const CONTACT_META: PageMeta = {
  path: CONTACT_PATH,
  title: "お問い合わせ",
  description: "お守りPDF への質問・不具合・セキュリティの弱点の知らせは、このページのフォームだけで受け付けています。PDF や個人情報、見つかった字の中身は書かないでください。",
};

/** フォームの種類。value は server/contact-send.php の KINDS と同じ（tests/contact-php.test.ts で照らす） */
export const CONTACT_KINDS: ReadonlyArray<{ value: string; label: string; note?: string }> = [
  { value: "question", label: "質問" },
  { value: "bug", label: "不具合" },
  { value: "security", label: "セキュリティの弱点", note: "弱点の詳しい中身は書かず、連絡先だけ書いてください。こちらから連絡します。" },
  { value: "other", label: "その他" },
];
export const CONTACT_BODY_MAX = 4000;
export const CONTACT_EMAIL_MAX = 254;
/** フォームのすぐ上に置く注意 */
export const CONTACT_WARNING = "PDF や個人情報、見つかった字の中身は書かないでください。";

export const CONTACT_BLOCKS: Block[] = [
  {
    heading: "知らせ方",
    paragraphs: [
      "質問・不具合・直してほしい所・セキュリティの弱点は、このページの下のフォームから送ってください。ほかの窓口では受け付けていません。",
      "送った中身は、運営者にだけメールで届きます。公開はしません。",
    ],
  },
  {
    heading: "書く前に、必ず読んでください",
    list: [
      "PDF のファイルは送れません。業務の PDF の中身や、実在の人名・団体名を書き写さないでください。",
      "見つかった字の中身（黒塗りの下の字・名前・番号など）を、そのまま書かないでください。種類と数だけで十分です。",
      "ブラウザの種類と版、どの手順で何が起きたかを書いてもらえると、調べやすくなります。",
      "名前は要りません。メールアドレスは、返事がほしいときだけ書いてください。",
    ],
  },
  {
    heading: "セキュリティの弱点を見つけたとき",
    paragraphs: [
      "弱点の詳しい中身は、フォームには書かないでください。種類で「セキュリティの弱点」を選び、連絡先のメールアドレスだけを書いて送ってください。こちらから連絡し、詳しい中身の受け取り方を決めます。",
      "直すまでの間は、中身を公開しないでください。",
    ],
  },
];

function contactForm(): string {
  const kinds = CONTACT_KINDS.map((k) =>
    [
      `            <li><label><input type="radio" name="kind" value="${e(k.value)}" required /><span>${e(k.label)}`,
      k.note ? `<span class="site-form-hint">${e(k.note)}</span>` : "",
      `</span></label></li>`,
    ].join(""),
  );
  return [
    `      <section class="site-section" aria-labelledby="contact-form-head">`,
    `        <h2 id="contact-form-head">フォーム</h2>`,
    `        <p class="site-form-warn"><span aria-hidden="true">▲ </span>${e(CONTACT_WARNING)}</p>`,
    `        <form class="site-form" method="post" action="${CONTACT_SEND_PATH}" accept-charset="UTF-8">`,
    `          <fieldset class="site-form-field">`,
    `            <legend>種類<span class="site-form-need">（必ず選ぶ）</span></legend>`,
    `            <ul class="site-form-choices">`,
    ...kinds,
    `            </ul>`,
    `          </fieldset>`,
    `          <div class="site-form-field">`,
    `            <label for="contact-body">本文<span class="site-form-need">（必ず書く。${CONTACT_BODY_MAX} 字まで）</span></label>`,
    `            <textarea id="contact-body" name="body" rows="8" maxlength="${CONTACT_BODY_MAX}" required></textarea>`,
    `          </div>`,
    `          <div class="site-form-field">`,
    `            <label for="contact-email">メールアドレス<span class="site-form-need">（返事がほしいときだけ）</span></label>`,
    `            <input id="contact-email" name="email" type="email" maxlength="${CONTACT_EMAIL_MAX}" autocomplete="email" inputmode="email" aria-describedby="contact-email-hint" />`,
    `            <p class="site-form-hint" id="contact-email-hint">返事のためだけに使います。セキュリティの弱点のときは、必ず書いてください。</p>`,
    `          </div>`,
    // 人には見えない欄（ボットだけが埋める）。読み上げにも出さず、Tab でも止まらない
    `          <div class="site-form-trap" aria-hidden="true">`,
    `            <label for="contact-website">この欄は空のままにしてください</label>`,
    `            <input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off" />`,
    `          </div>`,
    `          <p><button type="submit" class="site-form-submit">送る</button></p>`,
    `        </form>`,
    `        <p class="site-note">送った中身の扱い（何を受け取り、何に使い、いつ消すか）は、<a href="${PRIVACY_PATH}">プライバシーについて</a>に書いています。続けて送ることはできません。</p>`,
    `      </section>`,
  ].join("\n");
}

function renderContact(o: RenderOptions): string {
  // このページだけ、同じサイトへのフォームの送信を許す CSP と、同じサイトへだけ送り元を付ける参照元の決まりにする
  const co: RenderOptions = { ...o, csp: withFormActionSelf(o.csp), referrer: CONTACT_REFERRER };
  const body = [
    `      <div class="site-page">`,
    `      <h1>${e(CONTACT_META.title)}</h1>`,
    `      <p class="site-lead">${e(CONTACT_META.description)}</p>`,
    ...CONTACT_BLOCKS.map((b) => renderBlock(b, co)),
    contactForm(),
    `      <p class="site-back"><a href="/">検査のページへ</a></p>`,
    `      </div>`,
  ].join("\n");
  return layout(CONTACT_META, body, co);
}

/** 送り先の PHP が返す、結果のページ（受け付けた・送れなかった）。送れなかったときの一言は、PHP が CONTACT_MESSAGE_MARK の所に入れる */
export const CONTACT_MESSAGE_MARK = "<!--CONTACT_MESSAGE-->";

export function renderContactResults(o: RenderOptions): { done: string; error: string } {
  const co: RenderOptions = { ...o, csp: withFormActionSelf(o.csp), referrer: CONTACT_REFERRER };
  const page = (title: string, description: string, inner: string[]) =>
    layout(
      { path: CONTACT_SEND_PATH, title, description },
      [`      <div class="site-page">`, `      <h1>${e(title)}</h1>`, ...inner, `      <p class="site-back"><a href="/">検査のページへ</a></p>`, `      </div>`].join("\n"),
      co,
    );
  const done = page("受け付けました", "お守りPDF へのお問い合わせを受け付けました。返事がほしいとメールアドレスを書いたときは、そのアドレスにお返しします。", [
    `      <p class="site-lead">お問い合わせを受け付けました。ありがとうございます。</p>`,
    renderSection({
      heading: "このあと",
      list: [
        "メールアドレスを書いたときは、そのアドレスにお返しします。日にちがかかることがあります。",
        "セキュリティの弱点のときは、書いてもらったアドレスに、こちらから連絡します。",
        "届いたメールは、対応が済んだら消します。長くても、届いてから 90 日で消します。",
      ],
    }),
  ]);
  const error = page("送れませんでした", "お守りPDF へのお問い合わせを、送れませんでした。理由を読み、お問い合わせのページから、もう一度送ってください。", [
    `      <p class="site-form-warn" role="alert"><span aria-hidden="true">▲ </span>${CONTACT_MESSAGE_MARK}</p>`,
    `      <p>ブラウザの「戻る」で前のページに戻ると、書いた中身が残っていることがあります。</p>`,
    `      <p><a href="${CONTACT_PATH}">お問い合わせのページへ</a></p>`,
  ]);
  return { done, error };
}

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
      "検査も、PDF を整えるのも、あなたのパソコンのブラウザの中だけで動きます。PDF の中身やファイルの名前を外へ送る仕組みは、入れていません。",
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
      "検査のページの「整える」で、黒い四角の下の字を消した PDF を作れます。整えたあと、作った PDF を最初から読み直して、残っていないかを確かめます。",
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
    heading: "整えた PDF の見た目は変わりますか？",
    paragraphs: [
      "見えている字や絵は、そのまま残すようにしています。黒い四角の下の字や、見えない字・注釈・添付ファイル・文書情報などを取り除きます。",
      "整えたあとは、作った PDF を開いて、見た目と中身をご自身でも確かめてください。",
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
      "できます。提出先に容量の上限があるときは、検査のページで PDF を整えたあとに出る「ファイルを小さくする」を使います。整えた PDF の画像を縮めて書き直し、字・図形は変えません。", "小さくしたあとも、もう一度最初から検査し直し、整えて消したものが戻っていないかを確かめます。小さくした PDF を開いて、画像が読めるか（細かい字が潰れていないか）も、ご自身で確かめてください。",
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
    paragraphs: ["お問い合わせのページのフォームで受け付けています。PDF や個人情報、見つかった字の中身は書かないでください。"],
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
      "検査のページで調べ、見つかったものを「整える」で直したか",
      "整えた PDF を開き、見た目が崩れていないか、消した所の下の字が選べないかを確かめたか（P6・P7）",
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
      p(e("このサイトのファイルに入っていて、あなたのブラウザで動く部品です（検査・PDF を整える・ページの絵を描くのに使います）。")),
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

// ---------------------------------------------------------------- 検査のページの利用規約のダイアログ

/** index.html の中で、利用規約のダイアログに置き換える目印（site.ts の transformIndexHtml が置き換える） */
export const TERMS_DIALOG_MARKER = "<!-- terms-dialog -->";

/**
 * 検査のページ（index.html）に埋め込む、利用規約のダイアログ（<dialog>）。
 * 文は利用規約のページと同じ TERMS_META・TERMS_BLOCKS から作る（2 か所で文がずれないように）。
 * 検査のページは通信をしないので、開くときに取りに行かず、ビルドの時にページの中へ入れておく。
 * data-page は、押したときにダイアログで開くリンクの場所（src/ui/terms-dialog.ts が、この href のリンクだけを止める）
 */
export function renderTermsDialog(o: Pick<RenderOptions, "repoUrl">): string {
  return [
    `<dialog class="terms-dialog" id="terms-dialog" aria-labelledby="terms-dialog-title" data-page="${e(TERMS_PATH)}">`,
    `  <div class="terms-dialog-head">`,
    `    <h2 class="terms-dialog-title" id="terms-dialog-title" tabindex="-1">${e(TERMS_META.title)}</h2>`,
    `    <button type="button" class="terms-dialog-close" id="terms-dialog-close">閉じる</button>`,
    `  </div>`,
    `  <div class="terms-dialog-body" tabindex="0" role="region" aria-label="${e(TERMS_META.title)}の本文">`,
    `      <p class="site-lead">${e(TERMS_META.description)}</p>`,
    ...TERMS_BLOCKS.map((b) => renderBlock(b, o, 3)),
    `      <p class="terms-dialog-page"><a href="${e(TERMS_PATH)}" data-terms-page>利用規約のページで開く</a></p>`,
    `  </div>`,
    `</dialog>`,
  ].join("\n");
}

// ---------------------------------------------------------------- まとめ

/** サイトの案内のページの場所（sitemap に足す） */
export const GUIDE_PATHS = [CHECKLIST_PATH, FAQ_PATH, TERMS_PATH, LICENSES_PATH, CONTACT_PATH];

/** サイトの案内のページを全部作る。鍵は dist/ の中のファイルの名前 */
export function renderGuidePages(o: RenderOptions, licenses: LicenseData): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set(fileFor(CHECKLIST_PATH), simplePage(CHECKLIST_META, CHECKLIST_META.description, CHECKLIST_BLOCKS, o, "site-checklist", renderChecklistBlock));
  pages.set(fileFor(FAQ_PATH), simplePage(FAQ_META, FAQ_META.description, FAQ_BLOCKS, o));
  pages.set(fileFor(TERMS_PATH), simplePage(TERMS_META, TERMS_META.description, TERMS_BLOCKS, o));
  pages.set(fileFor(CONTACT_PATH), renderContact(o));
  pages.set(fileFor(LICENSES_PATH), renderLicenses(o, licenses));
  pages.set(fileFor(NOT_FOUND_META.path), simplePage(NOT_FOUND_META, NOT_FOUND_META.description, NOT_FOUND_BLOCKS, o));
  return pages;
}
