# 採点する側に足す案：見える字は課の名前なのに、リンクの行き先に個人の保存場所やアドレスが残る（P4）

CLAUDE.md §2-3 に従い、合成 PDF と正解データの案をここに置く。Claude は採点する側を書き換えない。人が中身を見て、移すかを決める。

## 何を足すか

| 合成 PDF | 種類 | 中身 |
|---|---|---|
| `e-link-01-personal-targets` | 漏れ 2 件（personal_storage_url：高、mailto_not_in_text：確認【仮】） | ページの字は「See the annex here」「Contact the section in charge」だけ。その上の `/Link` の注釈の行き先は、`https://share.example.jp/personal/jiro_kawamoto_example_jp/Documents/annex-member-list.xlsx` と `mailto:jiro.kawamoto@example.jp`。行き先の字は、ページの字のどこにも無い |
| `e-link-02-visible-or-public-targets` | 漏れでない 3 件 | 行き先と同じアドレスがページの字にも書いてある mailto、公開のページ（`https://www.example.jp/…`）への https、窓口らしい局所部（`info@example.jp`）の mailto |

作り方：`node build.mjs [出力先]`。出力先を省くと、このフォルダの `out/` に書く。名前・アドレス・ホスト名は架空（`example.jp` の下）。

- 正解データは `fixtures/p6` の形（`leaks`・`negatives`）にそろえ、`kind`・`level` を足した。`fixtures/` に P4 の置き場はまだ無い。
- ホスト名には、実在の会社の製品のドメインを入れなかった（CLAUDE.md §2-7 に触れるおそれがあるため）。パスの形（`/personal/<名前>_<所属>/Documents/…`）で見る前提にした。実在の製品のドメインを合成 PDF に入れてよいかは、人に確かめる。

## なぜ漏れか

Word で自動で付いたリンクの、表示の字だけを課の名前に直すと、押す・リンクの情報を見るだけで、担当者の個人のアドレスや、個人の保存場所とファイル名が分かる。個人の保存場所の URL は、P4 のユーザーのフォルダ（`user_path`）と同じ種類の情報（ユーザー名と、中のファイル名）。

- mailto のほうは弱い。課の共用アドレスと個人のアドレスを、ルールで見分けにくいため「確認」【仮】にした。

## 今の型との違い

- `rules/p4-paths` はリンクの動作の URI を読むが、https で数えるのは点の無いホスト名・内向きの IP アドレスと `/Users`・`/home` だけで、`/personal/` は数えない。
- `rules/p12-actions` は、mailto と、点のあるホスト名の https を数えない（`notCounted.link`）。`rules/pii` はページの字だけを見る。
- 見ないで作るテスト集の T13-c は `file:///C:/Users/…`、T13-ctl は公開の https、T89-a は外の場所の URI（P12 の確認）。`fixtures/p9` の `p9-n02` は漏れでないリンク。

## 確かめた結果（2026-11-07、Node、このフォルダの build.mjs）

- 2回作って、2つの PDF とも SHA-256 が同じだった（`e-link-01`：`4a14872e5eb33edb`、`e-link-02`：`fdcf4326ef9a34cf`）。

| 合成 PDF | 検出ルール（`node cli/omamori.ts check --format json`） | 検証器（P6・P1・P5・P7・P9） |
|---|---|---|
| e-link-01（漏れ 2） | **0 件（2 件とも見逃し）** | どれも 0 件（P4 の検証器は無い） |
| e-link-02（対照） | 1 件：`pii`（P13、低、確認）「メールアドレスらしい字があります」17 字。ページの見える字の `soudan@example.jp` に出たもので、リンクの行き先ではない。P4 は 0 件 | どれも 0 件 |

- 検出ルールは漏れ 2 件中 0 件。対照の P4 は 0 件。
- 対照の P13 の 1 件は、見える字のアドレスに出る今のふるまいどおりで、この案の対象（P4）ではない。移すときは、この対照を「出てはいけない：P4」として扱う。

## ルールを作る段への注意（反証役の注意から）

- 重心は、個人の保存場所の URL（P4 に足す）に置く。mailto は「行き先のアドレスがページの字に無い」ときだけ「確認」【仮】にする。
- `eval/cases/p12.ts` の `mailto:info@example.jp` を誤検知しないよう、課・窓口らしい局所部（info など）の扱いを決める。対照に `info@example.jp` を入れたのはそのため（扱いは【仮】）。

## 捨てた案

- 合成 PDF のホスト名に、実在の製品のドメインをそのまま使う案。本物らしくはなるが、§2-7 の「会社名を書かない」に触れるおそれがあり、人に確かめる前には書かない。

## 移し方（人が行う）

```
node proposals/e-shapes/link-target-personal/build.mjs <置き場>
```

- P4 の合成 PDF の置き場（`fixtures/p4` を作るか、見ないで作るテスト集に足すか）と、P4 の検証器を作るかを人が決める。
- 置き場が決まったら、`index.md`・`hashes.txt` を作り、`npm run eval` で確かめる。
