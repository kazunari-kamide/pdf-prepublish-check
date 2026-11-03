# 検出ルール：P5（旧版の残存）

PDF を入れると、いまの版では使っていないのに、ファイルの中に残っているオブジェクトの定義を返す（rubric/p5.md §2）。1件 ＝ 定義1つ。**値そのもの（名前・字）は返さない**。種類・場所・番号・字数だけ。

```ts
import { detectP5Revisions } from "./rules/p5-revisions/index.ts";
const report = await detectP5Revisions(bytes);
```

出力の形は `rules/p6-text`・`rules/p1-info`・`rules/p9-attach` にそろえた（`rule`・`status`・`error`・`findings`）。

| 項目 | 中身 |
|---|---|
| `findings[].where` | `superseded`（同じ番号を書き直した前の定義）・`free`（いまの xref が「使っていない」と印をつけた）・`unreferenced`（いまの xref にあるが、根からたどれない）・`orphan`（どの版の xref にも載っていない） |
| `findings[].kind` | `info`・`content`・`annotation`・`form_value`・`metadata`・`image`・`embedded_file` |
| `findings[].revision` | その定義のある版（1 ＝ いちばん古い。`%%EOF` で数える）。orphan は null |
| `findings[].chars` | info・annotation・form_value のとき、残っている字の数（目安） |
| `notCounted` | 残っているが数えなかったもの（骨組み・字のない注釈・値のない欄・ファイル指定・数える欄のない文書情報・P9 で数える添付） |
| `summary` | `previousInfo`（前の版の文書情報）・`removedAttachment`（free の添付の中身） |
| `chainFallback` | `/Prev` の鎖をたどれず、ファイルの中の順で版を決めたとき true |

## 読み方

検証器（`verifier/`）は、xref を版ごとにたどる方法と、ファイル全体から「N G obj」を探す方法の2つを、自分で書いたバイト列の読み手で持つ。検出ルールは、それと別に **pdf-lib（1.17.1）の読み手 `PDFParser`** を使う。

1. pdf-lib の読み手は、ファイルの頭から順に定義を読み、同じ番号はあとのもので上書きする。そのため、そのままでは前の版が見えない。
2. そこで、読み手の**インスタンス**に差し込みを入れる（クラスそのものは変えない）。
   - `context.assign`：定義を1つ読むたびに、番号・位置・オブジェクトを書き留める。オブジェクトストリームの中の定義は、どのオブジェクトストリームのものかを書き留める。
   - `maybeParseCrossRefSection`：xref の表の項目（位置・使っていない印）を書き留める。
   - xref ストリーム：読んだしるし（trailer の値が書かれた）を見て、同じ位置を読み直し、pdf-lib の `PDFXRefStreamParser` で項目を取る。
   - `maybeParseTrailerDict`：trailer の辞書をそのまま残す。pdf-lib は、新しい trailer にない鍵を古い値で埋めるため（P1 で見つけた落とし穴と同じ）。
3. 末尾の `startxref` から `/Prev` をたどって、新しい順の xref の区切りを作る（`/XRefStm` の混ぜた形も）。いまの版の表 ＝ 新しい区切りから見て最初に出てくる項目。
4. 定義ごとに場所を決める。どの版の xref からも指されていない → orphan。いまの表で使っていない → free。いまの表が指している定義 → 根（trailer の `/Root`・`/Info`・`/Encrypt`）からたどれなければ unreferenced（たどれれば、いまの版で使っているので数えない）。それ以外 → superseded。
5. 種類は辞書の鍵で見分ける（rubric/p5.md §2 の表のとおり）。中身（`/Type` のないストリーム・部品）は、pdf-lib の `decodePDFRawStream` で解き、字を描く命令（`Tj`・`TJ`・`'`・`"`）があれば content。xref ストリームとオブジェクトストリームは数えない（`notCounted` にも出さない）。

## 合成 PDF で測った値（2026-11-03、`npm run eval`）

- 検出率 100.0%（21 件中 21 件）。誤検知率 0.0%（18 件中 0 件）。内訳は `docs/evolution.md`。

## できないこと（限界）

- **暗号化された PDF は調べない**（`encrypted`）。共通の復号（`rules/shared/`）は、いまの版の文脈を復号して読み直す作りで、前の版の定義を復号しない。→ PR の「決めてほしいこと」
- pdf-lib の差し込みは、pdf-lib 1.17.1 の中の作り（`parseIndirectObject`・`maybeParseCrossRefSection` などの名前と、`subsections` の形）に頼っている。pdf-lib の版を上げるときは、このルールのテストで確かめる。
- xref の項目の位置と、定義の位置が完全に同じときだけ「指されている」とする。位置が少しずれた（壊れた）PDF では、いまの定義を orphan と取り違えることがある。
- 字を描く命令は、文字の並びで探す目安。
- 種類の見分けは、辞書の鍵での目安。`/Type` を省いた注釈などは、骨組みと見分けられないことがある。
- 線形化（Linearized）した PDF は、最初のページ用の xref があり、版が2つに見える。合成 PDF ではまだ試していない。
- 圧縮を解くのは、保存されている大きさが 32 MB までのストリーム。それより大きいものは `unreadable_stream`。圧縮を解いた結果が大きくなる細工は、このルールの中では止めない（画面では Worker の上限で止める）。
- 上限：定義 20 万、xref の区切り 1000。超えたら `unreadable`。
