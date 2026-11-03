# P1（文書情報）の合成 PDF の一覧

`node fixtures/p1/build.mjs` で作り直せる。日時を固定しているので、作り直しても SHA-256 は変わらない。
名前・団体はすべて架空。

- 合成 PDF：18 個
- 漏れ（検出率の分母）：22 件
- 漏れでない欄（誤検知率の分母）：20 件

| ファイル | 何を再現しているか | 漏れ | 漏れでない | SHA-256（先頭16桁） |
|---|---|---|---|---|
| p1-01-author-name.pdf | 作成者（Author）に個人名が残っている。作成ソフト名（Producer）と日付もある | 1 | 3 | `03b719e33a3430f4` |
| p1-02-all-standard.pdf | 決まった欄（タイトル・作成者・題・キーワード・作成アプリ）がすべて埋まっている | 5 | 3 | `ca4f367d5d7ae98e` |
| p1-03-custom-keys.pdf | 決まった欄の外の、独自の欄（会社名・管理者・元のファイルの更新日時）が残っている | 3 | 0 | `9cfe6fb0d2c58db2` |
| p1-04-literal-and-pdfdoc.pdf | ( ) の文字列の作成者と、PDFDocEncoding の8進エスケープを含むタイトル | 2 | 0 | `7d2eaf037589606f` |
| p1-05-object-stream.pdf | xref ストリームとオブジェクトストリームで保存（文書情報がストリームの中にある） | 2 | 1 | `754d6c5e405e5f32` |
| p1-06-direct-info.pdf | trailer の中に文書情報を直接書いている（参照でない） | 1 | 0 | `3fd159baafa34ec0` |
| p1-07-empty-values.pdf | 欄はあるが、値が空・空白だけ（片付けで空にした形） | 0 | 3 | `807415391aae0cc9` |
| p1-08-no-info.pdf | 文書情報がない（trailer に /Info がない） | 0 | 0 | `3215c582f8dffcb9` |
| p1-09-incremental-overwrite.pdf | 増分更新で、作成者を個人名から課の名前に書き換えた（前の版に個人名が残る） | 1 | 0 | `0ac15d7461a4c9b9` |
| p1-10-incremental-cleaned.pdf | 増分更新で、文書情報を新しい番号の Producer だけのものに差し替えた（前の版に作成者が残る） | 0 | 1 | `d0b24c02611427e7` |
| p1-11-path-in-title.pdf | タイトルに、作った PC のファイルの場所が残っている（P4 とも重なる） | 1 | 0 | `aa0e7f4a5a8f7305` |
| p1-12-dates-only.pdf | 日付だけが残っている | 0 | 2 | `d6ca1236e0723fd8` |
| p1-13-escaped-key.pdf | 名前に #20（空白）を含む独自の欄 | 1 | 0 | `011f97a8c76c5938` |
| p1-14-department-author.pdf | 作成者が課の名前（意図して残すこともある） | 1 | 0 | `422d01229444e466` |
| p1-15-trapped-and-creator.pdf | 作成アプリ（Creator）と、Trapped（印刷の設定）・Producer | 1 | 2 | `86524a0150985d2f` |
| p1-16-subject-keywords.pdf | 題とキーワードに、担当と内部の番号が残っている。日付もある | 2 | 3 | `983c736e0e43f13a` |
| p1-17-utf8-bom.pdf | UTF-8 の BOM つきの作成者（PDF 2.0 の書き方） | 1 | 0 | `31dbadfb03b68ac0` |
| p1-18-object-stream-incremental-clean.pdf | オブジェクトストリームで保存した PDF で、文書情報を空にした（正しく片付けた形。前の版はない） | 0 | 2 | `f6493a550d389f76` |
