# 採点する側に足す案：カタログの URI の基準（/URI /Base）に残った file:// のパス（P4）

CLAUDE.md §2-3 に従い、`fixtures/` に足す合成 PDF と正解データの案をここに置く。人が中身を見て、移すコミットを作る。利用者名は架空（yamada）。

## 何を足すか

| 合成 PDF | 型 | 中身 |
|---|---|---|
| `p4-u01-catalog-uri-base-file` | 漏れ 1（P4。user_path）・漏れでない 1 | カタログに直接 `/URI << /Base (file:///C:/Users/yamada/Documents/sagyou/) >>`。ページに相対の行き先のリンク（`/S /URI /URI (bessi.html)`）が1つ。リンクそのものは数えない |
| `p4-uc01-catalog-uri-base-web` | 漏れでない 2 | `/URI /Base` が公開のウェブの場所（`https://www.example.jp/kouhou/`）で、同じ相対のリンク |

作り方：`node build.mjs [出力先]`。出力先を省くと、横の `out/`（コミットしない）に書く。日時も乱数も使わないので、何度作っても同じバイト列になる。

## なぜ漏れか

カタログの `/URI` 辞書の `/Base`（ISO 32000 の 12.6.4.7、相対の URI を解く基準）は、ファイルの中に字として残る。Acrobat では文書のプロパティの「詳細」の「ベース URL」に出るので、文書情報と同じくらい気づきにくい。`file:///C:/Users/<名前>/…` ならユーザーのフォルダの名前が読める。

## 今の型との違い

- `rules/p4-paths/index.ts` の間接オブジェクトの見回り（162〜176 行）では、カタログは `/S` を持たないので動作として見られず、中に直接ある `/URI` 辞書も回る対象に入らない。`visitAction`（198〜210 行）も、動作の `/URI`・`/F`・`/Win /F` だけを読む。
- `proposals/blind` の t13-c-file-link はリンクの動作の行き先の `file://` で、基準ではない。`eval/cases/p4.ts` にも、ほかの案にも `/URI /Base` は無い。

## 確かめた結果（2026-11-07、Node 24.19.0、Windows）

`node build.mjs` を2回（`out/` と `out-again/`）実行し、PDF 2 個と正解データ 2 個の SHA-256 がすべて同じだった。

| 合成 PDF | SHA-256（先頭16桁） | 検出ルール | 検証器（`verifier/` の CLI。呼ぶだけ） |
|---|---|---|---|
| p4-u01-catalog-uri-base-file | `f1a124edd1604fec` | **見逃し**：P4 0 件。P12 は相対のリンクを `notCounted.link` 1 に入れた（正しい）。`omamori.ts check` は項目 0・stage `none` | P6・P1・P5・P7・P9 とも 0 件（P4 を見る検証器は無い） |
| p4-uc01-catalog-uri-base-web | `7b84650223a77b21` | 0 件（正しい。P12 の `notCounted.link` 1） | 5 つとも 0 件 |

- HTML などから PDF に変える道具が、`file://` の基準を実際に書くかは確かめていない（推測）。実物で見つかるまでは、深刻度を低めの【仮】にしておく案。

## 正解の決め方（人の判断）

- `where` に新しい値 `uri_base` を足す案。
- 相対のリンク（`bessi.html`）そのものは数えない（negatives に `relative_link` として書いた）。
- 対照の `https://www.example.jp/…` は、点のあるホスト名なので数えないのが正しい。

## 捨てた案

- 相対のリンクを置かない：基準だけでも漏れだが、リンクがあると「基準が実際に使われる形」になり、直し方がリンクの行き先だけを見るものになるのを防げる。

## 移し方（人が行う）

```
node proposals/e-shapes/p4-catalog-uri-base/build.mjs fixtures/p4
npm run eval
```

- fixtures に P4 のフォルダは無いので、置き場所は人が決める。`index.md` と `hashes.txt` も足す。
- `/URI` の辞書を間接オブジェクトにした版も1つ足すとよい（この案には入れていない）。直し方が、直接の辞書だけに合わせたものになるのを防げる。
- 検出ルールの直し方の案：カタログの `/URI`（直接でも間接でも）の `/Base` を `findPaths` にかける。
