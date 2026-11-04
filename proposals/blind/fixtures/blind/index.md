# 見ないで作るテスト集（blind）の一覧

`node build.mjs` が書き出す。型の説明だけから作った合成 PDF（中身はすべて架空）。

| 型 | ファイル | 種類 | 何を入れたか | 出てほしい型 |
|---|---|---|---|---|
| T01 | `pdf/t01-a-author.pdf` | 隠しあり | Author に架空の個人名（ASCII） | P1 |
| T01 | `pdf/t01-b-utf16.pdf` | 隠しあり | Title・Subject・Keywords に、架空の名前を UTF-16 で | P1 |
| T01 | `pdf/t01-ctl-dates.pdf` | 対照 | Info に日付だけ | 出てはいけない：すべて |
| T02 | `pdf/t02-a-company.pdf` | 隠しあり | 独自の欄 Company・Manager に架空の社名と人名 | P1 |
| T02 | `pdf/t02-b-sourcefile.pdf` | 隠しあり | 独自の欄 SourceModified・Owner に人名 | P1 |
| T02 | `pdf/t02-ctl-trapped.pdf` | 対照 | Info に日付と Trapped だけ | 出てはいけない：すべて |
| T03 | `pdf/t03-a-old-author.pdf` | 隠しあり | 前の版の Info に作成者名。新しい版の Info では消した | P1・P5 |
| T03 | `pdf/t03-ctl-dates-only.pdf` | 対照 | 前の版も新しい版も Info は日付だけ（増分更新で ModDate を変えた） | 出てはいけない：すべて |
| T04 | `pdf/t04-a-sjis-author.pdf` | 隠しあり | Author を Shift_JIS のバイト列のまま（16進）で | P1 |
| T04 | `pdf/t04-b-sjis-literal.pdf` | 隠しあり | Title を Shift_JIS のバイト列のまま（リテラル）で | P1 |
| T04 | `pdf/t04-ctl-sjis-generic.pdf` | 対照 | Subject に Shift_JIS で「会議」だけ（人名なし）。題を P1 として出すのはよい | 出てはいけない：P2・P3・P4・P5・P6・P7・P8・P9・P10・P11・P12・P13 |
| T05 | `pdf/t05-a-creator-differs.pdf` | 隠しあり | Info の作成者は課の名前、XMP の dc:creator は個人名 | P2 |
| T05 | `pdf/t05-b-title-differs.pdf` | 隠しあり | Info の題は新しく、XMP の dc:title に古い題（人名入り） | P2 |
| T05 | `pdf/t05-ctl-agree.pdf` | 対照 | Info と XMP の題が同じで、人名なし。題を P1 として出すのはよい | 出てはいけない：P2・P3・P4・P5・P6・P7・P8・P9・P10・P11・P12・P13 |
| T06 | `pdf/t06-a-dc-creator.pdf` | 隠しあり | XMP の dc:creator に個人名 | P2 |
| T06 | `pdf/t06-b-history.pdf` | 隠しあり | XMP の xmpMM:History に、編集した人の名前と保存の記録 | P2 |
| T06 | `pdf/t06-ctl-tool-only.pdf` | 対照 | XMP に作成ソフトと日付だけ | 出てはいけない：すべて |
| T07 | `pdf/t07-a-flate-xmp.pdf` | 隠しあり | Flate で圧縮した XMP の dc:creator に個人名 | P2 |
| T07 | `pdf/t07-ctl-flate-tool.pdf` | 対照 | Flate で圧縮した XMP に作成ソフトだけ | 出てはいけない：すべて |
| T08 | `pdf/t08-a-image-xmp.pdf` | 隠しあり | 画像に付いた XMP の dc:creator に個人名 | P2 |
| T08 | `pdf/t08-b-form-xmp.pdf` | 隠しあり | 部品（Form XObject）に付いた XMP の履歴に、元のファイルのパス | P2・P4 |
| T08 | `pdf/t08-ctl-image-xmp-format.pdf` | 対照 | 画像に付いた XMP に、画像の形式と大きさだけ | 出てはいけない：すべて |
| T09 | `pdf/t09-a-page-pieceinfo.pdf` | 隠しあり | ページの /PieceInfo に、編集用データ（利用者名・パス入り） | P2・P4 |
| T09 | `pdf/t09-b-catalog-pieceinfo.pdf` | 隠しあり | 文書の /PieceInfo に、アプリの私的データ（人名入り） | P2・P4 |
| T09 | `pdf/t09-ctl-pieceinfo-date.pdf` | 対照 | ページの /PieceInfo に、日付だけ（私的データは空） | 出てはいけない：すべて |
| T11 | `pdf/t11-a-other-org-title.pdf` | 隠しあり | Title に別の架空の団体名。本文は別の架空の団体 | P3（確認） |
| T11 | `pdf/t11-ctl-same-org.pdf` | 対照 | Title と本文が同じ架空の団体名。題を P1 として出すのはよい | 出てはいけない：P2・P3・P4・P5・P6・P7・P8・P9・P10・P11・P12・P13 |
| T12 | `pdf/t12-a-path-in-title.pdf` | 隠しあり | Title に C:\Users\… のパス | P4 |
| T12 | `pdf/t12-b-unc-in-xmp.pdf` | 隠しあり | XMP の DerivedFrom に \\サーバー\… のパス | P4 |
| T12 | `pdf/t12-ctl-slashes.pdf` | 対照 | Title に、パスでない記号（2026/2027・A:B・3\4）。題を P1 として出すのはよい | 出てはいけない：P2・P3・P4・P5・P6・P7・P8・P9・P10・P11・P12・P13 |
| T13 | `pdf/t13-a-unc-in-body.pdf` | 隠しあり | 本文の見える字に \\サーバー\… のパス | P4 |
| T13 | `pdf/t13-b-path-in-annot.pdf` | 隠しあり | 付箋の注釈の中身に C:\Users\… のパス | P4 |
| T13 | `pdf/t13-c-file-link.pdf` | 隠しあり | リンクの行き先が file:///C:/Users/… | P4 |
| T13 | `pdf/t13-ctl-web-link.pdf` | 対照 | 本文に「A/B」「C\D」、リンクは https の公開の場所 | 出てはいけない：すべて |
| T14 | `pdf/t14-a-incremental.pdf` | 隠しあり | 増分更新で、ページの中身（金額と名前）を差し替えた。前の版が残る | P5 |
| T14 | `pdf/t14-b-incremental-xrefstm.pdf` | 隠しあり | xref ストリームの文書に、xref ストリームで増分更新（前の版が残る） | P5 |
| T14 | `pdf/t14-ctl-added-page.pdf` | 対照 | 増分更新でページを1枚足しただけ（前の版の中身は今の版にもある） | 出てはいけない：P5・P6・P7・P1・P9 |
| T15 | `pdf/t15-a-after-eof.pdf` | 隠しあり | %%EOF のあとに、xref に載らないオブジェクト（古い字） | P5 |
| T15 | `pdf/t15-ctl-trailing-space.pdf` | 対照 | %%EOF のあとに、改行と空白だけ | 出てはいけない：すべて |
| T16 | `pdf/t16-a-orphan-stream.pdf` | 隠しあり | どこからも指されていない、字を描く中身のストリーム（xref には載る） | P5 |
| T16 | `pdf/t16-b-orphan-flate.pdf` | 隠しあり | どこからも指されていない、Flate で圧縮した中身のストリーム | P5 |
| T16 | `pdf/t16-ctl-free-entries.pdf` | 対照 | xref に空き（f）の番号があるだけ | 出てはいけない：すべて |
| T17 | `pdf/t17-a-detached-page.pdf` | 隠しあり | ページの木から外したページ（オブジェクトは残る） | P5 |
| T17 | `pdf/t17-ctl-two-pages.pdf` | 対照 | 2ページとも木にある | 出てはいけない：すべて |
| T18 | `pdf/t18-a-objstm-orphan.pdf` | 隠しあり | オブジェクトストリームの中に、どこからも指されていない辞書（古い字） | P5 |
| T18 | `pdf/t18-ctl-objstm-all-used.pdf` | 対照 | オブジェクトストリームの中は、すべて指されている | 出てはいけない：すべて |
| T19 | `pdf/t19-a-unused-form.pdf` | 隠しあり | ページの資源にあるが Do で描かれない部品（字が入っている） | P5 |
| T19 | `pdf/t19-ctl-used-form.pdf` | 対照 | 部品を Do で描いている | 出てはいけない：すべて |
| T20 | `pdf/t20-a-old-thumb.pdf` | 隠しあり | ページの縮小画像に、今のページにない字の模様（前のページ） | P5 |
| T20 | `pdf/t20-ctl-same-thumb.pdf` | 対照 | 縮小画像が、今のページ（スキャンの画像）を縮めたもの | 出てはいけない：すべて |
| T22 | `pdf/t22-a-old-phone.pdf` | 隠しあり | 前の版のページに電話番号と名前。新しい版では消した | P5 |
| T22 | `pdf/t22-ctl-old-date-only.pdf` | 対照 | 前の版と今の版の違いは日付だけ（個人情報なし）。前の版があること（P5）は出てよい | 出てはいけない：P1・P2・P3・P4・P6・P7・P8・P9・P10・P11・P12 |
| T23 | `pdf/t23-a-black-rect.pdf` | 隠しあり | 字の上に黒い四角（rg・re f） | P6 |
| T23 | `pdf/t23-b-path-rect.pdf` | 隠しあり | 字の上に黒い四角（m・l の道で描く） | P6 |
| T23 | `pdf/t23-c-tj-kerning.pdf` | 隠しあり | TJ の字送りつきの字の上に黒い四角 | P6 |
| T23 | `pdf/t23-ctl-bar-apart.pdf` | 対照 | 黒い帯があるが、字とは離れている | 出てはいけない：すべて |
| T24 | `pdf/t24-a-cmyk-k.pdf` | 隠しあり | CMYK の黒（0 0 0 1 k）の四角 | P6 |
| T24 | `pdf/t24-b-dark-navy.pdf` | 隠しあり | ごく濃い紺（0.1 0.1 0.2 rg）の四角 | P6 |
| T24 | `pdf/t24-c-rich-black.pdf` | 隠しあり | CMYK のリッチブラック（0.6 0.5 0.5 1 k） | P6 |
| T24 | `pdf/t24-ctl-dark-adjacent.pdf` | 対照 | 濃い色の四角が、字のすぐ右（重ならない） | 出てはいけない：すべて |
| T25 | `pdf/t25-a-cid.pdf` | 隠しあり | 日本語（CID 書体）の字の上に黒い四角 | P6 |
| T25 | `pdf/t25-b-cid-partial.pdf` | 隠しあり | 日本語の字の並びの後ろ半分だけに黒い四角 | P6 |
| T25 | `pdf/t25-ctl-cid-underline.pdf` | 対照 | 日本語の字の下に、細い黒い下線 | 出てはいけない：すべて |
| T26 | `pdf/t26-a-ellipse.pdf` | 隠しあり | 字の上に黒い楕円 | P6 |
| T26 | `pdf/t26-b-rotated.pdf` | 隠しあり | 字の上に、cm で少し回した黒い四角 | P6 |
| T26 | `pdf/t26-c-thick-line.pdf` | 隠しあり | 字の上に、太さ 16 の黒い線 | P6 |
| T26 | `pdf/t26-ctl-frame.pdf` | 対照 | 字を、細い黒い枠（線 1、塗りなし）で囲む | 出てはいけない：すべて |
| T27 | `pdf/t27-a-black-image.pdf` | 隠しあり | 字の上に黒い画像（Flate）を貼る | P6 |
| T27 | `pdf/t27-b-black-jpeg.pdf` | 隠しあり | 字の上に黒い画像（JPEG）を貼る | P6 |
| T27 | `pdf/t27-ctl-image-beside.pdf` | 対照 | 黒い画像が、字の横（重ならない） | 出てはいけない：すべて |
| T28 | `pdf/t28-a-square-ap.pdf` | 隠しあり | 字の上に、黒く塗った Square の注釈（見た目あり） | P6 |
| T28 | `pdf/t28-b-square-noap.pdf` | 隠しあり | 字の上に、塗りの色が黒の Square の注釈（見た目なし） | P6 |
| T28 | `pdf/t28-ctl-square-border.pdf` | 対照 | 字を、枠だけの Square の注釈で囲む（塗りなし） | 出てはいけない：P6・P7・P5・P1 |
| T29 | `pdf/t29-a-redact-annot.pdf` | 隠しあり | 字の上に、まだ適用していない墨消し注釈 | P6 |
| T29 | `pdf/t29-ctl-redact-empty.pdf` | 対照 | 字のない所に、未適用の墨消し注釈 | 出てはいけない：すべて |
| T30 | `pdf/t30-a-band-same-gray.pdf` | 隠しあり | 濃い灰の帯を先に描き、その上に同じ灰の字 | P6・P7 |
| T30 | `pdf/t30-b-band-black.pdf` | 隠しあり | 黒い帯を先に描き、その上に黒い字 | P6・P7 |
| T30 | `pdf/t30-ctl-band-white-text.pdf` | 対照 | 濃い灰の帯の上に白い字（読める） | 出てはいけない：すべて |
| T31 | `pdf/t31-a-white-rect.pdf` | 隠しあり | 字の上に白い四角（白で消したつもり） | P6 |
| T31 | `pdf/t31-ctl-white-blank.pdf` | 対照 | 字のない所に白い四角 | 出てはいけない：すべて |
| T32 | `pdf/t32-a-gray.pdf` | 隠しあり | 字の上に不透明な灰の四角 | P6 |
| T32 | `pdf/t32-b-red.pdf` | 隠しあり | 字の上に不透明な赤の四角 | P6 |
| T32 | `pdf/t32-c-blue.pdf` | 隠しあり | 字の上に不透明な青の四角 | P6 |
| T32 | `pdf/t32-ctl-color-under.pdf` | 対照 | 色の四角を先に描き、その上に字（読める） | 出てはいけない：すべて |
| T33 | `pdf/t33-a-dark-alpha.pdf` | 隠しあり | 字の上に、不透明さ 0.95 の黒い四角 | P6 |
| T33 | `pdf/t33-b-black-highlight.pdf` | 隠しあり | 字の上に、黒い蛍光ペン（Highlight の注釈、色は黒） | P6 |
| T33 | `pdf/t33-ctl-yellow-alpha.pdf` | 対照 | 字の上に、不透明さ 0.35 の黄色の四角（読める） | 出てはいけない：すべて |
| T34 | `pdf/t34-a-white-square-annot.pdf` | 隠しあり | 字の上に、白く塗った Square の注釈 | P6 |
| T34 | `pdf/t34-ctl-white-annot-blank.pdf` | 対照 | 字のない所に、白く塗った Square の注釈 | 出てはいけない：すべて |
| T35 | `pdf/t35-a-middle-word.pdf` | 隠しあり | 行の真ん中の1語だけを黒い四角で覆う | P6 |
| T35 | `pdf/t35-b-half-chars.pdf` | 隠しあり | 語の後ろ半分の字だけを覆う | P6 |
| T35 | `pdf/t35-ctl-after-line.pdf` | 対照 | 行の終わりのすぐ後ろ（字のない所）に黒い四角 | 出てはいけない：すべて |
| T36 | `pdf/t36-a-text-in-form.pdf` | 隠しあり | 部品の中の字を、ページの黒い四角で覆う | P6 |
| T36 | `pdf/t36-b-cover-in-form.pdf` | 隠しあり | ページの字を、部品の中の黒い四角で覆う | P6 |
| T36 | `pdf/t36-ctl-form-apart.pdf` | 対照 | 部品の中に字、黒い四角は離れた所 | 出てはいけない：すべて |
| T37 | `pdf/t37-a-white-then-text.pdf` | 隠しあり | 隠したい字の上に白い四角、その上に別の見える字 | P6 |
| T37 | `pdf/t37-b-black-then-label.pdf` | 隠しあり | 黒い四角の上に、白い字で「REDACTED」 | P6 |
| T37 | `pdf/t37-ctl-label-box.pdf` | 対照 | 白い札の上に字（札の下には何もない） | 出てはいけない：すべて |
| T38 | `pdf/t38-a-vertical.pdf` | 隠しあり | 縦書き（Identity-V）の日本語の字の上に黒い四角 | P6 |
| T38 | `pdf/t38-ctl-vertical-beside.pdf` | 対照 | 縦書きの字の横に黒い四角（重ならない） | 出てはいけない：すべて |
| T39 | `pdf/t39-a-scan-ocr-cover.pdf` | 隠しあり | スキャン画像＋見えない文字認識の層、その上に黒い四角 | P6 |
| T39 | `pdf/t39-b-scan-ocr-cover-form.pdf` | 隠しあり | スキャン＋文字認識の層、覆いは部品の中の黒い四角 | P6 |
| T39 | `pdf/t39-ctl-scan-ocr-beside.pdf` | 対照 | スキャン＋文字認識の層。黒い四角は画像の外 | 出てはいけない：P6 |
| T40 | `pdf/t40-a-scan-cover.pdf` | 隠しあり | スキャン画像の上に黒い四角（文字の層なし） | P6 |
| T40 | `pdf/t40-ctl-scan-burned.pdf` | 対照 | スキャン画像の覆う所が、画素ごと黒く塗ってある（正しい墨消し）＋黒い四角 | 出てはいけない：すべて |
| T41 | `pdf/t41-a-scan-square.pdf` | 隠しあり | スキャン画像の上に、黒い Square の注釈 | P6 |
| T41 | `pdf/t41-ctl-scan-burned-square.pdf` | 対照 | 画素ごと黒く塗ったスキャン＋その上の黒い Square の注釈 | 出てはいけない：すべて |
| T42 | `pdf/t42-a-scan-redact.pdf` | 隠しあり | スキャン画像の上に、未適用の墨消し注釈 | P6 |
| T42 | `pdf/t42-ctl-scan-applied.pdf` | 対照 | 墨消しを適用したあと（画素は黒、黒い四角をページに描いた） | 出てはいけない：すべて |
| T43 | `pdf/t43-a-image-white-rect.pdf` | 隠しあり | 画像（字の模様あり）の上に白い四角 | P6 |
| T43 | `pdf/t43-ctl-white-margin.pdf` | 対照 | 画像の外（余白）に白い四角 | 出てはいけない：すべて |
| T44 | `pdf/t44-a-photo-over-text.pdf` | 隠しあり | 字を描いたあと、明るい写真（JPEG）をその上に置く | P6・P7 |
| T44 | `pdf/t44-b-light-gray-image.pdf` | 隠しあり | 字を描いたあと、明るい灰の画像（Flate）で覆う | P6・P7 |
| T44 | `pdf/t44-ctl-caption-on-photo.pdf` | 対照 | 写真を置いたあと、その上に見える字（説明） | 出てはいけない：すべて |
| T45 | `pdf/t45-a-white-gray.pdf` | 隠しあり | 白い紙に白い字（1 g） | P7 |
| T45 | `pdf/t45-b-white-cmyk.pdf` | 隠しあり | 白い紙に白い字（0 0 0 0 k） | P7 |
| T45 | `pdf/t45-ctl-white-on-band.pdf` | 対照 | 黒い帯の上の白い字（読める） | 出てはいけない：すべて |
| T46 | `pdf/t46-a-blue-on-blue.pdf` | 隠しあり | 青い四角の上に、同じ青の字 | P7 |
| T46 | `pdf/t46-ctl-yellow-on-blue.pdf` | 対照 | 青い四角の上に、黄色の字（読める） | 出てはいけない：すべて |
| T47 | `pdf/t47-a-very-light-gray.pdf` | 隠しあり | ごく薄い灰の字（0.97 g） | P7 |
| T47 | `pdf/t47-b-very-light-rgb.pdf` | 隠しあり | ごく薄い色の字（0.96 0.97 0.98 rg） | P7 |
| T47 | `pdf/t47-ctl-gray-footer.pdf` | 対照 | 薄めの灰（0.6 g）の字（読める注記） | 出てはいけない：すべて |
| T48 | `pdf/t48-a-tr3.pdf` | 隠しあり | 描画モード 3（描かない）の字。画像の上ではない | P7 |
| T48 | `pdf/t48-b-tr7.pdf` | 隠しあり | 描画モード 7（切り抜きに足すだけ）の字 | P7 |
| T48 | `pdf/t48-ctl-tr2.pdf` | 対照 | 描画モード 2（塗りと線）の字（読める） | 出てはいけない：すべて |
| T49 | `pdf/t49-a-alpha0.pdf` | 隠しあり | 不透明さ 0 の字 | P7 |
| T49 | `pdf/t49-b-alpha002.pdf` | 隠しあり | 不透明さ 0.02 の字 | P7 |
| T49 | `pdf/t49-ctl-alpha05.pdf` | 対照 | 不透明さ 0.5 の字（読める） | 出てはいけない：すべて |
| T50 | `pdf/t50-a-size05.pdf` | 隠しあり | 大きさ 0.5pt の字 | P7 |
| T50 | `pdf/t50-b-size01.pdf` | 隠しあり | 大きさ 0.1pt の字 | P7 |
| T50 | `pdf/t50-ctl-size4.pdf` | 対照 | 大きさ 4pt の字（細かい注記） | 出てはいけない：すべて |
| T51 | `pdf/t51-a-tm-shrink.pdf` | 隠しあり | Tf は 12、Tm で 0.01 倍に縮めた字 | P7 |
| T51 | `pdf/t51-b-cm-shrink.pdf` | 隠しあり | cm で 0.02 倍に縮めた所に置いた字 | P7 |
| T51 | `pdf/t51-ctl-tm-large.pdf` | 対照 | Tm で 2 倍に広げた字（大きな見出し） | 出てはいけない：すべて |
| T52 | `pdf/t52-a-tz0.pdf` | 隠しあり | 横の伸縮 0%（Tz 0）の字 | P7 |
| T52 | `pdf/t52-b-tz1.pdf` | 隠しあり | 横の伸縮 1%（Tz 1）の字 | P7 |
| T52 | `pdf/t52-ctl-tz80.pdf` | 対照 | 横の伸縮 80%（長体）の字 | 出てはいけない：すべて |
| T53 | `pdf/t53-a-left-out.pdf` | 隠しあり | ページの左の外（x = -500）の字 | P7 |
| T53 | `pdf/t53-b-top-out.pdf` | 隠しあり | ページの上の外（y = 2000）の字 | P7 |
| T53 | `pdf/t53-ctl-near-edge.pdf` | 対照 | ページの端のすぐ内側の字 | 出てはいけない：すべて |
| T54 | `pdf/t54-a-outside-crop.pdf` | 隠しあり | MediaBox の中、CropBox の外の字 | P7 |
| T54 | `pdf/t54-ctl-inside-crop.pdf` | 対照 | CropBox のすぐ内側の字 | 出てはいけない：すべて |
| T55 | `pdf/t55-a-outside-clip.pdf` | 隠しあり | 切り抜き（W n）の外に置いた字 | P7 |
| T55 | `pdf/t55-ctl-inside-clip.pdf` | 対照 | 切り抜きの内側の字 | 出てはいけない：すべて |
| T56 | `pdf/t56-a-ocg-off.pdf` | 隠しあり | 最初から表示しないレイヤーの字 | P7 |
| T56 | `pdf/t56-ctl-ocg-on.pdf` | 対照 | 表示するレイヤーの字 | 出てはいけない：すべて |
| T57 | `pdf/t57-a-white-outline.pdf` | 隠しあり | 輪郭だけ（Tr 1）の白い字 | P7 |
| T57 | `pdf/t57-ctl-black-outline.pdf` | 対照 | 輪郭だけ（Tr 1）の黒い字（読める） | 出てはいけない：すべて |
| T58 | `pdf/t58-a-white-per-char.pdf` | 隠しあり | 1文字ずつ別の BT・ET で置いた白い字（1件にまとめてほしい） | P7 |
| T58 | `pdf/t58-ctl-black-per-char.pdf` | 対照 | 1文字ずつ別の命令で置いた黒い字（読める） | 出てはいけない：すべて |
| T59 | `pdf/t59-a-flate-white.pdf` | 隠しあり | Flate で圧縮したページの中身に白い字 | P7 |
| T59 | `pdf/t59-b-objstm-white.pdf` | 隠しあり | オブジェクトストリームと xref ストリームの文書、圧縮した中身に白い字 | P7 |
| T59 | `pdf/t59-ctl-flate-normal.pdf` | 対照 | Flate で圧縮した普通の黒い字 | 出てはいけない：すべて |
| T60 | `pdf/t60-a-overprint.pdf` | 隠しあり | 同じ所に違う字を2つ重ねて描く | P7 |
| T60 | `pdf/t60-ctl-bold-double.pdf` | 対照 | 同じ字を 0.3pt ずらして2度描く（太字） | 出てはいけない：すべて |
| T61 | `pdf/t61-a-same-color-on-image.pdf` | 隠しあり | 青い画像の上に、画像と同じ青の字 | P7 |
| T61 | `pdf/t61-ctl-white-on-image.pdf` | 対照 | 青い画像の上に白い字（読める） | 出てはいけない：すべて |
| T62 | `pdf/t62-n-ocr-layer.pdf` | お知らせ | スキャン画像の上に、見えない文字認識の層（知らせてほしい） | P7 |
| T62 | `pdf/t62-ctl-plain-text.pdf` | 対照 | 画像なしの普通の字だけ | 出てはいけない：すべて |
| T63 | `pdf/t63-a-outline-name.pdf` | 隠しあり | しおりの題に、本文にない名前と電話番号 | P7（確認） |
| T63 | `pdf/t63-ctl-outline-headings.pdf` | 対照 | しおりの題が、本文の見出しと同じ | 出てはいけない：すべて |
| T64 | `pdf/t64-a-actualtext-differs.pdf` | 隠しあり | 見える字と違う /ActualText | P7 |
| T64 | `pdf/t64-ctl-actualtext-same.pdf` | 対照 | 見える字と同じ /ActualText | 出てはいけない：すべて |
| T65 | `pdf/t65-a-alt-name.pdf` | 隠しあり | 図の代わりの説明 /Alt に、本文にない名前と住所 | P7（確認） |
| T65 | `pdf/t65-ctl-alt-caption.pdf` | 対照 | /Alt が、図の見える説明と同じ | 出てはいけない：すべて |
| T66 | `pdf/t66-a-tooltip.pdf` | 隠しあり | フォームの欄の説明（/TU）に、架空の個人名 | P7・P11（確認） |
| T66 | `pdf/t66-b-struct-t-e.pdf` | 隠しあり | 構造要素の題（/T）と略語の展開（/E）に、架空の個人名 | P7（確認） |
| T66 | `pdf/t66-ctl-tooltip-generic.pdf` | 対照 | 欄の説明が「Enter your name」 | 出てはいけない：すべて |
| T67 | `pdf/t67-a-zero-width-tag.pdf` | 隠しあり | 見える字の間に、幅 0 の字とタグ文字（U+E0000 台） | P7 |
| T67 | `pdf/t67-b-bidi.pdf` | 隠しあり | 向きの制御（U+202E）で字の並びを逆に見せる | P7 |
| T67 | `pdf/t67-c-c1-control.pdf` | 隠しあり | 字の中に C1 制御文字（U+0085・U+009B） | P7 |
| T67 | `pdf/t67-ctl-ideographic-space.pdf` | 対照 | 全角の空白（U+3000）と普通の日本語 | 出てはいけない：すべて |
| T68 | `pdf/t68-a-tounicode-swap.pdf` | 隠しあり | 見える字は「Approved」、ToUnicode では別の字（目印） | P7 |
| T68 | `pdf/t68-ctl-tounicode-same.pdf` | 対照 | ToUnicode が、見える字と同じ | 出てはいけない：すべて |
| T69 | `pdf/t69-a-unused-glyphs.pdf` | 隠しあり | 黒い四角の下の字は消したが、書体（Type3）にその字の字形が残る | P6・P7・P5 |
| T69 | `pdf/t69-ctl-used-glyphs.pdf` | 対照 | 書体（Type3）の字形が、すべてページで使われている | 出てはいけない：すべて |
| T70 | `pdf/t70-a-white-prompt.pdf` | 隠しあり | 白い小さな字で、AI への隠れた指示文 | P7 |
| T70 | `pdf/t70-b-tr3-prompt.pdf` | 隠しあり | 描かない字（Tr 3）で、AI への隠れた指示文 | P7 |
| T70 | `pdf/t70-ctl-visible-instructions.pdf` | 対照 | 見える字で「instructions」を含む普通の説明 | 出てはいけない：すべて |
| T71 | `pdf/t71-a-annot-author.pdf` | 隠しあり | 付箋の注釈の作成者名（/T）に、架空の個人名 | P8 |
| T71 | `pdf/t71-ctl-link-only.pdf` | 対照 | ページの中を指すリンクの注釈だけ（作成者名なし） | 出てはいけない：すべて |
| T72 | `pdf/t72-a-contents.pdf` | 隠しあり | 付箋の注釈の中身（/Contents）に、校閲のコメント | P8 |
| T72 | `pdf/t72-b-rc-subj.pdf` | 隠しあり | FreeText の注釈の /RC（リッチテキスト）と件名（/Subj） | P8 |
| T72 | `pdf/t72-ctl-link-only.pdf` | 対照 | リンクの注釈だけ | 出てはいけない：すべて |
| T73 | `pdf/t73-a-hidden-flag.pdf` | 隠しあり | 隠し（Hidden、/F 2）の印の付箋の注釈 | P8 |
| T73 | `pdf/t73-b-noview-flag.pdf` | 隠しあり | NoView（/F 32）の印の FreeText の注釈 | P8 |
| T73 | `pdf/t73-ctl-print-link.pdf` | 対照 | 印刷する印（/F 4）のリンクの注釈だけ | 出てはいけない：すべて |
| T74 | `pdf/t74-a-ap-text.pdf` | 隠しあり | スタンプの注釈の見た目（/AP）の中だけに字（/Contents なし） | P8・P7 |
| T74 | `pdf/t74-ctl-ap-shapes.pdf` | 対照 | スタンプの注釈の見た目が、図形だけ | 出てはいけない：P7・P6・P5 |
| T75 | `pdf/t75-a-names-tree.pdf` | 隠しあり | 名前の木（/EmbeddedFiles）の添付ファイル | P9 |
| T75 | `pdf/t75-b-annot.pdf` | 隠しあり | 添付ファイルの注釈（FileAttachment） | P9 |
| T75 | `pdf/t75-c-af.pdf` | 隠しあり | 文書の /AF（関連ファイル）だけで指す添付 | P9 |
| T75 | `pdf/t75-ctl-dests-only.pdf` | 対照 | 名前の木はあるが、名前つきの行き先（/Dests）だけ | 出てはいけない：すべて |
| T76 | `pdf/t76-a-orphan-attachment.pdf` | 隠しあり | どこからも指されていない添付ファイル（Filespec と中身） | P9・P5 |
| T76 | `pdf/t76-ctl-orphan-null.pdf` | 対照 | どこからも指されていない null のオブジェクトだけ | 出てはいけない：すべて |
| T77 | `pdf/t77-a-attached-pdf.pdf` | 隠しあり | 添付の PDF の中に、作成者名と白い字 | P1・P7 |
| T77 | `pdf/t77-b-attached-text.pdf` | 隠しあり | 添付の文字のファイルに、架空の名前と電話番号 | P9 |
| T77 | `pdf/t77-ctl-attached-clean-pdf.pdf` | 対照 | 添付の PDF の中は、隠しなし（添付そのものは出てよい） | 出てはいけない：P1・P7・P6・P5 |
| T78 | `pdf/t78-a-gps.pdf` | 隠しあり | PDF の中の写真（JPEG）の EXIF に位置情報 | P10 |
| T78 | `pdf/t78-ctl-no-exif.pdf` | 対照 | EXIF のない写真 | 出てはいけない：すべて |
| T79 | `pdf/t79-a-camera.pdf` | 隠しあり | 写真の EXIF に機種・撮影者・ソフト・撮影日時 | P10 |
| T79 | `pdf/t79-ctl-orientation-only.pdf` | 対照 | 写真の EXIF に向きと解像度だけ | 出てはいけない：すべて |
| T80 | `pdf/t80-a-exif-thumb.pdf` | 隠しあり | 写真の EXIF に、切る前・塗る前の縮小画像 | P10 |
| T80 | `pdf/t80-ctl-exif-no-thumb.pdf` | 対照 | 写真の EXIF に縮小画像なし（向きだけ） | 出てはいけない：すべて |
| T82 | `pdf/t82-a-image-off-page.pdf` | 隠しあり | ページの外（右）に置いた画像 | P7・P10・P5・P6 |
| T82 | `pdf/t82-ctl-image-on-page.pdf` | 対照 | ページの中に置いた画像 | 出てはいけない：すべて |
| T83 | `pdf/t83-a-clip-most.pdf` | 隠しあり | 切り抜きで、画像の大部分（字の模様の所）を隠した | P7・P10・P5・P6 |
| T83 | `pdf/t83-ctl-clip-margin.pdf` | 対照 | 切り抜きで、画像のふちを少し落としただけ | 出てはいけない：すべて |
| T84 | `pdf/t84-a-field-value.pdf` | 隠しあり | フォームの欄に値（架空の名前）が入ったまま | P11 |
| T84 | `pdf/t84-ctl-field-empty.pdf` | 対照 | フォームの欄が空 | 出てはいけない：すべて |
| T85 | `pdf/t85-a-no-widget.pdf` | 隠しあり | ウィジェットの無い欄（ページに出ない）に値 | P11 |
| T85 | `pdf/t85-b-hidden-widget.pdf` | 隠しあり | 隠した（/F 2）ウィジェットの欄に値 | P11 |
| T85 | `pdf/t85-ctl-hidden-empty.pdf` | 対照 | 隠したウィジェットの欄が空 | 出てはいけない：すべて |
| T86 | `pdf/t86-n-xfa.pdf` | お知らせ | AcroForm に XFA のフォーム（中に架空の名前） | P11 |
| T86 | `pdf/t86-ctl-acroform-only.pdf` | 対照 | XFA のない AcroForm（欄は空） | 出てはいけない：すべて |
| T87 | `pdf/t87-a-doc-js.pdf` | 隠しあり | 名前の木の文書の JavaScript | P12（確認） |
| T87 | `pdf/t87-ctl-goto-open.pdf` | 対照 | 開いたときの動作が、1ページめへの移動（GoTo）だけ | 出てはいけない：すべて |
| T88 | `pdf/t88-a-launch.pdf` | 隠しあり | 開いたときの動作で、外のプログラムを起動（Launch） | P12（確認） |
| T88 | `pdf/t88-b-page-aa-js.pdf` | 隠しあり | ページを開いたとき（/AA /O）の JavaScript | P12（確認） |
| T88 | `pdf/t88-c-openaction-js.pdf` | 隠しあり | 開いたときの動作（/OpenAction）の JavaScript | P12（確認） |
| T88 | `pdf/t88-ctl-goto.pdf` | 対照 | 開いたときの動作が GoTo だけ | 出てはいけない：すべて |
| T89 | `pdf/t89-a-uri.pdf` | 隠しあり | URL を開くリンク（外の場所） | P12（確認） |
| T89 | `pdf/t89-b-submit.pdf` | 隠しあり | フォームの送信先（SubmitForm） | P12・P11（確認） |
| T89 | `pdf/t89-ctl-goto-link.pdf` | 対照 | ページの中への移動のリンクだけ | 出てはいけない：すべて |
| T90 | `pdf/t90-a-empty-pw.pdf` | 隠しあり | パスワードなしで開ける暗号化（RC4 128bit）。中に作成者名と白い字 | P1・P7 |
| T90 | `pdf/t90-ctl-empty-pw-clean.pdf` | 対照 | パスワードなしで開ける暗号化。中に隠しなし（お知らせは出てよい） | 出てはいけない：すべて |
| T91 | `pdf/t91-u-user-pw.pdf` | 調べられない | 開くのにパスワードが要る暗号化（「調べられない」と出てほしい） | 調べられない |
| T91 | `pdf/t91-ctl-plain.pdf` | 対照 | 暗号化していない普通の文書 | 出てはいけない：すべて |
| T92 | `pdf/t92-n-signature.pdf` | お知らせ | 電子署名の欄に、署名者名（/Name） | P1・P11 |
| T92 | `pdf/t92-ctl-empty-sig-field.pdf` | 対照 | 署名していない、空の署名の欄 | 出てはいけない：すべて |
| T94 | `pdf/t94-n-c2pa.pdf` | お知らせ | C2PA の来歴の情報（関連ファイル /AF、C2PA_Manifest） | P2・P9 |
| T94 | `pdf/t94-ctl-no-c2pa.pdf` | 対照 | 来歴の情報なし | 出てはいけない：すべて |
| T95 | `pdf/t95-a-name-phone.pdf` | 隠しあり | 見える字に、日本語の氏名と携帯電話の番号 | 型を問わない |
| T95 | `pdf/t95-b-mynumber.pdf` | 隠しあり | 見える字に、架空の個人番号（12桁） | 型を問わない |
| T95 | `pdf/t95-c-email.pdf` | 隠しあり | 見える字に、個人のメールアドレス | 型を問わない |
| T95 | `pdf/t95-ctl-doc-number.pdf` | 対照 | 見える字に、文書番号と日付と課の名前だけ | 出てはいけない：すべて |
| F01 | `pdf/f01-ctl-hybrid.pdf` | 対照 | 普通の xref 表と /XRefStm の両方を持つ（Word の形）。版は1つ | 出てはいけない：すべて |
| F02 | `pdf/f02-ctl-white-heading.pdf` | 対照 | 黒い帯の上の白い見出し | 出てはいけない：すべて |
| F02 | `pdf/f02-ctl-white-heading-cmyk.pdf` | 対照 | CMYK の濃い帯の上の白い見出し（0 0 0 0 k） | 出てはいけない：すべて |
| F03 | `pdf/f03-ctl-dates-numbers.pdf` | 対照 | 作成日・文書番号の数字の並び（16桁・14桁） | 出てはいけない：すべて |
| F04 | `pdf/f04-ctl-burned-scan-unused-font.pdf` | 対照 | 正しく墨消ししたスキャン。使われていない書体の部品が残る | 出てはいけない：すべて |
| F05 | `pdf/f05-ctl-stroke-visible-fill-clear.pdf` | 対照 | 輪郭は見える（線は不透明）、塗りだけ透明（ca 0）の字 | 出てはいけない：すべて |
| F06 | `pdf/f06-ctl-redraw-on-band.pdf` | 対照 | 字を描き、帯で覆い、その上に同じ字を同じ所に描き直す | 出てはいけない：すべて |
| F07 | `pdf/f07-ctl-bold-double.pdf` | 対照 | 太字のための2度描き（0.4pt ずらし） | 出てはいけない：すべて |
| F07 | `pdf/f07-ctl-ligature.pdf` | 対照 | 合字（fi）を1字で描き、ActualText で fi と書く | 出てはいけない：すべて |
| F07 | `pdf/f07-ctl-plain-actualtext.pdf` | 対照 | 見える字と同じ ActualText（数字の読み） | 出てはいけない：すべて |

## 作らなかった型

| 型 | 理由 |
|---|---|
| T10 | 予定が「外」 |
| T93 | 予定が「外」 |
| T96 | 予定が「外」 |
| T99 | 予定が「外」（PDF でもない） |
| T97 | PDF でない（写真のファイル）。この集は PDF の型だけ |
| T98 | PDF でない（Office のファイル）。この集は PDF の型だけ |
| T21 | 画面の機能（押したときだけ前の版の字を見せる）で、PDF の型ではない。RULES の結果には中身を入れない決まりなので、結果から合否を決められない。案：画面のテストで、T14 の PDF を入れて「見せる」を押したときだけ字の数が出ることを見る |
| T81 | 電子小黒板の情報が写真のどこに、どの形で入るか（EXIF の独自の欄か、XMP か、別の区画か）が説明だけでは決まらない。案：仕様の一次情報を本人が確かめ、その形の架空の値を JPEG に入れて T79 と同じ作りで足す |
