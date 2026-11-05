// SPDX-License-Identifier: AGPL-3.0-only
//
// ページ全体の読み込み先と送り先を絞る決まり（CSP）。CLAUDE.md §11-4。
// CSP は被害を減らす層の1つで、「外に送れないことの保証」ではない。
//
// - connect-src 'none'：fetch・XMLHttpRequest・WebSocket・sendBeacon などの送り先をなくす
// - img-src に data: と blob: を許すのは、PDF のページの絵をブラウザの中で作って見せるため
// - worker-src 'self'：検査の Worker は、同じサイトのファイルからだけ起動する
// - 'wasm-unsafe-eval' は、WASM を使うと決めたときに足す（今は使わない。画像を解く部品は、WASM ではなく代わりの JS を読む）
// - 検査のページ（check.html）だけ connect-src を 'self' にする（2026-11-06 本人が決定。下の withConnectSelf）。
//   ページの絵を描く PDF.js が、配信の中に置いた字の対応表（cMap）を、自分の配信先から読むため。
//   外のサイトへの送り先は増やさない。サイトのページ（記事など）と、ほかのファイルは 'none' のまま

const directives: Record<string, string> = {
  "default-src": "'self'",
  "connect-src": "'none'",
  "img-src": "'self' data: blob:",
  "font-src": "'self'",
  "style-src": "'self'",
  "script-src": "'self'",
  "worker-src": "'self'",
  "form-action": "'none'",
  "base-uri": "'none'",
  "frame-src": "'none'",
  "object-src": "'none'",
  "manifest-src": "'none'",
  "media-src": "'none'",
};

/** <meta> で入れる CSP。frame-ancestors は <meta> では効かないので入れない */
export const cspForMeta = Object.entries(directives)
  .map(([k, v]) => `${k} ${v}`)
  .join("; ");

/** HTTP ヘッダーで返す CSP。他のページへの埋め込みも禁じる（CLAUDE.md §11-6） */
export const cspForHeader = `${cspForMeta}; frame-ancestors 'none'`;

/**
 * お問い合わせのページ（contact.html）と、その送り先（contact-send.php）だけの CSP（2026-11-05 本人が決定）。
 * ほかのページと同じ値から、form-action だけを 'self'（同じサイトへのフォームの送信）にする。
 * connect-src 'none' などはそのまま（ページはスクリプトを持たず、フォームはブラウザのふつうの送信で送る）。
 * 検査のページ（/）と、ほかのページの CSP は変えない
 */
export function withFormActionSelf(csp: string): string {
  const parts = csp.split("; ");
  const i = parts.indexOf("form-action 'none'");
  if (i < 0) throw new Error("CSP に form-action 'none' がありません（お問い合わせのページの CSP を作れません）");
  parts[i] = "form-action 'self'";
  return parts.join("; ");
}

export const cspForContactMeta = withFormActionSelf(cspForMeta);
export const cspForContactHeader = withFormActionSelf(cspForHeader);

/**
 * お問い合わせのページの参照元の決まり。同じサイトへの送信にだけ、送り元（Origin・Referer）を付けさせる。
 * no-referrer のままだと、フォームの送信の Origin が "null" になり、サーバーで「同じサイトから来たか」を確かめられない（CSRF の対策。server/contact-send.php）。
 * ほかのサイトへは、これまでどおり何も送らない
 */
export const CONTACT_REFERRER = "same-origin";

/**
 * 検査のページ（check.html）だけの CSP（2026-11-06 本人が決定）。ほかのページと同じ値から、connect-src だけを 'self' にする。
 * 自分の配信先の /pdfjs/ に置いた部品（cMap）を、PDF.js が読むため。外のサイトは足さない
 */
export function withConnectSelf(csp: string): string {
  const parts = csp.split("; ");
  const i = parts.indexOf("connect-src 'none'");
  if (i < 0) throw new Error("CSP に connect-src 'none' がありません（検査のページの CSP を作れません）");
  parts[i] = "connect-src 'self'";
  return parts.join("; ");
}

export const cspForCheckMeta = withConnectSelf(cspForMeta);
export const cspForCheckHeader = withConnectSelf(cspForHeader);

/** CSP と一緒に返すヘッダー */
export const securityHeaders: Record<string, string> = {
  "Content-Security-Policy": cspForHeader,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  // frame-ancestors 'none' が分からない古いブラウザでも、ほかのページへの埋め込みを止める
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * お問い合わせのページと送り先で返すヘッダー。ほかのページと違うのは、CSP・参照元の決まりと、
 * 書き置かせない（no-store）こと（フォームに、開いた時刻の印と、書いた中身が入るため）
 */
export const contactHeaders: Record<string, string> = {
  ...securityHeaders,
  "Content-Security-Policy": cspForContactHeader,
  "Referrer-Policy": CONTACT_REFERRER,
  "Cache-Control": "no-store",
};

/** 検査のページで返すヘッダー。ほかのページと違うのは、CSP の connect-src だけ */
export const checkHeaders: Record<string, string> = {
  ...securityHeaders,
  "Content-Security-Policy": cspForCheckHeader,
};
