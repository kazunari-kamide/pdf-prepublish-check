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

## 暗号化された PDF（1.1.0、PR #24 の返事の 1）

- **利用者のパスワードが空のもの**（印刷・編集の禁止だけのもの）は、前の版も含めて復号して調べる。対応する方式は共通の復号（`rules/shared/decrypt.ts`）と同じ：RC4（V1・V2、R2・R3）、AES-128 と RC4（V4・R4）、AES-256（V5・R5・R6）。報告の `decrypted` に方式と、解けなかったオブジェクトの数を出す。
- 利用者のパスワードが要るもの・対応していない方式は `encrypted` で止める。パスワードを試したり推したりはしない。
- 復号は共通の部品の `decryptContext` を使い、このルールでは書いていない（`decrypt.ts` は、組み分けとオブジェクトストリームを開く所だけ）。`decryptContext` は1つの文脈の中のものを全部解く作りなので、書き留めた定義を、同じ番号・世代が重ならない組に分け、組ごとに読み捨ての文脈に入れて解き、解けた中身を定義に戻す。オブジェクトの鍵は、その定義の番号と世代から作られる。
- 版ごとに、その版を閉じる xref の trailer に `/Encrypt` があるかを見る。ない版（暗号化する前の版）の定義は解かない。どの xref よりあとにある定義は、いまの版に合わせる。
- オブジェクトストリームは、暗号化されたまま pdf-lib に開かせると壊れる。読む前に `/ObjStm` の名前を同じ長さの別名に置き換え（`rules/shared/load.ts` と同じ考え方。位置がずれないので xref はそのまま使える）、解いてから自分で開く。

## 合成 PDF で測った値（2026-11-03、`npm run eval`）

- 1.1.0：検出率 100.0%（24 件中 24 件）。誤検知率 0.0%（20 件中 0 件）。1.0.0 では 87.5%（24 件中 21 件。暗号化した3個を見逃した）。内訳は `docs/evolution.md`。

## できないこと（限界）

- **利用者のパスワードが要る暗号化 PDF は調べない**（`encrypted`）。
- 暗号化の辞書と `/ID` は、`/Encrypt` を持ついちばん新しい trailer のものを使う。版ごとに暗号化の辞書や鍵が違う PDF は、古い版を正しく解けない。古い版だけが暗号化され、いまの版が暗号化されていない PDF も、合成 PDF では試していない。
- 暗号化の決まりをストリームごとに指定したもの（`/Filter /Crypt`）は見ていない（共通の復号と同じ）。
- 暗号化された PDF のオブジェクトストリームの中の定義は、世代を 0 とみなす（決まりのとおり）。
- pdf-lib の差し込みは、pdf-lib 1.17.1 の中の作り（`parseIndirectObject`・`maybeParseCrossRefSection` などの名前と、`subsections` の形）に頼っている。pdf-lib の版を上げるときは、このルールのテストで確かめる。
- xref の項目の位置と、定義の位置が完全に同じときだけ「指されている」とする。位置が少しずれた（壊れた）PDF では、いまの定義を orphan と取り違えることがある。
- 字を描く命令は、文字の並びで探す目安。
- 種類の見分けは、辞書の鍵での目安。`/Type` を省いた注釈などは、骨組みと見分けられないことがある。
- 線形化（Linearized）した PDF は、最初のページ用の xref があり、版が2つに見える。合成 PDF ではまだ試していない。
- 圧縮を解くのは、保存されている大きさが 32 MB までのストリーム。それより大きいものは `unreadable_stream`。圧縮を解いた結果が大きくなる細工は、このルールの中では止めない（画面では Worker の上限で止める）。
- 上限：定義 20 万、xref の区切り 1000。超えたら `unreadable`。
