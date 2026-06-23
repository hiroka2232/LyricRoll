# Lyric Roll

**DAW のピアノロール画面と TextAlive を組み合わせたリリックアプリです。**
お気に入りの曲を選ぶと、歌詞が DAW のピアノロールのように一つひとつのノートとなって流れていきます。タッチやマウスで操作しながら、音楽と歌詞を視覚的に楽しめます。

![Lyric Roll](public/logo.svg)

---

## 特徴

- 🎹 **ピアノロール型の歌詞表示** — 歌詞を単語ごとに MIDI ノートのように配置し、DAW の再生ライン上を流していきます。
- 🎨 **6 キャラクターカラーの段（レーン）** — 上から KAITO / 鏡音レン / 初音ミク / 鏡音リン / 巡音ルカ / MEIKO のピアプロカラーで段分け。
- ✋ **タッチ / AUTO の 2 モード** — タッチ（マウス）で歌詞の流れる段を自分で選ぶか、AUTO でおまかせするか切り替えられます。
- 🎤 **擬似ピッチ演出 & VU メーター** — 再生ライン上で光るボールが上下し、彗星の尾を引きます。下部の VU メーターは TextAlive の声量データ（`getVocalAmplitude`）で動きます。
- 📱 **レスポンシブ対応** — PC・スマートフォン（横向き推奨）で動作します。

---

## 動作環境

- **対象ブラウザ**: Google Chrome / Microsoft Edge / Safari（いずれも最新版）
- **OS**: Windows / macOS / iOS / Android
- **ネットワーク接続が必要です**（TextAlive API・楽曲データ・Web フォントの取得のため）
- 音が出る環境（スピーカー / イヤホン）を推奨します。
- スマートフォンでは**横向き**での利用を推奨しています。

> **本番設置に必要なものは HTTP サーバのみです（Node.js は不要）。**
> このアプリは HTML・CSS・JavaScript・フォントだけで構成された**静的アプリケーション**です。
> サーバ側でプログラムを動かして動的にレスポンスを返すことはなく、配信されたファイルが
> 利用者のブラウザ内だけで動作します。後述の `dist/` フォルダを HTTP サーバに置くだけで動きます。

---

## 本番設置の手順（審査・公開用）

ビルド済みの **`dist/` フォルダの中身を、HTTP サーバの公開フォルダにそのままコピーするだけ**です。
サーバへの Node.js のインストールや、サーバ側での起動作業は一切必要ありません。

```
dist/                         （HTTP サーバの公開フォルダ）
├ index.html      ──コピー──▶  ├ index.html
├ favicon.ico                  ├ favicon.ico
└ assets/                      └ assets/
   ├ index-*.css                  ├ index-*.css
   ├ *.js                         ├ *.js
   └ *.woff2                      └ *.woff2
```

リンクはすべて相対パス（`vite.config.js` の `base: './'`）なので、ドメイン直下でも
サブディレクトリ配下でも、置いた場所そのままで動作します。

---

## 開発・ビルド手順（開発者向け）

> ここで使う [Node.js](https://nodejs.org/)（v18 以上を推奨）は、**開発と `dist/` の生成にのみ
> 必要な道具**です。本番サーバや利用者の環境には Node.js は不要です。

```bash
# 1. 依存パッケージのインストール
npm install

# 2. 開発サーバを起動（http://localhost:5173 が開きます）
npm run dev

# 3. 本番用に静的ビルド（dist/ が生成されます）
npm run build

# 4. ビルド結果をローカルで確認
npm run preview
```

`npm run build` を実行すると、上記「本番設置の手順」で使う `dist/` フォルダが生成されます。

---

## 使い方

1. スタート画面（プロジェクト選択）から曲を選びます。
2. 画面下のトランスポート（▷ 再生 / ❚❚ 一時停止 / □ 停止）で再生します。
3. 左下の**モード切替**ボタンで「タッチ」「AUTO」を切り替えます。
   - **タッチ**: 画面をタップ／なぞると、歌詞ノートが流れる段を単語ごとに選べます。
   - **AUTO**: 段がランダムに選ばれて流れます（タッチ操作はオフ）。

---

## 楽曲について

楽曲は TextAlive 経由で読み込みます。各曲の URL は `src/songs.js` で管理しており、
歌詞・サビ等の音楽地図を固定するため、`https://piapro.jp/t/{曲ID}/{バージョン番号}` の
**バージョン番号付きフル URL** で指定しています。

収録楽曲（敬称略）:

| タイトル | アーティスト |
|---|---|
| こたえて | imie feat. 初音ミク |
| アフター・ザ・カーテン | Rulmry feat. 初音ミク |
| シャッターチャンス | 夜未アガリ feat. 初音ミク＆鏡音リン |
| 世界最後の音楽隊 | 夏山よつぎ×ど～ぱみん feat. 初音ミク |
| トリツクロジー | 鶴三 feat. 鏡音リン |
| TAKEOVER | Twinfield feat. 初音ミク |

---

## 使用技術・クレジット

- [TextAlive App API](https://developer.textalive.jp/) — 歌詞・ビート・声量などの楽曲解析データ
- [Vite](https://vitejs.dev/) — ビルドツール
- フォント
  - [M PLUS Rounded 1c](https://fonts.google.com/specimen/M+PLUS+Rounded+1c) / [Share Tech Mono](https://fonts.google.com/specimen/Share+Tech+Mono)（Google Fonts, SIL OFL）
  - [DSEG](https://github.com/keshikan/DSEG)（7 セグメント表示フォント, SIL OFL, © けしかん）— `src/fonts/` に同梱
- 描画はすべて HTML5 Canvas による自前実装です。
