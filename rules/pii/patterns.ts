// SPDX-License-Identifier: AGPL-3.0-only
//
// 個人情報らしい字の型ごとの探し方（rules/pii）。1行（縦書きは1列）の字の並びを受け取り、見つけた範囲と型と確からしさを返す。
// 字の中身は、この中で判定にだけ使い、返さない（返すのは並びの中の位置だけ）。
//
// 確からしさ：
//   high  … 前後の語（「氏名」「住所」「生年月日」など）や、表の見出しが、その型を指している。または、型そのものが強い手がかり（携帯電話の番号など）
//   check … 形は合うが、前後の語がない。利用者に確かめてもらう
// 除いたもの（返さず、理由ごとに数える）：役職名・団体名・見出しの語・様式の見本の値・団体の代表電話・法人番号・日付の並び など。

export type PiiType = "name" | "address" | "phone" | "my_number" | "bank_account" | "birth_date" | "email" | "card_number";
export const PII_TYPES: readonly PiiType[] = ["name", "address", "phone", "my_number", "bank_account", "birth_date", "email", "card_number"];

export type Confidence = "high" | "check";
/** 何を手がかりにしたか（画面で「なぜ候補にしたか」を、中身を出さずに説明するため） */
export type Basis = "label" | "column_header" | "honorific" | "pattern" | "check_digit";

export type ExcludeReason =
  | "sample" // 様式の見本の値（山田太郎・000-0000 など）、「記入例」「見本」の行
  | "role" // 役職名だけ
  | "organization" // 団体名・課の名前
  | "heading" // 見出しの語（「住所」など）
  | "office_contact" // 団体の代表電話・問い合わせ先・所在地
  | "free_dial" // 0120 などの事業者の番号
  | "corporate_number" // 法人番号（13 けた。公表されている番号）
  | "date_like" // 日付・時刻の並び
  | "placeholder"; // 伏せたことを示す語（非公開・記載省略 など）

export type Hit = { type: PiiType; start: number; end: number; confidence: Confidence; basis: Basis };
export type LineScan = { hits: Hit[]; excluded: Array<{ type: PiiType; reason: ExcludeReason }> };

// ---------------------------------------------------------------- 字をそろえる

const DASH = /[‐‑‒–—―−ｰー－─━﹣]/u;
const KANJI_DIGIT: Record<string, string> = { "〇": "0", "○": "0", "零": "0", "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9" };

/** 1字ずつ NFKC にかける（全角の英数字・記号を半角に）。字数が変わる字（㍻ など）はそのまま。長さは元と同じ */
export function normalize(s: string): string {
  let out = "";
  for (const ch of s) {
    const n = ch.normalize("NFKC");
    out += [...n].length === 1 && n.length === ch.length ? n : ch;
  }
  return out;
}

/** 数字を探すための並び：漢数字（〇〜九）を数字に、ダッシュの仲間を - にする。長さは元と同じ */
export function numericView(norm: string): string {
  let out = "";
  for (const ch of norm) {
    if (KANJI_DIGIT[ch] !== undefined && ch.length === 1) out += KANJI_DIGIT[ch];
    else if (DASH.test(ch) && ch.length === 1) out += "-";
    else out += ch;
  }
  return out;
}

/** 漢数字（十・百を含む）や数字の並びを数にする。読めなければ NaN */
export function parseNumber(s: string): number {
  const t = numericView(normalize(s));
  if (/^\d+$/.test(t)) return Number(t);
  if (t === "元") return 1;
  // 十・百を含む漢数字（例：六十二、十二、二十、百二）
  if (/^[0-9十百]+$/.test(t)) {
    let total = 0;
    let cur = 0;
    for (const ch of t) {
      if (ch === "百") {
        total += (cur || 1) * 100;
        cur = 0;
      } else if (ch === "十") {
        total += (cur || 1) * 10;
        cur = 0;
      } else cur = cur * 10 + Number(ch);
    }
    return total + cur;
  }
  return NaN;
}

// ---------------------------------------------------------------- 語の一覧

const HAN = "\\p{Script=Han}々〆ヶ";
const KANA = "\\p{Script=Hiragana}\\p{Script=Katakana}ー";
const NAME_CH = `[${HAN}${KANA}]`;

/** 氏名を指す語（確からしさ：高） */
const NAME_LABELS_HIGH = [
  "氏名", "氏 名", "お名前", "名前", "フリガナ", "ふりがな", "申請者", "申請人", "届出人", "請求者", "申込者", "応募者", "代表者",
  "保護者", "世帯主", "被保険者", "契約者", "受給者", "患者", "相続人", "筆頭者", "本人氏名", "連絡者", "署名",
];
/** 氏名を指すが、職員・係の名前のことも多い語（確からしさ：確認） */
const NAME_LABELS_CHECK = ["担当者名", "担当者", "担当", "作成者", "記入者", "起案者", "決裁者", "回答者", "報告者"];

const ROLE_WORDS = [
  "市長", "副市長", "町長", "副町長", "村長", "副村長", "区長", "知事", "副知事", "議長", "副議長", "委員長", "副委員長", "委員", "部長", "次長",
  "課長", "課長補佐", "係長", "主任", "主査", "主事", "参事", "会長", "副会長", "理事長", "理事", "監事", "社長", "副社長", "取締役",
  "代表取締役", "校長", "教頭", "教諭", "所長", "局長", "室長", "館長", "園長", "院長", "代表", "職員", "事務局", "事務局長", "幹事",
  "総裁", "大臣", "長官", "審議官", "議員", "教授", "准教授", "講師", "弁護士", "医師", "担当者", "担当", "責任者", "管理者",
];
/** 団体・組織の語尾（ここで終わる並びは、人の名前ではなく団体の名前とみなす） */
const ORG_SUFFIXES = [
  "課", "係", "部", "局", "室", "班", "庁", "省", "市", "町", "村", "区", "県", "都", "府", "道", "会", "社", "所", "署", "館", "園", "院",
  "校", "学校", "大学", "協会", "委員会", "議会", "審議会", "センター", "株式会社", "法人", "組合", "団体", "グループ", "チーム", "事務局",
  "本部", "支部", "支店", "営業所", "連合", "機構", "財団", "研究所", "病院", "診療所", "役所", "役場",
];
/**
 * 名字の終わりにもなる語尾（阿部・中村・田所・氷室・高市 など）。並びが 4 字以上か、前が部署の語（総務部の「総務」など）か、
 * かなで始まる（みどり市 など）ときだけ、団体名とみなす。
 */
const WEAK_ORG_SUFFIXES = ["部", "市", "町", "村", "区", "会", "所", "館", "園", "院", "校", "社", "道", "室"];
const DEPT_WORDS = [
  "総務", "財務", "財政", "企画", "政策", "市民", "区民", "町民", "村民", "県民", "福祉", "環境", "建設", "教育", "経済", "産業", "保健", "健康",
  "都市", "管理", "営業", "技術", "開発", "人事", "経理", "生活", "消防", "議会", "選挙", "監査", "会計", "税務", "農林", "水道", "土木", "観光",
  "文化", "情報", "広報", "秘書", "法務", "危機", "防災", "交通", "港湾", "住宅", "医療", "介護", "子育", "事業", "本", "支", "事務", "研究", "調査",
];
export function isOrganizationName(part: string): boolean {
  const s = part.trim();
  if (s.length < 2) return false;
  if (ORG_SUFFIXES.filter((x) => !WEAK_ORG_SUFFIXES.includes(x)).some((x) => s.endsWith(x))) return true;
  const weak = WEAK_ORG_SUFFIXES.find((x) => s.endsWith(x));
  if (!weak) return false;
  const stem = s.slice(0, s.length - weak.length);
  return s.length >= 4 || DEPT_WORDS.some((w) => stem.endsWith(w)) || /^[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s);
}

/** 見出しの語（表の見出しの並びを、氏名と取り違えないため） */
const HEADING_WORDS = [
  "氏名", "名前", "お名前", "住所", "現住所", "所在地", "電話", "電話番号", "連絡先", "生年月日", "年齢", "性別", "職業", "所属", "備考",
  "印", "続柄", "番号", "メール", "フリガナ", "ふりがな", "署名", "日付", "年月日", "期間", "金額", "合計", "内容", "区分", "種別", "件名",
  "方法", "場所", "日時", "目的", "理由", "結果", "様式", "記入例", "見本", "なし", "あり", "不明", "未定", "同上",
];
/** 伏せたこと・書いていないことを示す語（「氏名：非公開」など。中身は個人情報ではない） */
const PLACEHOLDER_WORDS = /^(非公開|非開示|不開示|部分開示|公開しない|記載省略|記入省略|省略|略|匿名|黒塗り|墨消し|伏せ字|未記入|記入不要|空欄|該当なし|なし|不明|未定|別紙|別添|別記|別表|同上|個人名|個人情報|本人|申請者)$/u;

/** 様式の見本の名前（よく使われる見本の値） */
const SAMPLE_NAMES = ["山田太郎", "山田花子", "山田一郎", "鈴木一郎", "鈴木花子", "佐藤太郎", "佐藤花子", "田中太郎", "田中花子", "日本太郎", "日本花子", "見本太郎"];
/** 「様」の前に来ても人の名前ではない語 */
const NOT_NAME_BEFORE_HONORIFIC = ["各位", "皆", "皆々", "お客", "客", "利用者", "関係者", "御中", "保護者", "参加者", "来場者", "住民", "市民", "県民", "町民", "村民", "区民", "神", "仏", "王", "殿", "奥", "旦那", "先方", "相手", "貴", "同", "両", "諸", "故"];

const SAMPLE_MARK = /[〇○△×✕＊*]{2,}|某|ＸＸ|XX|xx/u;
/** 行に見本・記入例を示す語があれば、その行の候補は見本の値とみなす */
const SAMPLE_LINE = /記入例|記載例|見本|サンプル|【例】|〔例〕|［例］|\[例\]|例[)）]|（例|\(例/u;
/** 団体の窓口を示す語（電話・メール・住所を、団体の連絡先とみなす） */
const OFFICE_CONTEXT = /代表|問い?合わ?せ|問合せ|窓口|事務局|役所|役場|庁舎|内線|FAX|Fax|fax|ファクス|ファックス|受付|(?:課|係(?![るりわ])|センター)(?![\p{Script=Han}])/u;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alt = (words: string[]) => [...words].sort((a, b) => b.length - a.length).map(escape).join("|");

// ---------------------------------------------------------------- 番号の確かめ

/** マイナンバー（12 けた）の検査用の数字（最後の1けた）が合うか */
export function isValidMyNumber(d: string): boolean {
  if (!/^\d{12}$/.test(d)) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = Number(d[11 - n]);
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const r = sum % 11;
  const check = r <= 1 ? 0 : 11 - r;
  return check === Number(d[11]);
}

/** 法人番号（13 けた）の検査用の数字（最初の1けた）が合うか */
export function isValidCorporateNumber(d: string): boolean {
  if (!/^\d{13}$/.test(d)) return false;
  let sum = 0;
  for (let n = 1; n <= 12; n++) {
    const p = Number(d[13 - n]);
    sum += p * (n % 2 === 1 ? 1 : 2);
  }
  return Number(d[0]) === 9 - (sum % 9);
}

/** カード番号の検査（Luhn） */
export function isLuhnValid(d: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let v = Number(d[i]);
    if (dbl) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
    dbl = !dbl;
  }
  return d.length > 0 && sum % 10 === 0;
}

function hasCardPrefix(d: string): boolean {
  const p2 = Number(d.slice(0, 2));
  const p4 = Number(d.slice(0, 4));
  return d[0] === "4" || (p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720) || p2 === 34 || p2 === 37 || (p4 >= 3528 && p4 <= 3589) || p2 === 36 || p2 === 38 || p4 === 6011 || p2 === 65;
}

/** 見本らしい数字（全部同じ数字・1234… の並び・0 が大半） */
function isSampleDigits(d: string): boolean {
  if (/^(\d)\1+$/.test(d)) return true;
  const asc = "01234567890123456789";
  const desc = "98765432109876543210";
  if (d.length >= 6 && (asc.includes(d) || desc.includes(d))) return true;
  const zeros = [...d].filter((c) => c === "0").length;
  return zeros >= d.length - 2;
}

/** 日付・時刻の並び（yyyymmdd・yyyymmddhhmm・yyyymmddhhmmss など）として読めるか */
function isDateLikeDigits(d: string): boolean {
  const y = Number(d.slice(0, 4));
  const mo = Number(d.slice(4, 6));
  const da = Number(d.slice(6, 8));
  if (!(y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return false;
  const rest = d.slice(8);
  if (rest.length >= 2 && Number(rest.slice(0, 2)) > 23) return false;
  if (rest.length >= 4 && Number(rest.slice(2, 4)) > 59) return false;
  return true;
}

// ---------------------------------------------------------------- 型ごとの探し方

type Ctx = { norm: string; num: string; sampleLine: boolean; office: boolean; out: LineScan };

function add(ctx: Ctx, hit: Hit) {
  if (ctx.sampleLine) {
    ctx.out.excluded.push({ type: hit.type, reason: "sample" });
    return;
  }
  ctx.out.hits.push(hit);
}
const exclude = (ctx: Ctx, type: PiiType, reason: ExcludeReason) => ctx.out.excluded.push({ type, reason });

/** 範囲 [start, end) の直前の、同じ欄（区切り \t の前まで）の字の並び */
function before(ctx: Ctx, start: number, max = 16): string {
  return ctx.norm.slice(Math.max(0, start - max), start);
}

function scanEmail(ctx: Ctx) {
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  for (const m of ctx.norm.matchAll(re)) {
    const [local, domain] = m[0].toLowerCase().split("@") as [string, string];
    if (/^example\.(com|net|org|jp)$|\.example$/.test(domain) || /^(sample|test|xxx+|aaa+|user|taro|hanako)$/.test(local)) {
      exclude(ctx, "email", "sample");
      continue;
    }
    if (/^(info|contact|webmaster|postmaster|admin|support|office|inquiry|toiawase|otoiawase|koho|kouhou|press|master|noreply|no-reply|soumu|jimukyoku|madoguchi)$/.test(local.replace(/[-_.]?\d*$/, ""))) {
      exclude(ctx, "email", "office_contact");
      continue;
    }
    if (ctx.office) {
      exclude(ctx, "email", "office_contact");
      continue;
    }
    const label = /個人|本人|自宅|私用/.test(before(ctx, m.index!, 20));
    add(ctx, { type: "email", start: m.index!, end: m.index! + m[0].length, confidence: label ? "high" : "check", basis: label ? "label" : "pattern" });
  }
}

const PHONE_PERSONAL_LABEL = /携帯|自宅|緊急連絡先|本人|保護者|連絡先|電話|TEL|Tel|tel|☎|℡/u;
const PHONE_STRONG_LABEL = /携帯|自宅|緊急連絡先|本人|保護者/u;

function scanPhone(ctx: Ctx, opts: { columnHeader?: boolean } = {}) {
  // 0 で始まり、数字と区切り（- ( ) 空白）が続く並び。前後に数字・- がないこと
  const re = /(?<![\d\-.])\(?0[\d\-() ]{7,16}\d(?![\d\-])/g;
  for (const m of ctx.num.matchAll(re)) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, "");
    const groups = raw.split(/[-() ]+/).filter(Boolean);
    if (digits.length !== 10 && digits.length !== 11) continue;
    if (groups.length > 4) continue;
    const start = m.index!;
    const end = start + raw.length;
    const lbl = before(ctx, start, 14);
    const labeled = PHONE_PERSONAL_LABEL.test(lbl) || opts.columnHeader === true;
    // 区切りのない並びは、前に電話を指す語があるときだけ
    if (groups.length === 1 && !labeled) continue;
    const mobile = digits.length === 11 && /^0[789]0/.test(digits);
    const ip = digits.length === 11 && /^050/.test(digits);
    if (digits.length === 11 && !mobile && !ip) continue;
    // 0120・0800 などは 10 けた（080・090 の携帯は 11 けたなので、頭が同じでも取り違えない）
    if (digits.length === 10 && /^0(120|800|570|180|990)/.test(digits)) {
      exclude(ctx, "phone", "free_dial");
      continue;
    }
    // 固定電話で区切りがあるとき、市内局番（2つめの組）が 1 で始まる番号は使われていない（1 は特番）。図番・日付などの並び
    if (digits.length === 10 && groups.length === 3 && /^1/.test(groups[1]!)) continue;
    // 局番のあとが全部同じ数字、または 0 ばかり → 見本
    const subscriber = digits.slice(-8);
    if (isSampleDigits(subscriber) || isSampleDigits(digits.slice(1))) {
      exclude(ctx, "phone", "sample");
      continue;
    }
    const strong = PHONE_STRONG_LABEL.test(lbl);
    if (mobile || ip) {
      add(ctx, { type: "phone", start, end, confidence: ctx.office && !strong ? "check" : "high", basis: strong || labeled ? (opts.columnHeader ? "column_header" : "label") : "pattern" });
      continue;
    }
    if (strong) {
      add(ctx, { type: "phone", start, end, confidence: "high", basis: "label" });
      continue;
    }
    if (ctx.office) {
      exclude(ctx, "phone", "office_contact");
      continue;
    }
    add(ctx, { type: "phone", start, end, confidence: opts.columnHeader ? "high" : "check", basis: opts.columnHeader ? "column_header" : labeled ? "label" : "pattern" });
  }
}

function scanNumbers(ctx: Ctx) {
  // 13 けた（法人番号）：除いたものとして数える
  // 数字の並びの境目：空白・ハイフンをはさんで数字が続く所（16 けたのカード番号の途中など）では切らない
  for (const m of ctx.num.matchAll(/(?<!\d[ -]?)(\d)[ -]?(\d{4})[ -]?(\d{4})[ -]?(\d{4})(?![ -]?\d)/g)) {
    const d = m.slice(1).join("");
    if (isValidCorporateNumber(d)) exclude(ctx, "my_number", "corporate_number");
  }
  // 12 けた（マイナンバー）：4・4・4 の区切りか、区切りなし
  for (const m of ctx.num.matchAll(/(?<!\d[ -]?)(\d{4})([ -]?)(\d{4})\2(\d{4})(?![ -]?\d)/g)) {
    const d = m[1]! + m[3]! + m[4]!;
    const start = m.index!;
    const end = start + m[0].length;
    const lbl = before(ctx, start, 16);
    if (/法人番号|会社法人等番号/.test(lbl)) {
      exclude(ctx, "my_number", "corporate_number");
      continue;
    }
    if (!isValidMyNumber(d)) continue;
    const labeled = /個人番号|マイナンバー|マイ・ナンバー/.test(lbl);
    if (isSampleDigits(d)) {
      exclude(ctx, "my_number", "sample");
      continue;
    }
    if (!labeled && isDateLikeDigits(d)) {
      exclude(ctx, "my_number", "date_like");
      continue;
    }
    add(ctx, { type: "my_number", start, end, confidence: labeled ? "high" : "check", basis: labeled ? "label" : "check_digit" });
  }
  // 14〜16 けた（カード番号）：4 けたずつの区切りか区切りなし。Luhn と、番号の頭で確かめる
  for (const m of ctx.num.matchAll(/(?<!\d[ -]?)(\d{4})([ -]?)(\d{4})\2(\d{4})\2(\d{2,4})(?![ -]?\d)/g)) {
    const d = m[1]! + m[3]! + m[4]! + m[5]!;
    const start = m.index!;
    const end = start + m[0].length;
    if (!isLuhnValid(d) || !hasCardPrefix(d)) continue;
    if (isDateLikeDigits(d)) {
      exclude(ctx, "card_number", "date_like");
      continue;
    }
    if (isSampleDigits(d) || /^4111111111111111$|^4242424242424242$|^5555555555554444$/.test(d)) {
      exclude(ctx, "card_number", "sample");
      continue;
    }
    const labeled = /カード|クレジット/.test(before(ctx, start, 16));
    add(ctx, { type: "card_number", start, end, confidence: labeled ? "high" : "check", basis: labeled ? "label" : "check_digit" });
  }
}

function scanBankAccount(ctx: Ctx) {
  // 口座の種類・「口座番号」のあとの 7 けた
  const re = /(口座番号|口座|普通預金|当座預金|普通|当座|貯蓄)[^\d\t]{0,10}?(?<![\d-])(\d{7})(?![\d-])/g;
  for (const m of ctx.num.matchAll(re)) {
    const d = m[2]!;
    const start = m.index! + m[0].length - d.length;
    const end = start + d.length;
    if (isSampleDigits(d)) {
      exclude(ctx, "bank_account", "sample");
      continue;
    }
    const payee = /振込先|振込口座|振り込み先|払込先/.test(ctx.norm);
    add(ctx, { type: "bank_account", start, end, confidence: payee ? "check" : "high", basis: "label" });
  }
  // ゆうちょの記号・番号（5 けた − 8 けた）
  for (const m of ctx.num.matchAll(/(?:記号[^\d\t]{0,4})?(?<![\d-])(\d{5})[- ]?(?:番号[^\d\t]{0,4})?(\d{8})(?![\d-])/g)) {
    const lbl = before(ctx, m.index!, 16) + m[0];
    if (!/記号|ゆうちょ|振替/.test(lbl)) continue;
    const d = m[1]! + m[2]!;
    if (isSampleDigits(d)) {
      exclude(ctx, "bank_account", "sample");
      continue;
    }
    const start = m.index! + m[0].indexOf(m[1]!);
    add(ctx, { type: "bank_account", start, end: m.index! + m[0].length, confidence: "high", basis: "label" });
  }
}

const N = "[0-9〇一二三四五六七八九十元]";
const ERA = "(?:明治|大正|昭和|平成|令和|[MTSHR]\\.?)";
const DATE_RE = new RegExp(
  `(?:${ERA}\\s?(${N}{1,3})\\s?年\\s?(${N}{1,3})\\s?月\\s?(${N}{1,3})\\s?日|((?:19|20)\\d\\d)\\s?年\\s?(\\d{1,2})\\s?月\\s?(\\d{1,2})\\s?日|((?:19|20)\\d\\d)[/.\\-](\\d{1,2})[/.\\-](\\d{1,2})|${ERA}(\\d{1,2})[/.](\\d{1,2})[/.](\\d{1,2}))`,
  "gu",
);
const BIRTH_LABEL = /生年月日|誕生日|出生日|生まれた日|出生年月日/u;

function scanBirthDate(ctx: Ctx, opts: { columnHeader?: boolean } = {}) {
  for (const m of ctx.norm.matchAll(DATE_RE)) {
    const g = m.slice(1);
    const mo = parseNumber(g[1] ?? g[4] ?? g[7] ?? g[10] ?? "");
    const da = parseNumber(g[2] ?? g[5] ?? g[8] ?? g[11] ?? "");
    if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) continue;
    const start = m.index!;
    const end = start + m[0].length;
    const lbl = before(ctx, start, 16);
    const after = ctx.norm.slice(end, end + 4);
    const label = BIRTH_LABEL.test(lbl);
    const born = /^\s?(生まれ|生|誕生)/u.test(after);
    if (!label && !born && !opts.columnHeader) continue; // ふつうの日付（作成日など）は候補にしない
    add(ctx, { type: "birth_date", start, end, confidence: "high", basis: opts.columnHeader ? "column_header" : "label" });
  }
}

const ADDR_NUM = "[0-9〇一二三四五六七八九十百]+";
const ADDR_BLOCK = `${ADDR_NUM}(?:丁目|番地|番|号|-|の)(?:${ADDR_NUM}(?:丁目|番地|番|号|-|の)?){0,4}`;
const ADDR_PLACE = `[${HAN}${KANA}ヶケ]`;
const ADDRESS_RE = new RegExp(`(?:${ADDR_PLACE}{2,3}[都道府県]\\s?)?${ADDR_PLACE}{1,6}?[市区町村郡]\\s?${ADDR_PLACE}{0,12}?\\s?${ADDR_BLOCK}`, "gu");
const ADDRESS_LOOSE_RE = new RegExp(`${ADDR_PLACE}{1,14}?\\s?${ADDR_BLOCK}`, "gu");
const ADDRESS_LABEL = /住\s?所|現住所|自宅|居所|本籍|住民票|届出地|送付先/u;
const ADDRESS_ORG_LABEL = /所在地|会場|場所|本社|本店|事務所|庁舎|開催地|開催場所|集合場所/u;

function scanAddress(ctx: Ctx, opts: { columnHeader?: boolean } = {}) {
  const re = opts.columnHeader ? ADDRESS_LOOSE_RE : ADDRESS_RE;
  re.lastIndex = 0;
  for (const m of ctx.norm.matchAll(re)) {
    let start = m.index!;
    const text = m[0];
    const end = start + text.length;
    // 前の語（「住所」など）が並びに入り込んだら、そこまでを外す
    const lead = text.match(new RegExp(`^.*?(${ADDRESS_LABEL.source}|${ADDRESS_ORG_LABEL.source})[:：\\s]*`, "u"));
    if (lead) start += lead[0].length;
    const body = ctx.norm.slice(start, end);
    // 住所の番地は、数が2つ以上（1丁目2番、1-2 など）。前に住所を指す語・表の見出しがあれば1つでもよい
    const nums = body.match(new RegExp(ADDR_NUM, "gu")) ?? [];
    const lbl = before(ctx, start, 16) + ctx.norm.slice(m.index!, start);
    const labeled = ADDRESS_LABEL.test(lbl) || opts.columnHeader === true;
    if (nums.length < 2 && !labeled) continue;
    if (/^第/.test(body) || /[条項]/.test(body)) continue; // 条文の番号
    if (SAMPLE_MARK.test(body)) {
      exclude(ctx, "address", "sample");
      continue;
    }
    if (ADDRESS_ORG_LABEL.test(lbl)) {
      exclude(ctx, "address", "office_contact");
      continue;
    }
    if (ctx.office && !ADDRESS_LABEL.test(lbl)) {
      exclude(ctx, "address", "office_contact");
      continue;
    }
    add(ctx, { type: "address", start, end, confidence: labeled ? "high" : "check", basis: opts.columnHeader ? "column_header" : labeled ? "label" : "pattern" });
  }
}

/** 氏名らしい並びかを確かめる。だめなら除く理由を、よければ null を返す（"skip" は何も数えない） */
export function judgeName(raw: string, opts: { kanaOk?: boolean } = {}): ExcludeReason | "skip" | null {
  const s = raw.replace(/[\s　]+/g, " ").trim();
  const compact = s.replace(/ /g, "");
  if (compact.length < 2 || compact.length > 10) return "skip";
  if (SAMPLE_MARK.test(compact) || SAMPLE_NAMES.includes(compact)) return "sample";
  if (PLACEHOLDER_WORDS.test(compact)) return "placeholder";
  if (HEADING_WORDS.includes(compact)) return "heading";
  if (ROLE_WORDS.includes(compact)) return "role";
  if (ROLE_WORDS.some((r) => compact.endsWith(r) && compact.length > r.length)) return "role"; // 総務課長 など
  // 語ごとに団体名かを見る（「企画課 内線」のように、団体名のあとに別の語が続く並び）
  if (s.split(" ").some(isOrganizationName)) return "organization";
  if (new RegExp(`^[\\p{Script=Hiragana}ー]+$`, "u").test(compact) && !opts.kanaOk) return "skip";
  if (!new RegExp(`^${NAME_CH}+$`, "u").test(compact)) return "skip";
  return null;
}

const NAME_LABEL_RE = new RegExp(
  `(${alt([...NAME_LABELS_HIGH, ...NAME_LABELS_CHECK])})(?:[（(][^）)]{0,8}[）)])?[:：\\s\\t]+(${NAME_CH}{1,6}(?: ${NAME_CH}{1,6})?)`,
  "gu",
);

function scanNameByLabel(ctx: Ctx) {
  for (const m of ctx.norm.matchAll(NAME_LABEL_RE)) {
    const label = m[1]!;
    let value = m[2]!;
    let offset = m.index! + m[0].length - m[2]!.length; // 値の並びの始まり
    // あとの部分が見出しの語（「住所」など）なら外す
    const parts = value.split(" ");
    while (parts.length > 1 && (HEADING_WORDS.includes(parts[parts.length - 1]!) || ROLE_WORDS.includes(parts[parts.length - 1]!))) parts.pop();
    value = parts.join(" ");
    // 前に役職がつく並び（「会長 朝霧」など）は、役職を外して確かめる
    let roleFirst = false;
    for (const r of [...ROLE_WORDS].sort((a, b) => b.length - a.length)) {
      if (value.startsWith(r + " ")) {
        value = value.slice(r.length + 1);
        offset += r.length + 1;
        roleFirst = true;
        break;
      }
    }
    const start = offset;
    const end = start + value.length;
    const kanaOk = /ふりがな|フリガナ/.test(label);
    const verdict = judgeName(value, { kanaOk });
    if (verdict === "skip") continue;
    if (verdict) {
      exclude(ctx, "name", verdict);
      continue;
    }
    const high = NAME_LABELS_HIGH.includes(label) && !roleFirst;
    add(ctx, { type: "name", start, end, confidence: high ? "high" : "check", basis: "label" });
  }
}

// 「担当」「担当者」は氏名を指す語（scanNameByLabel）で扱うので、ここでは外す（同じ所を2度数えない）
const ROLE_NAME_RE = new RegExp(`(?<![${HAN}])(${alt(ROLE_WORDS.filter((r) => !NAME_LABELS_CHECK.includes(r)))})[ :：]+(${NAME_CH}{1,6}(?: ${NAME_CH}{1,6})?)`, "gu");

/** 役職のあとの名前（「会長 宵町 律」など）。公表された役職の人のことも多いので、確からしさは「確認」 */
function scanNameByRole(ctx: Ctx, taken: Array<[number, number]>) {
  for (const m of ctx.norm.matchAll(ROLE_NAME_RE)) {
    const parts = m[2]!.split(" ");
    while (parts.length > 1 && (HEADING_WORDS.includes(parts[parts.length - 1]!) || ROLE_WORDS.includes(parts[parts.length - 1]!))) parts.pop();
    const value = parts.join(" ");
    const start = m.index! + m[0].length - m[2]!.length;
    const end = start + value.length;
    if (taken.some(([a, b]) => start < b && a < end)) continue;
    const verdict = judgeName(value);
    if (verdict === "skip") continue;
    if (verdict) {
      exclude(ctx, "name", verdict);
      continue;
    }
    add(ctx, { type: "name", start, end, confidence: "check", basis: "label" });
  }
}

const HONORIFIC_RE = new RegExp(`(?<![${HAN}])([${HAN}]{1,4}(?: [${HAN}]{1,4})?) ?(様|殿|さん|氏(?!名)|君)`, "gu");

function scanNameByHonorific(ctx: Ctx, taken: Array<[number, number]>) {
  for (const m of ctx.norm.matchAll(HONORIFIC_RE)) {
    const value = m[1]!;
    const start = m.index!;
    const end = start + value.length;
    if (taken.some(([a, b]) => start < b && a < end)) continue;
    const compact = value.replace(/ /g, "");
    if (NOT_NAME_BEFORE_HONORIFIC.some((w) => compact === w || compact.endsWith(w)) || /^[同両各貴御諸故]/u.test(compact)) continue;
    const verdict = judgeName(value);
    if (verdict === "skip") continue;
    if (verdict) {
      exclude(ctx, "name", verdict);
      continue;
    }
    add(ctx, { type: "name", start, end, confidence: "check", basis: "honorific" });
  }
}

// ---------------------------------------------------------------- 入口

/** 1行の字の並びから探す */
export function scanLine(text: string): LineScan {
  const norm = normalize(text);
  const out: LineScan = { hits: [], excluded: [] };
  const ctx: Ctx = { norm, num: numericView(norm), sampleLine: SAMPLE_LINE.test(norm), office: OFFICE_CONTEXT.test(norm), out };
  scanEmail(ctx);
  scanPhone(ctx);
  scanNumbers(ctx);
  scanBankAccount(ctx);
  scanBirthDate(ctx);
  scanAddress(ctx);
  scanNameByLabel(ctx);
  const names = (): Array<[number, number]> => out.hits.filter((h) => h.type === "name").map((h) => [h.start, h.end]);
  scanNameByRole(ctx, names());
  scanNameByHonorific(ctx, names());
  out.hits = dedupe(out.hits);
  return out;
}

/** 表の見出し（列の上の「氏名」「住所」など）から、その列の値の型を決める */
export type ColumnKind = "name" | "address" | "phone" | "birth_date";
const COLUMN_HEADERS: Array<[RegExp, ColumnKind]> = [
  [/^(氏\s*名|名前|お名前|氏名\s*[（(]?(フリガナ|ふりがな)?[）)]?|フリガナ|ふりがな|申請者|保護者|代表者|委員名)$/u, "name"],
  [/^(住\s*所|現住所|自宅住所)$/u, "address"],
  [/^(電話|電話番号|連絡先|携帯|携帯電話|自宅電話|TEL|Tel)$/u, "phone"],
  [/^(生年月日|誕生日)$/u, "birth_date"],
];
export function columnKindOf(header: string): ColumnKind | null {
  const s = normalize(header).trim();
  for (const [re, k] of COLUMN_HEADERS) if (re.test(s)) return k;
  return null;
}

/** 表の1つの欄の値を、見出しが指す型として確かめる。範囲は値の並びの中の位置 */
export function scanCell(text: string, kind: ColumnKind, rowContext: string): LineScan {
  const norm = normalize(text);
  const out: LineScan = { hits: [], excluded: [] };
  const ctx: Ctx = { norm, num: numericView(norm), sampleLine: SAMPLE_LINE.test(normalize(rowContext)), office: false, out };
  if (kind === "name") {
    const lead = norm.length - norm.trimStart().length;
    const value = norm.trim();
    const verdict = judgeName(value, { kanaOk: true });
    if (verdict === null) add(ctx, { type: "name", start: lead, end: lead + value.length, confidence: "high", basis: "column_header" });
    else if (verdict !== "skip") exclude(ctx, "name", verdict);
  } else if (kind === "address") scanAddress(ctx, { columnHeader: true });
  else if (kind === "phone") scanPhone(ctx, { columnHeader: true });
  else scanBirthDate(ctx, { columnHeader: true });
  out.hits = dedupe(out.hits);
  return out;
}

/** 同じ型で重なる範囲は、長いほう（同じなら確からしさの高いほう）を1つ残す */
function dedupe(hits: Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => b.end - b.start - (a.end - a.start) || (a.confidence === "high" ? -1 : 1));
  const kept: Hit[] = [];
  for (const h of sorted) {
    if (kept.some((k) => k.type === h.type && h.start < k.end && k.start < h.end)) continue;
    kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}
