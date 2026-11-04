# 検出ルール：P9（添付ファイル）

PDF を入れると、ファイルの中に残っている添付ファイルの中身（ファイル指定の `/EF` が指すストリーム）を返す。**ファイル名そのものは返さない**（字数と拡張子だけ）。ファイル名に個人名が入ることがあるため。

```ts
import { detectP9Attach } from "./rules/p9-attach/index.ts";
const report = await detectP9Attach(bytes);                         // ファイル名の字数と拡張子だけ
const report2 = await detectP9Attach(bytes, { includeNames: true }); // ファイル名そのものも返す（採点と調べるときだけ。記録やログには使わない）
```

出力の形は `rules/p6-text`・`rules/p1-info` にそろえた（`rule`・`status`・`error`・`findings`）。読み込みは共通の入口（`rules/shared/load.ts`）を使うので、パスワードなしで開ける暗号化 PDF は復号して調べる（`decrypted`）。

| 項目 | 中身 |
|---|---|
| `findings[].where` | `names`（名前の木）・`annotation`（ページの添付ファイルの注釈）・`af`（文書・ページの `/AF`）・`unreferenced`（どこからも指されていない） |
| `findings[].page` | `annotation` とページの `/AF` のとき、ページ番号 |
| `findings[].object` | 中身のストリームのオブジェクト番号 |
| `findings[].also` | 同じ中身を、ほかに指している場所 |
| `findings[].nameChars`・`ext` | ファイル名の字数（分からなければ 0）と拡張子（小文字。なければ null） |
| `findings[].size`・`subtype` | 中身の大きさ（`/Params` の `/Size`。なければ、圧縮していない中身の長さ。分からなければ null）と `/Subtype` |
| `externalRefs` | 中身のない（外のファイルを指すだけの）ファイル指定の数。漏れではない（参考） |
| `limits` | 上限に当たって、たどるのをやめた所。空でなければ、見落としがありうる |

## 数え方（rubric/p9.md §2 のとおり）

- 1件 ＝ 中身のストリーム1つ。同じ中身を2つの場所が指していれば1件にまとめ、場所は names → annotation → af → unreferenced の順で先のものにする。
- 数えない：中身のないファイル指定、リンク（URL・外のファイルを開く・別の PDF に飛ぶ）、空の名前の木、画像や XMP のストリーム、JavaScript の名前の木、ページの字の中の「EmbeddedFile」の文字。
- ファイル名は、ファイル指定の `/UF`、なければ `/F`、なければ名前の木の鍵。

## 読み方

検証器（`verifier/`）はバイト列を自分で読む・PDF.js を使う。検出ルールは、それと別の読み方として **pdf-lib**（1.17.1）を使う。

1. 名前の木：文書の根の `/Names` の `/EmbeddedFiles` から、`/Names` の組と `/Kids` をたどる。同じ節は2回たどらない（輪になった木で止まらないため）。
2. ページの注釈：`/Subtype /FileAttachment` の注釈の `/FS`。
3. 関連ファイル：文書の根とページの `/AF`。
4. どこからも指されていない中身：pdf-lib が読んだ**すべての間接オブジェクト**を見て、`/EF` を持つ辞書（間接オブジェクトの中に直接書かれたものも）の中身と、`/Type /EmbeddedFile` のストリームを集める。1〜3 で見つかっていなければ `unreferenced`。
- ファイル指定の `/EF` の中は、`/F`・`/UF` に限らず、ストリームを指す値をすべて中身とする（`/DOS`・`/Mac`・`/Unix` など）。
- 中身の圧縮は解かない（大きさは `/Params` の `/Size` を使う）。圧縮を解いた結果が大きくなる細工で止まらないため。

## 合成 PDF で測った値（2026-11-03、`npm run eval`）

- 検出率 100.0%（21 件中 21 件）。誤検知率 0.0%（15 件中 0 件）。内訳は `docs/evolution.md`。

## できないこと（限界）

- **pdf-lib は、xref を使わずにファイルの頭から全部のオブジェクトを読む。** そのため、増分更新で同じ番号を上書きして消した添付（P5 の範囲）は見ないが、新しい版の xref で「使っていない」とだけ印をつけたオブジェクト（上書きはしていない）は、残っているものとして `unreferenced` に数える。中身がファイルに残っていることは本当なので、安全側に倒している。検証器はいまの版の表にあるものだけを見るので、この形では食い違う（合成 PDF にはこの形はない）。
- 中身のストリームに `/Type /EmbeddedFile` がなく、`/EF` を持つ辞書からも指されていないものは見つけない。
- 文書の根・ページ以外の `/AF`（部品・構造の要素など）は、`af` ではなく `unreferenced` になる（中身は見つける）。
- リッチメディア・3D・音などの注釈の中身は、`/EF` を持つファイル指定の形なら `unreferenced` として見つけるが、場所の名前はつけない。
- 添付の中身の中（添付した PDF の中の添付など）は見ない。
- 上限：名前の木の節 1 万、入れ子 32 段、ページ 1 万。超えたら `limits` に出す。時間の上限はこのルールの中にはない。画面では Worker の時間の上限で止める。
- 復号できない暗号化（パスワードが要るものなど）は `encrypted` で止める。暗号化した PDF での動きは、このルールのテストではまだ試していない。

## 添付の中身を調べる（1.1.0、`inner.ts`）

```ts
import { inspectAttachments } from "./rules/p9-attach/inner.ts";
const inner = await inspectAttachments(bytes, detectors); // detectors＝中の PDF にかける検出ルール（見つけた件の並びを返す関数）
```

- `detectP9Attach(bytes, { includeContents: true })` で、添付の中身（展開したもの。32 MB まで）を `findings[].contents` に返す。画面・記録には出さない。
- 添付が **PDF**（先頭 1 KB に `%PDF-`）なら、渡された検出ルールで中も調べ、型ごとの件数（`counts`）を返す。中の PDF の添付も同じように調べ、中の添付そのものを P9 として 1 件ずつ、中で見つけた数も外の添付の数に足す。
- 添付が**文字のファイル**（種類が `text/…`、拡張子が `txt`・`csv`・`json` など、または種類も拡張子も無く字として読めるもの）なら、字数（空白を除く）を返す。UTF-8・UTF-16（BOM）・Shift_JIS を読む。
- 中身の字・ファイル名は返さない。
- 上限：入れ子は 3 段まで（`too_deep`）、調べる添付は全部で 50 個まで（`not_checked`）、1つの添付は 32 MB まで（`too_large`）。
- 画面（`src/inspect/rules.ts`）では、P9 以外の画面のルールを全部、中の PDF にかける。中で見つかれば、その添付を「高」【仮】にする。
- 合成 PDF 6 件（`eval/cases/p9-inner.ts`。`npm run eval:new`）：検出 7/7、誤検知 0。
