# 片付け（sanitize/）

見つかった危ない所を、**ブラウザの中で**取り除いた PDF を作る。通信はしない。Node でも同じコードが動く（採点・テスト用）。

```ts
import { sanitizePdf } from "../sanitize/index.ts";
const r = await sanitizePdf(bytes, { codec });   // bytes: Uint8Array（利用者の PDF）。codec は画像の道具（JPEG・CCITT・JBIG2 を解く。下の「画面へのつなぎ方」。なくても動く）
if (r.status === "ok") {
  r.bytes;    // 片付けた PDF
  r.removed;  // 取り除いた項目の一覧（画面の「証明」に使う）
  r.notDone;  // 片付けられなかった所（0 件でなければ「全部消えた」と言わない）
} else {
  r.code;     // "empty" | "unreadable" | "encrypted" | "too_large"
  r.message;  // 画面にそのまま出せる文
}
```

入出力の形は `types.ts`。取り出した字・名前・ファイル名などの**中身は、結果に入れない**（件数・場所・種類だけ）。

## 何を片付けるか

| 型 | 片付け方 | 見た目 |
|---|---|---|
| P6 見せかけの黒塗り（字） | 濃い覆い（塗り・太い線・濃い画像・注釈）に、字の箱の**半分以上**が隠れた字を、ページの命令から消す（検証器と同じ線。2026-11-03 人が決めた）。消した字は同じ幅の送り（`TJ` の数）に置き換えるので、残す字の位置は変わらない。文字認識の層（見えない字）も、濃い覆いの下なら消す | 変わらない（覆いは残す） |
| P6 見せかけの黒塗り（画像） | 画像のあとに描いた不透明な覆いの下の画素を塗った、新しい画像に差し替える（中心が覆いの中にある画素）。濃い覆いの下は黒く、**白など明るい覆い（明るさ 0.9 以上。注釈も、ページの中の白い四角も）の下は白く**塗る（2026-11-04 人が決めた。消しすぎの側：白い札の上に字を書いたものの下も塗る）。明るい覆いは画像を塗るときだけ使い、字の消し方には使わない。白い塗りは、白を重ねると白になる重ね方（`/BM` が Normal・Screen・Lighten・ColorDodge・HardLight・Luminosity）のときだけ覆いにする。Multiply など下が見えたままの重ね方のもの・半透明（不透明さ 0.5 以上 0.9 未満）のもの・表示しないレイヤーの中のものは、塗ると見た目が変わるので塗らず、画像の上にあれば `notDone`（`uncertain_cover`）にする。見た目を読めない注釈も、画像の上にあれば `uncertain_cover`。覆いが画像に縦横 1.5 画素以上重なるのに 1 画素も塗れなかったときも、黙らずに `notDone`（`unsupported_image`）にする（塗り損ねの安全網）。大きな Flate の画像（展開して 64MB 超）は、流しながら塗る。JPEG は、画像の道具を渡したときだけ、解いて塗って JPEG に書き直す（画質が少し落ちる。色は DeviceRGB になる）。CCITT（FAX 形式）・JBIG2 の白黒画像は、画像の道具に解く部品の置き場所（`wasmUrl`）を渡したときだけ、解いて塗って 1 ビットのまま Flate で書き直す（画質は変わらない）。画素の数が 7,200 万を超える画像は塗らない（`notDone`） | 覆いのふちが 1 画素ほど太ることがある（残り 0 件を優先する。2026-11-04 人が決めた）。覆いは上に残るので、塗った所は見えない |
| P6 未適用の墨消し注釈 | 下の字・画素を消し、黒い四角をページに描き込み、注釈を外す（2026-11-04 人が決めた） | 黒い四角が描かれる |
| P7 隠れたテキスト | 表示しないレイヤー・ページの外・切り抜きの外・描き方 3 と 7・不透明さ 0.1 未満・高さ 1pt 未満・白などの不透明な四角の下・地と同じ色の字を消す。画像の上の見えない字（文字認識の層）は残す | 変わらない |
| P1 文書情報 | Info 辞書を丸ごと消す（作成者などは書き換えずに消す。2026-11-03 人が決めた） | — |
| P2 XMP | `/Metadata` をすべて外す | — |
| P5 前の版 | 文書の根からたどれないものを捨て、1つの版として書き出す（`%%EOF` が1つ） | — |
| P8 コメントの注釈 | 付箋（Text）と吹き出し（Popup）の注釈を、まるごと外す（2026-11-04 人が決めた）。外した付箋への返信の指し先（`/IRT`）も外す | 付箋のアイコンが消える |
| P8 ほかの注釈の中身 | リンク・強調などの注釈は残し、コメント（`/Contents`・`/RC`）・作者名（`/T`）・件名・日時だけを消す | 変わらない |
| P9 添付ファイル | 名前の木の `/EmbeddedFiles`、添付ファイルの注釈、`/AF`、`/Collection` を外す。中身のストリームは、上の掃除でファイルから消える | 添付ファイルの注釈のアイコンが消える |
| P12 JavaScript | 名前の木の `/JavaScript`、JavaScript の動作（`/OpenAction`・`/A`・`/AA`・`/Next` の中）を外す | — |
| P7 字の読み替え（`/ActualText`） | 構造ツリーの要素・マーク付きの中身の属性の辞書・ページの中に直接書いたもの（`BDC` の辞書）から外す。構造ツリーそのもの・`/MCID`・`/Alt` は残す | 変わらない（コピー・検索で取れる字が、見えている字になる） |
| P5 ページの縮小画像（`/Thumb`） | ページから外す。画像はファイルから消える | ビューアーの縮小表示は、ページから作り直される |
| P2 アプリの独自データ（`/PieceInfo`） | 文書・ページ・部品から、対になる `/LastModified` と一緒に外す | 変わらない |

- パスワードなしで開ける暗号化は外して書き出す（`rules/shared/load.ts` で読む）。パスワードが要るものは `encrypted` を返し、片付けない。
- 圧縮の設定・パスワードをかける機能は、まだ入れていない（本人が決めてから）。

## 自分で黒塗りする（`redact`。0.5.0 から）

利用者がページの上で選んだ場所（または個人情報の候補から選んだ場所）を、**本当に消して**保存する。見た目に黒い四角を重ねるだけにはしない。

```ts
import { redact } from "../sanitize/index.ts";
import { rulesCheck } from "../sanitize/redact-check.ts";
const r = await redact(bytes, [{ page: 1, rect: [x0, y0, x1, y1] }], {
  codec,                                          // 画像の道具（sanitizePdf と同じ。JPEG・CCITT の画像を塗るのに要る）
  checks: [rulesCheck((b) => inspectAll(b))],     // 保存の前の読み直しに、作品の検査（全部のルール）を足す
});
if (r.status === "ok") r.bytes;                  // 保存してよい PDF
if (r.status === "blocked") r.leftovers;         // 読み直しで残りが見つかった。バイト列は返さない（保存させない）
if (r.status === "error") r.code;                // "bad_areas"（選んだ場所の形・ページが正しくない）など
```

- `rect` は `removed` の `rect` と同じ座標（ページの既定の座標。ポイント、左下が原点、`/Rotate` はかけない）。画面でページの絵の上を選んだら、絵の座標をこの座標に戻して渡す。
- 選んだ場所で消すもの：

| 何を | どう消すか | `removed` の `kind` |
|---|---|---|
| 字 | 字の箱が**少しでも**掛かる字を、1字まるごと消す（2026-11-05 人が決めた。見せかけの黒塗りの片付けの「半分以上」とは別の線）。消した字は同じ幅の送りになるので、残す字の位置は変わらない。縦書き（`Identity-V` など、`/WMode 1`）の字も、縦の箱で見る | `redacted_text`（場所ごと） |
| 画像の画素 | 中心が場所の中にある画素を黒く塗る（今の片付けの塗り方。JPEG・CCITT・JBIG2 は画像の道具を渡したときだけ）。画像に透明の型（`/SMask`）があれば、その所を不透明にする（型そのものに字や署名の形が残るため） | `redacted_pixels`（場所と画像ごと） |
| 注釈 | 場所に掛かる注釈を外す（付箋の吹き出しと、その持ち主も） | `redacted_annotation`（ページごと） |
| フォームの欄 | 見た目（Widget）が場所に掛かる欄を、欄ごと外す（値 `/V`・既定の値 `/DV` も消える）。XFA のフォームがあれば、XFA も外す。同じ欄の見た目がほかの所にも残るときは、値を消すと残った見た目と食い違うので外さず、`notDone`（`field_shared`）にする | `redacted_field` |
| 前の版・孤立した部品 | 片付けと同じく、1つの版にまとめて、たどれないものを捨てる | `previous_versions`・`unused_objects` |
| 字の対応表（`/ToUnicode`） | 黒塗りの前は使っていて、いまはどこでも使わないコードの行を、選んだ場所のあるページの書体から消す（字を絞った書体の対応表に、消した字が残らないように） | `font_unicode` |
| 黒い四角 | 選んだ場所の上に、ページのいちばん上に描く | `redaction_box`（場所ごと） |

- **保存の前の読み直し**：出来上がった PDF を最初から読み直す（片付けの報告は使わない）。次の残りが 1 件でもあれば `blocked` を返し、保存させない。`leftovers` の `check` で、どの確かめで見つかったかが分かる。
  1. `not_done`：片付けられなかった所（`notDone`）が 1 件でもあるとき（選んだ場所の外のものも入れる）
  2. `area`（いつも行う。`redact-check.ts`）：場所に掛かる字（空白は数えない）、場所の中の塗られていない画素（透明の型は不透明でないもの）、読み直せない画像・ページに直接埋め込んだ画像、場所に掛かる注釈
  3. `rules`（`checks` に渡したとき）：作品の検査で見つかった所すべてと、調べられなかったルール。ただし黒塗りの候補の型（P13【仮】、見える文字の個人情報らしい字）は残りではないので外す（画面の片付けの読み直しと同じ扱い。`CANDIDATE_PATTERNS`）。選んだ場所の中に字が残っていないかは、1 の場所ごとの確かめで見る
  4. `verifier`（`checks` に渡したとき。**Node だけ**）：検証器 P6。検証器は `node:crypto` を使うので、ブラウザでは動かない。テスト・採点では `tests/helpers/redact-checks.ts` の形で、検証器をコマンドとして呼ぶ
- 何も選ばない（`areas` が空）ときは、`sanitizePdf` とまったく同じ PDF になる。

**画面へのつなぎ方（B と合わせる案）**：片付けと同じく Worker の中で呼ぶ。やり取りの形の案：

```ts
type RedactRequest = { type: "redact"; id: number; buffer: ArrayBuffer; areas: RedactArea[] };
type RedactResponse =
  | { type: "redacted"; id: number; buffer: ArrayBuffer; removed: RemovedItem[] }
  | { type: "redact_blocked"; id: number; removed: RemovedItem[]; notDone: NotDoneItem[]; leftovers: RedactLeftover[] }
  | { type: "error"; id: number; message: string };
```

- `redact_blocked` のときは保存の場面に進ませず、`leftovers` の `label` と場所（`page`・`rect`）を出す（色だけで示さない）。
- 画面の「消しました」は、`removed` の `redacted_*` を場所ごとに並べる。「残っていません」は「選んだ所と、調べた項目（P1・P2・P5〜P9・P12 の範囲）について」と添える。
- Worker の中で作品の検査を呼ぶので、検査の Worker と同じ時間の上限をかける。

## ファイルを小さくする（`compress`。0.6.0 から）

片付けのあとの PDF を、画像の細かさ（dpi）と JPEG の質を選んで小さくする。提出先の容量の上限に合わせるための入口。片付けの代わりにはならないので、**片付けた PDF に使う**。

```ts
import { compress, COMPRESS_DPI, COMPRESS_QUALITY } from "../sanitize/index.ts";
import { rulesCheck } from "../sanitize/redact-check.ts";
const r = await compress(cleanedBytes, {
  codec,                                          // 片付けと同じ画像の道具（無いと no_codec）
  maxDpi: 150,                                    // 50〜600（COMPRESS_DPI）。既定 150
  jpegQuality: 0.75,                              // 0.3〜0.95（COMPRESS_QUALITY）。既定 0.75
  checks: [rulesCheck((b) => inspectAll(b))],     // 小さくする前と後に同じ確かめをかける
});
// r.status === "ok"      → r.bytes・r.sizeBefore・r.sizeAfter・r.changed・r.images（書き直した数・減ったバイト数・手を付けなかった理由と数）
// r.status === "blocked" → r.increased（増えた残りの種類・前の数・後の数）。バイト列は返さない
// r.status === "error"   → r.code（empty・unreadable・encrypted・too_large・bad_options・no_codec）・r.message
```

**小さくするもの**：ページ（と、その中の部品 Form）に描かれた画像のうち、いちばん大きく描かれた所でも `maxDpi` の 1.1 倍を超える細かさのもの。画素を平均して `maxDpi` まで縮め、JPEG（RGB）に書き直す。元より小さくなったときだけ置き換える。ほかのもの（字・図形・書体・透明の型）は変えない。

**手を付けない画像**（`r.images.skipped` に理由と数。`label` は画面にそのまま出せる）：

| reason | いつ |
|---|---|
| `within_dpi` | すでに選んだ細かさ以下 |
| `not_smaller` | 書き直しても小さくならなかった |
| `bitonal` | 白黒（1 ビット）の画像（JPEG にすると大きく、字がにじむ） |
| `mask` | 型抜きの画像（`/ImageMask`・`/Mask`）、`/Matte` のある透明の型を持つ画像 |
| `used_elsewhere` | 注釈の見た目・模様（パターン）など、ページと部品の中身の外からも使う画像（描かれる大きさが分からない） |
| `not_placed` | どこにも描かれていない画像、重くて読めなかったページの画像 |
| `too_large` | 画素の数が上限（片付けと同じ 7,200 万）を超える |
| `unreadable` | 解けなかった画像 |

**読み直し**：入れた PDF と出来上がった PDF の両方に `checks` をかけ、「確かめの名前・残りの種類・型（P1 など）」ごとの数を比べる。1 つでも増えたら `blocked`（場所は比べない。縮めると画像の境がずれるため）。出来上がった PDF を確かめられなかったとき・ページの数が変わったときも `blocked`。画像を1つも書き直さなかったときは、入れたバイト列をそのまま返し、確かめはかけない（`checked` は空）。

**画面へのつなぎ方（B と合わせる案）**：

```ts
// 画面 → 片付けの Worker（「3 片付ける」が済んで、読み直しが緑のあと）
{ type: "compress"; bytes: ArrayBuffer; maxDpi: number; jpegQuality: number }
// 片付けの Worker → 画面
{ type: "compressed"; bytes: ArrayBuffer; sizeBefore: number; sizeAfter: number; changed: boolean; images: CompressImages }
{ type: "compress_blocked"; sizeBefore: number; sizeAfter: number; increased: CompressIncrease[] }
{ type: "compress_error"; code: string; message: string }
```

- 選べる値は 3 つくらいに絞る案：「ふつう（150dpi・0.75）」「もっと小さく（100dpi・0.6）」「きれいに（200dpi・0.85）」。範囲は `COMPRESS_DPI`・`COMPRESS_QUALITY` から出す。
- 結果は「前 ○ KB → 後 ○ KB」と、書き直した画像の数・手を付けなかった画像の理由と数を出す。`changed: false` のときは「小さくできる画像がありませんでした」。
- `compress_blocked` のときは保存させず、`increased` の `label` と前後の数を出す。
- 小さくした PDF は、検査の画面にもう一度入れて読み直せるようにする（片付けのあとと同じ）。

## 片付けられなかった所（`notDone`）

| reason | いつ | 画面での出し方の例 |
|---|---|---|
| `unsupported_image` | 覆いの下の画像が JPEG 2000 など（画素を塗れない）、画像の道具を渡されなかった JPEG・CCITT・JBIG2、読めない画像 | `label` をそのまま＋ページ・場所（覆いごとに 1 件） |
| `image_too_large` | 覆いの下の画像が大きすぎる（画素の数が 7,200 万を超える。Flate 以外の圧縮で、展開して 64MB を超える） | 同上 |
| `inline_image` | ページに直接埋め込んだ画像があり、ページの命令を書き直せない（黒い覆い・白い覆いのどちらでも） | 同上 |
| `uncertain_cover` | 画像の上の白い塗りが、下が見えたままの重ね方（Multiply など）・半透明・表示しないレイヤーの中にあり、塗らなかった。画像の上の注釈の見た目を読めなかった | 同上（「見えている内容を確かめてください」） |
| `too_many_operations` | 命令が 300 万を超える重いページ（CLAUDE.md §5） | 「このページは図形が多すぎるため、片付けを省きました」＋ページ |
| `unreadable_page` | ページの中身を読めない | 同上 |
| `field_shared` | 自分で黒塗りしたフォームの欄が、ほかの所にも見た目を持っていて、欄ごとは外せない | 同上（「ほかの所の欄も選んでください」） |

`label` は画面にそのまま出せる文。`page`・`rect`（ページの既定の座標）は、ページの絵に枠を描くのに使える。

## 画面へのつなぎ方（B と合わせる案）

画面（`src/`）は B の担当なので、ここでは形だけを決める。`src/` は変えていない。

**「3 片付ける」**

1. 検査の Worker と同じく、**Worker の中で** `sanitizePdf(bytes)` を呼ぶ（時間の上限を超えたら Worker ごと止める。画面は止めない）。やり取りの形の案：
   ```ts
   type SanitizeRequest = { type: "sanitize"; id: number; buffer: ArrayBuffer };
   type SanitizeResponse =
     | { type: "sanitized"; id: number; buffer: ArrayBuffer; removed: RemovedItem[]; notDone: NotDoneItem[] }
     | { type: "error"; id: number; message: string };
   ```
   `buffer` は transfer で渡す（写しを作らない）。
   **画像の道具**（2026-11-04 から）：渡すと、覆いの下の JPEG・CCITT（FAX 形式）・JBIG2 の画像も塗る。渡さないと、その所は `notDone`（`unsupported_image`）になる（黙って残しはしない）。Worker の中で：
   ```ts
   import * as pdfjs from "<dist/ に入れて配る pdf.min.mjs>";          // 検査と同じ PDF.js（手を加えずに配るもの）
   import { createPdfjsImageCodec, offscreenCanvasJpegEncoder } from "../sanitize/image-codec.ts";
   const codec = createPdfjsImageCodec(pdfjs, offscreenCanvasJpegEncoder, {
     wasmUrl: "<dist/ に置いた PDF.js の wasm/ フォルダの URL>/",      // CCITT・JBIG2 を解く部品（jbig2_nowasm_fallback.js）の置き場所
   });                                                                  // 解く：PDF.js。JPEG を書く：OffscreenCanvas（Worker でも使える）
   const r = await sanitizePdf(bytes, { codec });
   ```
   - PDF.js には、画像1つだけの小さな PDF のバイト列だけを渡す（URL・書体・CMap は渡さない。`useWorkerFetch: false`・`useWasm: false`）。PDF.js が自分の Worker をどう立てるか（`GlobalWorkerOptions.workerSrc` など）は、検査の側と同じ決まりに合わせる。
   - メモリと時間（2026-11-04、headless Chrome 156 で測定。片付けを動かした描くプロセスの、メモリの最大の増え）：600dpi の A4 の JPEG で約 +530MB・0.9 秒、600dpi の A3（約 7,000 万画素）の JPEG で約 +1,000MB・1.5 秒。Flate の A3 は約 +280MB・0.8 秒。画像は1つずつ塗るので、増えはいちばん大きな画像1つ分。メモリの少ない PC では、A3 の JPEG で止まるかもしれない（止まったら Worker ごと止めて、片付けを失敗として出す）。
   - 書き直した JPEG のバイト列は、ブラウザと Node（採点は @napi-rs/canvas で書く）で同じにならない。
   - CCITT・JBIG2 を塗るには、`pdfjs-dist/wasm/jbig2_nowasm_fallback.js`（PDF.js と一緒に配られるもの。Apache-2.0）を、手を加えずに dist/ に入れて配り、そのフォルダの URL を `wasmUrl` に渡す。PDF.js がそこから `import()` で読む（同じサイトの中。`.wasm` は使わない：`useWasm: false`）。入れないなら `wasmUrl` を渡さない（CCITT・JBIG2 は `notDone` になる）。headless Chrome 156 で、開発サーバーから渡して CCITT の画像を塗れることを確かめた（2026-11-04）。
2. `removed` を「取り除いた項目」として並べる。並べ方の案：`pattern` ごとにまとめ、`label` と `count` を出す。`page`・`rect` があれば、ページの絵の上に枠を描く。`rect` は、`kind` ごとに次の箱（どれもページの既定の座標。ポイント、左下が原点、`/Rotate` はかけない）：
   - `covered_text`（黒い四角の下の字）：その字を隠していた**覆いの箱**。覆いごとに 1 件。
   - `covered_pixels`（黒い四角・白い四角の下の画像の画素。`label` で黒く塗ったか白く塗ったかが分かる）：**覆いの箱と画像の箱の重なり**（塗った所）。1つの画像に覆いが複数あれば、覆いごとに 1 件（`count` はその覆いで塗った画素の数。2つの覆いに入る画素は、あとに描いた（上にある）覆いの色で塗り、その覆いで数える。ただし、上にある濃い覆いが白い覆いの中にすっかり入っているとき〈白い札の上に書いた字や線〉は、白い覆いの色で塗り、白い覆いで数える。はみ出す濃い覆いは、濃い色のまま〈濃い覆いの下を白と黒の混ざりにすると、検証器が残りとして数えるため〉。2026-11-04 から。下の覆いがすべて上の覆いに隠れていれば、下の覆いの項目は出ない）。画像全体の箱ではない。
   - `redaction_applied`（適用した墨消し）：墨消し注釈の箱（描き込んだ黒い四角）。
   - `hidden_text`（見えない字）：消した字の箱を合わせた箱。理由（`reason`）ごとに 1 件。
   - ページの中の `actual_text` と、文書全体の項目（文書情報・添付など）には `rect` がない。
3. `notDone` が 1 件でもあれば、「片付けられなかった所」として目立つ所に出す（色だけで示さない。CLAUDE.md §6）。
4. 片付けた PDF は `Blob` にして、利用者が保存する（`URL.createObjectURL`。通信ではない）。

**「4 読み直す」**

- 片付けた PDF（`r.bytes`）を、**検査の入口に最初から入れ直す**（片付けの報告は使わない）。結果が全部緑になること、黒い四角の下を選んでも何も取れないことを見せる。
- 画面で「残っていません」と出すときは、「調べた項目（P1・P2・P5〜P9・P12 の範囲）について」と添える（CLAUDE.md §11-5b）。

## 確かめ方

```
npm run eval                                  # 検出ルールの採点と一緒に、片付けたあとに残る情報も型ごとに測る（先に片付けて --sanitized で渡す）
npm run eval:sanitize                         # 合成 PDF（5つの型）を片付けて .tmp/sanitized/ に書き出し、型ごとに採点する
npm run eval:p6 -- --sanitized .tmp/sanitized/p6   # 型ごとの採点だけ（p1・p9・p5・p7 も同じ）
npm run check:sanitized -- fixtures/p6 .tmp/sanitized/p6   # 壊れていないか（開ける・ページ数・字・見た目）
npm test                                      # tests/sanitize.test.ts・tests/sanitize-check.test.ts
```

壊れていないかの確かめ（`check/`。Node だけで使う道具。画面には入れない）：

1. 開ける：pdf-lib と PDF.js の両方で開け、全ページを描ける
2. ページ数・ページの大きさ・回転が同じ
3. 字が増えていない：片付けたあとに取り出せる字（字ごとの数）が、前の字の中に収まる
4. 見た目が同じ：PDF.js で前後を 1.5 倍で描き、色の差が 64 を超える画素を数える。ページの 0.05% を超えたら「違う」。適用した墨消しの箱の中は数えない

## 実物で調べる道具（trace）

`sanitizePdf(bytes, { trace })` に関数を渡すと、ページごとに「画像・黒でない塗り・塗った結果」を、数と名前だけで渡す（字・名前・画素などの中身は入れない。画面では使わない）。実物で「なぜ塗らなかったか」を、中身を見ずに調べるため（2026-11-04 から）。`fill` の `decision` が `light_cover` なら覆いにした、`skip_*` は覆いにせず `notDone` の側、`mid_tone`（明るさ 0.35〜0.9）・`unknown_color`（明るさが分からない色）は何もしていない。`burn` の `painted` は塗った画素の数、`expected` はだいたい塗れるはずの数。

## 中身の作り

- `index.ts`：入口。読む → ページごと（`content.ts`）→ 文書全体（`structure.ts`）→ 掃除して書き出す（`sanitizeCore`。`redact` も使う）
- `redact.ts`：自分で黒塗りする入口。選んだ場所に掛かる注釈・フォームの欄を外し、保存の前に読み直す
- `redact-check.ts`：読み直しの確かめ（選んだ場所の字・画素・注釈）と、作品の検査をつなぐ `rulesCheck`
- `redact-fonts.ts`：字の対応表（`/ToUnicode`）から、消した字だけで使っていた行を消す
- `compress.ts`：ファイルを小さくする入口。画像の描かれる大きさを `content.ts` の読み手で測り、縮めて JPEG に書き直し、前後に同じ確かめをかける
- `content.ts`：ページの命令を追い、字（どの命令の何文字目か）・覆い・塗り・画像を描いた順に集め、消す字・塗る画素を決め、書き直す。書き換えた部品・画像は**新しいオブジェクト**にし、元は書き換えない（ほかのページで使われているかもしれないため）。使われなくなった元は掃除で消える
- `images.ts`：画像の画素を塗る（Flate・LZW・ASCIIHex・ASCII85・RunLength。PNG・TIFF の予測も戻す。大きな Flate は流して塗る。JPEG・CCITT・JBIG2 は `image-codec.ts` の道具で解いて書き直す）
- `image-codec.ts`：画像の道具を作る（PDF.js と、JPEG に書く関数を受け取る。ブラウザは OffscreenCanvas）。片付けのコードは PDF.js を読み込まない
- `node/`：Node（採点・テスト）だけで使う画像の道具（pdfjs-dist の legacy の版と @napi-rs/canvas）。ブラウザには入れない
- `serialize.ts`：命令をバイト列に戻す
- `structure.ts`：P1・P2・P8・P9・P12 と、たどれないものの掃除
- `check/`：壊れていないかの確かめ（Node だけ）

検出ルールの部品のうち、次のものを読んでいる（書き換えてはいない）：`rules/shared/`（読み込み・復号・命令の読み手・書体の寸法）、`rules/p6-text/geometry.ts`・`images.ts` の `measureImageDarkness`・`page.ts` の `coverageOf` と `luminanceOf`。覆いの見つけ方を検出ルールとそろえるため。検証器（`verifier/`）は読まない。

## できないこと（限界）

- **見つけられるのは決めた範囲だけ**（P1・P2・P5〜P9・P12 の、上の表のもの）。すべての隠れた情報を消せるわけではない。
- フォームの入力値（P11）は、まだ片付けない（P11 の採点する側ができてから。2026-11-04 人が決めた）。構造ツリーの `/Alt`（画像の説明）も、まだ片付けない。
- 注釈の見た目（`/AP`）の中の `/ActualText` は外していない。付箋と吹き出しの注釈はまるごと外すので、残るのはそれ以外の注釈の見た目の中だけ（2026-11-04 人が決めた。注釈の見た目は書き換えない作りのため）。
- ページの中に画像を直接埋め込んだページでは、ページの中の `/ActualText` を外せない（`notDone`）。
- JPEG 2000 の画像と、画像の道具を渡されなかった JPEG・CCITT・JBIG2 の画素は塗れない（`notDone`）。型抜き（`/ImageMask`）の JPEG・CCITT・JBIG2 も塗れない（`notDone`）。JBIG2 を塗る道は、合成した JBIG2 の画像を作れないため、テストしていない（CCITT と同じ道を通る）。
- 白い塗りの色が、特色（Separation・DeviceN）・索引の色（Indexed）・模様（Pattern）で指定されているときは、色の明るさが分からないので、覆いにも `notDone` にもしない（黙って残る。2026-11-04 に合成 PDF で確かめた。検出ルール P6 1.9.0 も、この形を見つけない）。画素の数が 7,200 万を超える画像も塗れない（`notDone`）。ページに直接埋め込んだ画像があるページは、命令を書き直せない（`notDone`）。
- 白い覆いの下を塗ったかは、検証器（`verifier/`）では数えない（検証器は濃い覆いだけを見る）。いまは片付けのテスト（`tests/sanitize-images.test.ts`）で、塗った数を確かめている（2026-11-04 人が決めた。採点する側の直しは別に頼む）。
- 黒い覆いは、表示しないレイヤーの中のものも覆いとして扱っている（前から。白い覆いは扱わない）。表示しないレイヤーの黒い四角の下の画像は、黒く塗られて見た目が変わる（2026-11-04 に合成 PDF で確かめた。直すかは人が決める）。
- 字の区切りが分からない字の並び（2バイトの書体で、長さが合わないもの）は、並びごと消す（消しすぎの側）。
- 縦書きは、書体が縦書き（`/WMode 1`）のときだけ縦の箱で見る（0.5.0 から）。縦の寸法は `/DW2` だけを読み、字ごとの `/W2` は読まない（`/W2` で字ごとに位置を変えた書体では、箱がずれることがある）。
- **ファイルを小さくする（`compress`）の限界**：
  - 小さくするのは画像だけ。字・図形・書体・透明の型（`/SMask`）は小さくしない。書き直した画像は RGB の JPEG になる（灰色の画像・ICC の色も RGB にする。色が少し変わることがある）。
  - 縮めると、黒塗りした箱の縁の画素（縮めたあとの 1 画素ぶん）は、箱の中の黒と箱の外の紙の色が混ざる。箱の外は、もともと見えている所で、箱の中の中身は混ざらない（塗った画素は黒だけのため）。`redact` が描く黒い四角は、上にそのまま残る（2026-11-05 に合成 PDF で確かめた。縁を除いた内側の塗られていない画素は 0 個）。
  - 注釈の見た目・模様の中の画像、どこに描くか分からない画像は小さくしない（大きく描かれる所で粗くならないように）。
  - 読み直しは「種類ごとの数が増えないこと」を見る。場所が動いただけ（数が同じ）は見分けない。
- **自分で黒塗りする（`redact`）の限界**：
  - 書体の中の字の形（字形）は消さない。字の対応表の行は消すが、字を絞った書体の中には、消した字の形が残る（書体を作り直す道具が要るため）。
  - 字の一部だけを残す切り方はしない（掛かった字は 1 字まるごと消す。消しすぎの側）。
  - 黒い四角だけを描く（白で消す道はまだない。PR で人が決める）。
  - 画像の透明の型（`/SMask`）は不透明にするが、型抜きの画像（`/Mask` に画像を指定したもの）は塗らない。選んだ場所にそういう画像が掛かるときは、読み直しで「確かめられない画像」として数え、保存させない。色の値で抜く型（`/Mask` の色の範囲）は、塗った黒が抜ける色に入ると透けることがあるが、上に黒い四角を描き、塗った画素に中身は残らない。
  - 検証器での読み直しは Node だけ（ブラウザでは、選んだ場所の確かめと作品の検査だけ）。
  - 作品の検査で見つかった所は、選んだ場所と関係なくても残りとして数え、保存させない（「ほかの残りもないこと」を確かめるため）。黒塗りの候補（P13【仮】）だけは数えない。
- 書き直したページの命令には、もとのコメント・空白の並びは残らない。
