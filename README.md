# 半導體產業快報＋單字複習

<https://jasonzhi731.github.io/news-wab/> — 一個可加到手機主畫面的網站，兩個部分：

- **快報**（`index.html`）：純靜態的「殼」，每一則標題、摘要、數據、連結都是載入時從 Excel 即時解析（SheetJS，檔案不上傳）。
  新聞依日期由新到舊；分類／日期／主體篩選；每張卡「中 / EN」切換，英文模式重點字彙標螢光筆、其餘每個字都能點查中文
  （全站字典 `data/en/glossary.json`）並 ☆ 收藏；財經用語標「財經」；🔊 用瀏覽器內建語音朗讀；
  「英文字彙」分頁列出本期字卡，可「遮住中文」自測，或按「先練這期單字」直接進單字複習。
- **單字複習**（`study/`）：翻牌閃卡＋間隔重複（SM-2，後端計算）。練習範圍可選「全部（今日到期＋新字）」或某一期；
  卡片背面有新聞原句（每個字可點查義）、出處連結（打開那一期英文版並捲到那一則）、✨ AI 科技例句。
- **共用**：同一套外觀與導覽（`assets/shell.css`：色票、頂列、漸層標題區、分頁籤、手機底部選單）、深淺色設定（`wr-theme`）、
  單字本（`assets/wordbook.js`：兩頁的 ☆ 收藏是同一份，有 token 時同步到 Google Sheet）、字典 `glossary.json`。
- 資料：快報內容在 `data/`（GitHub Pages）；單字、複習進度、收藏在 Google Sheet，經 Apps Script（`backend/`）存取。

---

## 目錄結構

```
.
├── index.html              # 快報頁面骨架
├── assets/
│   ├── shell.css           # 兩頁共用：色票、頂列、hero、分頁籤、手機底部選單
│   ├── app.css  app.js     # 快報：Excel 解析、英文對照、篩選、字彙
│   ├── wordbook.js         # 兩頁共用的單字本（收藏＋同步到 Sheet）
│   ├── icons/              # App 圖示（manifest、apple-touch-icon）
│   └── og-cover.png        # 連結預覽圖
├── study/                  # 單字複習（PWA：manifest.webmanifest 的 scope 是整站，sw.js 只管 study/）
│   ├── index.html  app.css  app.js
│   ├── config.js           # 預設 API 網址、版本號
│   └── sw.js  manifest.webmanifest
├── backend/                # Google Apps Script 後端（貼進試算表的 Apps Script 編輯器）
│   ├── Code.gs
│   └── appsscript.json
├── vendor/xlsx.full.min.js # SheetJS 0.18.5（已內含，不依賴 CDN）
├── data/
│   ├── reports.json        # 快報清單（第一筆＝網站預設載入）
│   ├── *.xlsx              # 各期快報
│   └── en/  *.json  glossary.json   # 英文對照（與 xlsx 同名）＋全站英中字典
├── tools/                  # 本機工具（.git/info/exclude 排除，不進 git）
│   ├── build_weekly.py  fetch_period.py  publish_report.py   # 出刊流程
│   ├── vocab/              # export_vocab.py（補字到 Sheet）、test_gas.mjs（後端離線測試）、make_icons.py
│   ├── vocab_api.json      # {url, token}：出刊自動補字用（不進 git）
│   └── _archive/           # 不再使用的一次性腳本
└── .nojekyll
```

英文對照檔格式（沒有這個檔時網站照常顯示中文，只是不出現「中 / EN」切換）：

```json
{
  "source": "全球半導體代工產業快報_20260922-20260923.xlsx",
  "news": {
    "1": { "entity": "…", "title": "…", "summary": "…", "metric": "…", "impact": "…",
           "conf": "Confirmed (…)",
           "vocab": [["gross margin", "毛利率", "fin"], ["yield", "良率"]] }
  }
}
```

字彙第三欄 `"fin"` 代表財經用語。由 `tools/build_weekly.py`（本機產生器，以 .git/info/exclude 排除、不進 git）產生：內容 JSON 加上與 `news`
逐列對應的 `news_en`（字典沒有的字放 `glossary_add`），產生器會同時寫出 Excel、`data/en/` 對照檔並擴充字典；
財經用語依 `finance_terms.json` 自動標記。Excel 本身格式不變。

`glossary.json` 的鍵：縮寫與大小寫混合的字（TSMC、CoWoS）保留原樣，其餘一律小寫；網站查字時先比原樣、
再比小寫、再去掉所有格 's，連字號複合字查不到就拆開逐段查（規則與產生器一致）。

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

把 `.xlsx` **拖曳到網頁上**任何位置。純本機解析，適合週報還沒定稿時先預覽。

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

然後開 <http://localhost:8765>；單字複習開 <http://localhost:8765/study/?demo>（示範模式：讀真實單字，但作答與收藏不寫回 Sheet）。
改了 `study/` 或共用的 `assets/shell.css`、`assets/wordbook.js` 之後，把 `study/sw.js` 的 `CACHE` 版本號加 1，手機上的 App 才會換新。

---

## 單字複習與後端

- 第一次在新裝置用：單字複習 →「設定」貼上 token（Apps Script 的 `API_TOKEN`）。快報與單字複習同網域，設定一次兩頁共用。
- 作答先存在裝置上，約 1.5 秒後整批送出；離線時累積，連上網路自動補送（每筆帶 `rid` 防重送）。
- 收藏（☆）：兩頁共用 `assets/wordbook.js`，寫進 Words 的 `saved`／`saved_at`；本機還沒送出的動作優先，其餘以時間較新的一方為準。
  任一頁打開時都會補送佇列裡的收藏。收藏的字在「今日」新字中優先出題。
- 桌機快捷鍵：空白鍵翻面、`1` 答錯、`2` 答對、`3` 很簡單、`S` 發音、`Esc` 結束。
- 網址參數：快報 `?r=<檔名>&lang=en&n=<序號>`（開某一期、切英文、捲到某一則）；單字複習 `?src=<檔名>`（練某一期）、`#saved`（單字本只看收藏）。
- 舊網址 jasonzhi731.github.io/news-vocab/ 由 news-vocab repo 的 `docs/` 轉址到這裡（該 repo 只剩轉址，保留勿刪）。

### 架構

| 層 | 做法 | 理由 |
|---|---|---|
| 前端 | `study/`：純 HTML + 原生 JS，無建置流程；manifest + service worker 做 PWA | 跟快報同一個網站、同一套寫法 |
| API | GAS Web App：`doGet` 讀、`doPost` 寫 | 免費、免伺服器 |
| 資料 | Google Sheets 三張表：內容／進度／紀錄分開 | 重新匯入單字不會蓋掉複習進度 |
| SRS | **在後端計算**（SM-2 變體），前端只送「答對／答錯」 | 排程規則只存在一處；多裝置一致 |
| 離線 | 前端把作答排進佇列，有網路時整批 POST；每筆帶 `rid` 防重送 | 捷運上也能刷 |
| AI | GAS 代為呼叫 Gemini（或 Claude）API，結果快取在 Sheet | API key 只在 Script Properties，不進前端、不進 repo |

### Google Sheets 欄位

#### `Words`（單字內容：匯入工具與 AI 快取寫入，可手動編修）

| 欄 | 說明 | 範例 |
|---|---|---|
| `id` | 主鍵＝單字小寫、空白壓成一格 | `gross margin` |
| `word` | 原始寫法 | `gross margin` |
| `meaning_zh` | 中文解釋（重新匯入時**不覆蓋**你手改過的內容） | `毛利率` |
| `category` | `fin`＝財經用語；空白＝一般 | `fin` |
| `first_seen` / `last_seen` | 第一次／最近一次出現在哪一期（期間起訖日） | `2026-09-02` |
| `freq` | 在所有期別中出現的次數 | `23` |
| `context_en` | 原新聞中含這個字的那一句（閃卡背面的情境例句） | |
| `source` | 出處：`檔名#新聞序號` | `全球半導體代工產業快報_20261125-20261127#1` |
| `ai_examples` | AI 產生的例句（JSON：`[{en, zh, field}]`） | |
| `ai_model` / `ai_updated_at` | 產生例句的模型與時間 | |
| `added_at` | 加入 Sheet 的時間 | |
| `active` | 改成 `FALSE` 就不再出題 | `TRUE` |

#### `Progress`（複習狀態：只由 App 寫入；沒有列＝新字）

| 欄 | 說明 |
|---|---|
| `id` | 對應 Words.id |
| `due` | 下次複習日 `yyyy-MM-dd`（台北時間） |
| `interval` | 目前間隔天數 |
| `ease` | 難易係數（預設 2.5，最低 1.3） |
| `reps` | 連續答對次數 |
| `lapses` | 累計答錯（遺忘）次數 |
| `last_review` / `last_grade` | 最近一次作答時間與評分 |
| `total_reviews` | 總作答次數 |
| `created` | 第一次學這個字的日期（用來控制每日新字上限） |

#### `Log`（作答紀錄，只追加）

`ts, id, grade, prev_interval, new_interval, due, client_ts, rid`

日期類欄位一律存成純文字，避免 Sheets 自動轉日期造成時區偏移。

### SRS 規則（`nextSchedule_`）

評分：`0` 答錯／`1` 有點難／`2` 答對／`3` 很簡單（前端可以只做「答錯／答對」兩顆鈕）

| 情況 | 新間隔 | ease |
|---|---|---|
| 答錯 | 1 天，連續答對歸零 | −0.20 |
| 第 1 次答對 | 1 天（很簡單 4 天） | 難 −0.15／易 +0.15 |
| 第 2 次答對 | 6 天（難 3、易 8） | 同上 |
| 之後 | 間隔 × ease（難 ×1.2、易 ×ease×1.3），至少 +1 天，上限 365 | 同上 |

每日新字預設 20 個（`?action=due&newLimit=`）。當次答錯的卡要在同一輪再出一次，由前端處理。

### API

`GET {WEB_APP_URL}?action=...`

| action | 回傳 |
|---|---|
| `ping` | `{ok, today}` |
| `words` | 全部單字＋各自的 `progress`（`&all=1` 含停用字） |
| `due` | 今日佇列 `{due:[...], new:[...], counts}`；參數 `limit`、`newLimit` |
| `stats` | 總數、已學、到期、熟練（間隔 ≥ 21 天）、各分類數 |

POST 另有 `auth`（只驗證 token）、`saveWords`（收藏／取消，`items:[{word, saved, ts, …}]`；GET `?action=saved` 讀回）；`upsertWords` 的字帶 `context_refresh: true` 時會覆蓋新聞原句
（`tools/vocab/export_vocab.py --push --refresh-context`）。

`POST {WEB_APP_URL}`，**`Content-Type: text/plain;charset=utf-8`**，body 為 JSON：

```jsonc
{ "token": "…", "action": "review",
  "reviews": [{ "id": "tariff", "grade": 2, "ts": "2026-11-27T08:00:00Z", "rid": "uuid" }] }
{ "token": "…", "action": "upsertWords", "words": [{ "word": "…", "meaning_zh": "…", … }] }
{ "token": "…", "action": "aiExamples", "id": "tariff", "force": false }
```

所有回應都是 `{ok: true, ...}` 或 `{ok: false, code, error}`（GAS 不能設 HTTP 狀態碼，錯誤碼放在 body）。

> 為什麼用 `text/plain`：`application/json` 會觸發 CORS preflight（OPTIONS），GAS 不處理 OPTIONS，
> 瀏覽器會直接擋下。`text/plain` 是「簡單請求」，GAS 照樣能從 `e.postData.contents` 讀到 JSON。

### 部署步驟

1. 新增一份 Google 試算表（例如「News Vocab DB」）→「擴充功能 → Apps Script」。
2. 把 `backend/Code.gs` 整份貼進 `Code.gs`。顯示 `appsscript.json`：專案設定 → 勾「在編輯器中顯示 appsscript.json」，貼上 `backend/appsscript.json`。
3. 函式選 `setup` → 執行 → 授權。執行記錄會印出 `API_TOKEN`（之後在 專案設定 → 指令碼屬性 也看得到）。
4. 選 `testSchedule` 執行一次，確認記錄裡的間隔是 1 → 6 → 15 → 1 → 1 → 8。
5. 部署 → 新增部署作業 → 類型「網頁應用程式」：執行身分「我」、存取權「所有人」→ 複製 `/exec` 網址。
   之後改程式碼要「管理部署作業 → 編輯 → 版本選『新版本』」，網址才會吃到新程式。
6. 匯入單字（在本機 PowerShell）：
   ```powershell
   $env:VOCAB_API_URL = "https://script.google.com/macros/s/XXXX/exec"
   $env:VOCAB_API_TOKEN = "setup 印出的 token"
   & "C:\Users\derek.huang\AppData\Local\Programs\Python\Python312\python.exe" tools\vocab\export_vocab.py --push
   ```
   之後每期出刊時 `publish_report.py` 會自動跑 `export_vocab.py --push --only <那一期>`（只送那一期出現的字；
   出現次數仍以全部各期計算），token 放在 `tools/vocab_api.json`。`--csv` 可另存 `tools/vocab/words_seed.csv` 檢視。
7. 驗證：瀏覽器開 `…/exec?action=stats`，應看到 `total: 2426`。
8. （選用）AI 例句：指令碼屬性加 `GEMINI_API_KEY`（Google AI Studio 建立的金鑰），執行 `testAi` 看例句。
   預設模型 `gemini-3.8-flash`（屬性 `GEMINI_MODEL` 可改）、思考程度 `low`（`GEMINI_THINKING`）。
   App 的「設定 → AI 例句模型」可自選模型（由便宜到貴、標免費／需付費；清單在 `CFG.AI_CATALOG`，`GET ?action=aiModels` 讀取並標出金鑰看不到的模型），選擇存在各裝置。
   也可改用 Claude：加 `ANTHROPIC_API_KEY`，兩把都有時用 `AI_PROVIDER = gemini | claude` 指定（預設 Gemini）；
   Claude 預設 `claude-opus-5-5`、effort `low`（`AI_MODEL`、`AI_EFFORT`）。
   例句產生一次就存回 Sheet，同一個字之後不會重複計費（`force: true` 才會重產）。

### 安全說明

- 讀取預設不需 token（單字來自公開新聞）；要鎖起來就把指令碼屬性 `READ_TOKEN_REQUIRED` 設為 `true`。
- 寫入一律要 token。前端不把 token 寫進程式碼，而是第一次開 App 時在設定頁輸入、存在該裝置。
- Gemini／Anthropic API key 只放在 Script Properties，由 GAS 代為呼叫（Gemini 金鑰放在 header，不出現在網址）。

### 測試

```powershell
node tools\vocab\test_gas.mjs
```

以假的 SpreadsheetApp 等物件在本機跑完整流程：setup、token 驗證、匯入／重匯入不蓋手改、今日佇列排序、
作答與 `rid` 去重、每日新字上限、隔日到期、stats、未設 key 時 AI 回 501。

---

## 授權與聲明

`vendor/xlsx.full.min.js` 為 SheetJS Community Edition（Apache-2.0）。
本頁僅呈現使用者提供的資料，不構成任何投資建議。
