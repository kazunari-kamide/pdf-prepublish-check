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
import { loadPartsAfterDisplay, resetParts, waitParts } from "./parts";
import { startFile } from "./worker-slot";
import type { TidyChoices } from "./sanitize/protocol";
import type { PropertyKey, TidyPreflight } from "../sanitize/types.ts";
import { buildEdits, CONSENT_TEXT, DATE_HINT, MODE_LABEL, PROPERTY_FIELDS, type PropertyChoice, type PropertyMode } from "./ui/tidy-model";
import type { NotDoneItem } from "../sanitize/types.ts";
import { buildCompressView, COMPRESS_PRESETS, compressedFileName, DEFAULT_PRESET, limitLine, nextForLimit, SIZE_LIMITS, sizeLimitFrom } from "./ui/compress-model";
import type { CompressPreset, SizeLimit } from "./ui/compress-model";
import { buildCleanView, cleanedFileName, PATTERN_NAME, SAVE_NOTE, saveGate, saveTexts, type CleanView, type DoneMark, type SaveGate } from "./ui/clean-model";
import type { CoverageRow } from "./ui/coverage";
import { buildView, kindSummary, shortHeadline, tierOf, type Group, type PageMarks, type Row, type ViewModel } from "./ui/model";
import { uniqueFills, type Fraction } from "./ui/mark-fills";
import { isOfficialHost, UNOFFICIAL_NOTE } from "./ui/official";
import { clampResultsWidth, compactDetail, coverageSummary, SPLIT_BIG_STEP_PX, SPLIT_STEP_PX } from "./ui/compact";
import { orgSegments } from "./ui/org-words";
import { addAllCandidates, buildBlockedView, isCandidate, pickLabel, toAreas, toggleCandidate, type PickedArea } from "./ui/picks";
import { buildRulesetView } from "./ui/ruleset";
import { spreadBadges } from "./ui/badges";
import { keepUnits } from "./ui/text";
import { sampleFile, wantsSample, withoutSample } from "./ui/sample";
import { beforeAfterCounts, buildProcessReport, sha256Hex, type ProcessReportInput } from "./ui/process-report";
import { fullContent, maskContent, REVEAL_LABEL, REVEAL_NOTE, showsWhole } from "./ui/reveal";
import { buildGlance } from "./ui/props-glance";
import { setupTermsDialog } from "./ui/terms-dialog";
import { isOutside } from "./ui/terms-click";
import { bandProgressRatio, bandProgressText, buildTidyConfirm, propertySummary, sanitizeListText } from "./ui/tidy-confirm";
import { buildKeepRows, initialKept, keepList, keptCount, keptSummary, tierCounts, type KeepRow } from "./ui/keep-model";
import { createThumbQueue, type ThumbQueue } from "./ui/thumb-queue";

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
  tidyProps: el<HTMLDivElement>("tidy-props"),
  input: el<HTMLInputElement>("file"),
  drop: el<HTMLLabelElement>("drop"),
  workspace: el<HTMLElement>("workspace"),
  sample: el<HTMLButtonElement>("sample"),
  sampleRow: el<HTMLParagraphElement>("sample-row"),
  limitRow: el<HTMLDetailsElement>("limit-row"),
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
  markNote: el<HTMLParagraphElement>("mark-note"),
  tidyKinds: el<HTMLFieldSetElement>("tidy-kinds"),
  tidyKindsList: el<HTMLUListElement>("tidy-kinds-list"),
  keepSummary: el<HTMLParagraphElement>("keep-summary"),
  kept: el<HTMLDivElement>("kept"),
  keptList: el<HTMLUListElement>("kept-list"),
  marksPeek: el<HTMLButtonElement>("marks-peek"),
  renderNote: el<HTMLParagraphElement>("render-note"),
  resultTitle: el<HTMLHeadingElement>("result-title"),
  results: el<HTMLElement>("results"),
  status: el<HTMLParagraphElement>("status"),
  progress: el<HTMLProgressElement>("progress"),
  verified: el<HTMLDivElement>("verified"),
  verifiedText: el<HTMLParagraphElement>("verified-text"),
  verifiedScope: el<HTMLParagraphElement>("verified-scope"),
  clean: el<HTMLElement>("clean"),
  cleanCount: el<HTMLParagraphElement>("clean-count"),
  cleanCandidates: el<HTMLParagraphElement>("clean-candidates"),
  backToList: el<HTMLButtonElement>("back-to-list"),
  filePage: el<HTMLSpanElement>("file-page"),
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
  removed: el<HTMLDivElement>("removed"),
  cleanMore: el<HTMLDivElement>("clean-more"),
  compressSlot: el<HTMLDivElement>("compress-slot"),
  compressHome: el<HTMLDivElement>("compress-home"),
  resultFace: el<HTMLDivElement>("result-face"),
  resultEyebrow: el<HTMLParagraphElement>("result-eyebrow"),
  resultWhy: el<HTMLParagraphElement>("result-why"),
  kinds: el<HTMLOListElement>("kinds"),
  kindsMore: el<HTMLParagraphElement>("kinds-more"),
  propsGlance: el<HTMLDivElement>("props-glance"),
  more: el<HTMLDetailsElement>("more"),
  candidateSlot: el<HTMLDivElement>("candidate-slot"),
  tidyBand: el<HTMLDivElement>("tidy-band"),
  tidyBandText: el<HTMLParagraphElement>("tidy-band-text"),
  tidyBandRun: el<HTMLButtonElement>("tidy-band-run"),
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
  sanitizeMore: el<HTMLDetailsElement>("sanitize-more"),
  sanitizeList: el<HTMLParagraphElement>("sanitize-list"),
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
  coverageSlot: el<HTMLDivElement>("coverage-slot"),
};

/** 縮小したページの絵の幅（CSS のピクセル）。枠の幅が取れないときの目安 */
const THUMB_WIDTH = 96;
/** 縮小したページは、列に見えたものから描く（先頭から何枚、という上限は置かない。2026-11-06 朝） */
let thumbQueue: ThumbQueue | null = null;
let thumbObserver: IntersectionObserver | null = null;

function stopThumbs() {
  thumbQueue?.stop();
  thumbObserver?.disconnect();
  thumbQueue = null;
  thumbObserver = null;
}
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
/** 整える種類（D168）：見つかった種類の行と、本人が印を外した（整えない）種類 */
let keepRows: KeepRow[] = [];
let keptKinds = new Set<string>();
/** 整えたときに外していた種類（整えたあとの画面で、外した印を見分けるため） */
let keptAtClean = new Set<string>();
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

/** 見つけられる範囲の一文（結果の下の知らせと、何も見つからないときの緑の箱で同じ文。CLAUDE.md §11-5b） */
const SCOPE_NOTE = "見つけられるのは、ここに並べた種類だけです。すべての漏れを見つけられるわけではありません。";

function setStatus(text: string, tone: "neutral" | "ok" | "problem" = "neutral") {
  delete ui.status.dataset.quiet;
  ui.status.textContent = keepUnits(text);
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
    ui.compressSizes.textContent = keepUnits(v.sizes);
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
  // 小さくする所はふだん「詳しく見る」の中にある。入口で上限を選んだときは、結果が隠れないように「詳しく見る」の外（保存のすぐ下）へ移す
  // （#117 の考えを案 A でも保つ。動画の S16 で「上限以下になった」を映すため。2026-11-07 本人が承認）
  placeCompress(true);
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
  stopThumbs();
  for (const part of [ui.noticeList, ui.groups, ui.candidateSlot, ui.coverageSlot, ui.thumbs, ui.marks, ui.kinds, ui.propsGlance]) part.replaceChildren();
  for (const part of [ui.notices, ui.actions, ui.pickTools, ui.verified, ui.thumbs, ui.sheetWrap, ui.renderNote, ui.scopeNote, ui.props, ui.ruleset, ui.backToList]) part.hidden = true;
  for (const part of [ui.resultEyebrow, ui.resultWhy, ui.kinds, ui.kindsMore, ui.propsGlance, ui.more, ui.cleanMore]) part.hidden = true;
  for (const part of [ui.sanitizeMore, ui.more]) part.open = false;
  ui.resultFace.hidden = false;
  delete ui.resultFace.dataset.after;
  delete ui.status.dataset.quiet;
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
  // 整える前の確かめと、処理中の帯の形を片付ける（整えている途中で別の PDF を入れたときも、次の PDF に持ち越さない）
  const confirm = document.getElementById("tidy-dialog");
  if (confirm instanceof HTMLDialogElement && confirm.open) confirm.close();
  delete ui.sanitize.dataset.busy;
  ui.sanitize.style.removeProperty("--band-progress");
  ui.consent.replaceChildren();
  ui.consent.hidden = true;
  ui.tidySummary.textContent = "";
  ui.tidyProps.replaceChildren();
  ui.tidyProps.hidden = true;
  keepRows = [];
  keptKinds = new Set();
  keptAtClean = new Set();
  ui.tidyKindsList.replaceChildren();
  ui.tidyKinds.hidden = true;
  ui.keepSummary.hidden = true;
  ui.keptList.replaceChildren();
  ui.kept.hidden = true;
  ui.clean.hidden = true;
  ui.tidyBand.hidden = true;
  placeCompress(false);
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
  // 前のファイルで使った Worker を捨て、次の PDF のために新しく作って温める（PDF を入れる前に済ませる。src/parts.ts）
  void resetParts();
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
  ui.filePage.textContent = "";
  ui.input.value = "";
  setStatus("まだ PDF を選んでいません。");
  ui.input.focus();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- 右：種類ごとの結果

const SEVERITY_MARK: Record<Row["severity"], string> = { high: "▲", medium: "■", low: "●" };

/**
 * 種類ごとの囲み：左に色の帯（飾り。字は出さない）、右に見出しと項目（案 E2。design/README.md）。
 * 帯の字は見出しと同じことを言うので外した（2026-11-05 本人の画面のレビュー B4）
 */
/** found＝見えない情報の種類（紅）、candidate＝見えている個人情報らしい字の候補（知らせの形。紅にしない）、scope＝見た所・見なかった所 */
function groupBox(kind: "found" | "candidate" | "scope"): { box: HTMLElement; body: HTMLDivElement } {
  const box = make("section", undefined, "group");
  box.dataset.status = kind;
  const body = make("div", undefined, "group-body");
  box.append(body);
  return { box, body };
}

function itemButton(r: Row): HTMLButtonElement {
  const btn = make("button", undefined, "item");
  btn.type = "button";
  btn.id = `item-${r.no}`;
  btn.dataset.severity = r.severity;
  btn.dataset.tier = tierOf(r);
  if (r.check) btn.dataset.check = "true";
  if (r.candidate) btn.dataset.candidate = "true";
  btn.setAttribute("aria-expanded", "false");
  const top = make("span", undefined, "item-top");
  top.append(
    make("span", String(r.no), "item-no"),
    // 確かめてほしい所は、深刻度の札の代わりに「？ 確かめる」の札（形と字で示す。断定しない）
    r.candidate
      ? make("span", "ｉ 候補", "item-sev sev-candidate")
      : r.check
        ? make("span", "？ 確かめる", "item-sev sev-check")
        : make("span", `${SEVERITY_MARK[r.severity]} ${r.severityLabel}`, `item-sev sev-${r.severity}`),
    make("span", r.title, "item-title"),
  );
  // 整えたあとに、本人が外した種類（D168）の行は、題の横に「外した」（残っている所と見分ける）
  if (session?.phase === "after" && keptAtClean.has(r.pattern)) top.append(make("span", "◇ 外した（整えていません）", "item-kept"));
  // 閉じた形は 2 行（題の行と、場所・内訳の 1 行）。なぜ危ないかは、押して開いたときに出す（2026-11-05 本人の気づき）
  // ファイル全体の指摘は、押してもページの絵が動かないと分かるように言う（2026-11-06）
  const where = r.page !== null ? `ページ ${r.page}` : "ファイル全体（絵に印なし）";
  btn.append(
    top,
    make("span", `${where}・${compactDetail(r.detail)}`, "item-detail"),
    make("span", r.why, "item-why"),
    // P の番号は作る側の言葉なので、見出しには出さず、開いたときの細かい所にだけ出す（2026-11-05 本人の画面のレビュー B3）
    make("span", `種類の番号：${r.pattern}`, "item-why item-code"),
  );
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
  // 3 字以下は伏せずに全部を出し、「中身を見る」を出さない（2026-11-06 本人が決定。src/ui/reveal.ts）
  if (showsWhole(content)) {
    box.dataset.whole = "true";
    const whole = make("span", undefined, "reveal-text");
    if (full) whole.replaceChildren(full());
    else whole.textContent = fullContent(content);
    box.append(make("span", "中身：", "reveal-label"), whole);
    return box;
  }
  const text = make("span", maskContent(content), "reveal-text");
  text.setAttribute("aria-live", "polite");
  const btn = make("button", REVEAL_LABEL.closed, "reveal-toggle btn-sub");
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
  const b = make("button", undefined, "pick-candidate btn-sub");
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
  // 中身を伏せていることの一言は、結果の一番上に 1 回だけ（種類ごとに繰り返さない。2026-11-05 本人の画面のレビュー B2）
  if (s.view.rows.some((r) => r.content)) {
    ui.groups.append(make("p", `見つけた字の中身は、頭の数文字だけを出し、残りは伏せます（3 字以下は、そのまま出します）。「中身を見る」で全部を出します（この端末のブラウザの中だけで、どこにも送りません）。${REVEAL_NOTE}`, "reveal-note"));
  }
  // 1 件ずつの一覧（「詳しく見る」の中）。並びは深刻度の段の順（高 → 確かめる → 中 → 低）で、段の中は種類ごと。番号は model が並べた順。
  // 段の見出しは出さない（各行の「▲ 高」などの札で分かる。2026-11-07 本人が決定）。段は data-tier で持つ（色と形のため）。
  // 個人情報の候補は、「自分で黒塗りする所を選ぶ」の隣に置く（2026-11-07 本人が決定）
  for (const t of s.view.tiers) {
    const slot = t.key === "candidate" ? ui.candidateSlot : ui.groups;
    for (const g of t.groups) {
      const box = renderGroup(s, g);
      box.dataset.tier = t.key;
      slot.append(box);
    }
  }
  renderCoverage(s);
}

/**
 * 要点の一覧（結果の欄の上。案 A）：同じ種類は 1 行にまとめ、5 種類を超えた分は「詳しく見る」の中だけ（2026-11-07 本人が決定）。
 * 押すと「詳しく見る」を開き、その種類の最初の行を選ぶ（ページの絵の印とつながる）
 */
function renderKinds(s: Session) {
  const k = kindSummary(s.view);
  const first = k.shown[0];
  ui.resultWhy.textContent = first ? first.why : "";
  ui.resultWhy.hidden = !first;
  ui.kinds.replaceChildren(
    ...k.shown.map((row) => {
      const li = make("li");
      const btn = make("button", undefined, "kind");
      btn.type = "button";
      btn.dataset.sev = row.sev;
      const count = keepUnits(row.check && row.check < row.count ? `${row.count} か所（うち確かめる ${row.check}）` : `${row.count} か所`);
      btn.append(make("span", row.sevLabel, `kind-sev sev-${row.sev}`), make("span", row.title, "kind-title"), make("span", keepUnits(`${row.where}・${count}`), "kind-where"));
      btn.setAttribute("aria-label", `${row.sevLabel.replace(/^\S+ /, "")}：${row.title}。${row.where}・${count}。詳しく見る`);
      btn.addEventListener("click", () => {
        const r = s.view.rows.find((x) => x.no === row.firstNo);
        if (!r) return;
        openMoreFor(r.no);
        void select(r);
        const item = document.getElementById(`item-${r.no}`);
        item?.focus({ preventScroll: true });
        item?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      });
      li.append(btn);
      return li;
    }),
  );
  ui.kinds.hidden = k.shown.length === 0;
  const extra: string[] = [];
  if (k.moreKinds) extra.push(`ほかに ${k.moreKinds} 種類（${k.moreCount} か所）あります。「詳しく見る」の中に並べています。`);
  if (s.view.candidates && s.phase === "before") extra.push(`見えている個人情報らしい字が ${s.view.candidates} か所あります。黒塗りにするかは、「詳しく見る」の中で選べます。`);
  ui.kindsMore.textContent = keepUnits(extra.join(""));
  ui.kindsMore.hidden = extra.length === 0;
}

/** 1 つの段の中の、1 つの種類（見出しと項目） */
function renderGroup(s: Session, g: Group): HTMLElement {
  {
    const { box, body } = groupBox(g.rows[0]!.candidate ? "candidate" : "found");
    const head = make("h3", undefined, "group-head");
    const sure = g.rows.filter((r) => !r.check).length;
    const check = g.rows.length - sure;
    head.append(make("span", g.label, "group-name"));
    head.append(make("span", keepUnits([sure ? `${sure} 件` : "", check ? `確かめる ${check} 件` : ""].filter(Boolean).join("・")), "group-count"));
    body.append(head);
    // 黒塗りの候補（個人情報らしい字）：片付ける前だけ、選んだ所に加えるボタンを付ける（キーボードでも選べる）
    const candidates = s.phase === "before" && !ui.pickTools.hidden ? g.rows.filter(isCandidate) : [];
    if (candidates.length) {
      const all = make("button", "候補をすべて黒塗りに加える", "pick-all btn-sub");
      all.type = "button";
      all.addEventListener("click", () => {
        picks = addAllCandidates(picks, candidates);
        renderPicks();
        if (session) placeMarks(session, session.current);
      });
      body.append(all);
    }
    const list = make("ol", undefined, "items");
    for (const r of g.rows) {
      const li = make("li");
      li.append(itemButton(r));
      if (r.content) li.append(revealBox(r.content, `${r.no} 番`));
      if (candidates.some((c) => c.no === r.no)) li.append(candidateButton(r));
      list.append(li);
    }
    body.append(list);
    return box;
  }
}

/** 1 件ずつの一覧は「詳しく見る」の中にあるので、閉じていれば開く（ページの絵の番号を押したとき・要点の一覧を押したとき） */
function openMoreFor(no: number) {
  if (document.getElementById(`item-${no}`)?.closest("details.more") && !ui.more.open) ui.more.open = true;
}

/** 小さくする所の置き場：ふだんは「詳しく見る」の中。入口で上限を選んだときは、保存のすぐ下（「詳しく見る」の外） */
function placeCompress(outside: boolean) {
  const home = outside ? ui.compressSlot : ui.compressHome;
  if (ui.compress.parentElement !== home) home.append(ui.compress);
}

/** 見た所・見なかった所：P1〜P12 と新しい型を1行ずつ、毎回並べる（調べていない理由も） */
function renderCoverage(s: Session) {
  const { box, body } = groupBox("scope");
  box.id = "coverage";
  const details = make("details", undefined, "coverage-details");
  const summary = make("summary", undefined, "coverage-summary");
  const head = make("h3", "見た所・見なかった所", "group-head");
  summary.append(head, make("span", coverageSummary(s.view.coverage, s.phase), "coverage-sum"));
  details.append(summary);
  details.append(
    make(
      "p",
      "この版のルールで、どこまで調べたかを、種類ごとに並べます。「調べた」は、決めた範囲を調べたという意味で、すべてを保証するものではありません。",
      "group-message",
    ),
  );
  const list = make("ul", undefined, "coverage-list");
  for (const c of s.view.coverage) {
    const li = make("li");
    li.dataset.state = c.state;
    if (c.found || c.check) li.dataset.found = "true";
    li.append(make("span", c.name, "coverage-name"), make("span", coverageText(c, s.phase), "coverage-state"));
    for (const r of c.reasons) li.append(make("span", r, "coverage-reason"));
    list.append(li);
  }
  details.append(list);
  body.append(details);
  ui.coverageSlot.append(box);
}

// ---------------------------------------------------------------- 左：縮小した各ページ

function renderThumbs(s: Session) {
  const pages = s.summary.pages.length ? s.summary.pages.map((p) => p.page) : Array.from({ length: s.pdf?.pageCount ?? 0 }, (_, i) => i + 1);
  // 1 ページだけなら縮小の列は出さず、ページの絵を広くする（2026-11-05 本人の画面のレビュー B6）
  if (pages.length < 2) return;
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
  fitThumbsToWindow();
}

/**
 * 縮小したページの列の、今の上の端の位置を CSS に渡す（src/style.css の --thumbs-top）。
 * 開いた直後は列が窓の上に貼り付く前なので、上の決まりの高さのままだと、列の下の数枚が「整える」の帯の下に隠れていた（2026-11-06）
 */
function fitThumbsToWindow() {
  if (ui.thumbs.hidden) return;
  ui.thumbs.style.setProperty("--thumbs-top", `${Math.round(ui.thumbs.getBoundingClientRect().top)}px`);
}
let fitThumbsFrame = 0;
const fitThumbsSoon = () => {
  if (fitThumbsFrame) return;
  fitThumbsFrame = requestAnimationFrame(() => {
    fitThumbsFrame = 0;
    fitThumbsToWindow();
  });
};
window.addEventListener("scroll", fitThumbsSoon, { passive: true });
window.addEventListener("resize", fitThumbsSoon);
// 列より上の部品（お知らせ・手順など）の高さが変わり、送らずに列が上下したときも測り直す
new ResizeObserver(fitThumbsSoon).observe(document.body);

/**
 * 縮小した絵は、大きなページのあとに、列に見えたものから 1 枚ずつ描く（重いページは描かない）。
 * 描いた絵は小さな画像（data: の PNG）にして置き、canvas は捨てる（何百ページあっても、canvas のメモリを持ち続けない）。
 * 枠の縦横比は、描いたページの縦横比にそろえる（横長のページが枠からはみ出さないように）
 */
function drawThumbImages(s: Session) {
  stopThumbs();
  const pdf = s.pdf;
  if (!pdf) return;
  const alive = () => s.generation === generation && session === s && !pdf.stopped;
  const queue = createThumbQueue(async (n) => {
    if (!alive()) return false;
    const pic = document.getElementById(`thumb-${n}`)?.querySelector<HTMLSpanElement>(".thumb-pic");
    if (!pic || s.heavy.has(n)) return true;
    const canvas = make("canvas");
    try {
      await pdf.render(n, canvas, pic.clientWidth || THUMB_WIDTH);
    } catch {
      return false; // 時間の上限か、読めないページ。残りは番号だけ
    }
    if (!alive()) return false;
    const img = make("img");
    img.alt = "";
    img.decoding = "async";
    img.src = canvas.toDataURL("image/png");
    pic.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    pic.replaceChildren(img);
    canvas.width = 0;
    canvas.height = 0;
    return true;
  });
  // 縦に並ぶ列（広い画面）は列の中のスクロールで、狭い画面では窓のスクロールで見える。どちらも窓を基準に見張れば、
  // 列の外に隠れた所は「見えていない」になる（画面の幅が変わっても見張り方を変えずに済む）。
  // 見えたページのあと 2 枚も待ちに入れ、送ったときに白い枠が見えにくいようにする
  const observer = new IntersectionObserver((entries) => {
    const seen: number[] = [];
    for (const e of entries) {
      const n = Number((e.target as HTMLElement).id.slice("thumb-".length));
      if (e.isIntersecting) {
        queue.want(n);
        seen.push(n);
      } else queue.unwant(n);
    }
    for (const n of seen) for (const next of [n + 1, n + 2]) if (document.getElementById(`thumb-${next}`)) queue.want(next);
  });
  for (const btn of ui.thumbs.querySelectorAll<HTMLButtonElement>(".thumb")) observer.observe(btn);
  thumbQueue = queue;
  thumbObserver = observer;
}

// ---------------------------------------------------------------- 真ん中：大きなページ

function sheetWidth(): number {
  // 絵の欄（.sheet-wrap）が出ていれば、その中の幅（スクロールバーの分を除いた幅）に合わせる。まだ隠れているときは、
  // PDF の欄の幅から、内側の余白とスクロールバーの分を差し引いた目安（横にはみ出さないように。2026-11-05 夜のレビュー 15）
  const wrap = ui.sheetWrap.hidden ? 0 : ui.sheetWrap.clientWidth;
  const stage = ui.sheetWrap.parentElement;
  const w = wrap > 0 ? wrap - 4 : (stage?.clientWidth ?? SHEET_MAX_WIDTH) - 72;
  return Math.max(240, Math.min(SHEET_MAX_WIDTH, w));
}

function placeAt(e: HTMLElement, f: { left: number; top: number; width: number; height: number }) {
  // CSSOM で位置を入れる（style 属性の文字列は使わない。CSP の style-src に合わせる）
  e.style.left = `${f.left * 100}%`;
  e.style.top = `${f.top * 100}%`;
  e.style.width = `${f.width * 100}%`;
  e.style.height = `${f.height * 100}%`;
}

/** 押す所の位置：CSS の変数で渡し、大きさの下限（44px）は CSS で決める（.mark-hit） */
function hitAt(e: HTMLElement, f: { left: number; top: number; width: number; height: number }) {
  e.style.setProperty("--x", `${f.left * 100}%`);
  e.style.setProperty("--y", `${f.top * 100}%`);
  e.style.setProperty("--w", `${f.width * 100}%`);
  e.style.setProperty("--h", `${f.height * 100}%`);
}

/** 印の中の薄い地をまとめた層（見た目だけ。読み上げ・押す所には出さない）。層ごと薄くするので、地どうしが重なっても濃くならない */
function fillLayer(fills: Fraction[], className: string): HTMLElement {
  const layer = make("div", undefined, className);
  layer.setAttribute("aria-hidden", "true");
  for (const f of uniqueFills(fills)) {
    const fill = make("div", undefined, "mark-fill");
    placeAt(fill, f);
    layer.append(fill);
  }
  return layer;
}

function placeMarks(s: Session, page: number) {
  ui.marks.replaceChildren();
  const box = s.boxes.get(page);
  if (!box) return;
  // 印の中の薄い地は、印とは別の層に 1 つにまとめる（重なっても濃くならない。src/ui/mark-fills.ts）
  const doneFills: Fraction[] = [];
  const foundFills: Fraction[] = [];
  // 片付けた所（緑の点線の枠と「済」の札）。押せない。残っている所の枠より下に置く
  for (const d of s.doneByPage.get(page) ?? []) {
    const f = toFraction(box, d.rect);
    if (!f) continue;
    doneFills.push(f);
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
    // 薄い紅の地は「高」の印だけに付ける（ほかの段は、段の色の枠だけ。紅ばかりで見分けにくかったため。2026-11-06 本人）
    // 選んだ印は中を塗らない（下の絵を見て確かめられるように。2026-11-06 本人）
    if (m.tier === "high" && s.selected !== m.no) foundFills.push(f);
    // 見た目の枠（隠した所の大きさのまま）と、押す所（枠を中心に縦横とも 44px 以上）を分ける。
    // 枠を大きくすると、細い黒塗りの所が太い枠に見えるため。押す所は透明で、上に重ねる
    // 整えたあとに、本人が外した種類（D168）の印は「外」の札と灰の点線（残っている所の紅と見分ける）
    const kept = s.phase === "after" && keptAtClean.has(m.pattern);
    const frame = make("div", undefined, `mark sev-${m.severity} tier-${m.tier}${m.candidate ? " mark-candidate" : ""}${kept ? " mark-kept" : ""}`);
    frame.id = `mark-frame-${m.no}`;
    frame.setAttribute("aria-hidden", "true");
    frame.append(make("span", kept ? `${m.no}・外` : String(m.no), "mark-no"));
    // 選んだ印の番号は枠の外（上）に出す。ページの上の端に近い枠は、下に出す（絵の外で切れないように）
    if (f.top < 0.05) frame.classList.add("badge-below");
    placeAt(frame, f);
    const mark = make("button", undefined, "mark-hit");
    mark.type = "button";
    mark.id = `mark-${m.no}`;
    mark.setAttribute("aria-label", kept ? `番号 ${m.no}（外した種類。整えずに残しています）：${m.title}` : `番号 ${m.no}：${m.title}`);
    if (s.selected === m.no) {
      mark.classList.add("is-selected");
      frame.classList.add("is-selected");
    }
    if (flashing && flashing.no === m.no && performance.now() < flashing.until) frame.classList.add("is-flash");
    hitAt(mark, f);
    ui.marks.append(frame);
    mark.addEventListener("click", () => {
      if (picking) return; // 選んでいる間は、枠を押しても動かない（ドラッグを邪魔しない）
      openMoreFor(m.no);
      const item = document.getElementById(`item-${m.no}`);
      // 結果の行を、見える所の上から 1/3 の高さに出す（「nearest」だと画面の下の端に付き、帯に隠れることがあった。2026-11-06 本人）
      if (item) {
        scrollToThird(item);
        item.focus({ preventScroll: true });
      }
      markSelected(m.no);
      if (session) placeMarks(session, session.current);
    });
    ui.marks.append(mark);
  }
  // 地の層は、枠と押す所より下（先頭）に置く
  ui.marks.prepend(fillLayer(foundFills, "mark-fills"), fillLayer(doneFills, "mark-fills mark-fills-done"));
  placePicks(s, page);
  spreadMarkBadges();
}

/**
 * ページの絵の上の番号の札を、重ならないように横へずらす（見つかった所の番号の順 → 消した所 → 自分で選んだ所の順に、
 * 先の札ほど動かさない）。札の位置は描いたあとの大きさで測る（絵の幅で変わるため、描き直すたびに測り直す）
 */
function spreadMarkBadges() {
  const all = [...ui.marks.querySelectorAll<HTMLElement>(".mark-no")];
  for (const b of all) b.style.transform = "";
  const kind = (b: HTMLElement) => (b.parentElement?.classList.contains("mark-done") ? 1 : b.parentElement?.classList.contains("mark-pick") ? 2 : 0);
  const order = [...all].sort((a, b) => kind(a) - kind(b));
  const rects = order.map((b) => b.getBoundingClientRect());
  if (!rects.some((r) => r.width > 0)) return;
  const dx = spreadBadges(rects.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })));
  order.forEach((b, i) => {
    if (dx[i]) b.style.transform = `translateX(${dx[i]}px)`;
  });
}

function markSelected(no: number | null) {
  if (session) session.selected = no;
  for (const e of document.querySelectorAll(".is-selected")) e.classList.remove("is-selected");
  if (no === null) return;
  document.getElementById(`mark-${no}`)?.classList.add("is-selected");
  document.getElementById(`mark-frame-${no}`)?.classList.add("is-selected");
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
  const thumb = document.getElementById(`thumb-${page}`);
  thumb?.setAttribute("aria-current", "page");
  // 縮小の列の中だけをスクロールして、今のページの縮小を見せる（ページ全体は動かさない）
  if (thumb && ui.thumbs.scrollHeight > ui.thumbs.clientHeight) {
    // 縮小の列は貼り付け（sticky）なので、縮小の offsetTop は列の中の位置
    const top = thumb.offsetParent === ui.thumbs ? thumb.offsetTop : thumb.offsetTop - ui.thumbs.offsetTop;
    if (top < ui.thumbs.scrollTop || top + thumb.offsetHeight > ui.thumbs.scrollTop + ui.thumbs.clientHeight) ui.thumbs.scrollTop = top - 8;
  }
  const total = s.summary.pages.length;
  ui.filePage.textContent = total > 1 ? `ページ ${page} / ${total}` : "";

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

/** 動きを減らす設定か */
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** いちばん近い、縦にスクロールする箱（なければ null＝ページ全体） */
function scrollParent(e: HTMLElement): HTMLElement | null {
  for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** 要素を、見える所の上から 1/3 の高さに動かす（印から行へ動いたとき、目の動く先をそろえる） */
function scrollToThird(e: HTMLElement) {
  const box = scrollParent(e);
  const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
  const r = e.getBoundingClientRect();
  if (box) {
    const b = box.getBoundingClientRect();
    box.scrollTo({ top: box.scrollTop + (r.top - b.top) - box.clientHeight / 3, behavior });
  } else {
    window.scrollTo({ top: window.scrollY + r.top - window.innerHeight / 3, behavior });
  }
}

/**
 * 行から印へ（逆引き）：ページの絵の欄の中だけを動かして、印を真ん中に出し、少しのあいだ光らせる（2026-11-06 本人）。
 * ページ全体は動かさない（広い画面では、押した行が画面の外へ流れないように）。狭い画面で絵まで動かすのは select() がする
 */
const FLASH_MS = 1600;
let flashing: { no: number; until: number } | null = null;
function centerMark(no: number) {
  const frame = document.getElementById(`mark-frame-${no}`);
  if (!frame) return;
  const box = ui.sheetWrap;
  if (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) {
    const r = frame.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    box.scrollTo({
      top: box.scrollTop + (r.top - b.top) - (box.clientHeight - r.height) / 2,
      left: box.scrollLeft + (r.left - b.left) - (box.clientWidth - r.width) / 2,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  }
  // 光らせている間に印を描き直しても（絵の大きさが変わったときなど）、光が途中で消えないよう、終わる時刻で持つ
  flashing = { no, until: performance.now() + FLASH_MS };
  frame.classList.remove("is-flash");
  void frame.offsetWidth; // もう一度光らせるため、形を一度読み直す
  frame.classList.add("is-flash");
  window.setTimeout(() => document.getElementById(`mark-frame-${no}`)?.classList.remove("is-flash"), FLASH_MS);
}

/** 縦に積む狭い画面か（結果の欄が上、ページの絵がずっと下にある形） */
const stacked = () => getComputedStyle(ui.workspace).flexDirection === "column";

async function select(r: Row) {
  if (r.page !== null && session) await showPage(r.page, r.hasRect ? r.no : null);
  markSelected(r.no);
  // 行から印へ（逆引き）：押したときだけ、印を真ん中に出して光らせる（絵の大きさが変わって描き直すときは、動かさない）
  if (r.hasRect) centerMark(r.no);
  // 読み上げにも、どこへ動いたか（動かなかったか）を伝える。ファイル全体の指摘は、ページの絵に印がない
  ui.markNote.textContent =
    r.page === null
      ? `${r.no} 番は、ファイル全体の指摘です。ページの絵に印はありません。`
      : r.hasRect
        ? `${r.no} 番の印を、ページ ${r.page} の絵の真ん中に出しました。`
        : `ページ ${r.page} を出しました。${r.no} 番は、ページの中の場所が決まっていない指摘なので、印はありません。`;
  // 狭い画面では、ページの絵が結果のずっと下にあるので、押した所の枠まで動かす。絵の下に「一覧へ戻る」を出す
  if (r.hasRect && stacked()) {
    document.getElementById(`mark-frame-${r.no}`)?.scrollIntoView({ block: "center" });
    ui.backToList.dataset.no = String(r.no);
    ui.backToList.hidden = false;
  }
}

// 押している間だけ、ページの絵の上の印を消す（印の下の絵を見るため。2026-11-06 本人）。指・マウス・キーボード（Space・Enter）で使える
{
  const peek = (on: boolean) => {
    ui.sheet.dataset.peek = String(on);
    ui.marksPeek.setAttribute("aria-pressed", String(on));
  };
  ui.marksPeek.addEventListener("pointerdown", (e) => {
    ui.marksPeek.setPointerCapture(e.pointerId);
    peek(true);
  });
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"] as const) ui.marksPeek.addEventListener(t, () => peek(false));
  ui.marksPeek.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      peek(true);
    }
  });
  ui.marksPeek.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") peek(false);
  });
  ui.marksPeek.addEventListener("blur", () => peek(false));
  ui.marksPeek.addEventListener("contextmenu", (e) => e.preventDefault()); // 長押しでメニューを出さない
}

ui.backToList.addEventListener("click", () => {
  const item = document.getElementById(`item-${ui.backToList.dataset.no ?? ""}`);
  item?.scrollIntoView({ block: "center" });
  item?.focus();
});

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

/**
 * 結果の欄の「プロパティに入っていた情報」（案 A）：欄の名前と、値の頭の 2 字だけ（2026-11-07 本人が決定）。
 * 整える前だけ出す。全部の値は「詳しく見る」の中のプロパティの一覧で
 */
function renderPropsGlance(s: Session) {
  const p = s.summary.properties;
  ui.propsGlance.replaceChildren();
  ui.propsGlance.hidden = s.phase !== "before" || !p;
  if (s.phase !== "before" || !p) return;
  const g = buildGlance(p, (k) => (k in INFO_LABEL ? INFO_LABEL[k]! : null));
  if (g.empty) {
    ui.propsGlance.dataset.empty = "true";
    ui.propsGlance.append(make("p", "プロパティ（作成者・タイトルなどの欄）は、空でした。", "glance-empty"));
    return;
  }
  delete ui.propsGlance.dataset.empty;
  ui.propsGlance.append(make("h3", "プロパティに入っていた情報", "glance-head"), make("p", "ファイルの「プロパティ」を開くと、誰でも見られます。", "glance-why"));
  const dl = make("dl", undefined, "glance-list");
  for (const r of g.rows) {
    const row = make("div", undefined, "glance-row");
    row.append(make("dt", r.label), make("dd", r.value));
    dl.append(row);
  }
  ui.propsGlance.append(dl);
  const tail = [g.more ? `ほか ${g.more} 欄` : "", g.xmp ? `作ったときの記録（XMP）にも ${g.xmp} 欄` : ""].filter(Boolean).join("・");
  ui.propsGlance.append(make("p", `${tail ? `${tail}。` : ""}値は頭の 2 字だけを出し、残りは伏せています（全部は「詳しく見る」のプロパティの一覧で）。${REVEAL_NOTE}`, "glance-note"));
}

/** 文書情報と XMP のすべての欄を、値ごと出す。団体名らしい語に印を付け、「片付ける」へ案内する */
function renderProperties(s: Session) {
  const p = s.summary.properties;
  ui.props.replaceChildren();
  renderPropsGlance(s);
  if (p === undefined) {
    ui.props.hidden = true;
    return;
  }
  const count = p ? p.info.length + p.xmp.length : 0;
  const summary = make("summary");
  summary.append(
    make("span", p ? `プロパティの一覧（文書情報 ${p.info.length} 欄・XMP ${p.xmp.length} 欄）` : "プロパティの一覧（読めませんでした）"),
    // 閉じていても読める一言（値をそのまま出す所なので、画面共有・画面の撮影の前に閉じてもらう）
    make("span", "開くと、すべての欄の名前と値の頭の数文字を出します。画面を共有・撮影する前は、閉じておいてください。", "props-warn"),
  );
  ui.props.append(summary);
  const body = make("div", undefined, "props-body");
  body.append(
    make(
      "p",
      `欄の値は、頭の数文字だけを出しています。「中身を見る」で全部を出します（この端末のブラウザの中だけで、外には出ません）。${REVEAL_NOTE}団体名らしい語には、全部を出したときに印を付けています（形で拾うだけなので、見落としや関係のない語もあります）。`,
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
  // その場で「消す」へ案内する（片付ける前で、片付けられるときだけ）。欄ごとの扱いは「整える内容」で選ぶ（6 の案 A）
  if (count && s.phase === "before" && !ui.sanitize.disabled) {
    const go = make("button", "この欄を消す（「整える内容」へ）", "props-go btn-sub");
    go.type = "button";
    go.addEventListener("click", () => {
      ui.more.open = true;
      ui.sanitizeMore.open = true;
      ui.sanitizeMore.scrollIntoView({ block: "start", behavior: "smooth" });
      (ui.tidyProps.querySelector<HTMLInputElement>("input:checked") ?? ui.sanitizeMore.querySelector("summary"))?.focus({ preventScroll: true });
    });
    body.append(go, make("p", "「整える」を押すと、文書情報と XMP の欄を、まとめて消した PDF を新しく作ります（元の PDF は変えません）。欄ごとに「そのまま」「書き直す」も選べます。", "props-note"));
  }
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
    body.append(make("h4", "最近足した種類"));
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
  renderKinds(s);
  renderProperties(s);
  renderRuleset(s);
  // 整えたあとは、整えた結果の欄に同じ意味の一言（「すべてを見つけるものではありません」）があるので出さない
  ui.scopeNote.hidden = (s.view.clean && s.phase === "before") || s.phase === "after";
  // 細かい情報は「詳しく見る」の中（案 A）。最初は閉じた形で出す
  ui.more.hidden = false;

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
  // 大きな見出しは短く（何か所・何が）。くわしい文（確かめる所・候補の数）は、状態の文が読み上げに伝える（案 A）
  ui.resultEyebrow.textContent = v.hidden ? "見つかりました" : "";
  ui.resultEyebrow.hidden = !v.hidden;
  ui.resultTitle.textContent = v.hidden ? shortHeadline(v) : "種類ごとの結果";
  if (v.hidden) ui.status.dataset.quiet = "true";
  setStep(ui.stepCheck, "done");
  // 数は「見た目では分からない情報」だけ（見えている候補は入れない。見出しと同じ物差し）
  ui.stepCheckNote.textContent = v.hidden
    ? keepUnits(`${v.hidden} か所 見つかりました`)
    : v.candidates
    ? keepUnits(`候補 ${v.candidates} か所`)
    : v.clean
    ? "見つかりませんでした"
    : "調べられない所あり";

  // 片付けは、検査ができた PDF ならいつでも押せる（見つからなくても、XMP・注釈のコメント・JavaScript なども外す）
  ui.actions.hidden = false;
  ui.sanitize.disabled = s.original === null || s.pdfProblem === "password";
  renderTidySummary();
  renderKeepKinds(s);
  // 説明は 1 行だけ。消す対象の列挙とプロパティの扱いは「整える内容」を開いて読み、選ぶ（2026-11-05 本人の画面のレビュー B1・2026-11-06 の 6）
  const password = s.pdfProblem === "password";
  ui.sanitizeNote.textContent = password
    ? "パスワードが要る PDF は、整えられません。"
    : v.hidden
    ? "見えない情報を消した PDF を、新しく作ります。元の PDF は変えません。"
    : "見つかった所はありませんが、見えない情報を消した PDF を作れます。元の PDF は変えません。";
  ui.sanitizeList.textContent = sanitizeListText();
  ui.sanitizeMore.hidden = password;
  // 「提出のためにファイルを小さくする」の入口から来たとき（B の #116）：上限まで小さくすることを、1 行の説明に足す
  if (shrinkLimit) ui.sanitizeNote.textContent += `整えて読み直したあとに、選んだ上限（${shrinkLimit.label}）まで小さくします。`;
  // 自分で黒塗りする所を選ぶ：片付けられて、ページの絵と形があるときだけ
  ui.pickTools.hidden = ui.sanitize.disabled || !s.pdf || s.summary.pagesUnreadable;
  ui.pickHelpCandidates.hidden = !v.rows.some(isCandidate);
  setStep(ui.stepClean, v.rows.length ? "now" : "todo");
  ui.stepCleanNote.textContent = "「整える」を押します";

  // 何も見つからなかったときの札（片付けたあとの「全部緑」は renderCleaned）。
  // 同じ意味の文を 2 回出さない：上の状態の文は見た目では隠し（読み上げには残す）、緑の箱 1 つにする。
  // 「見つけられるのは、ここに並べた種類だけ」も、この箱の続きに入れて 1 つの塊にする（2026-11-05 夜のレビュー 7）
  const checkedKinds = v.coverage.filter((c) => c.state === "checked").length;
  ui.verified.dataset.state = v.clean ? "clean" : "none";
  ui.verifiedText.textContent = v.clean ? `調べた ${checkedKinds} 種類では、見つかりませんでした。` : "";
  ui.verifiedScope.textContent = v.clean ? SCOPE_NOTE : "";
  ui.verified.hidden = !v.clean;
  if (v.clean) ui.status.dataset.quiet = "true";
  ui.scopeNote.hidden = v.clean;
  // 何も見つからないときは、「整える」を主のボタンから第 2 の形に下げる（公開してよいのか、整えるべきかで迷わせない）
  ui.sanitize.dataset.weight = v.clean ? "sub" : "main";
  ui.sanitize.textContent = v.clean ? "念のため整える（プロパティなどを消した写しを作る）" : sanitizeLabel();

  renderInspection(s);
  syncTidyBand();
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
  if (outcome.kind === "timeout") return fail("時間がかかりすぎたため、検査を止めました。ページを減らすか、いくつかに分けてから、「別の PDF」で入れ直してください。");
  if (outcome.kind === "error") return fail(outcome.message);
  if (!outcome.precheck.ok) return fail(outcome.precheck.message);
  if (!outcome.summary) return fail("検査の結果を受け取れませんでした。");
  const summary = outcome.summary;
  const pages = summary.pagesUnreadable ? "ページの数 不明" : `${summary.pages.length} ページ`;
  // かかった秒は帯に出さない（利用者には要らない。帯を 1 行に収めるため。夜のレビュー 16）
  ui.fileFacts.textContent = keepUnits(`${pages}・${formatBytes(outcome.precheck.byteLength)}`);
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
  ui.fileName.title = file.name;
  ui.fileFacts.textContent = "";
  ui.filePage.textContent = "";
  ui.filebar.hidden = false;
  ui.progress.hidden = false;
  ui.progress.value = 0;
  try {
    // 新しいファイルとして数える（前のファイルで使った Worker は使わない。src/worker-slot.ts）。
    // 部品をまだ読み終えていなければ、読み終わるまで待つ（PDF を入れた後に部品を読みに行かないため。src/parts.ts）
    startFile();
    await waitParts((p) => {
      ui.progress.max = p.total;
      ui.progress.value = p.done;
      setStatus(`準備しています（${p.done}/${p.total}）…`);
    });
    setStatus("確かめています…");
    ui.progress.value = 0;
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

/** 「整える内容」の中（帯のすぐ上）に、8 つの項目ごとの「消す／そのまま／書き直す」を出す（既定は消す。6 の案 A） */
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

// ---------------------------------------------------------------- 整える種類（5 の案 B。2026-11-06 本人が決定。D168。src/ui/keep-model.ts）

/** 「整える内容」の中に、見つかった種類ごとの印を出す。最初の印は keep-model.ts の defaultOn（高・確かめるを含む種類。例外あり） */
function renderKeepKinds(s: Session) {
  keepRows = s.phase === "before" ? buildKeepRows(s.view.rows, (p) => PATTERN_NAME[p] ?? p) : [];
  keptKinds = initialKept(keepRows);
  ui.tidyKindsList.replaceChildren(
    ...keepRows.map((r) => {
      const li = make("li", undefined, "tidy-kind");
      const label = make("label", undefined, "tidy-kind-label");
      const box = make("input");
      box.type = "checkbox";
      box.checked = !keptKinds.has(r.pattern);
      box.disabled = !r.keepable;
      box.addEventListener("change", () => {
        if (box.checked) keptKinds.delete(r.pattern);
        else keptKinds.add(r.pattern);
        li.dataset.kept = String(!box.checked);
        renderKeepSummary();
      });
      label.append(box, make("span", r.name, "tidy-kind-name"), make("span", keepUnits(`${r.count} か所（${tierCounts(r)}）`), "tidy-kind-count"));
      li.append(label);
      if (r.note) li.append(make("p", r.note, "props-note tidy-kind-note"));
      li.dataset.kept = String(keptKinds.has(r.pattern));
      if (!r.keepable) li.dataset.fixed = "true";
      return li;
    }),
  );
  ui.tidyKinds.hidden = keepRows.length === 0;
  renderKeepSummary();
}

/** 外す種類があれば、「整える」の上に一言（「整える内容」を閉じていても読める） */
function renderKeepSummary() {
  const t = keptSummary(keepRows, keptKinds);
  ui.keepSummary.textContent = t ? keepUnits(`外す種類：${t}。整えずに残します（「詳しく見る」の「整える内容」で変えられます）。`) : "";
  ui.keepSummary.hidden = !t;
  if (session?.phase === "before" && ui.sanitize.dataset.weight !== "sub" && ui.sanitize.dataset.busy !== "true") ui.sanitize.textContent = sanitizeLabel();
  syncTidyBand();
  // 消すものの一覧からも、外した種類を除く（「注釈も消します」と「注釈を外す」を並べない）
  ui.sanitizeList.textContent = sanitizeListText(keptKinds);
}

/** 「整える」の近くに、プロパティをどうするかの一言を出す */
function renderTidySummary() {
  // 実際の選びの数を出す（押す前の確かめにも、同じ文を出す。src/ui/tidy-confirm.ts の propertySummary）
  ui.tidySummary.textContent = tidyPre ? propertySummary(PROPERTY_FIELDS.map((f) => propChoices[f.key]?.mode ?? "remove")) : "";
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
      ...(keptKinds.size ? { keep: keepList(keptKinds) } : {}),
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

/** 大きなボタンの字：何か所を整えるか（見えない情報＋自分で選んだ所。外す種類は除く） */
function sanitizeLabel(): string {
  const s = session;
  if (!s) return "整える";
  const kept = keepRows.filter((r) => r.keepable && keptKinds.has(r.pattern)).reduce((n, r) => n + r.count, 0);
  const n = Math.max(0, s.view.hidden - kept) + picks.length;
  return n ? `${n} か所を整える` : "整える";
}

/**
 * 「整える」のボタンが画面の外にあるときだけ、欄の下に帯を出す（案 B の帯。2026-11-07 本人）。
 * 整える前で、主のボタン（第 2 の形の「念のため整える」でない）が押せるときだけ。整えている間・整えたあとは出さない
 */
let sanitizeInView = true;
function syncTidyBand() {
  const s = session;
  const show =
    !!s &&
    s.phase === "before" &&
    ui.workspace.dataset.state === "result" &&
    !ui.actions.hidden &&
    !ui.sanitize.disabled &&
    ui.sanitize.dataset.weight !== "sub" &&
    ui.sanitize.dataset.busy !== "true" &&
    !sanitizeInView;
  if (show) {
    const label = ui.sanitize.textContent ?? "整える";
    const n = /^(\d+) か所/.exec(label)?.[1];
    ui.tidyBandText.textContent = keepUnits(n ? `${n} か所が残っています` : "見えない情報を消した PDF を作れます");
    ui.tidyBandRun.textContent = label;
  }
  ui.tidyBand.hidden = !show;
}
if (typeof IntersectionObserver === "function") {
  new IntersectionObserver((entries) => {
    for (const e of entries) sanitizeInView = e.isIntersecting;
    syncTidyBand();
  }).observe(ui.sanitize);
}

function renderPicks() {
  const s = session;
  ui.pickList.replaceChildren(
    ...picks.map((p, i) => {
      const li = make("li");
      const rm = make("button", "外す", "pick-remove btn-sub");
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
  // 「黒塗りに加える」のボタンだけを直す。候補の行のボタン（.item）にも data-candidate="true" が付いているので、取り違えない
  // （前は行のボタンの題が「黒塗りに加える」に書き換わっていた。2026-11-06）
  for (const b of ui.more.querySelectorAll<HTMLElement>(".pick-candidate[data-candidate]")) syncCandidateButton(b, Number(b.dataset.candidate));
  ui.pickCount.textContent = `選んだ所 ${picks.length} か所（「整える」を押すと、見つかった所といっしょに黒塗りします。下の字・画像・注釈も消します）${picks.length >= MAX_REDACT_AREAS ? `。一度に選べるのは ${MAX_REDACT_AREAS} か所までです` : ""}`;
  if (s && s.phase === "before" && !ui.sanitize.disabled && ui.sanitize.dataset.weight !== "sub") ui.sanitize.textContent = sanitizeLabel();
  syncTidyBand();
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
    // 候補から加えた所は、候補の枠そのものに「選」を足す（同じ所に枠と札を 2 つ重ねない。前は「選 1」の札が候補の番号に重なっていた）
    const frame = p.candidate !== undefined ? document.getElementById(`mark-frame-${p.candidate}`) : null;
    if (frame) {
      frame.classList.add("is-picked");
      const no = frame.querySelector(".mark-no");
      if (no) no.textContent = `${p.candidate}・選${i + 1}`;
      document.getElementById(`mark-${p.candidate}`)?.setAttribute("aria-label", `番号 ${p.candidate}（自分で選んだ所 ${i + 1}。黒塗りに加えました）`);
      return;
    }
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
  ui.sanitize.textContent = sanitizeLabel();
  ui.pickTools.hidden = retry === null;
}

function renderCleaned(c: CleanView, file: { name: string; bytes: number; pages: number; seconds: string }) {
  ui.workspace.dataset.phase = "after";
  ui.actions.hidden = true;
  ui.tidyBand.hidden = true;
  ui.pickTools.hidden = true;
  // 通ったときは、上の文で「0 件」を言わず、下の「整える前 N か所 → 読み直したあと 0 か所」だけにする（2026-11-05 本人の画面のレビュー C1）。
  // 残っている・言い切れないときは、上の文がそれを知らせるので残す
  setStatus(c.verdict === "clean" ? "" : c.headline, c.verdict === "clean" ? "ok" : c.verdict === "left" ? "problem" : "neutral");

  setStep(ui.stepClean, "done");
  ui.stepCleanNote.textContent = "整えました";
  if (c.verdict === "clean") {
    setStep(ui.stepVerify, "done");
    ui.stepVerifyNote.textContent = "残り 0 件・保存できます";
  } else {
    setStep(ui.stepVerify, "now");
    ui.stepVerifyNote.textContent = c.left === null ? "読み直せませんでした" : c.left > 0 ? keepUnits(`${c.left} か所 残っています`) : "消えたと言い切れない所があります";
  }

  ui.cleanCount.textContent =
    c.left === null ? `整える前 ${c.before} か所 → 読み直せませんでした` : `整える前 ${c.before} か所 → 読み直したあと ${c.left} か所`;
  // 外した種類（D168）の行は、読み直したあとの数に入れていないことを添える
  if (c.kept > 0) ui.cleanCount.textContent += `（あなたが外した ${c.kept} か所は数えていません）`;
  ui.cleanCount.textContent = keepUnits(ui.cleanCount.textContent ?? "");
  ui.cleanCount.dataset.verdict = c.verdict;
  // 見えている個人情報らしい字（候補）は、見えない情報とは別の行で、前と後を同じ物差しで（黒塗りにするかは本人が決める）
  ui.cleanCandidates.textContent = c.candidatesBefore
    ? keepUnits(`見えている個人情報らしい字：${c.candidatesBefore} か所 → ${c.candidatesAfter === null ? "読み直せませんでした" : `${c.candidatesAfter} か所`}（黒塗りするかは、あなたが決めます）`)
    : "";
  ui.cleanCandidates.hidden = !c.candidatesBefore;
  ui.download.download = file.name;
  applySaveGate(saveGate(c));
  // 確認が要る理由で、保存の上の文と印の字を分ける（外した種類だけなら「言い切れない」と言わない。D168）
  const texts = saveTexts(c);
  ui.saveNote.textContent = texts.note;
  el<HTMLSpanElement>("save-confirm-text").textContent = texts.label;
  ui.downloadNote.textContent = keepUnits(`${file.name}（${file.pages} ページ・${formatBytes(file.bytes)}・${file.seconds}）。元の PDF は変えていません。`);

  ui.notDoneList.replaceChildren(...c.notDone.map((t) => make("li", t)));
  ui.notDone.hidden = c.notDone.length === 0;
  // 本人が「整えない」を選んだ種類（D168）。残しているので、必ず並べる
  ui.keptList.replaceChildren(...c.keptLines.map((t) => make("li", t)));
  ui.kept.hidden = c.keptLines.length === 0;

  // 消したものは、見つかった種類・念のため消したもの・自分で選んだ所に分け、全部の合計は出さない。
  // 「3 か所見つかった」のに「5 件消した」と並ぶと、数が合わないように見えるため（2026-11-05 本人の画面のレビュー C2）
  const removedSection = (title: string, groups: typeof c.removed, note?: string) => {
    const sec = make("section", undefined, "removed-section");
    sec.append(make("h4", title));
    if (note) sec.append(make("p", note, "removed-note"));
    for (const g of groups) {
      const box = make("div", undefined, "removed-group");
      box.append(make("h5", `${g.name}　${g.total} 件`), make("ul"));
      box.querySelector("ul")!.append(...g.lines.map((t) => make("li", t)));
      sec.append(box);
    }
    return sec;
  };
  const foundGroups = c.removed.filter((g) => !g.self && g.found);
  const extraGroups = c.removed.filter((g) => !g.self && !g.found);
  const selfGroups = c.removed.filter((g) => g.self);
  const sections: HTMLElement[] = [];
  if (foundGroups.length) {
    const many = foundGroups.some((g) => g.total !== g.seen);
    sections.push(removedSection("見つかった種類で消したもの", foundGroups, many ? "1 か所に、消すものが複数あることがあります（例：1 つの欄と、その写し）。そのため、見つかった数と消した数は同じになりません。" : undefined));
  }
  if (selfGroups.length) sections.push(removedSection("自分で選んで黒塗りした所", selfGroups));
  if (extraGroups.length) sections.push(removedSection("念のため消したもの（確かめた画面には出ていない種類）", extraGroups));
  ui.removedGroups.replaceChildren(...sections);
  ui.removed.hidden = sections.length === 0;

  const notes = [...c.notes, ...c.propertyLines.map((t) => `プロパティ：${t}`)];
  ui.cleanNotes.replaceChildren(...notes.map((t) => make("li", t)));
  ui.cleanNotes.hidden = notes.length === 0;
  ui.cleanScope.textContent = c.scope;
  ui.cleanScope.hidden = c.scope === "";
  ui.clean.hidden = false;
  // 消したものの一覧・前と後の数・報告書・小さくするは、「詳しく見る」の中（案 A）
  ui.cleanMore.hidden = false;
  ui.cleanTitle.textContent = c.verdict === "clean" ? "整えた PDF には、残っていません" : "整えた結果";

  ui.clean.dataset.verdict = c.verdict;
  // 片付けた結果の見出しへ移す（キーボード・読み上げで、次にすること（保存）がすぐ分かるように）
  ui.cleanTitle.focus();
  // 「全部緑」は、片付けた結果の欄（緑の枠）が示す。同じ文を重ねない
  ui.verified.hidden = true;
  // 読み直しで残っている所がなければ、上の面は状態の文だけにする（整えた結果の欄が主役。案 A）。残っていれば、その所を要点の一覧で出す
  const leftRows = session?.phase === "after" ? session.view.hidden : 0;
  ui.resultFace.dataset.after = leftRows ? "left" : "clean";
  ui.resultEyebrow.hidden = true;
  ui.resultTitle.textContent = leftRows ? "読み直したあとも残っている所" : "読み直した結果";
  if (leftRows) ui.status.dataset.quiet = "true";
  ui.fileName.textContent = file.name;
  ui.fileName.title = file.name;
  ui.fileFacts.textContent = keepUnits(`整えた PDF・${file.pages} ページ・${formatBytes(file.bytes)}`);
}

/** 型ごとの、片付ける前と読み直したあとの数（11/5 B の 6） */
function renderBeforeAfter(before: ViewModel, after: ViewModel | null) {
  const rows = beforeAfterCounts(before.coverage, after?.coverage ?? null, [...keptAtClean]);
  ui.beforeAfterList.replaceChildren(
    ...rows.map((r) => {
      const li = make("li");
      if (r.after) li.dataset.left = "true";
      if (r.kept) li.dataset.kept = "true";
      li.append(make("span", r.name, "ba-name"), make("span", `${r.before} → ${r.after === null ? "読み直せなかった" : r.after}${r.kept ? "（外した）" : ""}`, "ba-count"));
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
  const bandLabel = ui.sanitize.textContent ?? "整える";
  setBand("tidy");
  try {
    const { tidy, bad } = collectTidy();
    if (bad.length) {
      s.original = original;
      clearBand(bandLabel);
      ui.sanitize.disabled = false;
      ui.progress.hidden = true;
      setStep(ui.stepClean, "now");
      ui.stepCleanNote.textContent = "「整える」を押します";
      setStatus(`${bad.join("・")}の日付の書き方が違います。${DATE_HINT}`, "problem");
      return;
    }
    // 外した種類（D168）。整えたあとの画面で、外した印・行を見分けるために覚えておく
    keptAtClean = new Set(tidy.keep ?? []);
    const areas = toAreas(picks);
    // 自分で黒塗りした PDF が読み直しで止められたら、選び直してもう一度片付けられるよう、元の写しを持っておく
    const retry = areas.length ? original.slice() : null;
    setPicking(false);
    ui.pickTools.hidden = true;
    const out = await sanitizeInWorker(original.buffer as ArrayBuffer, undefined, areas, tidy);
    if (gen !== generation) return;
    if (out.kind === "timeout") return cleanFailed("時間がかかりすぎたため、整えるのを止めました。ページを減らすか、いくつかに分けてから、「別の PDF」で入れ直してください。");
    if (out.kind === "blocked") return redactBlocked(s, retry, out.leftovers, out.notDone);
    if (out.kind !== "done") return cleanFailed(out.message);

    setStep(ui.stepClean, "done");
    ui.stepCleanNote.textContent = "整えました";
    setStep(ui.stepVerify, "now");
    ui.stepVerifyNote.textContent = "読み直しています";
    setStatus("整えた PDF を、最初から検査し直しています…");
    ui.progress.value = 0;
    setBand("verify");

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
      setBand("verify", p);
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
      kept: [...keptAtClean],
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
        ...(keptAtClean.size ? { kept: { patterns: [...keptAtClean], lines: clean.keptLines } } : {}),
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
    if (gen === generation) clearBand(bandLabel);
  }
  // 提出のために小さくする入口：読み直しが通って、小さくする欄が出たときだけ、続けて小さくする
  if (gen === generation && shrinkLimit && !ui.compress.hidden) await shrinkToLimit(gen, shrinkLimit);
}

// ---------------------------------------------------------------- 7：押す前の確かめ（画面全体のポップアップ）と、処理中の帯（2026-11-06 本人）

/** 帯そのものを進み具合にする（字は段階と、読み直しの数。進んだ分は左から塗る） */
function setBand(stage: "tidy" | "verify", verify?: { done: number; total: number }) {
  ui.sanitize.dataset.busy = "true";
  ui.sanitize.textContent = bandProgressText(stage, verify);
  syncTidyBand();
  ui.sanitize.style.setProperty("--band-progress", String(bandProgressRatio(stage, verify)));
}

/** 進み具合の形をやめる。字が進み具合のままなら、押す前の字に戻す（止められたときに、別の字を入れていれば、それを残す） */
function clearBand(label: string) {
  delete ui.sanitize.dataset.busy;
  ui.sanitize.style.removeProperty("--band-progress");
  if ((ui.sanitize.textContent ?? "").startsWith("1 整え")) ui.sanitize.textContent = label;
  syncTidyBand();
}

const tidyDialog = el<HTMLDialogElement>("tidy-dialog");
const tidyDialogTitle = el<HTMLHeadingElement>("tidy-dialog-title");
const tidyDialogRun = el<HTMLButtonElement>("tidy-dialog-run");

/** 「整える」を押したとき：何を何か所消すかをポップアップで確かめてから整える（ダイアログが使えないブラウザでは、そのまま整える） */
function confirmSanitize() {
  const s = session;
  if (!s || busy || s.phase !== "before" || !s.original || ui.sanitize.disabled) return;
  // 日付の書き方が違う項目は、確かめを開く前に知らせる（開いてから止めない）
  const { bad } = collectTidy();
  if (bad.length) {
    setStatus(`${bad.join("・")}の日付の書き方が違います。${DATE_HINT}`, "problem");
    return;
  }
  if (typeof tidyDialog.showModal !== "function") return void runSanitize();
  const p = s.summary.properties;
  const c = buildTidyConfirm({
    tiers: s.view.tiers,
    picks: picks.length,
    properties: ui.tidySummary.textContent ?? "",
    ...(shrinkLimit ? { shrink: shrinkLimit.label } : {}),
    kept: keepRows.filter((r) => r.keepable && keptKinds.has(r.pattern)).map((r) => ({ pattern: r.pattern, name: r.name, count: r.count })),
    kinds: s.view.groups.map((g) => ({ name: g.label, count: g.rows.filter((r) => !r.candidate).length })),
    propsFilled: p ? p.info.length + p.xmp.length : null,
  });
  tidyDialogTitle.textContent = c.title;
  el<HTMLParagraphElement>("tidy-dialog-lead").textContent = keepUnits(c.lead);
  el<HTMLUListElement>("tidy-dialog-items").replaceChildren(
    ...c.items.map((it) => {
      const li = make("li");
      li.append(make("span", "✓", "tidy-dialog-check"), make("span", undefined, "tidy-dialog-item"));
      li.lastElementChild!.append(make("b", keepUnits(it.head)), make("span", keepUnits(it.text)));
      li.firstElementChild!.setAttribute("aria-hidden", "true");
      return li;
    }),
  );
  el<HTMLParagraphElement>("tidy-dialog-tech-text").textContent = c.tech;
  el<HTMLDetailsElement>("tidy-dialog-tech").open = false;
  const notes = el<HTMLUListElement>("tidy-dialog-notes");
  notes.replaceChildren(...c.notes.map((t) => make("li", keepUnits(t))));
  notes.hidden = c.notes.length === 0;
  el<HTMLParagraphElement>("tidy-dialog-hint").textContent = c.hint;
  tidyDialogRun.textContent = c.run;
  tidyDialog.returnValue = "";
  tidyDialog.showModal();
  tidyDialogTitle.focus();
}

/** 確かめの窓を開いたボタン（「整える」のボタンか、画面の下の帯のボタン）。やめたとき、そこへフォーカスを戻す */
let tidyOpener: HTMLButtonElement = ui.sanitize;
ui.sanitize.addEventListener("click", () => {
  tidyOpener = ui.sanitize;
  confirmSanitize();
});
ui.tidyBandRun.addEventListener("click", () => {
  tidyOpener = ui.tidyBandRun;
  confirmSanitize();
});
tidyDialogRun.addEventListener("click", () => tidyDialog.close("run"));
el<HTMLButtonElement>("tidy-dialog-close").addEventListener("click", () => tidyDialog.close());
{
  // 外側（::backdrop）を押したときもやめる。押し始めも離した所も外のときだけ（利用規約のダイアログと同じ）
  const onBackdrop = (e: MouseEvent) => e.target === tidyDialog && isOutside(e.clientX, e.clientY, tidyDialog.getBoundingClientRect());
  let downOutside = false;
  tidyDialog.addEventListener("pointerdown", (e) => {
    downOutside = onBackdrop(e);
  });
  tidyDialog.addEventListener("click", (e) => {
    if (downOutside && onBackdrop(e)) tidyDialog.close();
    downOutside = false;
  });
}
// Esc はブラウザが閉じる（cancel → close）。「整える」を押したときだけ整え、ほかはフォーカスを「整える」のボタンへ戻す
tidyDialog.addEventListener("close", () => {
  if (tidyDialog.returnValue === "run") {
    // ボタンは押せない形になるので、フォーカスは結果の見出しへ（終わったら「整えた結果」の見出しへ移る）
    ui.resultTitle.focus({ preventScroll: true });
    void runSanitize();
  } else {
    // 帯から開いたときは帯へ戻す（帯がもう消えていれば、「整える」のボタンへ）
    (tidyOpener === ui.tidyBandRun && !ui.tidyBand.hidden ? ui.tidyBandRun : ui.sanitize).focus();
  }
});
ui.saveConfirmBox.addEventListener("change", () => {
  if (ui.saveConfirmBox.checked) unlockDownload();
  else lockDownload();
});
// 押せない形のときは、押しても何もしない（href がないので、もともと保存は起きない。念のため止める）
/** 保存を押したあとの一言（保存しても画面が変わらず、済んだのか分からないため。2026-11-05 夜のレビュー 19） */
const SAVED_NOTE = "✓ 保存しました（ダウンロードのフォルダ）。公開する前に、保存した PDF をもう一度ここに入れると、念のため確かめられます。";

ui.download.addEventListener("click", (e) => {
  if (ui.download.getAttribute("aria-disabled") === "true") {
    e.preventDefault();
    return;
  }
  ui.saveNote.textContent = SAVED_NOTE;
  ui.saveNote.dataset.gate = "saved";
});

ui.compressRun.addEventListener("click", () => void runCompress());
ui.reportContentsBox.addEventListener("change", refreshReport);
ui.compressConfirmBox.addEventListener("change", () => {
  if (ui.compressConfirmBox.checked) unlockCompressDownload();
  else lockCompressDownload();
});
ui.compressDownload.addEventListener("click", (e) => {
  if (ui.compressDownload.getAttribute("aria-disabled") === "true") {
    e.preventDefault();
    return;
  }
  ui.compressSaveNote.textContent = SAVED_NOTE;
  ui.compressSaveNote.dataset.gate = "saved";
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

ui.input.addEventListener("change", () => {
  const file = ui.input.files?.[0];
  if (file) void handle(file);
});

// 「別の PDF にする」：最初の画面に戻り、そこで置く・選ぶ・見本を試す（「別の PDF を選ぶ」と 1 つにまとめた。2026-11-05 本人の画面のレビュー B7）
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

// 処理に要る部品は、画面の表示が終わってから裏で読み込む（2026-11-06 本人が決定。src/parts.ts）
loadPartsAfterDisplay();
