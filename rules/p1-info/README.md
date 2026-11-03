# 検出ルール：P1（文書情報）

PDF を入れると、いまの版の文書情報（trailer の `/Info`）で、値が残っている欄を返す。**値そのものは返さない**（どの欄に、何字残っているかだけ）。

```ts
import { detectP1Info } from "./rules/p1-info/index.ts";
const report = await detectP1Info(bytes);                          // 欄の名前と字数だけを返す
const report2 = await detectP1Info(bytes, { includeValues: true }); // 値そのものも返す（調べるときだけ。記録やログには使わない）
```

出力の形は `rules/p6-text` にそろえた（`rule`・`status`・`error`・`findings`）。`findings` の1件が、文書情報の1つの欄。

| 項目 | 中身 |
|---|---|
| `findings[].key` | 欄の名前（`Author`・`Company` など。`#xx` は解いたもの） |
| `findings[].group` | `standard`（Title・Author・Subject・Keywords・Creator）か `custom`（それ以外の独自の欄） |
| `findings[].chars` | 値の字数（前後の空白を除く） |
| `notCounted` | あったが数えなかった欄と理由（`producer`・`date`・`trapped`・`empty`） |
| `previousInfo` | 前の版（増分更新）の文書情報。P5 の範囲なので、数だけ出す |

## 数え方（rubric/p1.md §2 のとおり）

- 数える：値が空でない欄のうち、下の「数えない欄」以外のすべて。作成者が課の名前でも、Creator（作成アプリ）でも、値があれば数える。
- 数えない：`Producer`、`CreationDate`・`ModDate`、`Trapped`、値が空・空白だけの欄。
- 空白は JavaScript の `trim()` で取れるもの（全角の空白を含む）と、NUL。
- 値の中身（個人名か課の名前か、パスが入っているか）は見ない。

## 読み方

検証器（`verifier/`）はバイト列を自分で読む・PDF.js を使う。検出ルールは、それと別の読み方として **pdf-lib**（1.17.1）を使う。

1. pdf-lib でファイル全体を読む（オブジェクトストリームの中も、あとの版の定義が前の版を上書きする）。
2. **いまの版の trailer を読み直す。** pdf-lib は、新しい trailer に `/Info` がないとき、古い trailer の `/Info` を使い続ける（`node_modules/pdf-lib/cjs/core/parser/PDFParser.js` の `maybeParseTrailerDict`、267 行）。そのままだと、片付けで `/Info` を外した PDF でも、前の版の作成者を「いま残っている」と報告してしまう。そこで、最後の版（最後から2つ目の `%%EOF` のあと）の中の `trailer` を pdf-lib の `PDFObjectParser` で読み、`/Info` があるかを確かめる。`trailer` のない版（xref ストリーム）は、pdf-lib が xref ストリームの辞書から読んだものを使う（こちらは古い値を引き継がない。`PDFXRefStreamParser.js` 40 行）。
3. 値の文字は、UTF-16BE（BOM）・UTF-16LE（BOM）・UTF-8（BOM）・PDFDocEncoding を読み分ける。UTF-16BE の中の言語のしるし（ESC で囲んだ部分）は除く。
4. 値が名前・数・真偽のときも、値ありとする。配列は中の文字をつないで見る。辞書は、中身があれば値ありとする（どれも合成 PDF にはない。安全側に倒した）。
5. 暗号化された PDF：読み込みは共通の入口（`rules/shared/load.ts`。P6 の検出ルールと同じ）を使う（1.1.0 から）。パスワードなしで開ける暗号化（RC4・AES-128・AES-256）は復号して調べ、パスワードが要るものは `encrypted` で止める。復号した文書のオブジェクトの番号は元のままなので、いまの版の trailer を元のバイト列から読み直すやり方（3）は変えていない。
   - pdf-lib 1.17.1 の `EncryptedPDFError` は `instanceof` で見分けられない（ES5 向けに変換されたクラスで、作られたエラーの型が `Error` になる。2026-11-03 に Node 24.19.0 で確かめた）。そのため、共通の入口は `ignoreEncryption: true` で読み、`isEncrypted` で見分ける。

### 前の版（`previousInfo`）

- `%%EOF` ごとにファイルを切り出し、それぞれを同じ読み方で読み直す。前の版にあって、いまの版にない・値が違う「数える欄」の数を `keys` に出す（同じ鍵は1つと数える）。
- 版の数は `revisions`。読み直すのは新しいほうから 64 版まで（`MAX_REVISIONS`）。超えたら `truncated` を立てる。
- 前の版だけでは読めない区切り（線形化した PDF の最初の区切りなど）は数えない。

## 合成 PDF で測った値（2026-11-03、`npm run eval:p1`）

- 検出率 100.0%（22 件中 22 件）。誤検知率 0.0%（20 件中 0 件）。内訳は `docs/evolution.md`。

## できないこと（限界）

- **XMP（P2）は見ない。** 同じ作成者名が XMP に残っていても、P1 では数えない。
- 値の中身は判定しない（個人名か、課の名前か、パスか）。
- 前の版の数は、`%%EOF` で区切って数える。ストリームの中にたまたま `%%EOF` の並びがあると、版を多く数えることがある（合否には使わない）。
- いまの版の trailer は、最後の版の中で最後に出てくる `trailer` の文字で探す。圧縮していないストリームの中に、たまたま `trailer` の並びがあると、読み違えることがある（読めなければ pdf-lib の読んだものを使う）。
- 前の版の読み直しは、版ごとにファイルの頭から読み直すので、版が多い大きなファイルでは時間がかかる。時間の上限はこのルールの中にはない。画面では Worker の時間の上限で止める。
- パスワードが要る暗号化 PDF は読まない（`encrypted`）。パスワードなしで開ける暗号化は、復号して読む（1.1.0 から）。
- 増分更新した暗号化 PDF の前の版（`previousInfo`）も、版ごとに復号して読む。合成 PDF ではまだ試していない。
