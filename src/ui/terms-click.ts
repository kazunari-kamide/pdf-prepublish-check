// SPDX-License-Identifier: AGPL-3.0-only
//
// 利用規約のダイアログ（src/ui/terms-dialog.ts）で使う、押し方の見分け。DOM に触らない（テストで確かめる）。

/** 止めてダイアログで開くクリックか（修飾キーなしの、主ボタンのクリックだけ） */
export function isPlainClick(e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/** 点（x, y）が、四角（ダイアログの枠）の外か */
export function isOutside(x: number, y: number, r: { left: number; right: number; top: number; bottom: number }): boolean {
  return x < r.left || x > r.right || y < r.top || y > r.bottom;
}
