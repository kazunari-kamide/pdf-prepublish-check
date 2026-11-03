// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面。PDF を受け取り、Worker で検査し、結果を出す。見た目の決まりは design/（README.md・tokens.css）。
// - 判定は検査の Worker（src/worker/inspect.worker.ts）だけが行う。ページの絵（PDF.js、src/render/pdf-view.ts）は見せるためだけ。
// - ファイルから取り出した文字や、ファイル名は、HTML として解釈させない（textContent だけを使う。CLAUDE.md §11-3）。
// - 字の中身は出さない。数と場所だけ（検査の Worker がそもそも返さない）。

import type { InspectOutcome } from "./inspect/protocol";
import type { PageBox, InspectSummary } from "./inspect/report";
import { inspectInWorker } from "./inspect/run";
import { toFraction, viewSize } from "./inspect/view";
import { PdfView, RenderTimeout } from "./render/pdf-view";
import { buildView, type PageMarks, type Row, type ViewModel } from "./ui/model";

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
  stepVerify: el<HTMLLIElement>("step-verify"),
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
  status: el<HTMLParagraphElement>("status"),
  progress: el<HTMLProgressElement>("progress"),
  verified: el<HTMLDivElement>("verified"),
  verifiedText: el<HTMLParagraphElement>("verified-text"),
  notices: el<HTMLDivElement>("notices"),
  noticeList: el<HTMLUListElement>("notice-list"),
  groups: el<HTMLDivElement>("groups"),
  actions: el<HTMLDivElement>("actions"),
  scopeNote: el<HTMLParagraphElement>("scope-note"),
};

/** 縮小したページの絵を描く数の上限。超えた分は番号だけ出す【仮の値】 */
const MAX_THUMB_IMAGES = 60;
const THUMB_WIDTH = 96;
const SHEET_MAX_WIDTH = 900;

type Session = {
  generation: number;
  pdf: PdfView | null;
  pdfProblem: "password" | "unreadable" | null;
  summary: InspectSummary;
  view: ViewModel;
  boxes: Map<number, PageBox>;
  marksByPage: Map<number, PageMarks>;
  heavy: Set<number>;
  current: number;
  selected: number | null;
};

let busy = false;
let generation = 0;
let session: Session | null = null;

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
}

function reset() {
  for (const part of [ui.noticeList, ui.groups, ui.thumbs, ui.marks]) part.replaceChildren();
  for (const part of [ui.notices, ui.actions, ui.verified, ui.thumbs, ui.sheetWrap, ui.renderNote, ui.scopeNote, ui.filebar]) part.hidden = true;
  ui.progress.hidden = true;
  ui.caption.textContent = "";
  delete ui.workspace.dataset.thumbs;
  setStep(ui.stepCheck, "todo");
  setStep(ui.stepVerify, "todo");
  ui.stepCheckNote.textContent = "まだです";
}

// ---------------------------------------------------------------- 右：種類ごとの結果

const SEVERITY_MARK: Record<Row["severity"], string> = { high: "▲", medium: "■", low: "●" };

function renderGroups(s: Session) {
  for (const g of s.view.groups) {
    const box = make("section", undefined, "group");
    box.dataset.status = g.status === "error" ? "error" : g.rows.length ? "found" : "none";
    const head = make("h3", undefined, "group-head");
    head.append(make("span", `${g.label}（${g.pattern}）`, "group-name"));
    const count =
      g.status === "error" ? "調べられませんでした" : g.rows.length ? `${g.rows.length} 件` : "見つかりませんでした";
    head.append(make("span", count, "group-count"));
    box.append(head);
    if (g.message) box.append(make("p", g.message, "group-message"));
    if (g.rows.length) {
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
      box.append(list);
    }
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
    btn.append(pic, make("span", `${n}`, "thumb-no"));
    if (count) btn.append(make("span", `${count}`, "thumb-count"));
    btn.setAttribute("aria-label", count ? `ページ ${n}（${count} か所）` : `ページ ${n}`);
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
    if (s.generation !== generation || s.pdf.stopped) return;
    const n = Number(btn.id.slice("thumb-".length));
    const pic = btn.querySelector<HTMLSpanElement>(".thumb-pic");
    if (!pic || s.heavy.has(n) || drawn >= MAX_THUMB_IMAGES) continue;
    const canvas = make("canvas");
    canvas.setAttribute("aria-hidden", "true");
    try {
      await s.pdf.render(n, canvas, THUMB_WIDTH);
      if (s.generation !== generation) return;
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

function placeMarks(s: Session, page: number) {
  ui.marks.replaceChildren();
  const pm = s.marksByPage.get(page);
  const box = s.boxes.get(page);
  if (!pm || !box) return;
  for (const m of pm.marks) {
    const f = toFraction(box, m.rect);
    if (!f) continue;
    const mark = make("button", undefined, `mark sev-${m.severity}`);
    mark.type = "button";
    mark.id = `mark-${m.no}`;
    mark.append(make("span", String(m.no), "mark-no"));
    mark.setAttribute("aria-label", `番号 ${m.no}：${m.title}`);
    if (s.selected === m.no) mark.classList.add("is-selected");
    // CSSOM で位置を入れる（style 属性の文字列は使わない。CSP の style-src に合わせる）
    mark.style.left = `${f.left * 100}%`;
    mark.style.top = `${f.top * 100}%`;
    mark.style.width = `${f.width * 100}%`;
    mark.style.height = `${f.height * 100}%`;
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
  ui.caption.textContent = `ページ ${page}${count ? `（見つかった所 ${count} か所）` : ""}`;
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
      if (s.generation !== generation || s.current !== page) return;
      ui.sheet.dataset.drawn = "true";
    } catch (e) {
      if (s.generation !== generation || s.current !== page) return;
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

function renderSummary(s: Session) {
  const v = s.view;
  setStatus(v.headline, v.tone);
  setStep(ui.stepCheck, "done");
  ui.stepCheckNote.textContent = v.rows.length ? `${v.rows.length} か所 見つかりました` : v.clean ? "見つかりませんでした" : "調べられない所あり";

  // 調べられなかったルールは、右の「種類ごとの結果」の中に出す（ここでは重ねない）
  const notes = v.notices;
  if (notes.length) {
    for (const n of notes) ui.noticeList.append(make("li", n));
    ui.notices.hidden = false;
  }
  renderGroups(s);
  ui.actions.hidden = v.rows.length === 0;
  ui.scopeNote.hidden = false;

  // 片付けたあとに「全部緑」になる所。いまは、何も見つからなかったときの札だけ（片付けは C が作る）
  ui.verified.dataset.state = v.clean ? "clean" : "none";
  ui.verifiedText.textContent = v.clean ? "調べた項目では、見つかりませんでした。" : "";
  ui.verified.hidden = !v.clean;
  if (v.clean) setStep(ui.stepVerify, "done");

  renderThumbs(s);
  ui.workspace.dataset.thumbs = ui.thumbs.hidden ? "none" : "some";
  const first = v.rows.find((r) => r.page !== null && r.hasRect)?.page ?? s.summary.pages[0]?.page ?? (s.pdf ? 1 : null);
  if (first !== null) {
    void showPage(first, null).then(() => drawThumbImages(s));
  } else {
    ui.renderNote.textContent =
      s.pdfProblem === "password" ? "パスワードが要るため、ページの絵を描けません。" : "ページを読めなかったため、ページの絵を描けません。";
    ui.renderNote.hidden = false;
  }
}

function fail(text: string) {
  setStatus(text, "problem");
  setStep(ui.stepCheck, "now");
  ui.stepCheckNote.textContent = "確かめられませんでした";
}

function renderOutcome(outcome: InspectOutcome, s: Omit<Session, "summary" | "view" | "boxes" | "marksByPage" | "heavy" | "current" | "selected">) {
  const seconds = `${(outcome.elapsedMs / 1000).toFixed(1)} 秒`;
  if (outcome.kind === "timeout") return fail("時間がかかりすぎたため、検査を止めました。画面はそのまま使えます。");
  if (outcome.kind === "error") return fail(outcome.message);
  if (!outcome.precheck.ok) return fail(outcome.precheck.message);
  if (!outcome.summary) return fail("検査の結果を受け取れませんでした。");
  const summary = outcome.summary;
  const view = buildView(summary);
  const pages = summary.pagesUnreadable ? "ページの数 不明" : `${summary.pages.length} ページ`;
  ui.fileFacts.textContent = `${pages}・${formatBytes(outcome.precheck.byteLength)}・${seconds}`;
  session = {
    ...s,
    summary,
    view,
    boxes: new Map(summary.pages.map((p) => [p.page, p])),
    marksByPage: new Map(view.pages.map((p) => [p.box.page, p])),
    heavy: new Set(view.heavyPages),
    current: 0,
    selected: null,
  };
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
    // 絵を描く側には写しを渡す（検査の Worker には元を渡し切るため）
    const forPicture = new Uint8Array(buffer.slice(0));
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
