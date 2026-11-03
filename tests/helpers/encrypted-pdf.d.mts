// SPDX-License-Identifier: AGPL-3.0-only
//
// tests/helpers/encrypted-pdf.mjs の型

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array;
export function makeEncryptedPdf(opts?: { objectStream?: boolean; ownerPassword?: string; userPassword?: string }): Uint8Array;
export function latin1(b: Uint8Array): string;
