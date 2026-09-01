# 半導體產業週報閱讀器

一個純靜態的網頁「殼」。**網頁本身不含任何新聞內容**——畫面上的每一則標題、摘要、數據、連結，
都是載入時從 Excel 週報即時解析出來的。換一份 Excel，網站內容就整份換掉。

- 解析全在瀏覽器端完成（SheetJS），**檔案不會上傳到任何伺服器**
- 無建置流程、無框架、無外部 CDN，直接丟上 GitHub Pages 就能跑
- 支援：分類 / 日期 / 主體 三軸篩選、全文搜尋與關鍵字標記、卡片與表格兩種檢視、
  CSV 匯出、深色模式、列印、手機版

---

## 目錄結構

```
.
├── index.html              # 頁面骨架
├── assets/
│   ├── app.css             # 樣式（配色沿用 Excel 週報的深藍 #1F3864）
│   └── app.js              # Excel 解析 + 篩選 + 呈現
├── vendor/
│   └── xlsx.full.min.js    # SheetJS 0.18.5（已內含，不依賴 CDN）
├── data/
│   ├── reports.json        # 週報清單（下拉選單的來源）
│   └── *.xlsx              # 你的週報檔案
└── .nojekyll               # 讓 GitHub Pages 不要跑 Jekyll
```

---

## 換成你自己的資料

### 方法 A：放進 repo（做成長期的線上週報）

1. 把 `.xlsx` 丟進 `data/`
2. 編輯 `data/reports.json`，把新的一份加在**最前面**（網站預設載入第一筆）：

```json
[
  { "file": "全球半導體代工產業週報_20260902-20260908.xlsx", "label": "2026/09/02–09/08" },
  { "file": "全球半導體代工產業週報_20260826-20260901.xlsx", "label": "2026/08/26–09/01" }
]
```

3. `git add . && git commit && git push` — GitHub Pages 幾十秒後自動更新

### 方法 B：不動 repo，直接看本機檔案

把 `.xlsx` **拖曳到網頁上**（或按右上角「載入 Excel…」）。純本機解析，適合週報還沒定稿時先預覽。

---

## Excel 需要長什麼樣

分頁用**名稱關鍵字**辨識，欄位用**標題文字**辨識，所以欄位順序可以不同、可以多可以少：

| 分頁 | 判斷依據 | 讀取的欄位 |
|---|---|---|
| 新聞彙整 | 名稱含「新聞」「彙整」或 news | 序號、日期、分類、主體/公司、標題、重點摘要、關鍵數據、影響/觀察、來源、連結、資料確認度 |
| 重點數據 | 名稱含「重點數據」「數據」「指標」 | 類別、項目、數值、說明、來源 / 日期 |
| 說明與方法 | 名稱含「說明」「方法」「備註」 | A 欄逐行純文字 |

其他細節：

- **標題列自動偵測**：程式會掃前 20 列，找欄位名稱命中最多的那一列當表頭，
  所以像現有週報那樣「第 1 列大標、第 2 列副標、第 4 列才是欄位名」也沒問題
- 第 1、2 列的文字會被拿來當網頁的大標與副標
- 認得的欄位以外，多出來的欄位會原樣顯示在卡片裡，不會被丟掉
- 「資料確認度」若含「待確認 / 預估 / 傳聞 / 未證實 / 揣測 / 草案」等字樣，會自動標成橘色警示徽章
- `連結` 欄是 http(s) 開頭才會變成可點的連結

---

## 部署到 GitHub Pages

在這個資料夾裡：

```bash
git init -b main
git add .
git commit -m "Add semiconductor weekly report reader"
git remote add origin https://github.com/<你的帳號>/<repo 名稱>.git
git push -u origin main
```

然後到 GitHub 的 **Settings → Pages**，Source 選 `Deploy from a branch`，
Branch 選 `main` / `(root)`，存檔。約一分鐘後網址是：

```
https://<你的帳號>.github.io/<repo 名稱>/
```

> repo 設為 Public 時 Pages 免費。設 Private 需要 GitHub Pro 以上方案。

---

## 本機預覽

不能用 `file://` 直接開 `index.html`——瀏覽器會擋下讀取 `data/` 的請求
（這時網頁會提示你改用拖曳）。起一個本機伺服器即可：

```bash
python -m http.server 8765
```

然後開 <http://localhost:8765>。

---

## 授權與聲明

`vendor/xlsx.full.min.js` 為 SheetJS Community Edition（Apache-2.0）。
本頁僅呈現使用者提供的資料，不構成任何投資建議。
