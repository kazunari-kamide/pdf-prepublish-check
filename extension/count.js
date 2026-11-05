// SPDX-License-Identifier: AGPL-3.0-only
//
// 通信を数える決まり（拡張機能の中で、外とはつながらない計算だけ）。background.js と tests/extension.test.ts から使う。
//
// - 数えるのは、見ているタブ（omamoripdf.com・localhost・127.0.0.1 のページ）から出た要求だけ。
// - 「送った」と「読み込んだ」を分ける：
//   - 読み込んだ … ページと同じサイトへの GET・HEAD で、本文がなく、URL に「?」がないもの（Worker・pdf.js などの部品を取りに行った）。
//   - 送った     … それ以外の全部（ほかのサイトへの要求、POST などの本文つき、? つきの URL、型が ping・beacon・websocket などのもの）。
// - 大きさは目安：要求の1行目（メソッドと URL）＋ヘッダー＋本文のバイト数。ブラウザが足すヘッダー（Cookie など）は見えない分がある。

const encoder = new TextEncoder();

/** 文字列の UTF-8 でのバイト数 */
export function utf8Bytes(s) {
  return encoder.encode(String(s ?? "")).byteLength;
}

/** 見るページか（ページの URL で決める） */
export function isWatchedPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:" && u.hostname === "omamoripdf.com") return true;
  if (u.protocol === "http:" || u.protocol === "https:") return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  return false;
}

/** 新しいページを開いた時の、タブの数の入れ物 */
export function newTabState(pageUrl) {
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    origin = "";
  }
  return {
    pageOrigin: origin,
    phase: "waiting", // waiting … PDF を待っている / counting … 数えている
    startedBy: null, // "pdf"（ページの合図）か "manual"（手で数え直した）
    startedAt: null,
    before: 0, // 数え始める前の要求の数（ページを開いた時の読み込みなど。数には入れない）
    sent: { count: 0, bytes: 0, unknownBody: 0 },
    loaded: { count: 0, bytes: 0 },
    recent: [], // 数え始めてからの要求（新しい順。最大 RECENT_MAX 件）
  };
}

export const RECENT_MAX = 40;

/** 要求の本文のバイト数。分からない（大きすぎてブラウザが渡さない）ときは null */
export function bodyBytes(requestBody) {
  if (!requestBody) return 0;
  if (requestBody.error) return null;
  let n = 0;
  if (Array.isArray(requestBody.raw)) {
    for (const part of requestBody.raw) {
      if (part.bytes && typeof part.bytes.byteLength === "number") n += part.bytes.byteLength;
      else if (part.file) return null; // ファイルの中身はブラウザが渡さない
    }
  }
  if (requestBody.formData && typeof requestBody.formData === "object") {
    // 送るときの形（区切りの文字など）までは分からないので、名前と値の字だけを足す（少なめの目安）
    for (const [key, values] of Object.entries(requestBody.formData)) {
      for (const v of values ?? []) n += utf8Bytes(key) + utf8Bytes(v) + 2;
    }
  }
  return n;
}

/** ヘッダーのバイト数（「名前: 値\r\n」で数える） */
export function headerBytes(headers) {
  let n = 0;
  for (const h of headers ?? []) {
    const value = h.value ?? (h.binaryValue ? String.fromCharCode(...h.binaryValue) : "");
    n += utf8Bytes(h.name) + 2 + utf8Bytes(value) + 2;
  }
  return n;
}

/** 要求の1行目（「GET /path HTTP/1.1\r\n」）のバイト数 */
export function requestLineBytes(method, url) {
  return utf8Bytes(method) + 1 + utf8Bytes(url) + 11;
}

/** 「読み込んだ」か「送った」か */
export function classify(req, pageOrigin) {
  let u;
  try {
    u = new URL(req.url);
  } catch {
    return "sent";
  }
  const method = String(req.method ?? "GET").toUpperCase();
  const quiet = method === "GET" || method === "HEAD";
  const kinds = new Set(["ping", "beacon", "csp_report", "websocket", "webtransport", "webbundle"]);
  if (!quiet || kinds.has(req.type)) return "sent";
  if (req.requestBody && (req.requestBody.raw || req.requestBody.formData || req.requestBody.error)) return "sent";
  if (!pageOrigin || u.origin !== pageOrigin) return "sent";
  if (u.search !== "") return "sent";
  return "loaded";
}

/**
 * 要求を1件、数に入れる（onBeforeRequest で呼ぶ）。数えた要求の印（後でヘッダーの分を足すため）を返す。
 * 数え始める前なら before だけを増やし、null を返す。
 */
export function addRequest(state, req) {
  if (state.phase !== "counting") {
    state.before += 1;
    return null;
  }
  const kind = classify(req, state.pageOrigin);
  const body = bodyBytes(req.requestBody);
  const bytes = requestLineBytes(req.method ?? "GET", req.url) + (body ?? 0);
  const bucket = kind === "sent" ? state.sent : state.loaded;
  bucket.count += 1;
  bucket.bytes += bytes;
  if (kind === "sent" && body === null) state.sent.unknownBody += 1;
  let where = req.url;
  try {
    const u = new URL(req.url);
    where = u.origin === state.pageOrigin ? u.pathname + u.search : u.origin + u.pathname + u.search;
  } catch {
    // そのまま
  }
  state.recent.unshift({ kind, method: String(req.method ?? "GET"), type: String(req.type ?? ""), where: where.slice(0, 200), bytes });
  if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX;
  return { kind };
}

/** ヘッダーの分を足す（onBeforeSendHeaders で呼ぶ）。印は addRequest が返したもの */
export function addHeaders(state, mark, headers) {
  if (!mark || state.phase !== "counting") return;
  const n = headerBytes(headers);
  (mark.kind === "sent" ? state.sent : state.loaded).bytes += n;
}

/** 数え始める。how は "pdf" か "manual"。PDF の合図は、もう数えているときは無視する（2つめの PDF で数を消さない） */
export function start(state, how, now) {
  if (how === "pdf" && state.phase === "counting") return false;
  const fresh = newTabState(state.pageOrigin);
  fresh.before = state.before + state.sent.count + state.loaded.count;
  fresh.phase = "counting";
  fresh.startedBy = how;
  fresh.startedAt = now;
  Object.assign(state, fresh);
  return true;
}

/** バイト数を短く（1024 未満は B のまま。丸めて 0 に見せない） */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** バッジに出す字（4 字まで） */
export function badgeText(state) {
  if (!state || state.phase !== "counting") return "－";
  const n = state.sent.bytes;
  if (n < 1000) return `${n}B`;
  if (n < 1024 * 1000) return `${Math.min(999, Math.floor(n / 1024))}K`;
  return `${Math.min(999, Math.floor(n / 1024 / 1024))}M`;
}

/** 画面に出す文（ページの隅とポップアップで同じものを使う） */
export function view(state) {
  if (!state) {
    return { tone: "off", title: "このページは数えていません", value: "", detail: "", note: "" };
  }
  if (state.phase !== "counting") {
    return {
      tone: "waiting",
      title: "PDF を入れると、数え始めます",
      value: "待っています",
      detail: "",
      note: `ページを開いた時の読み込み：${state.before} 件（数に入れません）`,
    };
  }
  const s = state.sent;
  const label = state.startedBy === "pdf" ? "PDF を入れたあとに送ったデータ" : "数え直したあとに送ったデータ";
  const unknown = s.unknownBody > 0 ? `・大きさが分からない本文 ${s.unknownBody} 件` : "";
  return {
    tone: s.count === 0 ? "zero" : "sent",
    title: label,
    value: formatBytes(s.bytes),
    detail: `要求 ${s.count} 件${unknown}`,
    note: `このサイトから読み込んだ部品：${state.loaded.count} 件（送ったデータに数えません）`,
  };
}
