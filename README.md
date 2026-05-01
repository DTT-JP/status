# Status Page

サービスの稼働状況をリアルタイムで確認できるステータスページです。

## 概要

このリポジトリは、GitHub Pages で公開されるステータスページの静的ファイルを管理します。  
Cloudflare Workers が定期的にサービスの稼働状況を監視し、結果を JSON として配信します。  
フロントエンドはクライアントサイド JavaScript でデータを取得・描画します。

## ファイル構成

| ファイル | 説明 |
|:---|:---|
| `index.html` | ステータスページ本体 |
| `style.css` | UI スタイルシート |
| `app.js` | データ取得・SLA計算・DOM生成ロジック |
| `config.json` | グループ名・サービスIDの設定ファイル |

## データソース

ステータスデータは以下の優先順位で取得されます：

1. **GitHub Pages 公開URL**（最優先）
2. **raw.githubusercontent.com**（2分以上遅延時）
3. **Cloudflare R2 CDN**（さらに遅延時の最終手段）
