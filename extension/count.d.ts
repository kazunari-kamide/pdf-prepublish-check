// SPDX-License-Identifier: AGPL-3.0-only
// count.js の型（tests/extension.test.ts から使うため。拡張機能そのものは型を使わない）

export interface Bucket {
  count: number;
  bytes: number;
}
export interface Recent {
  kind: "sent" | "loaded";
  method: string;
  type: string;
  where: string;
  bytes: number;
}
export interface TabState {
  pageOrigin: string;
  phase: "waiting" | "counting";
  startedBy: "pdf" | "manual" | null;
  startedAt: number | null;
  before: number;
  sent: Bucket & { unknownBody: number };
  loaded: Bucket;
  recent: Recent[];
}
export interface RequestLike {
  url: string;
  method?: string;
  type?: string;
  requestBody?: { raw?: Array<{ bytes?: ArrayBuffer; file?: string }>; formData?: Record<string, string[]>; error?: string } | null;
}
export interface View {
  tone: "off" | "waiting" | "zero" | "sent";
  title: string;
  value: string;
  detail: string;
  note: string;
}
export const RECENT_MAX: number;
export function utf8Bytes(s: unknown): number;
export function isWatchedPage(url: string): boolean;
export function newTabState(pageUrl: string): TabState;
export function bodyBytes(body: RequestLike["requestBody"]): number | null;
export function headerBytes(headers: Array<{ name: string; value?: string; binaryValue?: number[] }> | undefined): number;
export function requestLineBytes(method: string, url: string): number;
export function classify(req: RequestLike, pageOrigin: string): "sent" | "loaded";
export function addRequest(state: TabState, req: RequestLike): { kind: "sent" | "loaded" } | null;
export function addHeaders(state: TabState, mark: { kind: "sent" | "loaded" } | null, headers: Array<{ name: string; value?: string }> | undefined): void;
export function start(state: TabState, how: "pdf" | "manual", now: number): boolean;
export function formatBytes(n: number): string;
export function badgeText(state: TabState | undefined | null): string;
export function view(state: TabState | undefined | null): View;
