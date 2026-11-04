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

// 同梱の書体のライセンス（SIL OFL 1.1）。書体と一緒に配る（design/fonts/README.md）
import fontLicenseUrl from "./assets/fonts/OFL.txt?url";
import type { InspectOutcome } from "./inspect/protocol";
import type { PageBox, InspectSummary } from "./inspect/report";
import { inspectInWorker } from "./inspect/run";
import { fromFraction, toFraction, viewSize } from "./inspect/view";
import { PdfView, RenderTimeout } from "./render/pdf-view";
import { MAX_REDACT_AREAS, type RedactArea } from "./sanitize/areas";
import { sanitizeInWorker } from "./sanitize/run";
import { buildCleanView, cleanedFileName, SAVE_NOTE, saveGate, type CleanView, type DoneMark, type SaveGate } from "./ui/clean-model";
import type { CoverageRow } from "./ui/coverage";
import { FUDA_SCOPE, fudaLabel } from "./ui/fuda";
import { buildView, type PageMarks, type Row, type ViewModel } from "./ui/model";
import { orgSegments } from "./ui/org-words";
import { buildRulesetView } from "./ui/ruleset";
import { sampleFile } from "./ui/sample";
import { beforeAfterCounts, buildProcessReport, sha256Hex } from "./ui/process-report";

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
  sample: el<HTMLButtonElement>("sample"),
  sampleRow: el<HTMLParagraphElement>("sample-row"),
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
  saveNote: el<HTMLParagraphElement>("save-note"),
  beforeAfter: el<HTMLDivElement>("before-after"),
  beforeAfterList: el<HTMLUListElement>("before-after-list"),
  reportDownload: el<HTMLAnchorElement>("report-download"),
  saveConfirm: el<HTMLLabelElement>("save-confirm"),
  saveConfirmBox: el<HTMLInputElement>("save-confirm-box"),
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
  props: el<HTMLDetailsElement>("props"),
  ruleset: el<HTMLDetailsElement>("ruleset"),
  actions: el<HTMLDivElement>("actions"),
  sanitize: el<HTMLButtonElement>("sanitize"),
  sanitizeNote: el<HTMLParagraphElement>("sanitize-note"),
  pickTools: el<HTMLDivElement>("pick-tools"),
  pickToggle: el<HTMLButtonElement>("pick-toggle"),
  pickHelp: el<HTMLParagraphElement>("pick-help"),
  picks: el<HTMLDivElement>("picks"),
  pickCount: el<HTMLParagraphElement>("pick-count"),
  pickList: el<HTMLUListElement>("pick-list"),
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
  /** 元の PDF の SHA-256（処理の報告書に載せる） */
  sha256: string | null;
  byteLength: number;
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
/** 片付けた PDF（保存する中身）。保存のリンクは、読み直しが通ったあとでだけ、ここから作る */
let cleanedBlob: Blob | null = null;
let reportUrl: string | null = null;

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
  lockDownload();
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  reportUrl = null;
  ui.reportDownload.removeAttribute("href");
  ui.reportDownload.hidden = true;
  cleanedBlob = null;
  ui.saveConfirm.hidden = true;
  ui.saveConfirmBox.checked = false;
  ui.saveNote.textContent = "";
}

/** 保存のリンクを押せない形にする（href を外す。読み上げでも「使えない」と伝える） */
function lockDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  ui.download.removeAttribute("href");
  ui.download.setAttribute("aria-disabled", "true");
}

/** 保存のリンクを押せる形にする。読み直しが通ったときだけ呼ぶ（saveGate） */
function unlockDownload() {
  if (!cleanedBlob) return;
  if (!downloadUrl) downloadUrl = URL.createObjectURL(cleanedBlob);
  ui.download.href = downloadUrl;
  ui.download.removeAttribute("aria-disabled");
}

function applySaveGate(gate: SaveGate) {
  ui.saveNote.textContent = SAVE_NOTE[gate];
  ui.saveNote.dataset.gate = gate;
  ui.saveConfirm.hidden = gate !== "confirm";
  ui.saveConfirmBox.checked = false;
  if (gate === "ok") unlockDownload();
  else lockDownload();
}

function clearResults() {
  for (const part of [ui.noticeList, ui.groups, ui.thumbs, ui.marks]) part.replaceChildren();
  for (const part of [ui.notices, ui.actions, ui.verified, ui.thumbs, ui.sheetWrap, ui.renderNote, ui.scopeNote, ui.props, ui.ruleset]) part.hidden = true;
  ui.caption.textContent = "";
  delete ui.workspace.dataset.thumbs;
}

function reset() {
  clearResults();
  clearPicks();
  ui.pickTools.hidden = true;
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
  ui.stepVerifyNote.textContent = "残り 0 件なら完了";
}

// ---------------------------------------------------------------- 右：種類ごとの結果

const SEVERITY_MARK: Record<Row["severity"], string> = { high: "▲", medium: "■", low: "●" };

/** 種類ごとの囲み：左に札（飾り。読み上げでは見出しを読む）、右に見出しと項目（案 E2。design/README.md） */
function groupBox(fuda: string, kind: "found" | "scope"): { box: HTMLElement; body: HTMLDivElement } {
  const box = make("section", undefined, "group");
  box.dataset.status = kind;
  const tag = make("span", fuda, "fuda");
  tag.setAttribute("aria-hidden", "true");
  const body = make("div", undefined, "group-body");
  box.append(tag, body);
  return { box, body };
}

function itemButton(r: Row): HTMLButtonElement {
  const btn = make("button", undefined, "item");
  btn.type = "button";
  btn.id = `item-${r.no}`;
  btn.dataset.severity = r.severity;
  if (r.check) btn.dataset.check = "true";
  const top = make("span", undefined, "item-top");
  top.append(
    make("span", String(r.no), "item-no"),
    // 確かめてほしい所は、深刻度の札の代わりに「？ 確かめる」の札（形と字で示す。断定しない）
    r.check
      ? make("span", "？ 確かめる", "item-sev sev-check")
      : make("span", `${SEVERITY_MARK[r.severity]} ${r.severityLabel}`, `item-sev sev-${r.severity}`),
    make("span", r.page !== null ? `ページ ${r.page}` : "ファイル全体", "item-page"),
  );
  btn.append(top, make("span", r.title, "item-title"), make("span", r.why, "item-why"), make("span", r.detail, "item-detail"));
  btn.addEventListener("click", () => void select(r));
  return btn;
}

/** 「見た所・見なかった所」の1行の、状態の言葉（形の印つき。色だけにしない） */
function coverageText(c: CoverageRow, phase: Session["phase"]): string {
  const parts: string[] = [];
  if (c.found) parts.push(`${phase === "after" ? "残り" : "見つかった"} ${c.found} 件`);
  if (c.check) parts.push(`確かめる ${c.check} 件`);
  const counts = parts.length ? parts.join("・") : phase === "after" ? "残っていない" : "見つからない";
  switch (c.state) {
    case "checked":
      return `${parts.length ? "▲" : "✓"} 調べた：${counts}`;
    case "partial":
      return `◐ 一部だけ調べた：${counts}`;
    case "failed":
      return "－ 調べられなかった";
    case "not_in_version":
      return "○ この版では調べていない";
  }
}

function renderGroups(s: Session) {
  for (const g of s.view.groups) {
    if (g.status === "error" || !g.rows.length) continue;
    const { box, body } = groupBox(fudaLabel(g.label, g.pattern), "found");
    const head = make("h3", undefined, "group-head");
    const sure = g.rows.filter((r) => !r.check).length;
    const check = g.rows.length - sure;
    head.append(make("span", `${g.label}（${g.pattern}）`, "group-name"));
    head.append(make("span", [sure ? `${sure} 件` : "", check ? `確かめる ${check} 件` : ""].filter(Boolean).join("・"), "group-count"));
    body.append(head);
    const list = make("ol", undefined, "items");
    for (const r of g.rows) {
      const li = make("li");
      li.append(itemButton(r));
      list.append(li);
    }
    body.append(list);
    ui.groups.append(box);
  }
  renderCoverage(s);
}

/** 見た所・見なかった所：P1〜P12 と新しい型を1行ずつ、毎回並べる（調べていない理由も） */
function renderCoverage(s: Session) {
  const { box, body } = groupBox(FUDA_SCOPE, "scope");
  box.id = "coverage";
  body.append(make("h3", "見た所・見なかった所", "group-head"));
  body.append(
    make(
      "p",
      "この版のルールで、どこまで調べたかを、型ごとに並べます。「調べた」は、決めた範囲を調べたという意味で、すべてを保証するものではありません。",
      "group-message",
    ),
  );
  const list = make("ul", undefined, "coverage-list");
  for (const c of s.view.coverage) {
    const li = make("li");
    li.dataset.state = c.state;
    if (c.found || c.check) li.dataset.found = "true";
    li.append(make("span", `${c.name}（${c.key}）`, "coverage-name"), make("span", coverageText(c, s.phase), "coverage-state"));
    for (const r of c.reasons) li.append(make("span", r, "coverage-reason"));
    list.append(li);
  }
  body.append(list);
  ui.groups.append(box);
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
      if (picking) return; // 選んでいる間は、枠を押しても動かない（ドラッグを邪魔しない）
      const item = document.getElementById(`item-${m.no}`);
      item?.scrollIntoView({ block: "nearest" });
      item?.focus();
      markSelected(m.no);
    });
    ui.marks.append(mark);
  }
  placePicks(s, page);
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

// ---------------------------------------------------------------- プロパティの一覧（値を出してよいのは、ここだけ）

/** 文書情報の欄の、画面での名前（用語集の言葉）。ない欄は、欄の名前をそのまま出す */
const INFO_LABEL: Record<string, string> = {
  Title: "タイトル",
  Author: "作成者",
  Subject: "件名",
  Keywords: "キーワード",
  Creator: "作成したソフト",
  Producer: "PDF にしたソフト",
  CreationDate: "作った日時",
  ModDate: "直した日時",
  Trapped: "トラッピング",
};

function valueWithMarks(text: string, truncated: boolean): HTMLElement {
  const v = make("span", undefined, "prop-value");
  for (const seg of orgSegments(text)) v.append(seg.org ? make("mark", seg.text, "prop-org") : document.createTextNode(seg.text));
  if (truncated) v.append(make("span", "…（長いので途中まで）", "prop-cut"));
  return v;
}

function propRows(list: Array<{ key: string; value: string; truncated: boolean }>, label: (k: string) => string): HTMLElement {
  const dl = make("dl", undefined, "prop-list");
  for (const p of list) {
    const row = make("div", undefined, "prop-row");
    row.append(make("dt", label(p.key)), make("dd"));
    row.querySelector("dd")!.append(valueWithMarks(p.value, p.truncated));
    dl.append(row);
  }
  return dl;
}

/** 文書情報と XMP のすべての欄を、値ごと出す。団体名らしい語に印を付け、「片付ける」へ案内する */
function renderProperties(s: Session) {
  const p = s.summary.properties;
  ui.props.replaceChildren();
  if (p === undefined) {
    ui.props.hidden = true;
    return;
  }
  const count = p ? p.info.length + p.xmp.length : 0;
  const summary = make("summary", p ? `プロパティの一覧（文書情報 ${p.info.length} 欄・XMP ${p.xmp.length} 欄）` : "プロパティの一覧（読めませんでした）");
  ui.props.append(summary);
  const body = make("div", undefined, "props-body");
  body.append(
    make(
      "p",
      "この一覧だけは、欄の値をそのまま出します（このパソコンの画面の中だけで、外には出ません）。団体名らしい語には印を付けています（形で拾うだけなので、見落としや関係のない語もあります）。",
      "props-note",
    ),
  );
  if (p) {
    if (p.info.length) {
      body.append(make("h4", "文書情報"));
      body.append(propRows(p.info, (k) => (INFO_LABEL[k] ? `${INFO_LABEL[k]}（${k}）` : k)));
    }
    if (p.xmp.length) {
      body.append(make("h4", "XMP メタデータ"));
      body.append(propRows(p.xmp, (k) => k));
    }
    if (p.xmpProblem) body.append(make("p", p.xmpProblem === "too_large" ? "XMP が大きすぎるため、欄を並べていません。" : "XMP の字を読めなかったため、欄を並べていません。", "props-note"));
    if (p.limited) body.append(make("p", "欄が多すぎるため、途中までしか並べていません。", "props-note"));
    if (!count) body.append(make("p", s.phase === "after" ? "文書情報と XMP に、値の入った欄は残っていません。" : "文書情報と XMP に、値の入った欄はありません。"));
  }
  // その場で「消す」へ案内する（片付ける前で、片付けられるときだけ）
  if (count && s.phase === "before" && !ui.sanitize.disabled) {
    const go = make("button", "この欄を消す（「片付ける」へ）", "props-go");
    go.type = "button";
    go.addEventListener("click", () => {
      ui.actions.scrollIntoView({ block: "center", behavior: "smooth" });
      ui.sanitize.focus({ preventScroll: true });
    });
    body.append(go, make("p", "「片付ける」を押すと、文書情報と XMP の欄を、まとめて消した PDF を新しく作ります（元の PDF は変えません）。", "props-note"));
  }
  ui.props.append(body);
  ui.props.open = count > 0 && s.phase === "before";
  ui.props.hidden = false;
}

/** ルールの版・更新日・最近足した型（11/5 B の 10） */
function renderRuleset(s: Session) {
  const r = buildRulesetView(s.summary.rules);
  const body = make("div", undefined, "ruleset-body");
  if (r.recent.length) {
    body.append(make("h4", "最近足した型"));
    body.append(make("ul", undefined, "ruleset-list"));
    body.lastElementChild!.append(...r.recent.map((t) => make("li", t)));
  }
  body.append(make("h4", "ルールごとの版"));
  body.append(make("ul", undefined, "ruleset-list"));
  body.lastElementChild!.append(...r.versions.map((t) => make("li", t)));
  ui.ruleset.replaceChildren(make("summary", r.headline), body);
  ui.ruleset.hidden = false;
}

// ---------------------------------------------------------------- 結果の全体

/** 種類ごとの結果・お知らせ・ページを出す（片付ける前も、読み直したあとも同じ形） */
function renderInspection(s: Session) {
  const v = s.view;
  for (const n of v.notices) ui.noticeList.append(make("li", n));
  ui.notices.hidden = v.notices.length === 0;
  renderGroups(s);
  renderProperties(s);
  renderRuleset(s);
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
  // 自分で黒塗りする所を選ぶ：片付けられて、ページの絵と形があるときだけ
  ui.pickTools.hidden = ui.sanitize.disabled || !s.pdf || s.summary.pagesUnreadable;
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
  base: Pick<Session, "generation" | "phase" | "fileName" | "original" | "sha256" | "byteLength" | "pdf" | "pdfProblem">,
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

function renderOutcome(outcome: InspectOutcome, base: Pick<Session, "generation" | "fileName" | "original" | "sha256" | "byteLength" | "pdf" | "pdfProblem">) {
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
  ui.sampleRow.hidden = true;
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
    const sha256 = await sha256Hex(original).catch(() => null);
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
      sha256,
      byteLength: original.byteLength,
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

// ---------------------------------------------------------------- 自分で黒塗りする所を選ぶ（11/5 B の 9）

/** 選んだ所（片付ける前の PDF のページの座標）。片付けるときに、片付けの Worker へ渡す */
let picks: RedactArea[] = [];
let picking = false;

function setPicking(on: boolean) {
  picking = on;
  ui.pickToggle.setAttribute("aria-pressed", String(on));
  ui.pickToggle.textContent = on ? "選び終える" : "自分で黒塗りする所を選ぶ";
  ui.sheet.dataset.picking = String(on);
  ui.pickHelp.hidden = !on;
}

function renderPicks() {
  const s = session;
  ui.pickList.replaceChildren(
    ...picks.map((p, i) => {
      const li = make("li");
      const rm = make("button", "外す", "pick-remove");
      rm.type = "button";
      rm.setAttribute("aria-label", `選んだ所 ${i + 1}（ページ ${p.page}）を外す`);
      rm.addEventListener("click", () => {
        picks.splice(i, 1);
        renderPicks();
        if (session) placeMarks(session, session.current);
      });
      li.append(make("span", `選んだ所 ${i + 1}：ページ ${p.page}`), rm);
      return li;
    }),
  );
  ui.picks.hidden = picks.length === 0;
  ui.pickCount.textContent = `選んだ所 ${picks.length} か所（「片付ける」を押すと、見つかった所といっしょに黒塗りします。下の字は消します）`;
  if (s && s.phase === "before" && !ui.sanitize.disabled) {
    ui.sanitize.textContent = picks.length ? `片付ける（選んだ ${picks.length} か所も黒塗り）` : "片付ける";
  }
}

function clearPicks() {
  picks = [];
  setPicking(false);
  renderPicks();
  ui.sanitize.textContent = "片付ける";
}

/** ページの上に、選んだ所（墨の点線の枠）を描く */
function placePicks(s: Session, page: number) {
  const box = s.boxes.get(page);
  if (!box || s.phase !== "before") return;
  picks.forEach((p, i) => {
    if (p.page !== page) return;
    const f = toFraction(box, p.rect);
    if (!f) return;
    const e = make("div", undefined, "mark mark-pick");
    e.setAttribute("role", "img");
    e.setAttribute("aria-label", `自分で選んだ所 ${i + 1}`);
    e.append(make("span", `選${i + 1}`, "mark-no"));
    placeAt(e, f);
    ui.marks.append(e);
  });
}

// ページの上をドラッグして選ぶ（ポインター。マウス・指・ペン）
let dragStart: { x: number; y: number } | null = null;
let dragEl: HTMLDivElement | null = null;
function sheetPoint(e: PointerEvent) {
  const r = ui.sheet.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
function dragFraction(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
ui.sheet.addEventListener("pointerdown", (e) => {
  if (!picking || !session || session.phase !== "before") return;
  e.preventDefault();
  ui.sheet.setPointerCapture(e.pointerId);
  dragStart = sheetPoint(e);
  dragEl = make("div", undefined, "mark mark-pick is-drawing");
  ui.marks.append(dragEl);
});
ui.sheet.addEventListener("pointermove", (e) => {
  if (!dragStart || !dragEl) return;
  placeAt(dragEl, dragFraction(dragStart, sheetPoint(e)));
});
ui.sheet.addEventListener("pointerup", (e) => {
  if (!dragStart || !session) return;
  const f = dragFraction(dragStart, sheetPoint(e));
  dragStart = null;
  dragEl?.remove();
  dragEl = null;
  const box = session.boxes.get(session.current);
  // 小さすぎる所（ただのクリック）は選ばない
  if (!box || f.width < 0.005 || f.height < 0.005) return;
  if (picks.length >= MAX_REDACT_AREAS) return;
  picks.push({ page: session.current, rect: fromFraction(box, f) });
  renderPicks();
  placeMarks(session, session.current);
});
ui.pickToggle.addEventListener("click", () => setPicking(!picking));

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
    ui.stepVerifyNote.textContent = "残り 0 件になりました";
  } else {
    setStep(ui.stepVerify, "now");
    ui.stepVerifyNote.textContent = c.left === null ? "読み直せませんでした" : c.left > 0 ? `${c.left} か所 残っています` : "消えたと言い切れない所があります";
  }

  ui.cleanCount.textContent =
    c.left === null ? `片付ける前 ${c.before} か所 → 読み直せませんでした` : `片付ける前 ${c.before} か所 → 読み直したあと ${c.left} か所`;
  ui.cleanCount.dataset.verdict = c.verdict;
  ui.download.download = file.name;
  applySaveGate(saveGate(c));
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

/** 型ごとの、片付ける前と読み直したあとの数（11/5 B の 6） */
function renderBeforeAfter(before: ViewModel, after: ViewModel | null) {
  const rows = beforeAfterCounts(before.coverage, after?.coverage ?? null);
  ui.beforeAfterList.replaceChildren(
    ...rows.map((r) => {
      const li = make("li");
      if (r.after) li.dataset.left = "true";
      li.append(make("span", `${r.name}（${r.key}）`, "ba-name"), make("span", `${r.before} → ${r.after === null ? "読み直せなかった" : r.after}`, "ba-count"));
      return li;
    }),
  );
  ui.beforeAfter.hidden = rows.length === 0;
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
    const areas = picks.slice();
    setPicking(false);
    ui.pickTools.hidden = true;
    const out = await sanitizeInWorker(original.buffer as ArrayBuffer, undefined, areas);
    if (gen !== generation) return;
    if (out.kind === "timeout") return cleanFailed("時間がかかりすぎたため、片付けを止めました。画面はそのまま使えます。");
    if (out.kind !== "done") return cleanFailed(out.message);

    setStep(ui.stepClean, "done");
    ui.stepCleanNote.textContent = "片付けました";
    setStep(ui.stepVerify, "now");
    ui.stepVerifyNote.textContent = "読み直しています";
    setStatus("片付けた PDF を、最初から検査し直しています…");
    ui.progress.value = 0;

    // 保存する PDF（Blob は中身を写して持つ）。絵を描く側にも写しを渡し、検査の Worker には元を渡し切る。
    // 保存のリンク（Blob の URL）は、ここでは作らない。読み直しが通ったあと（renderCleaned の saveGate）でだけ作る
    const name = cleanedFileName(s.fileName);
    const byteLength = out.bytes.byteLength;
    const afterSha = await sha256Hex(out.bytes).catch(() => null);
    releaseDownload();
    cleanedBlob = new Blob([out.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
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
        { generation: gen, phase: "after", fileName: name, original: null, sha256: afterSha, byteLength, pdf: opened.ok ? opened.view : null, pdfProblem: opened.ok ? null : opened.reason },
        clean.doneMarks,
      );
      renderInspection(session);
    } else if (opened.ok) {
      void opened.view.close();
    }
    renderCleaned(clean, file);
    const afterView = afterSummary ? buildView(afterSummary) : null;
    renderBeforeAfter(s.view, afterView);
    if (s.sha256 && afterSha) {
      const text = buildProcessReport({
        date: new Date().toLocaleDateString("sv-SE"), // YYYY-MM-DD（利用者のパソコンの日付）
        before: { sha256: s.sha256, bytes: s.byteLength, coverage: s.view.coverage },
        after: { sha256: afterSha, bytes: byteLength, pages: out.pages, coverage: afterView?.coverage ?? null },
        removed: out.removed,
        notDone: out.notDone,
        verdict: clean.headline,
        rules: (afterSummary ?? s.summary).rules.filter((r) => r.ruleVersion).map((r) => `${r.ruleId}@${r.ruleVersion}`),
      });
      reportUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      ui.reportDownload.href = reportUrl;
      ui.reportDownload.hidden = false;
    }
  } catch {
    if (gen === generation) cleanFailed("片付けの途中で問題が起きました。");
  } finally {
    busy = false;
  }
}

ui.sanitize.addEventListener("click", () => void runSanitize());
ui.saveConfirmBox.addEventListener("change", () => {
  if (ui.saveConfirmBox.checked) unlockDownload();
  else lockDownload();
});
// 押せない形のときは、押しても何もしない（href がないので、もともと保存は起きない。念のため止める）
ui.download.addEventListener("click", (e) => {
  if (ui.download.getAttribute("aria-disabled") === "true") e.preventDefault();
});

el<HTMLAnchorElement>("font-license").href = fontLicenseUrl;

ui.sample.addEventListener("click", () => {
  const file = sampleFile();
  if (file) void handle(file);
});

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
