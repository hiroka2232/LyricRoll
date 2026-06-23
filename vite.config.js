// Vite（開発サーバ）の設定ファイル。
//
// スマホ実機での確認は「cloudflared トンネル」で行う方針。
// トンネルでは、公開URL( https://〇〇.trycloudflare.com )側が HTTPS を担当してくれる。
// そのため PC 内部の開発サーバーは HTTP のままでよい（自己署名証明書の検証で
// 引っかかるのを防ぐため、あえて HTTPS 化しない）。

import { defineConfig } from 'vite';

export default defineConfig({
  // 生成物のリンクを相対パスにする。これで主催者がサイトのサブディレクトリ
  // （例: https://example.com/works/lyric-roll/）に配置しても、JS/CSS/フォントが
  // 404 にならず確実に読み込める。ルート直下配信でも問題なく動く。
  base: './',

  server: {
    // 使うポート番号。cloudflared がこのポートに転送する。固定しておくと毎回同じで楽。
    port: 5173,

    // Vite はセキュリティのため「知らないドメイン名でのアクセス」を既定でブロックする。
    // cloudflared の公開URL( 〇〇.trycloudflare.com )は毎回サブドメインが変わるので、
    // 先頭ドットの書き方で「trycloudflare.com の全サブドメイン」をまとめて許可する。
    allowedHosts: ['.trycloudflare.com'],

    // ── songle.jp の CORS 回避プロキシは廃止した ──
    // 以前は songle.jp の 302リダイレクト(CORSヘッダー無し)を避けるため、開発サーバで
    // 中継していた。今は songs.js の曲URLにバージョン番号を付け、最初からリダイレクトが
    // 起きない正式URLを叩くようにしたのでプロキシは不要。詳しくは songs.js の先頭コメント参照。
  },

  // preview（本番ビルドの確認サーバ：npm run preview）の設定。
  // 上の server.allowedHosts は「開発サーバ(npm run dev)」専用で preview には効かないため、
  // 本番ビルドを cloudflared トンネル経由で実機確認できるよう preview 側にも許可を書く。
  preview: {
    allowedHosts: ['.trycloudflare.com'],
  },
});
