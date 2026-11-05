// SPDX-License-Identifier: AGPL-3.0-only
//
// ページ全体の読み込み先と送り先を絞る決まり（CSP）。CLAUDE.md §11-4。
// CSP は被害を減らす層の1つで、「外に送れないことの保証」ではない。
//
// - connect-src 'none'：fetch・XMLHttpRequest・WebSocket・sendBeacon などの送り先をなくす
// - img-src に data: と blob: を許すのは、PDF のページの絵をブラウザの中で作って見せるため
// - worker-src 'self'：検査の Worker は、同じサイトのファイルからだけ起動する
// - 'wasm-unsafe-eval' は、WASM を使うと決めたときに足す（今は使わない）

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
