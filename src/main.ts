// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面。PDF を受け取り、Worker で検査し、結果を出す。「片付ける」を押すと、片付けた PDF を作り、検査の入口に最初から入れ直す。
// 見た目の決まりは design/（README.md・tokens.css）。
// - 判定は検査の Worker（src/worker/inspect.worker.ts）だけが行う。ページの絵（PDF.js、src/render/pdf-view.ts）は見せるためだけ。
// - 片付けは片付けの Worker（src/worker/sanitize.worker.ts → sanitize/）が行う。「残っていない」は、片付けの報告ではなく、
//   片付けた PDF を検査し直した結果だけで言う（sanitize/README.md「4 読み直す」）。
// - 片付けた PDF は Blob にして、利用者が保存する（URL.createObjectURL。通信ではない）。
// - ファイルから取り出した文字や、ファイル名は、HTML として解釈させない（textContent だけを使う。CLAUDE.md §11-3）。
// - 見つけた字の中身は、頭の数文字だけを出して伏せ、「中身を見る」で全部を出す（2026-11-05 本人が決めた。src/ui/reveal.ts）。
//   中身は画面の中だけで使う。報告書には「中身も入れる」を選んだときだけ入れる。ログ・ファイル名には入れない。

import type { InspectOutcome } from "./inspect/protocol";
import type { PageBox, InspectSummary } from "./inspect/report";
import { inspectInWorker } from "./inspect/run";
import { fromFraction, toFraction, viewSize } from "./inspect/view";
import { PdfView, RenderTimeout } from "./render/pdf-view";
import { MAX_REDACT_AREAS } from "./sanitize/areas";
import { compressInWorker, preflightInWorker, sanitizeInWorker } from "./sanitize/run";
import type { TidyChoices } from "./sanitize/protocol";
import type { PropertyKey, TidyPreflight } from "../sanitize/types.ts";
import { buildEdits, CONSENT_TEXT, DATE_HINT, MODE_LABEL, PROPERTY_FIELDS, type PropertyChoice, type PropertyMode } from "./ui/tidy-model";
import type { NotDoneItem } from "../sanitize/types.ts";
import { buildCompressView, COMPRESS_PRESETS, compressedFileName, DEFAULT_PRESET, limitLine, nextForLimit, SIZE_LIMITS, sizeLimitFrom } from "./ui/compress-model";
import type { CompressPreset, SizeLimit } from "./ui/compress-model";
import { buildCleanView, cleanedFileName, SAVE_NOTE, saveGate, type CleanView, type DoneMark, type SaveGate } from "./ui/clean-model";
import type { CoverageRow } from "./ui/coverage";
import { FUDA_SCOPE, fudaLabel } from "./ui/fuda";
import { buildView, type PageMarks, type Row, type ViewModel } from "./ui/model";
import { isOfficialHost, UNOFFICIAL_NOTE } from "./ui/official";
import { clampResultsWidth, compactDetail, coverageSummary, SPLIT_BIG_STEP_PX, SPLIT_STEP_PX } from "./ui/compact";
import { orgSegments } from "./ui/org-words";
import { addAllCandidates, buildBlockedView, isCandidate, pickLabel, toAreas, toggleCandidate, type PickedArea } from "./ui/picks";
import { buildRulesetView } from "./ui/ruleset";
import { sampleFile, wantsSample, withoutSample } from "./ui/sample";
import { beforeAfterCounts, buildProcessReport, sha256Hex, type ProcessReportInput } from "./ui/process-report";
import { fullContent, maskContent, REVEAL_LABEL, REVEAL_NOTE } from "./ui/reveal";
import { setupTermsDialog } from "./ui/terms-dialog";
import { originNote, repoFromMeta } from "./ui/rule-origin-note";

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
  /** プロパティの選び方の欄（プロパティの一覧を作るたびに作り直す） */
  tidyProps: document.createElement("div"),
  input: el<HTMLInputElement>("file"),
  drop: el<HTMLLabelElement>("drop"),
  workspace: el<HTMLElement>("workspace"),
  sample: el<HTMLButtonElement>("sample"),
  sampleRow: el<HTMLParagraphElement>("sample-row"),
  limitRow: el<HTMLDivElement>("limit-row"),
  sizeLimit: el<HTMLSelectElement>("size-limit"),
  compressLimit: el<HTMLParagraphElement>("compress-limit"),
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
  results: el<HTMLElement>("results"),
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
  reportContents: el<HTMLLabelElement>("report-contents"),
  reportContentsBox: el<HTMLInputElement>("report-contents-box"),
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
  pickHelpCandidates: el<HTMLParagraphElement>("pick-help-candidates"),
  tidySummary: el<HTMLParagraphElement>("tidy-summary"),
  consent: el<HTMLDivElement>("consent"),
  cleanTitle: el<HTMLHeadingElement>("clean-title"),
  compress: el<HTMLElement>("compress"),
  compressTitle: el<HTMLHeadingElement>("compress-title"),
  compressPresets: el<HTMLFieldSetElement>("compress-presets"),
  compressRun: el<HTMLButtonElement>("compress-run"),
  compressResult: el<HTMLDivElement>("compress-result"),
  compressHeadline: el<HTMLParagraphElement>("compress-headline"),
  compressSizes: el<HTMLParagraphElement>("compress-sizes"),
  compressLines: el<HTMLUListElement>("compress-lines"),
  compressRecheck: el<HTMLParagraphElement>("compress-recheck"),
  compressDownload: el<HTMLAnchorElement>("compress-download"),
  compressSaveNote: el<HTMLParagraphElement>("compress-save-note"),
  compressConfirm: el<HTMLLabelElement>("compress-confirm"),
  compressConfirmBox: el<HTMLInputElement>("compress-confirm-box"),
  picks: el<HTMLDivElement>("picks"),
  pickCount: el<HTMLParagraphElement>("pick-count"),
  pickList: el<HTMLUListElement>("pick-list"),
  redactLeft: el<HTMLDivElement>("redact-left"),
  redactLeftList: el<HTMLUListElement>("redact-left-list"),
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
/** 整える前の問い合わせ（プロパティの今の値・PDF/A の印・電子署名）。片付けの Worker の preflightTidy */
let tidyPre: Extract<TidyPreflight, { status: "ok" }> | null = null;
/** 本人が選んだプロパティの書き直し（既定はすべて「消す」） */
let propChoices: Partial<Record<PropertyKey, PropertyChoice>> = {};
/** 報告書の中身（中身を入れるかを選び直したときに、作り直すため）。見つけた字の中身は contents に分けて持つ */
let reportInput: { base: ProcessReportInput; contents: NonNullable<ProcessReportInput["contents"]> } | null = null;

/** 報告書を作り直す。「中身も入れる」に印があるときだけ、見つけた字の中身を入れる（初めは入れない） */
function refreshReport() {
  if (!reportInput) return;
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  const withContents = ui.reportContentsBox.checked && reportInput.contents.length > 0;
  const text = buildProcessReport(withContents ? { ...reportInput.base, contents: reportInput.contents } : reportInput.base);
  reportUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  ui.reportDownload.href = reportUrl;
  ui.reportDownload.hidden = false;
  ui.reportContents.hidden = reportInput.contents.length === 0;
}
/** 小さくした PDF（保存する中身）と、その保存のリンク。読み直しが通ったあとでだけリンクを作る（片付けと同じ） */
let compressedBlob: Blob | null = null;
let compressUrl: string | null = null;
/** 片付けて読み直した結果（小さくしたあとの読み直しと比べる） */
let cleanedState: { view: ViewModel; notDone: NotDoneItem[]; name: string } | null = null;
/** 提出のために小さくする入口で選んだ上限（PDF を置いたときの選択。選ばなければ null＝ふつうの検査） */
let shrinkLimit: SizeLimit | null = null;

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
  reportInput = null;
  ui.reportDownload.removeAttribute("href");
  ui.reportDownload.hidden = true;
  ui.reportContents.hidden = true;
  ui.reportContentsBox.checked = false;
  cleanedBlob = null;
  cleanedState = null;
  resetCompress();
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

// ---------------------------------------------------------------- ファイルを小さくする（片付けの compress）

function lockCompressDownload() {
  if (compressUrl) URL.revokeObjectURL(compressUrl);
  compressUrl = null;
  ui.compressDownload.removeAttribute("href");
  ui.compressDownload.setAttribute("aria-disabled", "true");
}

function unlockCompressDownload() {
  if (!compressedBlob) return;
  if (!compressUrl) compressUrl = URL.createObjectURL(compressedBlob);
  ui.compressDownload.href = compressUrl;
  ui.compressDownload.removeAttribute("aria-disabled");
}

function resetCompress() {
  lockCompressDownload();
  compressedBlob = null;
  ui.compress.hidden = true;
  ui.compressResult.hidden = true;
  ui.compressDownload.hidden = true;
  ui.compressConfirm.hidden = true;
  ui.compressConfirmBox.checked = false;
  ui.compressRun.disabled = false;
  ui.compressLines.replaceChildren();
  for (const part of [ui.compressHeadline, ui.compressSizes, ui.compressRecheck, ui.compressSaveNote, ui.compressLimit]) part.textContent = "";
  ui.compressLimit.hidden = true;
}

/** 選べる3つの値（ラジオボタン。矢印キーで選べる） */
function renderCompressPresets() {
  if (ui.compressPresets.querySelector("input")) return;
  for (const p of COMPRESS_PRESETS) {
    const label = make("label", undefined, "compress-preset");
    const input = make("input");
    input.type = "radio";
    input.name = "compress-preset";
    input.value = p.id;
    input.checked = p.id === DEFAULT_PRESET.id;
    label.append(input, make("span", p.label, "compress-preset-name"), make("span", p.note, "compress-preset-note"));
    ui.compressPresets.append(label);
  }
}

function chosenPreset() {
  const v = ui.compressPresets.querySelector<HTMLInputElement>("input:checked")?.value;
  return COMPRESS_PRESETS.find((p) => p.id === v) ?? DEFAULT_PRESET;
}

/**
 * 小さくする。preset を渡したときは、その細かさを選んだ形にしてから小さくする（上限の入口から呼ぶとき）。
 * 小さくしたあとの大きさ（changed＝縮めた画像があったか）を返す。止めた・失敗した・残りが増えた・保存できないときは null
 */
async function runCompress(preset?: CompressPreset): Promise<{ size: number; changed: boolean } | null> {
  const base = cleanedState;
  if (busy || !cleanedBlob || !base) return null;
  if (preset) {
    const radio = ui.compressPresets.querySelector<HTMLInputElement>(`input[value="${preset.id}"]`);
    if (radio) radio.checked = true;
  }
  let result: { size: number; changed: boolean } | null = null;
  busy = true;
  const gen = generation;
  resetCompress();
  ui.compress.hidden = false;
  ui.compressRun.disabled = true;
  ui.progress.removeAttribute("value");
  ui.progress.hidden = false;
  setStatus("ファイルを小さくしています…（小さくする前と後に、検査をかけています）");
  try {
    const out = await compressInWorker(await cleanedBlob.arrayBuffer(), chosenPreset());
    if (gen !== generation) return null;
    ui.compressResult.hidden = false;
    if (out.kind === "timeout" || out.kind === "refused" || out.kind === "error") {
      const text = out.kind === "timeout" ? "時間がかかりすぎたため、小さくするのを止めました。整えた PDF はそのまま保存できます。" : out.message;
      ui.compressHeadline.textContent = text;
      setStatus(text, "problem");
      return null;
    }
    const v = buildCompressView(out.kind === "done" ? { status: "ok", ...out } : { status: "blocked", ...out });
    ui.compressHeadline.textContent = v.headline;
    ui.compressSizes.textContent = v.sizes;
    ui.compressLines.replaceChildren(...v.lines.map((t) => make("li", t)));
    if (out.kind !== "done" || !out.changed) {
      setStatus(v.headline, v.kind === "blocked" ? "problem" : "neutral");
      return out.kind === "done" ? { size: out.sizeBefore, changed: false } : null;
    }
    // 小さくした PDF を、検査の入口に最初から入れ直す（片付けたあとと同じ。保存できるかは、この結果だけで決める）
    compressedBlob = new Blob([out.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
    setStatus("小さくした PDF を、最初から検査し直しています…");
    const re = await inspectInWorker(out.bytes.buffer as ArrayBuffer, (p) => {
      ui.progress.max = p.total;
      ui.progress.value = p.done;
      setStatus(`小さくした PDF を、最初から検査し直しています…（${p.label}、${p.done + 1}/${p.total}）`);
    });
    if (gen !== generation) return null;
    const afterSummary = re.kind === "done" && re.precheck.ok ? re.summary : null;
    const c = buildCleanView({ before: base.view, after: afterSummary ? buildView(afterSummary) : null, removed: [], notDone: base.notDone, decrypted: false });
    ui.compressRecheck.textContent = `小さくした PDF を最初から検査し直しました。${c.headline}`;
    const gate = saveGate(c);
    ui.compressDownload.download = compressedFileName(base.name);
    ui.compressDownload.hidden = false;
    ui.compressSaveNote.textContent = SAVE_NOTE[gate];
    ui.compressSaveNote.dataset.gate = gate;
    ui.compressConfirm.hidden = gate !== "confirm";
    if (gate === "ok") unlockCompressDownload();
    else lockCompressDownload();
    setStatus(`${v.headline}${c.headline}`, gate === "blocked" ? "problem" : gate === "ok" ? "ok" : "neutral");
    if (gate !== "blocked") result = { size: out.sizeAfter, changed: true };
  } catch {
    if (gen === generation) {
      ui.compressResult.hidden = false;
      ui.compressHeadline.textContent = "小さくする途中で問題が起きました。整えた PDF はそのまま保存できます。";
    }
  } finally {
    ui.progress.hidden = true;
    ui.compressRun.disabled = false;
    busy = false;
    // 結果の一文へ移し、保存のボタン（なければ結果の欄）が窓に入るまで動かす（押した所の下に出るので、気づけるように）
    if (gen === generation && !ui.compressResult.hidden) {
      ui.compressHeadline.focus({ preventScroll: true });
      (ui.compressDownload.hidden ? ui.compressResult : ui.compressDownload).scrollIntoView({ block: "nearest" });
    } else if (gen === generation) ui.compressTitle.focus();
  }
  return result;
}

/**
 * 提出のために小さくする入口：整えて読み直したあと、選んだ上限に収まるまで「ふつう」→「もっと小さく」の順で小さくする。
 * 整えた PDF がもう収まっていれば、小さくしない。結果は、小さくする欄のいちばん上の 1 文で知らせる
 */
async function shrinkToLimit(gen: number, limit: SizeLimit) {
  if (!cleanedBlob) return;
  let size = cleanedBlob.size;
  let compressed = false;
  const tried: CompressPreset["id"][] = [];
  const steps: string[] = [];
  for (;;) {
    const next = nextForLimit(size, limit, tried);
    if (next.kind !== "try") break;
    const last = COMPRESS_PRESETS.find((p) => p.id === tried.at(-1));
    if (last) steps.push(`「${last.label}」では収まらなかったため、「${next.preset.label}」で小さくし直しました。`);
    tried.push(next.preset.id);
    const r = await runCompress(next.preset);
    if (gen !== generation || r === null) return;
    size = r.size;
    compressed ||= r.changed;
    if (!r.changed) break;
  }
  const text = [...steps, limitLine(size, limit, compressed)].join("");
  ui.compressLimit.textContent = text;
  ui.compressLimit.hidden = false;
  // 読み直し（または小さくしたあとの読み直し）の一文は消さずに、後ろへ足す。色（tone）も、読み直しの結果のまま
  const tone = ui.status.dataset.tone === "ok" || ui.status.dataset.tone === "problem" ? ui.status.dataset.tone : "neutral";
  setStatus(`${ui.status.textContent ?? ""}${text}`, tone);
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
  for (const part of [ui.notDoneList, ui.removedGroups, ui.cleanNotes, ui.redactLeftList]) part.replaceChildren();
  ui.redactLeft.hidden = true;
  ui.consent.replaceChildren();
  ui.consent.hidden = true;
  ui.tidySummary.textContent = "";
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
  ui.stepVerifyNote.textContent = "通れば保存できます";
}

/** 最初の画面（PDF を置く所）に戻る。見本の PDF のあとなどに使う */
function goHome() {
  if (busy) return;
  generation++;
  const old = session;
  session = null;
  void old?.pdf?.close();
  reset();
  ui.workspace.dataset.state = "empty";
  ui.sampleRow.hidden = false;
  ui.limitRow.hidden = false;
  setStep(ui.stepPick, "now");
  ui.stepPickNote.textContent = "PDF を置く";
  ui.fileName.textContent = "";
  ui.fileFacts.textContent = "";
  ui.input.value = "";
  setStatus("まだ PDF を選んでいません。");
  ui.input.focus();
  window.scrollTo(0, 0);
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
  btn.setAttribute("aria-expanded", "false");
  const top = make("span", undefined, "item-top");
  top.append(
    make("span", String(r.no), "item-no"),
    // 確かめてほしい所は、深刻度の札の代わりに「？ 確かめる」の札（形と字で示す。断定しない）
    r.check
      ? make("span", "？ 確かめる", "item-sev sev-check")
      : make("span", `${SEVERITY_MARK[r.severity]} ${r.severityLabel}`, `item-sev sev-${r.severity}`),
    make("span", r.title, "item-title"),
  );
  // 閉じた形は 2 行（題の行と、場所・内訳の 1 行）。なぜ危ないかは、押して開いたときに出す（2026-11-05 本人の気づき）
  const where = r.page !== null ? `ページ ${r.page}` : "ファイル全体";
  btn.append(top, make("span", `${where}・${compactDetail(r.detail)}`, "item-detail"), make("span", r.why, "item-why"));
  btn.addEventListener("click", () => {
    // もう一度押すと閉じる。ほかの項目を押すと、そちらを開く
    const open = btn.getAttribute("aria-expanded") === "true" && session?.selected === r.no;
    if (open) {
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    void select(r);
  });
  return btn;
}

/**
 * 見つけた字の中身：頭の数文字だけを出して伏せ、「中身を見る」で全部を出す（もう一度押すと伏せる）。
 * 字は textContent でだけ出す（HTML として解釈させない）。full を渡すと、全部を出すときにその部品を使う（プロパティの一覧の印つきの値）
 */
function revealBox(content: string, what: string, full?: () => HTMLElement): HTMLElement {
  const box = make("div", undefined, "reveal");
  const text = make("span", maskContent(content), "reveal-text");
  text.setAttribute("aria-live", "polite");
  const btn = make("button", REVEAL_LABEL.closed, "reveal-toggle");
  btn.type = "button";
  btn.setAttribute("aria-pressed", "false");
  btn.setAttribute("aria-label", `${what}の中身を見る`);
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(open));
    btn.textContent = open ? REVEAL_LABEL.open : REVEAL_LABEL.closed;
    btn.setAttribute("aria-label", open ? `${what}の中身を伏せる` : `${what}の中身を見る`);
    if (open && full) text.replaceChildren(full());
    else text.textContent = open ? fullContent(content) : maskContent(content);
    box.dataset.open = String(open);
  });
  box.append(make("span", "中身：", "reveal-label"), text, btn);
  return box;
}

/** 候補の行の「黒塗りに加える／外す」（押した状態を aria-pressed と字で示す） */
function candidateButton(r: Row): HTMLButtonElement {
  const b = make("button", undefined, "pick-candidate");
  b.type = "button";
  b.dataset.candidate = String(r.no);
  b.addEventListener("click", () => {
    picks = toggleCandidate(picks, r);
    renderPicks();
    if (session) placeMarks(session, session.current);
  });
  syncCandidateButton(b, r.no);
  return b;
}

function syncCandidateButton(b: HTMLElement, no: number) {
  const on = picks.some((p) => p.candidate === no);
  b.setAttribute("aria-pressed", String(on));
  b.textContent = on ? "✓ 黒塗りに加えました（外す）" : "黒塗りに加える";
  b.setAttribute("aria-label", on ? `候補 ${no} を、黒塗りする所から外す` : `候補 ${no} を、黒塗りする所に加える`);
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
    // 黒塗りの候補（個人情報らしい字）：片付ける前だけ、選んだ所に加えるボタンを付ける（キーボードでも選べる）
    const candidates = s.phase === "before" && !ui.pickTools.hidden ? g.rows.filter(isCandidate) : [];
    if (candidates.length) {
      const all = make("button", "候補をすべて黒塗りに加える", "pick-all");
      all.type = "button";
      all.addEventListener("click", () => {
        picks = addAllCandidates(picks, candidates);
        renderPicks();
        if (session) placeMarks(session, session.current);
      });
      body.append(all);
    }
    if (g.rows.some((r) => r.content)) body.append(make("p", `見つけた字の中身は、頭の数文字だけを出しています。${REVEAL_NOTE}`, "reveal-note"));
    const list = make("ol", undefined, "items");
    for (const r of g.rows) {
      const li = make("li");
      li.append(itemButton(r));
      if (r.content) li.append(revealBox(r.content, `${r.no} 番`));
      // 見つける段から来た型だけ、出どころの札（src/ui/rule-origin.ts）
      if (r.origin) li.append(originNote(document, r.origin, repoFromMeta(document)));
      if (candidates.some((c) => c.no === r.no)) li.append(candidateButton(r));
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
  const details = make("details", undefined, "coverage-details");
  const summary = make("summary", undefined, "coverage-summary");
  const head = make("h3", "見た所・見なかった所", "group-head");
  summary.append(head, make("span", coverageSummary(s.view.coverage, s.phase), "coverage-sum"));
  details.append(summary);
  details.append(
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
  details.append(list);
  body.append(details);
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
    if (done) parts.push(`消した所 ${done} か所`);
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
    done.setAttribute("aria-label", `消した所：${d.label}`);
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
  // 選んだ項目だけを開く（ページの上の枠を押したときも、その項目の説明が開く）
  for (const e of document.querySelectorAll<HTMLElement>(".item[aria-expanded]")) e.setAttribute("aria-expanded", String(e.id === `item-${no}`));
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
  if (done) facts.push(`消した所 ${done} か所`);
  ui.caption.textContent = `${s.phase === "after" ? "整えた PDF の" : ""}ページ ${page}${facts.length ? `（${facts.join("・")}）` : ""}`;
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
    // heavy には、解くと大きすぎる中身のあるページも入る（src/ui/model.ts の heavyPages）。理由ごとの文は右の「お知らせ」に出る
    note = "このページは、図形が多すぎるか、解くと大きすぎる中身があるため、絵を描いていません（検査も省きました）。";
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
    row.querySelector("dd")!.append(revealBox(p.value, label(p.key), () => valueWithMarks(p.value, p.truncated)));
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
  const summary = make("summary");
  summary.append(
    make("span", p ? `プロパティの一覧（文書情報 ${p.info.length} 欄・XMP ${p.xmp.length} 欄）` : "プロパティの一覧（読めませんでした）"),
    // 閉じていても読める一言（値をそのまま出す所なので、画面共有・画面の撮影の前に閉じてもらう）
    make("span", "開くと欄の値を、頭の数文字だけ出します。画面を共有・撮影する前は、閉じておいてください。", "props-warn"),
  );
  ui.props.append(summary);
  const body = make("div", undefined, "props-body");
  body.append(
    make(
      "p",
      `欄の値は、頭の数文字だけを出しています。「中身を見る」で全部を出します（このパソコンの画面の中だけで、外には出ません）。${REVEAL_NOTE}団体名らしい語には、全部を出したときに印を付けています（形で拾うだけなので、見落としや関係のない語もあります）。`,
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
    const go = make("button", "この欄を消す（「整える」へ）", "props-go");
    go.type = "button";
    go.addEventListener("click", () => {
      ui.actions.scrollIntoView({ block: "center", behavior: "smooth" });
      ui.sanitize.focus({ preventScroll: true });
    });
    body.append(go, make("p", "「整える」を押すと、文書情報と XMP の欄を、まとめて消した PDF を新しく作ります（元の PDF は変えません）。", "props-note"));
  }
  ui.tidyProps = make("div", undefined, "tidy-props");
  if (s.phase === "before") body.prepend(ui.tidyProps);
  ui.props.append(body);
  if (s.phase === "before") renderTidyEditor();
  // 最初は閉じた形で出す（値をそのまま出す所なので、開くのは利用者が決める）
  ui.props.open = false;
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
  renderTidySummary();
  ui.sanitizeNote.textContent = s.pdfProblem === "password"
    ? "パスワードが要る PDF は、整えられません。"
    : v.rows.length
    ? "「整える」では、見えない情報を消します（黒塗りの下の字・見えない字・作成者などの欄・前の版の残り・添付ファイル・注釈・JavaScript など）。整えた PDF を新しく作り、元の PDF は変えません。"
    : "見つかった所はありませんが、「整える」で、XMP メタデータ・注釈のコメント・JavaScript などの見えない情報を消した PDF を作れます。元の PDF は変えません。";
  if (shrinkLimit) ui.sanitizeNote.textContent += `整えて読み直したあとに、選んだ上限（${shrinkLimit.label}）まで小さくします。`;
  // 自分で黒塗りする所を選ぶ：片付けられて、ページの絵と形があるときだけ
  ui.pickTools.hidden = ui.sanitize.disabled || !s.pdf || s.summary.pagesUnreadable;
  ui.pickHelpCandidates.hidden = !v.rows.some(isCandidate);
  setStep(ui.stepClean, v.rows.length ? "now" : "todo");
  ui.stepCleanNote.textContent = "「整える」を押します";

  // 何も見つからなかったときの札（片付けたあとの「全部緑」は renderCleaned）
  ui.verified.dataset.state = v.clean ? "clean" : "none";
  ui.verifiedText.textContent = v.clean ? "調べた項目では、見つかりませんでした。" : "";
  ui.verified.hidden = !v.clean;

  renderInspection(s);
  // 押したボタン（見本の PDF で試す など）が隠れてフォーカスが行き場を失ったときは、結果の見出しへ移す
  const a = document.activeElement;
  if (!a || a === document.body || (a instanceof HTMLElement && a.offsetParent === null)) ui.resultTitle.focus();
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
  // 通信を数える拡張機能（extension/）への合図。ページの中の属性を変えるだけで、通信はしない
  document.documentElement.dataset.omamoriPdf = String(gen);
  const old = session;
  session = null;
  void old?.pdf?.close();
  reset();
  ui.workspace.dataset.state = "working";
  ui.sampleRow.hidden = true;
  ui.limitRow.hidden = true;
  shrinkLimit = sizeLimitFrom(ui.sizeLimit.value);
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
    tidyPre = null;
    propChoices = {};
    const forPreflight = original.slice();
    renderOutcome(outcome, {
      generation: gen,
      fileName: file.name,
      original,
      sha256,
      byteLength: original.byteLength,
      pdf: opened.ok ? opened.view : null,
      pdfProblem: opened.ok ? null : opened.reason,
    });
    const cur = session as Session | null; // renderOutcome の中で作り直すので、型の絞り込みを外す
    if (cur && cur.phase === "before" && cur.pdfProblem !== "password") void loadPreflight(gen, forPreflight);
  } catch {
    ui.progress.hidden = true;
    fail("ファイルを読めませんでした。");
  } finally {
    busy = false;
    ui.input.value = "";
  }
}

// ---------------------------------------------------------------- 整えるときに本人が選ぶこと（プロパティ・PDF/A・電子署名）

async function loadPreflight(gen: number, bytes: Uint8Array) {
  const r = await preflightInWorker(bytes.buffer as ArrayBuffer).catch(() => null);
  if (gen !== generation || !session || session.phase !== "before") return;
  tidyPre = r && r.status === "ok" ? r : null;
  renderTidyEditor();
  renderConsent();
  // 提出のために小さくする入口で、何も見つからなければ、そのまま整えて小さくする所まで進む。
  // 同意が要る PDF（PDF/A の印・電子署名）や、自分で黒塗りする所を選んでいる間は、本人が「整える」を押すのを待つ
  if (shrinkLimit && session.view.clean && ui.consent.hidden && !ui.sanitize.disabled && picks.length === 0 && !picking) {
    setStatus(`見つかった所はありませんでした。選んだ上限（${shrinkLimit.label}）まで小さくするため、続けて整えます…`, "ok");
    void runSanitize();
  }
}

/** プロパティの一覧の上に、8 つの項目ごとの「消す／そのまま／書き直す」を出す（既定は消す） */
function renderTidyEditor() {
  ui.tidyProps.replaceChildren();
  ui.tidyProps.hidden = !tidyPre;
  if (!tidyPre) return;
  const pre = tidyPre;
  ui.tidyProps.append(
    make("h4", "整えるときのプロパティ"),
    make("p", "8 つの項目は、文書情報と XMP の両方に同じ値で書きます。選ばなければ消します。ほかの欄（独自の欄・履歴など）は、いつも消します。", "props-note"),
  );
  const list = make("div", undefined, "tidy-list");
  for (const f of PROPERTY_FIELDS) {
    const now = pre.properties.find((x) => x.key === f.key);
    const value = now?.info ?? now?.xmp ?? "";
    const row = make("fieldset", undefined, "tidy-row");
    row.append(make("legend", `${f.label}（${f.info}）`));
    row.append(value ? revealBox(value, f.label) : make("p", "今は空です。", "props-note"));
    const choice = propChoices[f.key] ?? { mode: "remove" as PropertyMode, value: "" };
    const modes = make("div", undefined, "tidy-modes");
    const input = make("input", undefined, "tidy-input");
    input.type = "text";
    input.value = choice.value;
    input.setAttribute("aria-label", `${f.label}の新しい値`);
    if (f.date) input.placeholder = "2026-11-05";
    const hint = make("p", f.date ? DATE_HINT : "書き直す値を入れてください。", "props-note");
    const sync = () => {
      const c = propChoices[f.key] ?? { mode: "remove" as PropertyMode, value: "" };
      input.hidden = c.mode !== "set";
      hint.hidden = c.mode !== "set";
      renderTidySummary();
    };
    for (const m of ["remove", "keep", "set"] as PropertyMode[]) {
      if (m === "keep" && !value) continue;
      const label = make("label", undefined, "tidy-mode");
      const radio = make("input");
      radio.type = "radio";
      radio.name = `tidy-${f.key}`;
      radio.value = m;
      radio.checked = choice.mode === m;
      radio.addEventListener("change", () => {
        propChoices[f.key] = { mode: m, value: input.value };
        sync();
        if (m === "set") input.focus();
      });
      label.append(radio, make("span", MODE_LABEL[m]));
      modes.append(label);
    }
    input.addEventListener("input", () => {
      propChoices[f.key] = { mode: "set", value: input.value };
      renderTidySummary();
    });
    row.append(modes, input, hint);
    list.append(row);
    sync();
  }
  ui.tidyProps.append(list);
}

/** 「整える」の近くに、プロパティをどうするかの一言を出す */
function renderTidySummary() {
  const chosen = PROPERTY_FIELDS.filter((f) => (propChoices[f.key]?.mode ?? "remove") !== "remove");
  ui.tidySummary.textContent = !tidyPre
    ? ""
    : chosen.length
      ? `プロパティ：${chosen.map((f) => `${f.label}を${MODE_LABEL[propChoices[f.key]!.mode]}`).join("・")}。ほかは消します（プロパティの一覧で変えられます）。`
      : "プロパティは、すべて消します（プロパティの一覧で「そのまま」「書き直す」を選べます）。";
}

/** PDF/A の印・電子署名があれば、整える前に問いかけて同意を取る（既定は外す）。同意の印を付けるまで「整える」は押せない */
function renderConsent() {
  ui.consent.replaceChildren();
  const pre = tidyPre;
  const need = !!pre && (pre.pdfa !== null || pre.signatures > 0);
  ui.consent.hidden = !need;
  if (!pre || !need) {
    syncSanitizeEnabled();
    return;
  }
  const ask = (name: string, text: string, keepLabel: string) => {
    const box = make("fieldset", undefined, "consent-item");
    box.append(make("legend", text));
    for (const [v, label] of [["remove", "外す（おすすめ）"], ["keep", keepLabel]] as const) {
      const l = make("label", undefined, "tidy-mode");
      const r = make("input");
      r.type = "radio";
      r.name = name;
      r.value = v;
      r.checked = v === "remove";
      l.append(r, make("span", label));
      box.append(l);
    }
    ui.consent.append(box);
  };
  if (pre.pdfa) ask("consent-pdfa", CONSENT_TEXT.pdfa, "印を残す（形式の決まりを満たさないことがあります）");
  if (pre.signatures > 0) ask("consent-sig", CONSENT_TEXT.signatures(pre.signatures), "署名を残す（無効のまま残ります）");
  const agree = make("label", undefined, "save-confirm");
  const box = make("input");
  box.type = "checkbox";
  box.id = "consent-agree";
  box.addEventListener("change", syncSanitizeEnabled);
  agree.append(box, make("span", CONSENT_TEXT.agree));
  ui.consent.append(agree);
  syncSanitizeEnabled();
}

function consentGiven(): boolean {
  if (ui.consent.hidden) return true;
  return (document.getElementById("consent-agree") as HTMLInputElement | null)?.checked === true;
}

/** 「整える」を押せるか（同意が要るときは、印を付けるまで押せない） */
function syncSanitizeEnabled() {
  const s = session;
  if (!s || s.phase !== "before") return;
  ui.sanitize.disabled = s.original === null || s.pdfProblem === "password" || !consentGiven();
}

/** 本人が選んだことを集める。日付の形が違う項目があれば、その名前を返す */
function collectTidy(): { tidy: TidyChoices; bad: string[] } {
  const { edits, bad } = buildEdits(propChoices);
  const pick = (name: string) => ((document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value === "keep" ? "keep" : "remove");
  return {
    tidy: {
      ...(tidyPre ? { properties: edits } : {}),
      ...(tidyPre?.pdfa ? { pdfaMark: pick("consent-pdfa") } : {}),
      ...(tidyPre && tidyPre.signatures > 0 ? { signatures: pick("consent-sig") } : {}),
    },
    bad,
  };
}

// ---------------------------------------------------------------- 自分で黒塗りする所を選ぶ（11/5 B の 9）

/** 選んだ所（片付ける前の PDF のページの座標）。片付けるときに、片付けの Worker へ渡す */
let picks: PickedArea[] = [];
let picking = false;

function setPicking(on: boolean) {
  picking = on;
  ui.pickToggle.setAttribute("aria-pressed", String(on));
  ui.pickToggle.textContent = on ? "選び終える" : "自分で黒塗りする所を選ぶ";
  ui.sheet.dataset.picking = String(on);
  ui.pickHelp.hidden = !on;
  // キーボードでも選べるよう、選んでいる間だけ、ページの絵に Tab で移れるようにする
  if (on) {
    ui.sheet.tabIndex = 0;
    ui.sheet.setAttribute("role", "group");
    ui.sheet.setAttribute("aria-label", "黒塗りする所を選ぶページの絵（Enter で枠を出す）");
    ui.sheet.setAttribute("aria-describedby", "pick-help");
    // 幅の狭い画面では、ページの絵が結果の下にあるので、見える所まで移す
    const r = ui.sheetWrap.getBoundingClientRect();
    if (r.top > window.innerHeight || r.bottom < 0) ui.sheetWrap.scrollIntoView({ block: "start" });
  } else {
    ui.sheet.removeAttribute("tabindex");
    for (const a of ["role", "aria-label", "aria-describedby"]) ui.sheet.removeAttribute(a);
    cancelKeyDraft();
  }
}

// キーボードで選ぶ：Enter で枠を出し、矢印で動かし、Shift＋矢印で大きさを変え、Enter で決める。Esc でやめる
let keyDraft: { left: number; top: number; width: number; height: number } | null = null;
let keyDraftEl: HTMLDivElement | null = null;
function cancelKeyDraft() {
  keyDraft = null;
  keyDraftEl?.remove();
  keyDraftEl = null;
}
ui.sheet.addEventListener("keydown", (e) => {
  if (!picking || !session || session.phase !== "before") return;
  const step = 0.01;
  if (e.key === "Escape") {
    e.preventDefault();
    if (keyDraft) cancelKeyDraft();
    else {
      setPicking(false);
      ui.pickToggle.focus();
    }
    return;
  }
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (!keyDraft) {
      keyDraft = { left: 0.35, top: 0.45, width: 0.3, height: 0.05 };
      keyDraftEl = make("div", undefined, "mark mark-pick is-drawing");
      ui.marks.append(keyDraftEl);
      placeAt(keyDraftEl, keyDraft);
      return;
    }
    const box = session.boxes.get(session.current);
    if (box && picks.length < MAX_REDACT_AREAS) {
      picks.push({ page: session.current, rect: fromFraction(box, keyDraft) });
      renderPicks();
    }
    cancelKeyDraft();
    placeMarks(session, session.current);
    return;
  }
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = arrows[e.key];
  if (!d || !keyDraft || !keyDraftEl) return;
  e.preventDefault();
  const k = keyDraft;
  if (e.shiftKey) {
    k.width = Math.min(1 - k.left, Math.max(0.01, k.width + d[0] * step));
    k.height = Math.min(1 - k.top, Math.max(0.01, k.height + d[1] * step));
  } else {
    k.left = Math.min(1 - k.width, Math.max(0, k.left + d[0] * step));
    k.top = Math.min(1 - k.height, Math.max(0, k.top + d[1] * step));
  }
  placeAt(keyDraftEl, k);
});

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
      li.append(make("span", pickLabel(p, i)), rm);
      return li;
    }),
  );
  ui.picks.hidden = picks.length === 0;
  for (const b of ui.groups.querySelectorAll<HTMLElement>("[data-candidate]")) syncCandidateButton(b, Number(b.dataset.candidate));
  ui.pickCount.textContent = `選んだ所 ${picks.length} か所（「整える」を押すと、見つかった所といっしょに黒塗りします。下の字・画像・注釈も消します）${picks.length >= MAX_REDACT_AREAS ? `。一度に選べるのは ${MAX_REDACT_AREAS} か所までです` : ""}`;
  if (s && s.phase === "before" && !ui.sanitize.disabled) {
    ui.sanitize.textContent = picks.length ? `整える（選んだ ${picks.length} か所も黒塗り）` : "整える";
  }
}

function clearPicks() {
  picks = [];
  setPicking(false);
  renderPicks();
  ui.sanitize.textContent = "整える";
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
  ui.stepCleanNote.textContent = "整えられませんでした";
  ui.progress.hidden = true;
  ui.sanitizeNote.textContent = text;
}

/**
 * 自分で黒塗りした PDF を、保存の前に読み直したら残りが見つかった（片付けの redact の blocked）。
 * PDF は返ってこないので、保存の場面に進まない。何がどこに残ったかを並べ、選び直してもう一度片付けられるようにする
 */
function redactBlocked(s: Session, retry: Uint8Array | null, leftovers: Parameters<typeof buildBlockedView>[0], notDone: Parameters<typeof buildBlockedView>[1]) {
  const v = buildBlockedView(leftovers, notDone);
  setStatus(v.headline, "problem");
  setStep(ui.stepClean, "now");
  ui.stepCleanNote.textContent = "保存できる形にできませんでした";
  ui.progress.hidden = true;
  ui.sanitizeNote.textContent = "選んだ所を見直して（外す・選び直す）、もう一度「整える」を押せます。";
  // 「見つかりませんでした」の緑の札は、片付ける前の検査の結果。止められた今は出さない（全部緑と見誤らせない）
  ui.verified.hidden = true;
  ui.redactLeftList.replaceChildren(...v.lines.map((t) => make("li", t)));
  ui.redactLeft.hidden = v.lines.length === 0;
  s.original = retry;
  ui.sanitize.disabled = retry === null;
  ui.sanitize.textContent = picks.length ? `整える（選んだ ${picks.length} か所も黒塗り）` : "整える";
  ui.pickTools.hidden = retry === null;
}

function renderCleaned(c: CleanView, file: { name: string; bytes: number; pages: number; seconds: string }) {
  ui.workspace.dataset.phase = "after";
  ui.actions.hidden = true;
  setStatus(c.headline, c.verdict === "clean" ? "ok" : c.verdict === "left" ? "problem" : "neutral");

  setStep(ui.stepClean, "done");
  ui.stepCleanNote.textContent = "整えました";
  if (c.verdict === "clean") {
    setStep(ui.stepVerify, "done");
    ui.stepVerifyNote.textContent = "残り 0 件・保存できます";
  } else {
    setStep(ui.stepVerify, "now");
    ui.stepVerifyNote.textContent = c.left === null ? "読み直せませんでした" : c.left > 0 ? `${c.left} か所 残っています` : "消えたと言い切れない所があります";
  }

  ui.cleanCount.textContent =
    c.left === null ? `整える前 ${c.before} か所 → 読み直せませんでした` : `整える前 ${c.before} か所 → 読み直したあと ${c.left} か所`;
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

  const notes = [...c.notes, ...c.propertyLines.map((t) => `プロパティ：${t}`)];
  ui.cleanNotes.replaceChildren(...notes.map((t) => make("li", t)));
  ui.cleanNotes.hidden = notes.length === 0;
  ui.cleanScope.textContent = c.scope;
  ui.clean.hidden = false;

  ui.clean.dataset.verdict = c.verdict;
  // 片付けた結果の見出しへ移す（キーボード・読み上げで、次にすること（保存）がすぐ分かるように）
  ui.cleanTitle.focus();
  // 「全部緑」は、片付けた結果の欄（緑の枠）が示す。同じ文を重ねない
  ui.verified.hidden = true;
  ui.resultTitle.textContent = "読み直した結果（種類ごと）";
  ui.fileName.textContent = file.name;
  ui.fileFacts.textContent = `整えた PDF・${file.pages} ページ・${formatBytes(file.bytes)}`;
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
  ui.redactLeft.hidden = true;
  setStep(ui.stepClean, "now");
  ui.stepCleanNote.textContent = "整えています";
  setStatus("整えています…");
  ui.progress.removeAttribute("value"); // どこまで進んだか分からないので、動いていることだけを示す
  ui.progress.hidden = false;
  try {
    const { tidy, bad } = collectTidy();
    if (bad.length) {
      s.original = original;
      ui.sanitize.disabled = false;
      ui.progress.hidden = true;
      setStep(ui.stepClean, "now");
      ui.stepCleanNote.textContent = "「整える」を押します";
      setStatus(`${bad.join("・")}の日付の書き方が違います。${DATE_HINT}`, "problem");
      return;
    }
    const areas = toAreas(picks);
    // 自分で黒塗りした PDF が読み直しで止められたら、選び直してもう一度片付けられるよう、元の写しを持っておく
    const retry = areas.length ? original.slice() : null;
    setPicking(false);
    ui.pickTools.hidden = true;
    const out = await sanitizeInWorker(original.buffer as ArrayBuffer, undefined, areas, tidy);
    if (gen !== generation) return;
    if (out.kind === "timeout") return cleanFailed("時間がかかりすぎたため、整えるのを止めました。画面はそのまま使えます。");
    if (out.kind === "blocked") return redactBlocked(s, retry, out.leftovers, out.notDone);
    if (out.kind !== "done") return cleanFailed(out.message);

    setStep(ui.stepClean, "done");
    ui.stepCleanNote.textContent = "整えました";
    setStep(ui.stepVerify, "now");
    ui.stepVerifyNote.textContent = "読み直しています";
    setStatus("整えた PDF を、最初から検査し直しています…");
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
      setStatus(`整えた PDF を、最初から検査し直しています…（${p.label}、${p.done + 1}/${p.total}）`);
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
      ...(out.properties ? { properties: out.properties } : {}),
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
    // ファイルを小さくする：読み直しで残りが 0 件のときだけ出す（残っている PDF を小さくしても、保存できないため）
    cleanedState = afterSummary ? { view: buildView(afterSummary), notDone: out.notDone, name } : null;
    renderCompressPresets();
    ui.compress.hidden = !cleanedState || saveGate(clean) === "blocked";
    const afterView = afterSummary ? buildView(afterSummary) : null;
    renderBeforeAfter(s.view, afterView);
    if (s.sha256 && afterSha) {
      const base: ProcessReportInput = {
        date: new Date().toLocaleDateString("sv-SE"), // YYYY-MM-DD（利用者のパソコンの日付）
        before: { sha256: s.sha256, bytes: s.byteLength, coverage: s.view.coverage },
        after: { sha256: afterSha, bytes: byteLength, pages: out.pages, coverage: afterView?.coverage ?? null },
        removed: out.removed,
        notDone: out.notDone,
        properties: clean.propertyLines,
        verdict: clean.headline,
        rules: (afterSummary ?? s.summary).rules.filter((r) => r.ruleVersion).map((r) => `${r.ruleId}@${r.ruleVersion}`),
      };
      // 見つけた字の中身（整える前に見つけた所）。報告書には「中身も入れる」を選んだときだけ入れる
      const contents = s.view.rows.filter((r) => r.content).map((r) => ({ pattern: r.pattern, page: r.page, title: r.title, content: r.content! }));
      reportInput = { base, contents };
      ui.reportContentsBox.checked = false;
      refreshReport();
    }
  } catch {
    if (gen === generation) cleanFailed("整える途中で問題が起きました。");
  } finally {
    busy = false;
  }
  // 提出のために小さくする入口：読み直しが通って、小さくする欄が出たときだけ、続けて小さくする
  if (gen === generation && shrinkLimit && !ui.compress.hidden) await shrinkToLimit(gen, shrinkLimit);
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

ui.compressRun.addEventListener("click", () => void runCompress());
ui.reportContentsBox.addEventListener("change", refreshReport);
ui.compressConfirmBox.addEventListener("change", () => {
  if (ui.compressConfirmBox.checked) unlockCompressDownload();
  else lockCompressDownload();
});
ui.compressDownload.addEventListener("click", (e) => {
  if (ui.compressDownload.getAttribute("aria-disabled") === "true") e.preventDefault();
});


// 「利用規約」のリンクを押したとき、ページを移らずにダイアログで読めるようにする（src/ui/terms-dialog.ts）
setupTermsDialog();

// 公式のサイトで動いていなければ、画面の上に知らせる（丸写しの目印。守りの中心にはしない。src/ui/official.ts）

if (!isOfficialHost(location.hostname)) {
  const note = el<HTMLParagraphElement>("unofficial");
  note.textContent = UNOFFICIAL_NOTE;
  note.hidden = false;
}

// 提出のために小さくする入口の上限（compress-model.ts の SIZE_LIMITS から並べる）
for (const l of SIZE_LIMITS) {
  const o = make("option", `上限 ${l.label}`);
  o.value = String(l.mb);
  ui.sizeLimit.append(o);
}

ui.sample.addEventListener("click", () => {
  const file = sampleFile();
  if (file) void handle(file);
});

// 「別の PDF を選ぶ」：結果のあとは置き場（とファイルの欄）が隠れるので、ボタンからファイルの欄を開く（Tab で行けるように）
el<HTMLButtonElement>("file-again").addEventListener("click", () => ui.input.click());

ui.input.addEventListener("change", () => {
  const file = ui.input.files?.[0];
  if (file) void handle(file);
});

el<HTMLButtonElement>("go-home").addEventListener("click", goHome);

// 画面のどこに落としても受け取る（結果を見ている間も）。画面の外に落としたファイルを、ブラウザが開いてしまわないようにもする。
// ファイルを持ってきている間は、画面全体に「ここに落とす」を出す（字や画像のドラッグでは出さない）
const dropAnywhere = el<HTMLDivElement>("drop-anywhere");
const draggingFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
function dropOff() {
  delete ui.drop.dataset.over;
  dropAnywhere.hidden = true;
}
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!draggingFiles(e)) return;
  ui.drop.dataset.over = "true";
  dropAnywhere.hidden = busy;
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) dropOff();
});
window.addEventListener("dragend", dropOff);
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropOff();
  const file = e.dataTransfer?.files?.[0];
  if (file) void handle(file);
});

// 幅が変わったら、大きなページを描き直す
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

const splitter = el<HTMLDivElement>("splitter");
const stageEl = ui.sheetWrap.parentElement as HTMLElement;
const rootPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 18;
/** PDF の欄と結果の欄に使える幅（いまの 2 つの欄の幅の和） */
const splitAvailable = () => stageEl.getBoundingClientRect().width + ui.results.getBoundingClientRect().width;
function setResultsWidth(want: number) {
  const w = clampResultsWidth(want, splitAvailable(), rootPx());
  ui.workspace.style.setProperty("--results-w", `${w}px`);
  const total = splitAvailable();
  splitter.setAttribute("aria-valuenow", String(Math.round(((total - w) / total) * 100)));
  splitter.setAttribute("aria-valuetext", `PDF の欄 ${Math.round(((total - w) / total) * 100)}%・結果の欄 ${Math.round((w / total) * 100)}%`);
}
let splitDrag: { x: number; w: number } | null = null;
splitter.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitDrag = { x: e.clientX, w: ui.results.getBoundingClientRect().width };
  splitter.dataset.dragging = "true";
});
splitter.addEventListener("pointermove", (e) => {
  if (!splitDrag) return;
  // 仕切りを左へ動かすと、結果の欄が広がる（PDF の欄が狭まる）
  setResultsWidth(splitDrag.w + (splitDrag.x - e.clientX));
});
const endDrag = () => {
  splitDrag = null;
  delete splitter.dataset.dragging;
};
splitter.addEventListener("pointerup", endDrag);
splitter.addEventListener("pointercancel", endDrag);
splitter.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? SPLIT_BIG_STEP_PX : SPLIT_STEP_PX;
  const w = ui.results.getBoundingClientRect().width;
  if (e.key === "ArrowLeft") setResultsWidth(w + step);
  else if (e.key === "ArrowRight") setResultsWidth(w - step);
  else if (e.key === "Home") setResultsWidth(Number.POSITIVE_INFINITY);
  else if (e.key === "End") setResultsWidth(0);
  else return;
  e.preventDefault();
});
// PDF の欄の幅が変わったら（仕切り・窓の大きさ）、ページの絵を欄の幅に合わせて描き直す（少し待ってから。ドラッグ中に何度も描かない）
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (session && session.current) void showPage(session.current, session.selected);
  }, 200);
}).observe(stageEl);
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (session && session.current) void showPage(session.current, session.selected);
  }, 200);
});

// /?sample=1 で開いたら、「見本の PDF で試す」を押したときと同じに進む（サービス紹介のページから来たとき）。ほかの準備がすべて済んだ、このファイルの最後で呼ぶ。
// 見本はこのファイルに埋め込んだもので、取りに行く通信はない。再読み込みで何度も読まないよう、アドレスから外す
if (wantsSample(location.search)) {
  history.replaceState(history.state, "", withoutSample(location.pathname, location.search, location.hash));
  const file = sampleFile();
  if (file) void handle(file);
}
