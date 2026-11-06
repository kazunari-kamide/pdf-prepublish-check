// SPDX-License-Identifier: AGPL-3.0-only
//
// Worker を 1 つ持ち、温め・使い回し・作り直しを受け持つ（検査の Worker と、整える処理の Worker で同じ作り）。
// 2026-11-06 本人が決定：PDF を入れた後は、同じサイトへの要求も 0 件にする。
// - 画面の表示が終わったあとに Worker を作り、PDF.js と画像を解く部品を読み込ませておく（prepare）。
// - 1 つのファイルの流れの中では、同じ Worker を使い回す（新しいファイルは startFile で知らせる）。
// - ファイルが変わるときは作り直す（細工された PDF の影響を次のファイルに残さないため）。作り直すのは、最初の画面に戻ったとき（reset）。
// - 時間の上限を超えた・止まったときは捨て、その場では作り直さない（その PDF の後に要求を出さない）。

type WarmMessage = { type: "warm-done"; id: number; ok: boolean };
type Any = { type: string; id: number };

let nextId = 1;
/** 今のファイルの番号（新しいファイルを始めるたびに進める。Worker は、最後に使ったファイルの番号と違えば作り直す） */
let fileKey = 0;
/** 新しいファイルを始める（PDF を選んだ・置いた・見本を試したとき） */
export function startFile(): void {
  fileKey++;
}
/** 頼みの番号（検査・整える処理の頼みで共通。番号が重ならないように） */
export function nextJobId(): number {
  return nextId++;
}

export class WorkerSlot {
  private current: { worker: Worker; ready: Promise<boolean>; used: boolean; file: number } | null = null;

  constructor(private readonly create: () => Worker) {}

  private make() {
    const worker = this.create();
    const id = nextJobId();
    const ready = new Promise<boolean>((resolve) => {
      const onMessage = (e: MessageEvent<WarmMessage>) => {
        if (e.data?.type !== "warm-done" || e.data.id !== id) return;
        worker.removeEventListener("message", onMessage);
        resolve(e.data.ok);
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", () => resolve(false), { once: true });
    });
    worker.postMessage({ type: "warm", id });
    return { worker, ready, used: false, file: -1 };
  }

  /** Worker を作って温める（まだなければ）。温め終わったら true */
  prepare(): Promise<boolean> {
    this.current ??= this.make();
    return this.current.ready;
  }

  /** 前のファイルで使った Worker を捨て、新しく作って温める（最初の画面に戻ったとき） */
  reset(): Promise<boolean> {
    if (this.current?.used) {
      this.current.worker.terminate();
      this.current = null;
    }
    return this.prepare();
  }

  /** 前のファイルで使った Worker を捨てる（作り直さない） */
  drop(): void {
    this.current?.worker.terminate();
    this.current = null;
  }

  /**
   * 1 つの頼みを送り、答えを待つ。handle が値を返したら終わり（undefined なら、その答えは進み具合などとして読み流す）。
   * 前のファイルで使った Worker しかないときは作り直す（最初の画面を通らずに次の PDF が来たとき。startFile）。
   * 時間の上限は、温め終わって頼んだときから数える
   */
  job<T>(o: {
    request: (id: number) => { message: Any; transfer?: Transferable[] };
    handle: (res: Any & Record<string, unknown>) => T | undefined;
    onTimeout: () => T;
    onBroken: () => T;
    timeoutMs: number;
  }): Promise<T> {
    if (this.current?.used && this.current.file !== fileKey) this.drop();
    const s = (this.current ??= this.make());
    s.used = true;
    s.file = fileKey;
    const worker = s.worker;
    const id = nextJobId();
    return new Promise<T>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: T, broken: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onError);
        if (broken) {
          worker.terminate();
          if (this.current === s) this.current = null;
        }
        resolve(value);
      };
      const onMessage = (e: MessageEvent<Any & Record<string, unknown>>) => {
        if (!e.data || e.data.id !== id) return;
        const v = o.handle(e.data);
        if (v !== undefined) finish(v, false);
      };
      const onError = () => finish(o.onBroken(), true);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onError);
      void s.ready.then(() => {
        if (settled) return;
        timer = setTimeout(() => finish(o.onTimeout(), true), o.timeoutMs);
        const { message, transfer } = o.request(id);
        worker.postMessage(message, transfer ?? []);
      });
    });
  }
}
