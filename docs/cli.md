<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# コマンドの道具（cli/）

PDF を公開・提出する前に、フォルダごとまとめて確かめるための道具です。PDF は画面の検査器と同じルールの一覧（`src/inspect/rules.ts` の `RULES`）で調べ、写真（JPEG・PNG・WebP・HEIC）と今の Office（docx・xlsx・pptx）は `formats/` で調べます（`formats/README.md`）。**型・数・場所だけ**を出します。覆われた字・欄の値・中のファイル名・シートの名前は出しません。

- **通信しません。** ファイルを読んで、結果を画面かファイルに書くだけです（`tests/cli-no-network.test.ts` で、通信の部品を使っていないことを文字で確かめています。目安であって、保証ではありません）。
- ファイル1つごとに Node の Worker を作り直し、時間（既定 120 秒）とメモリ（既定 2048MB）の上限を超えたら、その Worker だけを止めます。止めたファイルは「調べられなかった所」に数えます。
- 見つけられるのは、このツールが調べる決まった型だけです。「見つかりませんでした」は、調べた項目についての結果で、すべてを保証するものではありません。

## 使い方

Node 22.12 以上（TypeScript をそのまま動かすため。このリポジトリでは 24 で確かめた）で、リポジトリの中から動かします。

```
npm ci
npx omamori-pdf check <ファイルやフォルダ>...
npx omamori-pdf compare <元の PDF> <公開する PDF>
```

`npm run cli -- check …`、`node cli/omamori.ts check …` でも同じです。

### check：調べる

| 選択肢 | 意味 |
|---|---|
| `--format text\|json\|sarif` | 出し方。既定は `text`（人が読む形） |
| `--output <ファイル>` | 結果をファイルに書く。既定は画面 |
| `--fail-on <段階,…>` | 終了コードを 0 以外にする段階。`review`・`high`・`unchecked` を `,` でつなぐ。`never` で、どの段階でも 0。既定は `review,high,unchecked` |
| `--timeout <秒>` | ファイル1つにかけてよい時間。既定は 120 秒 |

- フォルダを渡すと、中までたどって `.pdf`・`.jpg`・`.jpeg`・`.png`・`.webp`・`.heic`・`.heif`・`.docx`・`.docm`・`.xlsx`・`.xlsm`・`.pptx`・`.pptm` を調べます（リンク・`node_modules`・`.git` はたどりません。1万個まで）。古い Office（.doc など）・一太郎は調べないので、フォルダからは拾いません。
- ファイルを直接渡したときは、拡張子を問わず中身（先頭のバイト）で見分けます。調べられない形式なら「調べられなかった所」（3）になります。
- PDF の結果の `ruleId` は検出ルールの id（`p6-text` など）、写真は `formats-image`、Office は `formats-office` です。PDF 以外の `pattern` は `null` で、細かい型は `type`（`image.gps` など。`docs/glossary.md`）に入ります。PDF 以外の場所は `where`（「2 枚目のシート B3」など）に入ります。

### 終了コード（check）

| コード | 段階 | 意味 |
|---|---|---|
| 0 | 見つからない | 調べた項目について、見つかりませんでした |
| 1 | 確認してほしい所だけ | 深刻度が中・低のものだけ（文書情報・添付ファイルなど） |
| 2 | 高い危険 | 深刻度が高のものがある（見せかけの黒塗り・前の版の残り・見えない字など） |
| 3 | 調べられなかった所がある | PDF でない・大きすぎる・ルールが止まった・図形が多くて省いたページ・読めなかった画像・時間かメモリの上限 |
| 64 | 使い方の誤り | 選択肢の誤り・ファイルが見つからない |

- いくつかのファイルを調べたときや、1つのファイルで高と「調べられなかった所」が両方あるときは、`--fail-on` に挙げた段階のうち、届いたものの一番大きい数になります。例：`--fail-on high` なら、高があれば 2、なければ 0（省いたページがあっても 0）。
- 深刻度は画面と同じです（P6 の「高」のほかは【仮】。`src/inspect/rules.ts`）。

### compare：2つの PDF を比べる

元の PDF と公開する PDF（または片付けの前と後）を比べます。比べる中身は `compare/index.ts` にあり、画面からも同じ関数（`comparePdfs`）を呼べます。

1. **消したはずの字**：公開する PDF の濃い覆い（黒い四角・黒い画像・墨消しの注釈など）の下に、元の PDF の字が、覆いより先に描いた字としてほぼ同じ所に残っているか。字の中身は出さず、字数とページと覆いの箱を出します。覆いのあとに同じ字を描き直したもの（上に見えている字）は数えません。あわせて、元にあって公開する PDF から取り出せなくなった字の数も出します。
2. **文書情報と XMP の違い**：欄ごとに、足された・消えた・変わった・同じ。値は出しません。文書情報の独自の欄と、XMP のよく使う名前空間（`dc`・`xmp`・`pdf` など）にない項目は、名前も出しません（名前が手がかりになりうるため）。
3. **数の違い**：版（前の版の残り）・添付ファイル・注釈の数。

ページは番号で対応させます（元の n ページ目と、公開する PDF の n ページ目）。途中のページを抜いた PDF では、後ろのページがずれて比べられません。

| 選択肢 | 意味 |
|---|---|
| `--format text\|json` | 出し方。既定は `text` |
| `--output <ファイル>` | 結果をファイルに書く |

終了コード：0 消したはずの字が残っていない／2 残っている／3 比べられなかった所がある（ページの数が違う・図形が多くて省いたページ・読めない欄。2 と両方なら 3）／64 使い方の誤り。

## GitHub Actions の例

公開する PDF を置くリポジトリで、PR ごとに調べる例です。**この道具は npm に出していません。** そのため、このリポジトリのタグ付きのリリースを取り出して動かします（CLAUDE.md §11-5：配布はタグ付きリリースに限る）。

- 道具の依存を入れる `npm ci` は、npm から取ってくるので通信します。**調べる処理そのものは通信しません。** 気になる場合は、依存を入れる手順と調べる手順を別のジョブに分け、調べるジョブでは通信を止める（自前のランナーなど）方法があります。
- 外部のアクションはコミットの SHA で固定します。下の `actions/checkout`・`actions/setup-node` は、このリポジトリの `.github/workflows/deploy.yml` と同じ SHA です。SARIF を上げる `github/codeql-action/upload-sarif` の SHA は、使う時点の公式のリリースで確かめて書いてください（ここでは確かめていないので【 】のままにしています）。

```yaml
name: PDF の確かめ

on:
  pull_request:
    paths: ["**/*.pdf"]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    permissions:
      contents: read
      security-events: write # SARIF を上げるときだけ要る
    steps:
      - name: 公開する PDF を取り出す
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false

      - name: 確かめる道具を取り出す（タグ付きのリリース）
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          repository: 【このリポジトリ】
          ref: 【タグ】
          path: omamori
          persist-credentials: false

      - name: Node を用意する
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: 24.19.0

      - name: 道具の依存を入れる
        run: npm ci --prefix omamori

      - name: 調べる（高い危険と、調べられなかった所があれば落とす）
        run: node omamori/cli/omamori.ts check docs --format sarif --output omamori.sarif --fail-on high,unchecked

      - name: 結果を上げる（落ちたときも）
        if: always()
        uses: github/codeql-action/upload-sarif@【SHA】 # 【版】
        with:
          sarif_file: omamori.sarif
```

- SARIF を上げない場合は、`--format text` にして最後の手順を外します。結果は Actions の記録に出ます（型・数・場所とファイルの場所だけ）。
- SARIF の結果には行の番号がありません（PDF には行がないため）。ページは `logicalLocations` と `properties.page` に入れています。

## ほかの入口との関係

- 調べる中身は `cli/inspect-pdf.ts`（Node の API を使わない）。画面の Worker と同じ `inspectAll`（`src/inspect/inspect.ts`）を呼び、結果の形を並べ替えるだけです。Claude Code のスキル／MCP 版を作るときも、これを呼べば同じ検査になります（いまはスキル／MCP 版はありません）。
- 画面のコードは Vite で動かすので、相対の import に拡張子がありません。Node で読むため、`cli/resolve-ts.ts` のフックで、見つからないときだけ `.ts` を足して探します。
