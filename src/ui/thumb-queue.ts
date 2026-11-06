// SPDX-License-Identifier: AGPL-3.0-only
//
// 左の列の縮小したページを、見えたものから 1 枚ずつ描く順番待ち（2026-11-06 朝）。
// 前は先頭から 60 枚までしか描かず、それより後のページは白い枠のままだった。
// 画面の部品に頼らない順番の決まりだけを置き、テストで確かめる（見えたかどうかは main.ts の IntersectionObserver が知らせる）。

export type ThumbQueue = {
  /** 見えた（描いてほしい）ページ */
  want(page: number): void;
  /** 見えなくなったページ（まだ描いていなければ、待ちから外す） */
  unwant(page: number): void;
  /** 描くのをやめる（別の PDF に替わったとき） */
  stop(): void;
  /** 今の待ちが空になるまで待つ（テスト用） */
  idle(): Promise<void>;
};

/**
 * draw(page) は 1 枚を描き、続けてよければ true、この PDF ではもう描けない（時間の上限など）なら false を返す。
 * 一度に描くのは 1 枚だけ。描き始めたページは、二度と待ちに入れない。
 */
export function createThumbQueue(draw: (page: number) => Promise<boolean>): ThumbQueue {
  const waiting = new Set<number>();
  const started = new Set<number>();
  let running: Promise<void> | null = null;
  let stopped = false;

  const pump = async () => {
    while (!stopped && waiting.size > 0) {
      const page = waiting.values().next().value as number;
      waiting.delete(page);
      started.add(page);
      let more = false;
      try {
        more = await draw(page);
      } catch {
        more = false;
      }
      if (!more) stopped = true;
    }
    running = null;
  };

  return {
    want(page) {
      if (stopped || started.has(page)) return;
      waiting.add(page);
      running ??= pump();
    },
    unwant(page) {
      waiting.delete(page);
    },
    stop() {
      stopped = true;
      waiting.clear();
    },
    async idle() {
      while (running) await running;
    },
  };
}
