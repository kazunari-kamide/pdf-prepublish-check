// SPDX-License-Identifier: AGPL-3.0-only
//
// フォルダを渡したときに、調べるファイルの拡張子（小文字）。ファイルを直接渡したときは、拡張子を問わず中身で見分ける。
// 古い Office（.doc・.xls・.ppt）・一太郎は調べないので、フォルダからは拾わない。

export const CHECK_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif",
  ".docx", ".docm", ".xlsx", ".xlsm", ".pptx", ".pptm",
];
