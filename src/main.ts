// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面。PDF を受け取り、Worker で検査し、結果を出す。「片付ける」を押すと、片付けた PDF を作り、検査の入口に最初から入れ直す。
// 見た目の決まりは design/（README.md・tokens.css）。
// - 判定は検査の Worker（src/worker/inspect.worker.ts）だけが行う。ページの絵（PDF.js、src/render/pdf-view.ts）は見せるためだけ。
// - 片付けは片付けの Worker（src/worker/sanitize.worker.ts → sanitize/）が行う。「残っていない」は、片付けの報告ではなく、
//   片付けた PDF を検査し直した結果だけで言う（sanitize/README.md「4 読み直す」）。
// - 片付けた PDF は Blob にして、利用者が保存する（URL.createObjectURL。通信ではない）。
// - ファイルから取り出した文字や、ファイル名は、HTML として解釈させない（textContent だけを使う。CLAUDE.md §11-3）。
// - 字の中身は出さない。数と場所だけ（検査の Worker も片付けの Worker も、そもそも返さない）。

import type { InspectOutcome } from "./inspect/protocol";
import type { PageBox, InspectSummary } from "./inspect/report";
import { inspectInWorker } from "./inspect/run";
import { toFraction, viewSize } from "./inspect/view";
import { PdfView, RenderTimeout } from "./render/pdf-view";
import { sanitizeInWorker } from "./sanitize/run";
import { buildCleanView, cleanedFileName, type CleanView, type DoneMark } from "./ui/clean-model";
import { FUDA_ERROR, FUDA_NONE, fudaLabel } from "./ui/fuda";
import { buildView, type Group, type PageMarks, type Row, type ViewModel } from "./ui/model";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`画面の部品が見つかりません：${id}`);
  return found as T;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}

const ui = {
  input: el<HTMLInputElement>("file"),
  drop: el<HTMLLabelElement>("drop"),
  workspace: el<HTMLElement>("workspace"),
  stepPick: el<HTMLLIElement>("step-pick"),
  stepPickNote: el<HTMLSpanElement>("step-pick-note"),
  stepCheck: el<HTMLLIElement>("step-check"),
  stepCheckNote: el<HTMLSpanElement>("step-check-note"),
  stepClean: el<HTMLLIElement>("step-clean"),
  stepCleanNote: el<HTMLSpanElement>("step-clean-note"),
  stepVerify: el<HTMLLIElement>("step-verify"),
  stepVerifyNote: el<HTMLSpanElement>("step-verify-note"),
  thumbs: el<HTMLElement>("thumbs"),
  filebar: el<HTMLDivElement>("filebar"),
  fileName: el<HTMLSpanElement>("file-name"),
  fileFacts: el<HTMLSpanElement>("file-facts"),
  sheetWrap: el<HTMLElement>("sheet-wrap"),
  sheet: el<HTMLDivElement>("sheet"),
  canvas: el<HTMLCanvasElement>("sheet-canvas"),
  marks: el<HTMLDivElement>("marks"),
  caption: el<HTMLElement>("sheet-caption"),
  renderNote: el<HTMLParagraphElement>("render-note"),
  resultTitle: el<HTMLHeadingElement>("result-title"),
  status: el<HTMLParagraphElement>("status"),
  progress: el<HTMLProgressElement>("progress"),
  verified: el<HTMLDivElement>("verified"),
  verifiedText: el<HTMLParagraphElement>("verified-text"),
  clean: el<HTMLElement>("clean"),
  cleanCount: el<HTMLParagraphElement>("clean-count"),
  download: el<HTMLAnchorElement>("download"),
  downloadNote: el<HTMLParagraphElement>("download-note"),
  notDone: el<HTMLDivElement>("not-done"),
  notDoneList: el<HTMLUListElement>("not-done-list"),
  removed: el<HTMLDetailsElement>("removed"),
  removedTitle: el<HTMLElement>("removed-title"),
  removedGroups: el<HTMLDivElement>("removed-groups"),
  cleanNotes: el<HTMLUListElement>("clean-notes"),
  cleanScope: el<HTMLParagraphElement>("clean-scope"),
  notices: el<HTMLDivElement>("notices"),
  noticeList: el<HTMLUListElement>("notice-list"),
  groups: el<HTMLDivElement>("groups"),
  actions: el<HTMLDivElement>("actions"),
  sanitize: el<HTMLButtonElement>("sanitize"),
  sanitizeNote: el<HTMLParagraphElement>("sanitize-note"),
  scopeNote: el<HTMLParagraphElement>("scope-note"),
};

/** 縮小したページの絵を描く数の上限。超えた分は番号だけ出す【仮の値】 */
const MAX_THUMB_IMAGES = 60;
const THUMB_WIDTH = 96;
const SHEET_MAX_WIDTH = 900;

type Session = {
  generation: number;
  /** before＝片付ける前の PDF を見ている。after＝片付けた PDF を読み直した結果を見ている */
  phase: "before" | "after";
  fileName: string;
  /** 片付けに渡す元の PDF（片付けを始めたら渡し切って null にする） */
  original: Uint8Array | null;
  pdf: PdfView | null;
  pdfProblem: "password" | "unreadable" | null;
  summary: InspectSummary;
  view: ViewModel;
  boxes: Map<number, PageBox>;
  marksByPage: Map<number, PageMarks>;
  doneByPage: Map<number, DoneMark[]>;
  heavy: Set<number>;
  current: number;
  selected: number | null;
};

let busy = false;
let generation = 0;
let session: Session | null = null;
let downloadUrl: string | null = null;

function setStatus(text: string, tone: "neutral" | "ok" | "problem" = "neutral") {
  ui.status.textContent = text;
  ui.status.dataset.tone = tone;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} バイト`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function setStep(li: HTMLLIElement, state: "todo" | "now" | "done") {
  li.dataset.state = state;
  // いまの段を、読み上げでも伝える（色と形だけにしない）
  if (state === "now") li.setAttribute("aria-current", "step");
  else li.removeAttribute("aria-current");
}

function releaseDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  ui.download.removeAttribute("href");
}

function clearResults() {
  for (const part of [ui.noticeList, ui.groups, ui.thumbs, ui.marks]) part.replaceChildren();
  for (const part of [ui.notices, ui.actions, ui.verified, ui.thumbs, ui.sheetWrap, ui.renderNote, ui.scopeNote]) part.hidden = true;
  ui.caption.textContent = "";
  delete ui.workspace.dataset.thumbs;
}

function reset() {
  clearResults();
  releaseDownload();
  for (const part of [ui.notDoneList, ui.removedGroups, ui.cleanNotes]) part.replaceChildren();
  ui.clean.hidden = true;
  ui.filebar.hidden = true;
  ui.progress.hidden = true;
  ui.resultTitle.textContent = "種類ごとの結果";
  delete ui.workspace.dataset.phase;
  setStep(ui.stepCheck, "todo");
  setStep(ui.stepClean, "todo");
  setStep(ui.stepVerify, "todo");
  ui.stepCheckNote.textContent = "まだです";
  ui.stepCleanNote.textContent = "まだです";
  ui.stepVerifyNote.textContent = "全部 緑になれば完了";
}

// ---------------------------------------------------------------- 右：種類ごとの結果

const SEVERITY_MARK: Record<Row["severity"], string> = { high: "▲", medium: "■", low: "●" };

/** 種類ごとの囲み：左に札（飾り。読み上げでは見出しを読む）、右に見出しと項目（案 E2。design/README.md） */
function groupBox(fuda: string, kind: "found" | "none" | "error"): { box: HTMLElement; body: HTMLDivElement } {
  const box = make("section", undefined, "group");
  box.dataset.status = kind;
  const tag = make("span", fuda, "fuda");
  tag.setAttribute("aria-hidden", "true");
  const body = make("div", undefined, "group-body");
  box.append(tag, body);
  return { box, body };
}

function renderGroups(s: Session) {
  const none: Group[] = [];
  const errors: Group[] = [];
  for (const g of s.view.groups) {
    if (g.status === "error") {
      errors.push(g);
      continue;
    }
    if (!g.rows.length) {
      none.push(g);
      continue;
    }
    const { box, body } = groupBox(fudaLabel(g.label, g.pattern), "found");
    const head = make("h3", undefined, "group-head");
    head.append(make("span", `${g.label}（${g.pattern}）`, "group-name"));
    head.append(make("span", `${g.rows.length} 件`, "group-count"));
    body.append(head);
    if (g.message) body.append(make("p", g.message, "group-message"));
    const list = make("ol", undefined, "items");
    for (const r of g.rows) {
      const li = make("li");
      const btn = make("button", undefined, "item");
      btn.type = "button";
      btn.id = `item-${r.no}`;
      btn.dataset.severity = r.severity;
      const top = make("span", undefined, "item-top");
      top.append(
        make("span", String(r.no), "item-no"),
        make("span", `${SEVERITY_MARK[r.severity]} ${r.severityLabel}`, `item-sev sev-${r.severity}`),
        make("span", r.page !== null ? `ページ ${r.page}` : "ファイル全体", "item-page"),
      );
      btn.append(top, make("span", r.title, "item-title"), make("span", r.why, "item-why"), make("span", r.detail, "item-detail"));
      btn.addEventListener("click", () => void select(r));
      li.append(btn);
      list.append(li);
    }
    body.append(list);
    ui.groups.append(box);
  }
  // 調べられなかった種類は、1つの囲みにまとめる（隠さない。理由がみな同じなら、理由は1回だけ出す）
  if (errors.length) {
    const { box, body } = groupBox(FUDA_ERROR, "error");
    body.append(make("h3", "調べられなかった種類", "group-head"));
    const reasons = new Set(errors.map((g) => g.message ?? ""));
    const shared = reasons.size === 1 ? [...reasons][0] : null;
    if (shared) body.append(make("p", shared, "group-message"));
    const list = make("ul", undefined, "none-list");
    for (const g of errors) {
      const li = make("li");
      li.append(make("span", `${g.label}（${g.pattern}）`, "group-name"), make("span", "調べられませんでした", "group-count"));
      if (!shared && g.message) li.append(make("span", g.message, "group-message"));
      list.append(li);
    }
    body.append(list);
    ui.groups.append(box);
  }
  if (none.length) {
    const word = s.phase === "after" ? "残っていません" : "見つかりませんでした";
    const { box, body } = groupBox(FUDA_NONE, "none");
    body.append(make("h3", s.phase === "after" ? "残っていない種類" : "見つからなかった種類", "group-head"));
    const list = make("ul", undefined, "none-list");
    for (const g of none) {
      const li = make("li");
      li.append(make("span", `${g.label}（${g.pattern}）`, "group-name"), make("span", word, "group-count"));
      list.append(li);
    }
    body.append(list);
    ui.groups.append(box);
  }
}

// ---------------------------------------------------------------- 左：縮小した各ページ

function renderThumbs(s: Session) {
  const pages = s.summary.pages.length ? s.summary.pages.map((p) => p.page) : Array.from({ length: s.pdf?.pageCount ?? 0 }, (_, i) => i + 1);
  if (!pages.length) return;
  for (const n of pages) {
    const btn = make("button", undefined, "thumb");
    btn.type = "button";
    btn.id = `thumb-${n}`;
    const box = s.boxes.get(n);
    const pic = make("span", undefined, "thumb-pic");
    if (box) {
      const size = viewSize(box);
      pic.style.aspectRatio = `${size.width} / ${size.height}`;
    }
    const count = s.marksByPage.get(n)?.marks.length ?? 0;
    const done = s.doneByPage.get(n)?.length ?? 0;
    btn.append(pic, make("span", `${n}`, "thumb-no"));
    if (count) btn.append(make("span", `${count}`, "thumb-count"));
    else if (done) btn.append(make("span", "済", "thumb-count thumb-done"));
    const parts = [`ページ ${n}`];
    if (count) parts.push(`${s.phase === "after" ? "残っている所" : "見つかった所"} ${count} か所`);
    if (done) parts.push(`片付けた所 ${done} か所`);
    btn.setAttribute("aria-label", parts.join("、"));
    btn.addEventListener("click", () => void showPage(n, null));
    ui.thumbs.append(btn);
  }
  ui.thumbs.hidden = false;
}

/** 縮小した絵は、大きなページのあとに、1枚ずつ順に描く（重いページは描かない） */
async function drawThumbImages(s: Session) {
  if (!s.pdf) return;
  let drawn = 0;
  for (const btn of ui.thumbs.querySelectorAll<HTMLButtonElement>(".thumb")) {
    if (s.generation !== generation || session !== s || s.pdf.stopped) return;
    const n = Number(btn.id.slice("thumb-".length));
    const pic = btn.querySelector<HTMLSpanElement>(".thumb-pic");
    if (!pic || s.heavy.has(n) || drawn >= MAX_THUMB_IMAGES) continue;
    const canvas = make("canvas");
    canvas.setAttribute("aria-hidden", "true");
    try {
      await s.pdf.render(n, canvas, THUMB_WIDTH);
      if (s.generation !== generation || session !== s) return;
      pic.replaceChildren(canvas);
      pic.style.aspectRatio = "";
      drawn++;
    } catch {
      return; // 時間の上限か、読めないページ。残りは番号だけ
    }
  }
}

// ---------------------------------------------------------------- 真ん中：大きなページ

function sheetWidth(): number {
  const stage = ui.sheetWrap.parentElement;
  const w = (stage?.clientWidth ?? SHEET_MAX_WIDTH) - 32;
  return Math.max(240, Math.min(SHEET_MAX_WIDTH, w));
}

function placeAt(e: HTMLElement, f: { left: number; top: number; width: number; height: number }) {
  // CSSOM で位置を入れる（style 属性の文字列は使わない。CSP の style-src に合わせる）
  e.style.left = `${f.left * 100}%`;
  e.style.top = `${f.top * 100}%`;
  e.style.width = `${f.width * 100}%`;
  e.style.height = `${f.height * 100}%`;
}

function placeMarks(s: Session, page: number) {
  ui.marks.replaceChildren();
  const box = s.boxes.get(page);
  if (!box) return;
  // 片付けた所（緑の点線の枠と「済」の札）。押せない。残っている所の枠より下に置く
  for (const d of s.doneByPage.get(page) ?? []) {
    const f = toFraction(box, d.rect);
    if (!f) continue;
    const done = make("div", undefined, "mark mark-done");
    done.setAttribute("role", "img");
    done.setAttribute("aria-label", `片付けた所：${d.label}`);
    done.append(make("span", "済", "mark-no"));
    placeAt(done, f);
    ui.marks.append(done);
  }
  for (const m of s.marksByPage.get(page)?.marks ?? []) {
    const f = toFraction(box, m.rect);
    if (!f) continue;
    const mark = make("button", undefined, `mark sev-${m.severity}`);
    mark.type = "button";
    mark.id = `mark-${m.no}`;
    mark.append(make("span", String(m.no), "mark-no"));
    mark.setAttribute("aria-label", `番号 ${m.no}：${m.title}`);
    if (s.selected === m.no) mark.classList.add("is-selected");
    placeAt(mark, f);
    mark.addEventListener("click", () => {
      const item = document.getElementById(`item-${m.no}`);
      item?.scrollIntoView({ block: "nearest" });
      item?.focus();
      markSelected(m.no);
    });
    ui.marks.append(mark);
  }
}

function markSelected(no: number | null) {
  if (session) session.selected = no;
  for (const e of document.querySelectorAll(".is-selected")) e.classList.remove("is-selected");
  if (no === null) return;
  document.getElementById(`mark-${no}`)?.classList.add("is-selected");
  document.getElementById(`item-${no}`)?.classList.add("is-selected");
}

async function showPage(page: number, selectNo: number | null) {
  const s = session;
  if (!s) return;
  s.current = page;
  s.selected = selectNo;
  for (const t of ui.thumbs.querySelectorAll(".thumb")) t.removeAttribute("aria-current");
  document.getElementById(`thumb-${page}`)?.setAttribute("aria-current", "page");

  const box = s.boxes.get(page);
  const size = box ? viewSize(box) : { width: 595, height: 842 };
  const width = sheetWidth();
  ui.sheet.style.width = `${width}px`;
  ui.sheet.style.aspectRatio = `${size.width} / ${size.height}`;
  const count = s.marksByPage.get(page)?.marks.length ?? 0;
  const done = s.doneByPage.get(page)?.length ?? 0;
  const facts = [];
  if (count) facts.push(`${s.phase === "after" ? "残っている所" : "見つかった所"} ${count} か所`);
  if (done) facts.push(`片付けた所 ${done} か所`);
  ui.caption.textContent = `${s.phase === "after" ? "片付けた PDF の" : ""}ページ ${page}${facts.length ? `（${facts.join("・")}）` : ""}`;
  ui.sheetWrap.hidden = false;
  placeMarks(s, page);
  markSelected(selectNo);
  if (selectNo !== null) document.getElementById(`mark-${selectNo}`)?.scrollIntoView({ block: "center", behavior: "smooth" });

  // 絵を描く。描けないときは、白いページの形の上に枠だけを出す
  const clear = () => {
    ui.canvas.width = 1;
    ui.canvas.height = 1;
    ui.sheet.dataset.drawn = "false";
  };
  let note = "";
  if (s.heavy.has(page)) {
    clear();
    note = "このページは図形が多すぎるため、絵を描いていません（検査も省きました）。";
  } else if (!s.pdf) {
    clear();
    note =
      s.pdfProblem === "password"
        ? "パスワードが要るため、ページの絵を描けません。"
        : "ページの絵を描けませんでした。ページの形の上に、場所だけを示します。";
  } else if (s.pdf.stopped) {
    clear();
    note = "絵を描くのに時間がかかりすぎたため、この PDF では絵を描くのをやめました。場所だけを示します。";
  } else {
    try {
      await s.pdf.render(page, ui.canvas, width);
      if (session !== s || s.current !== page) return;
      ui.sheet.dataset.drawn = "true";
    } catch (e) {
      if (session !== s || s.current !== page) return;
      clear();
      note =
        e instanceof RenderTimeout
          ? "絵を描くのに時間がかかりすぎたため、描くのをやめました。場所だけを示します。"
          : "このページの絵を描けませんでした。場所だけを示します。";
    }
  }
  ui.renderNote.textContent = note;
  ui.renderNote.hidden = note === "";
}

async function select(r: Row) {
  if (r.page !== null && session) await showPage(r.page, r.hasRect ? r.no : null);
  markSelected(r.no);
}

// ---------------------------------------------------------------- 結果の全体

/** 種類ごとの結果・お知らせ・ページを出す（片付ける前も、読み直したあとも同じ形） */
function renderInspection(s: Session) {
  const v = s.view;
  for (const n of v.notices) ui.noticeList.append(make("li", n));
  ui.notices.hidden = v.notices.length === 0;
  renderGroups(s);
  ui.scopeNote.hidden = false;

  renderThumbs(s);
  ui.workspace.dataset.thumbs = ui.thumbs.hidden ? "none" : "some";
  const first =
    v.rows.find((r) => r.page !== null && r.hasRect)?.page ??
    [...s.doneByPage.keys()].sort((a, b) => a - b)[0] ??
    s.summary.pages[0]?.page ??
    (s.pdf ? 1 : null);
  if (first !== null) {
    void showPage(first, null).then(() => drawThumbImages(s));
  } else {
    ui.renderNote.textContent =
      s.pdfProblem === "password" ? "パスワードが要るため、ページの絵を描けません。" : "ページを読めなかったため、ページの絵を描けません。";
    ui.renderNote.hidden = false;
  }
}

function renderSummary(s: Session) {
  const v = s.view;
  setStatus(v.headline, v.tone);
  setStep(ui.stepCheck, "done");
  ui.stepCheckNote.textContent = v.rows.length ? `${v.rows.length} か所 見つかりました` : v.clean ? "見つかりませんでした" : "調べられない所あり";

  // 片付けは、検査ができた PDF ならいつでも押せる（見つからなくても、XMP・注釈のコメント・JavaScript なども外す）
  ui.actions.hidden = false;
  ui.sanitize.disabled = s.original === null || s.pdfProblem === "password";
  ui.sanitizeNote.textContent = s.pdfProblem === "password"
    ? "パスワードが要る PDF は、片付けられません。"
    : v.rows.length
    ? "見つかった所を取り除いた PDF を、新しく作ります。元の PDF は変えません。"
    : "見つかった所はありませんが、XMP メタデータ・注釈のコメント・JavaScript なども取り除いた PDF を作れます。元の PDF は変えません。";
  setStep(ui.stepClean, v.rows.length ? "now" : "todo");
  ui.stepCleanNote.textContent = "押すと始めます";

  // 何も見つからなかったときの札（片付けたあとの「全部緑」は renderCleaned）
  ui.verified.dataset.state = v.clean ? "clean" : "none";
  ui.verifiedText.textContent = v.clean ? "調べた項目では、見つかりませんでした。" : "";
  ui.verified.hidden = !v.clean;

  renderInspection(s);
}

function fail(text: string) {
  setStatus(text, "problem");
  setStep(ui.stepCheck, "now");
  ui.stepCheckNote.textContent = "確かめられませんでした";
}

function makeSession(
  summary: InspectSummary,
  base: Pick<Session, "generation" | "phase" | "fileName" | "original" | "pdf" | "pdfProblem">,
  done: DoneMark[] = [],
): Session {
  const view = buildView(summary);
  const doneByPage = new Map<number, DoneMark[]>();
  for (const d of done) doneByPage.set(d.page, [...(doneByPage.get(d.page) ?? []), d]);
  return {
    ...base,
    summary,
    view,
    boxes: new Map(summary.pages.map((p) => [p.page, p])),
    marksByPage: new Map(view.pages.map((p) => [p.box.page, p])),
    doneByPage,
    heavy: new Set(view.heavyPages),
    current: 0,
    selected: null,
  };
}

function renderOutcome(outcome: InspectOutcome, base: Pick<Session, "generation" | "fileName" | "original" | "pdf" | "pdfProblem">) {
  const seconds = `${(outcome.elapsedMs / 1000).toFixed(1)} 秒`;
  if (outcome.kind === "timeout") return fail("時間がかかりすぎたため、検査を止めました。画面はそのまま使えます。");
  if (outcome.kind === "error") return fail(outcome.message);
  if (!outcome.precheck.ok) return fail(outcome.precheck.message);
  if (!outcome.summary) return fail("検査の結果を受け取れませんでした。");
  const summary = outcome.summary;
  const pages = summary.pagesUnreadable ? "ページの数 不明" : `${summary.pages.length} ページ`;
  ui.fileFacts.textContent = `${pages}・${formatBytes(outcome.precheck.byteLength)}・${seconds}`;
  session = makeSession(summary, { ...base, phase: "before" });
  renderSummary(session);
}

async function handle(file: File) {
  if (busy) return;
  busy = true;
  const gen = ++generation;
  const old = session;
  session = null;
  void old?.pdf?.close();
  reset();
  ui.workspace.dataset.state = "working";
  setStep(ui.stepPick, "done");
  ui.stepPickNote.textContent = "置きました";
  setStep(ui.stepCheck, "now");
  ui.stepCheckNote.textContent = "確かめています";
  ui.fileName.textContent = file.name;
  ui.fileFacts.textContent = "";
  ui.filebar.hidden = false;
  setStatus("確かめています…");
  ui.progress.hidden = false;
  ui.progress.value = 0;
  try {
    const buffer = await file.arrayBuffer();
    // 検査の Worker には元を渡し切るので、絵を描く側と片付けに渡す側には写しを持つ
    const forPicture = new Uint8Array(buffer.slice(0));
    const original = new Uint8Array(buffer.slice(0));
    const opening = PdfView.open(forPicture).catch(() => ({ ok: false as const, reason: "unreadable" as const }));
    const outcome = await inspectInWorker(buffer, (p) => {
      ui.progress.max = p.total;
      ui.progress.value = p.done;
      setStatus(`確かめています…（${p.label}、${p.done + 1}/${p.total}）`);
    });
    const opened = await opening;
    ui.progress.hidden = true;
    if (gen !== generation) {
      if (opened.ok) void opened.view.close();
      return;
    }
    ui.workspace.dataset.state = "result";
    renderOutcome(outcome, {
      generation: gen,
      fileName: file.name,
      original,
      pdf: opened.ok ? opened.view : null,
      pdfProblem: opened.ok ? null : opened.reason,
    });
  } catch {
    ui.progress.hidden = true;
    fail("ファイルを読めませんでした。");
  } finally {
    busy = false;
    ui.input.value = "";
  }
}

// ---------------------------------------------------------------- 3 片付ける → 4 読み直す

function cleanFailed(text: string) {
  setStatus(text, "problem");
  setStep(ui.stepClean, "now");
  ui.stepCleanNote.textContent = "片付けられませんでした";
  ui.progress.hidden = true;
  ui.sanitizeNote.textContent = text;
}

function renderCleaned(c: CleanView, file: { name: string; bytes: number; pages: number; seconds: string }) {
  ui.workspace.dataset.phase = "after";
  ui.actions.hidden = true;
  setStatus(c.headline, c.verdict === "clean" ? "ok" : c.verdict === "left" ? "problem" : "neutral");

  setStep(ui.stepClean, "done");
  ui.stepCleanNote.textContent = "片付けました";
  if (c.verdict === "clean") {
    setStep(ui.stepVerify, "done");
    ui.stepVerifyNote.textContent = "全部 緑になりました";
  } else {
    setStep(ui.stepVerify, "now");
    ui.stepVerifyNote.textContent = c.left === null ? "読み直せませんでした" : c.left > 0 ? `${c.left} か所 残っています` : "言い切れない所あり";
  }

  ui.cleanCount.textContent =
    c.left === null ? `片付ける前 ${c.before} か所 → 読み直せませんでした` : `片付ける前 ${c.before} か所 → 読み直したあと ${c.left} か所`;
  ui.cleanCount.dataset.verdict = c.verdict;
  ui.download.download = file.name;
  ui.downloadNote.textContent = `${file.name}（${file.pages} ページ・${formatBytes(file.bytes)}・${file.seconds}）。元の PDF は変えていません。`;

  ui.notDoneList.replaceChildren(...c.notDone.map((t) => make("li", t)));
  ui.notDone.hidden = c.notDone.length === 0;

  const total = c.removed.reduce((n, g) => n + g.total, 0);
  ui.removedTitle.textContent = `取り除いたもの（${total} 件）`;
  ui.removedGroups.replaceChildren(
    ...c.removed.map((g) => {
      const box = make("section", undefined, "removed-group");
      box.append(make("h4", `${g.name}（${g.pattern}）　${g.total} 件`), make("ul"));
      box.querySelector("ul")!.append(...g.lines.map((t) => make("li", t)));
      return box;
    }),
  );
  ui.removed.hidden = total === 0;

  ui.cleanNotes.replaceChildren(...c.notes.map((t) => make("li", t)));
  ui.cleanNotes.hidden = c.notes.length === 0;
  ui.cleanScope.textContent = c.scope;
  ui.clean.hidden = false;

  ui.clean.dataset.verdict = c.verdict;
  // 「全部緑」は、片付けた結果の欄（緑の枠）が示す。同じ文を重ねない
  ui.verified.hidden = true;
  ui.resultTitle.textContent = "読み直した結果（種類ごと）";
  ui.fileName.textContent = file.name;
  ui.fileFacts.textContent = `片付けた PDF・${file.pages} ページ・${formatBytes(file.bytes)}`;
}

async function runSanitize() {
  const s = session;
  if (!s || busy || s.phase !== "before" || !s.original) return;
  busy = true;
  const gen = s.generation;
  const original = s.original;
  s.original = null;
  ui.sanitize.disabled = true;
  setStep(ui.stepClean, "now");
  ui.stepCleanNote.textContent = "片付けています";
  setStatus("片付けています…");
  ui.progress.removeAttribute("value"); // どこまで進んだか分からないので、動いていることだけを示す
  ui.progress.hidden = false;
  try {
    const out = await sanitizeInWorker(original.buffer as ArrayBuffer);
    if (gen !== generation) return;
    if (out.kind === "timeout") return cleanFailed("時間がかかりすぎたため、片付けを止めました。画面はそのまま使えます。");
    if (out.kind !== "done") return cleanFailed(out.message);

    setStep(ui.stepClean, "done");
    ui.stepCleanNote.textContent = "片付けました";
    setStep(ui.stepVerify, "now");
    ui.stepVerifyNote.textContent = "読み直しています";
    setStatus("片付けた PDF を、最初から検査し直しています…");
    ui.progress.value = 0;

    // 保存する PDF（Blob は中身を写して持つ）。絵を描く側にも写しを渡し、検査の Worker には元を渡し切る
    const name = cleanedFileName(s.fileName);
    const byteLength = out.bytes.byteLength;
    releaseDownload();
    downloadUrl = URL.createObjectURL(new Blob([out.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
    ui.download.href = downloadUrl;
    const opening = PdfView.open(out.bytes.slice()).catch(() => ({ ok: false as const, reason: "unreadable" as const }));
    const re = await inspectInWorker(out.bytes.buffer as ArrayBuffer, (p) => {
      ui.progress.max = p.total;
      ui.progress.value = p.done;
      setStatus(`片付けた PDF を、最初から検査し直しています…（${p.label}、${p.done + 1}/${p.total}）`);
    });
    const opened = await opening;
    ui.progress.hidden = true;
    if (gen !== generation) {
      if (opened.ok) void opened.view.close();
      return;
    }
    const afterSummary = re.kind === "done" && re.precheck.ok ? re.summary : null;
    const clean = buildCleanView({
      before: s.view,
      after: afterSummary ? buildView(afterSummary) : null,
      removed: out.removed,
      notDone: out.notDone,
      decrypted: out.decrypted,
    });
    const file = { name, bytes: byteLength, pages: out.pages, seconds: `${((out.elapsedMs + re.elapsedMs) / 1000).toFixed(1)} 秒` };
    if (afterSummary) {
      // ここからは、片付けた PDF を見せる（ページの絵も、読み直した結果も）
      void s.pdf?.close();
      clearResults();
      session = makeSession(
        afterSummary,
        { generation: gen, phase: "after", fileName: name, original: null, pdf: opened.ok ? opened.view : null, pdfProblem: opened.ok ? null : opened.reason },
        clean.doneMarks,
      );
      renderInspection(session);
    } else if (opened.ok) {
      void opened.view.close();
    }
    renderCleaned(clean, file);
  } catch {
    if (gen === generation) cleanFailed("片付けの途中で問題が起きました。");
  } finally {
    busy = false;
  }
}

ui.sanitize.addEventListener("click", () => void runSanitize());

ui.input.addEventListener("change", () => {
  const file = ui.input.files?.[0];
  if (file) void handle(file);
});

// 画面のどこに落としても受け取る。画面の外に落としたファイルを、ブラウザが開いてしまわないようにもする
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  ui.drop.dataset.over = "true";
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) delete ui.drop.dataset.over;
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  delete ui.drop.dataset.over;
  const file = e.dataTransfer?.files?.[0];
  if (file) void handle(file);
});

// 幅が変わったら、大きなページを描き直す
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (session && session.current) void showPage(session.current, session.selected);
  }, 200);
});
