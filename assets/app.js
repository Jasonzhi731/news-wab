/* ============================================================
   半導體產業快報閱讀器
   這支程式不含任何新聞內容 —— 畫面上的一切都來自使用者的 Excel。
   解析全在瀏覽器端完成，檔案不會被上傳。
   ============================================================ */
(function () {
  'use strict';

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- 欄位別名：讓不同版本的週報都能對上 ---------- */
  var NEWS_COLS = {
    no:      ['序號', '編號', '#', 'no'],
    date:    ['日期', '時間', 'date'],
    cat:     ['分類', '類別', 'category'],
    entity:  ['主體/公司', '主體', '公司', '對象', 'company'],
    title:   ['標題', 'title'],
    summary: ['重點摘要', '摘要', '內容', 'summary'],
    metric:  ['關鍵數據', '數據', 'metrics'],
    impact:  ['影響/觀察', '影響', '觀察', 'impact'],
    source:  ['來源', '媒體', 'source'],
    link:    ['連結', '網址', '原文連結', 'url', 'link'],
    conf:    ['資料確認度', '確認度', '可信度', 'confidence']
  };
  var DATA_COLS = {
    cat:  ['類別', '分類', 'category'],
    item: ['項目', '指標', 'item'],
    val:  ['數值', '值', 'value'],
    desc: ['說明', '備註', 'note'],
    src:  ['來源 / 日期', '來源/日期', '來源', 'source']
  };

  /* ---------- 分類：英文名稱與色系（色值定義在 app.css 的 --c-* 變數） ---------- */
  var CAT_META = {
    '政策/關稅':   { en: 'Policy & Tariffs',       c: 'rose' },
    '總體數據':    { en: 'Macro Data',             c: 'sky' },
    '財報營收':    { en: 'Earnings & Revenue',     c: 'emerald' },
    '資本支出':    { en: 'CapEx',                  c: 'emerald' },
    '市場行情':    { en: 'Markets',                c: 'amber' },
    '價格/報價':   { en: 'Pricing',                c: 'amber' },
    '產能/技術':   { en: 'Capacity & Technology',  c: 'violet' },
    '技術/製程':   { en: 'Process Technology',     c: 'violet' },
    '產能擴充':    { en: 'Capacity Expansion',     c: 'violet' },
    '供應鏈':      { en: 'Supply Chain',           c: 'teal' },
    '供應鏈/封裝': { en: 'Supply Chain & Packaging', c: 'teal' },
    '展會/展望':   { en: 'Events & Outlook',       c: 'fuchsia' },
    '客戶/訂單':   { en: 'Customers & Orders',     c: 'orange' }
  };
  function catColor(cat) { return (CAT_META[cat] && CAT_META[cat].c) || 'slate'; }
  function catEn(cat) { return (CAT_META[cat] && CAT_META[cat].en) || cat; }

  /* ---------- 狀態 ---------- */
  var report = null;                       // 解析後的整份週報
  var state = {
    tab: 'news',
    cats: [], dates: [], ents: [],
    dcats: [],
    lang: {},                              // 每則新聞目前顯示的語言：{ 序號: 'en' }，預設中文
    vscope: 'report',                      // 字彙分頁：'report' 本期 / 'saved' 我的收藏
    vhide: false,                          // 字彙分頁：遮住中文自我測驗
    vtype: ''                              // 字彙分頁：'' 全部 / 'fin' 財經用語 / 'general' 一般字彙
  };

  /* ---------- 收藏的單字：存在這台瀏覽器（跨期保留） ---------- */
  var SAVED_KEY = 'wr-vocab-saved';
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function storeSaved(m) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(m)); } catch (e) {}
  }
  var saved = loadSaved();

  /* ============================================================
     工具
     ============================================================ */
  function norm(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return fmtDate(v);
    return String(v).replace(/　/g, ' ').trim();
  }
  function fmtDate(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate());
  }
  function weekdayOf(s) {
    var m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(s);
    if (!m) return '';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (isNaN(d)) return '';
    return '週' + '日一二三四五六'[d.getDay()];
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isHttp(u) { return /^https?:\/\//i.test(u); }
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // 完整的年/月/日才省略年份（2026/09/22 → 09/22）；「2026/08」這種只到月的保持原樣
  function shortDate(s) {
    return /^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(s) ? s.replace(/^\d{4}[\/\-.]/, '') : s;
  }

  // 日期字串轉成可比大小的數字；非日期（例如「本週背景」）回傳 -1
  function dateKey(s) {
    var m = /^(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?/.exec(String(s || ''));
    if (!m) return -1;
    return (+m[1]) * 10000 + (+m[2]) * 100 + (+(m[3] || 0));
  }
  // 由新到舊排序：同一天維持 Excel 原本的順序，沒有日期的排在最後
  function sortNewestFirst(items) {
    return items
      .map(function (it, i) { return { it: it, i: i, k: dateKey(it.date) }; })
      .sort(function (a, b) { return a.k !== b.k ? b.k - a.k : a.i - b.i; })
      .map(function (x) { return x.it; });
  }

  /* ============================================================
     Excel 解析
     ============================================================ */
  function pickSheet(wb, keywords) {
    for (var i = 0; i < wb.SheetNames.length; i++) {
      var n = wb.SheetNames[i];
      for (var k = 0; k < keywords.length; k++) {
        if (n.indexOf(keywords[k]) >= 0) return wb.Sheets[n];
      }
    }
    return null;
  }

  function rowsOf(sheet) {
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: '' });
  }

  // 在前 20 列裡找出標題列：命中最多欄位別名的那一列
  function findHeader(rows, colmap) {
    var aliases = [];
    Object.keys(colmap).forEach(function (k) { aliases = aliases.concat(colmap[k]); });
    var best = -1, bestHits = 0;
    for (var r = 0; r < Math.min(rows.length, 20); r++) {
      var hits = 0;
      (rows[r] || []).forEach(function (c) {
        var v = norm(c);
        if (v && aliases.some(function (a) { return v === a || v.indexOf(a) === 0; })) hits++;
      });
      if (hits > bestHits) { bestHits = hits; best = r; }
    }
    return bestHits >= 3 ? best : -1;
  }

  // 依標題列建立 欄位鍵 -> 欄索引 的對照
  function mapCols(headerRow, colmap) {
    var idx = {}, extras = [];
    (headerRow || []).forEach(function (cell, c) {
      var v = norm(cell);
      if (!v) return;
      var matched = null;
      Object.keys(colmap).forEach(function (key) {
        if (matched) return;
        if (colmap[key].some(function (a) { return v === a; })) matched = key;
      });
      if (!matched) {
        Object.keys(colmap).forEach(function (key) {
          if (matched || idx[key] !== undefined) return;
          if (colmap[key].some(function (a) { return v.indexOf(a) >= 0; })) matched = key;
        });
      }
      if (matched && idx[matched] === undefined) idx[matched] = c;
      else if (!matched) extras.push({ col: c, name: v });
    });
    return { idx: idx, extras: extras };
  }

  function parseNews(sheet) {
    var rows = rowsOf(sheet);
    if (!rows.length) return { items: [], extras: [] };
    var hr = findHeader(rows, NEWS_COLS);
    if (hr < 0) return { items: [], extras: [] };
    var m = mapCols(rows[hr], NEWS_COLS);
    var items = [];
    for (var r = hr + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var get = function (key) {
        return m.idx[key] === undefined ? '' : norm(row[m.idx[key]]);
      };
      var o = {
        no: get('no'), date: get('date'), cat: get('cat'), entity: get('entity'),
        title: get('title'), summary: get('summary'), metric: get('metric'),
        impact: get('impact'), source: get('source'), link: get('link'), conf: get('conf'),
        extras: {}
      };
      m.extras.forEach(function (e) {
        var v = norm(row[e.col]); if (v) o.extras[e.name] = v;
      });
      // 標題或摘要任一有值才算一筆
      if (!o.title && !o.summary) continue;
      items.push(o);
    }
    return { items: items, extras: m.extras.map(function (e) { return e.name; }) };
  }

  function parseData(sheet) {
    var rows = rowsOf(sheet);
    if (!rows.length) return [];
    var hr = findHeader(rows, DATA_COLS);
    if (hr < 0) return [];
    var m = mapCols(rows[hr], DATA_COLS);
    var out = [];
    for (var r = hr + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var get = function (k) { return m.idx[k] === undefined ? '' : norm(row[m.idx[k]]); };
      var o = { cat: get('cat'), item: get('item'), val: get('val'), desc: get('desc'), src: get('src') };
      if (!o.item && !o.val) continue;
      out.push(o);
    }
    return out;
  }

  // 說明分頁要保留行首縮排（用來判斷條列與續行），所以不套用 norm() 的左側 trim
  function parseNotes(sheet) {
    var rows = rowsOf(sheet);
    return rows.map(function (r) {
      var v = (r || [])[0];
      if (v === null || v === undefined) return '';
      return String(v).replace(/　/g, ' ').replace(/\s+$/, '');
    });
  }

  function parseWorkbook(wb, label) {
    var nsheet = pickSheet(wb, ['新聞', 'news', '彙整']);
    var dsheet = pickSheet(wb, ['重點數據', '數據', 'data', '指標']);
    var tsheet = pickSheet(wb, ['說明', '方法', 'note', '備註']);
    if (!nsheet) nsheet = wb.Sheets[wb.SheetNames[0]];

    var news = parseNews(nsheet);
    var head = rowsOf(nsheet);
    var title = norm((head[0] || [])[0]) || label || '半導體產業快報';
    var sub = norm((head[1] || [])[0]);
    // 若 A1/A2 剛好就是標題列，代表這份檔沒有標題區，改用檔名
    if (/序號|日期/.test(title)) { title = label || '半導體產業快報'; sub = ''; }

    return {
      label: label,
      title: title,
      subtitle: sub,
      news: sortNewestFirst(news.items),
      newsExtras: news.extras,
      data: dsheet ? parseData(dsheet) : [],
      notes: tsheet ? parseNotes(tsheet) : [],
      sheetNames: wb.SheetNames.slice()
    };
  }

  /* ============================================================
     載入來源
     ============================================================ */
  function readWorkbook(buf) {
    return XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
  }

  // 英文對照檔：data/en/<Excel 檔名去掉副檔名>.json，以「序號」對應每一則新聞。
  // Excel 本身維持原樣不動；沒有對照檔時網站照常顯示中文，只是不出現語言切換鈕。
  function loadEnglish(fileName) {
    var base = String(fileName || '').replace(/\.[^.]+$/, '');
    if (!base) return Promise.resolve(null);
    return Promise.all([
      fetch('data/en/' + encodeURIComponent(base) + '.json', { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; }),
      loadGlossary()
    ]).then(function (r) { return r[0]; });
  }

  // 全站共用的英中字典 data/en/glossary.json：英文模式下點任一字查中文。只載一次
  var gloss = {}, glossPromise = null;
  function loadGlossary() {
    if (!glossPromise) {
      glossPromise = fetch('data/en/glossary.json', { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; })
        .then(function (g) { gloss = g || {}; });
    }
    return glossPromise;
  }

  function loadFromUrl(url, label) {
    var name = decodeURIComponent(url.split('/').pop());
    return Promise.all([
      fetch(url).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      }),
      loadEnglish(name)
    ]).then(function (r) {
      var rpt = parseWorkbook(readWorkbook(r[0]), label || name);
      rpt.en = r[1];
      show(rpt);
    });
  }

  function loadFromFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var rpt;
      try {
        rpt = parseWorkbook(readWorkbook(fr.result), file.name.replace(/\.[^.]+$/, ''));
      } catch (e) {
        alert('無法解析這個檔案：' + e.message);
        return;
      }
      // 拖進來的檔案若與網站上某期同名，一樣套用它的英文對照
      loadEnglish(file.name).then(function (en) { rpt.en = en; show(rpt); });
    };
    fr.readAsArrayBuffer(file);
  }

  /* ============================================================
     呈現
     ============================================================ */
  function show(rpt) {
    report = rpt;
    state.cats = []; state.dates = []; state.ents = [];
    state.dcats = [];
    state.lang = {};

    $('#stage-empty').hidden = true;
    $('#stage-report').hidden = false;

    $('#rpt-title').textContent = rpt.title;
    $('#rpt-sub').textContent = rpt.subtitle;
    $('#foot-src').textContent = '資料來源：' + rpt.label + '（' + rpt.sheetNames.join('、') + '）';
    document.title = rpt.title;

    // 日期欄可能出現「本週背景」這類非日期字樣，算範圍時只取真的日期
    var dates = uniq(rpt.news.map(function (n) { return n.date; }))
      .filter(function (d) { return /^\d{4}[\/\-.]\d{1,2}/.test(d); }).sort();
    var nEn = rpt.news.filter(function (n) { return !!enOf(n); }).length;
    $('#rpt-stats').innerHTML =
      stat('新聞', rpt.news.length, '則') +
      stat('重點數據', rpt.data.length, '筆') +
      (dates.length ? stat('新聞日期', shortDate(dates[0]) +
        (dates.length > 1 ? ' – ' + shortDate(dates[dates.length - 1]) : ''), '') : '') +
      stat('英文對照', nEn ? nEn + ' / ' + rpt.news.length : '—', nEn ? '則' : '');
    $('#hero-eyebrow').textContent = nEn ? 'FOUNDRY BRIEF · 中英對照' : 'FOUNDRY BRIEF';
    renderMix();

    $('#tabcount-news').textContent = rpt.news.length;
    $('#tabcount-data').textContent = rpt.data.length;
    $('#tabcount-vocab').textContent = reportVocab().length || '';
    $('#btn-all-lang').hidden = !nEn;
    $('#en-hint').hidden = !nEn;
    $('#en-hint').textContent = canSpeak
      ? '英文模式：點任一個字看中文，字彙按 🔊 聽發音'
      : '英文模式：點任一個字看中文';

    buildFilters();
    buildDataFilter();
    renderNotes();
    renderNews();
    renderData();
    renderVocab();
    syncTopbarHeight();
    window.scrollTo(0, 0);
  }

  function stat(k, v, unit) {
    return '<div class="stat"><span>' + esc(k) + '</span><b>' + esc(v) +
           (unit ? '<small>' + esc(unit) + '</small>' : '') + '</b></div>';
  }

  // 標題區的分類比例條：點圖例可直接篩選該分類
  function renderMix() {
    var cats = countBy(report.news, 'cat'), total = report.news.length || 1;
    var keys = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; });
    $('#rpt-mix').innerHTML =
      '<div class="mix-bar">' + keys.map(function (c) {
        return '<i class="c-' + catColor(c) + '" style="flex:' + cats[c] + '" title="' +
               esc(c) + ' ' + cats[c] + ' 則"></i>';
      }).join('') + '</div>' +
      '<div class="mix-legend">' + keys.map(function (c) {
        return '<button type="button" class="c-' + catColor(c) + '" data-cat="' + esc(c) + '">' +
               '<i></i>' + esc(c) + '<b>' + Math.round(cats[c] / total * 100) + '%</b></button>';
      }).join('') + '</div>';
  }

  function uniq(a) {
    var seen = {}, out = [];
    a.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }
  function countBy(items, key) {
    var m = {};
    items.forEach(function (i) { var v = i[key]; if (v) m[v] = (m[v] || 0) + 1; });
    return m;
  }

  /* ---------- 篩選下拉選單 ---------- */
  function optionHtml(value, label, count, on) {
    return '<option value="' + esc(value) + '"' + (on ? ' selected' : '') + '>' +
           esc(label) + '（' + count + '）</option>';
  }

  function buildFilters() {
    var n = report.news;

    // 分類：依 Excel 裡出現的順序
    var cats = countBy(n, 'cat');
    $('#s-cat').innerHTML =
      optionHtml('', '全部分類', n.length, !state.cats.length) +
      Object.keys(cats).map(function (c) {
        return optionHtml(c, c, cats[c], state.cats[0] === c);
      }).join('');

    // 日期：由新到舊
    var dts = countBy(n, 'date');
    var dkeys = Object.keys(dts).sort(function (a, b) { return dateKey(b) - dateKey(a); });
    $('#s-date').innerHTML =
      optionHtml('', '全部日期', n.length, !state.dates.length) +
      dkeys.map(function (d) {
        var wd = weekdayOf(d);
        return optionHtml(d, shortDate(d) + (wd ? ' ' + wd : ''),
                          dts[d], state.dates[0] === d);
      }).join('');

    // 主體：依則數多寡排序
    // 用「主要關鍵字」歸戶：先去掉括號內容（股號、成員列舉），再依分隔符切開
    var ents = {};
    n.forEach(function (i) {
      keyEntities(i.entity).forEach(function (e) { ents[e] = (ents[e] || 0) + 1; });
    });
    var ekeys = Object.keys(ents).sort(function (a, b) {
      return ents[b] - ents[a] || a.localeCompare(b);
    });
    $('#s-ent').innerHTML =
      optionHtml('', '全部主體', n.length, !state.ents.length) +
      ekeys.map(function (e) {
        return optionHtml(e, e, ents[e], state.ents[0] === e);
      }).join('');
  }

  // 先拿掉括號內容（股號、成員列舉），再依分隔符切開，避免把括號切成兩半
  function keyEntities(entity) {
    return String(entity || '')
      .replace(/[（(][^)）]*[)）]/g, ' ')
      .split(/[\/、,，]/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function buildDataFilter() {
    var cats = countBy(report.data, 'cat');
    $('#s-dcat').innerHTML =
      optionHtml('', '全部類別', report.data.length, !state.dcats.length) +
      Object.keys(cats).map(function (c) {
        return optionHtml(c, c, cats[c], state.dcats[0] === c);
      }).join('');
  }

  /* ---------- 新聞 ---------- */
  function filteredNews() {
    return report.news.filter(function (i) {
      if (state.cats.length && state.cats.indexOf(i.cat) < 0) return false;
      if (state.dates.length && state.dates.indexOf(i.date) < 0) return false;
      if (state.ents.length) {
        var ks = keyEntities(i.entity);
        if (!state.ents.some(function (e) { return ks.indexOf(e) >= 0; })) return false;
      }
      return true;
    });
  }

  function renderNews() {
    var list = filteredNews();
    $('#result-count').textContent = '顯示 ' + list.length + ' / ' + report.news.length + ' 則';
    $('#news-none').hidden = list.length > 0;
    $('#news-cards').hidden = !list.length;
    closePop();
    renderCards(list);
    syncAllLangBtn();
  }

  function renderCards(list) {
    var html = '', lastDate = null;
    var perDate = countBy(list, 'date');
    list.forEach(function (i) {
      if (i.date !== lastDate) {
        lastDate = i.date;
        var wd = weekdayOf(i.date);
        var isDate = dateKey(i.date) > 0;
        html += '<div class="date-head' + (isDate ? '' : ' is-bg') + '">' +
                '<b>' + esc(isDate ? shortDate(i.date) : (i.date || '未標日期')) + '</b>' +
                (wd ? '<span class="wd">' + wd + '</span>' : '') +
                (isDate ? '' : '<span class="wd">區間外、理解本期必要的背景</span>') +
                '<span class="line"></span><span class="cnt">' + (perDate[i.date] || 0) + ' 則</span></div>';
      }
      html += cardHtml(i);
    });
    $('#news-cards').innerHTML = html;
  }

  function keyOf(i) { return i.no || i.title; }
  function enOf(i) {
    var m = report && report.en && report.en.news;
    var e = m && i.no ? m[i.no] : null;
    return e && e.title ? e : null;
  }
  function isWarn(conf) { return /待確認|預估|傳聞|未證實|揣測|非公司公告|草案|待驗證|Unconfirmed|Unverified/i.test(conf); }

  function isFin(v) { return v && v[2] === 'fin'; }

  /* ---- 英文內文 ----
     1. 本則的重點字彙包成 <mark>：螢光筆底、滑過（手機點一下）顯示中文。每個字只標第一次出現
     2. 其餘每個英文字包成 <span class="w">：點一下跳出中文（查 data/en/glossary.json）
     斷字與查字規則必須與 foundry-weekly-tools/build_weekly.py 的 TOKEN_RE / gloss_lookup 一致 */
  var TOKEN_RE = /[A-Za-z0-9À-ɏ]+(?:[-'’][A-Za-z0-9À-ɏ]+)*/g;

  function glossLookup(tok) {
    tok = tok.replace(/’/g, "'");
    var stripped = tok.replace(/'s$/i, '');
    var cands = [tok, tok.toLowerCase(), stripped, stripped.toLowerCase()];
    for (var i = 0; i < cands.length; i++) {
      if (Object.prototype.hasOwnProperty.call(gloss, cands[i])) return cands[i];
    }
    return null;
  }

  function wordSpan(tok) {
    if (/\d/.test(tok)) return esc(tok);               // 2nm、Q3、A14 這類不查
    var k = glossLookup(tok);
    if (k) return '<span class="w" data-k="' + esc(k) + '">' + esc(tok) + '</span>';
    if (tok.indexOf('-') > 0) return tok.split('-').map(wordSpan).join('-');   // 複合字查不到就拆開查
    return esc(tok);
  }

  function wrapWords(text) {
    var out = '', last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      out += esc(text.slice(last, m.index)) + wordSpan(m[0]);
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  function enHtml(text, vocab, seen) {
    text = String(text || '');
    if (!vocab || !vocab.length) return wrapWords(text);
    var byTerm = {};
    var terms = vocab.map(function (v) { byTerm[v[0].toLowerCase()] = v; return v[0]; })
      .sort(function (a, b) { return b.length - a.length; });
    var re = new RegExp('(^|[^A-Za-z0-9])(' + terms.map(escRe).join('|') +
                        ')((?:s|es|d|ed)?)(?![A-Za-z0-9])', 'gi');
    var out = '', last = 0, m;
    while ((m = re.exec(text))) {
      var v = byTerm[m[2].toLowerCase()];
      var start = m.index + m[1].length;
      if (!v || seen[v[0].toLowerCase()]) continue;
      seen[v[0].toLowerCase()] = 1;
      out += wrapWords(text.slice(last, start)) +
             '<mark class="vw' + (isFin(v) ? ' fin' : '') + '" tabindex="0" data-t="' + esc(v[0]) +
             '" data-zh="' + esc(v[1]) + '"' + (isFin(v) ? ' data-fin="1"' : '') + '>' +
             esc(m[2] + m[3]) + '</mark>';
      last = start + m[2].length + m[3].length;
    }
    return out + wrapWords(text.slice(last));
  }

  function cardHtml(i) {
    var en = enOf(i);
    var isEn = !!en && state.lang[keyOf(i)] === 'en';
    var bg = dateKey(i.date) < 0;
    var h = '<article class="card c-' + catColor(i.cat) + (isEn ? ' is-en' : '') + (bg ? ' is-bg' : '') +
            '" data-key="' + esc(keyOf(i)) + '"' + (isEn ? ' lang="en"' : '') + '>';

    h += '<div class="card-top"><div class="tags">';
    if (i.cat)    h += '<span class="tag cat">' + esc(isEn ? catEn(i.cat) : i.cat) + '</span>';
    if (i.entity) h += '<span class="tag ent">' + esc(isEn && en.entity ? en.entity : i.entity) + '</span>';
    if (bg)       h += '<span class="tag bgt">' + (isEn ? 'Background' : '本期背景') + '</span>';
    h += '</div>';
    if (en) {
      h += '<div class="lang" role="group" aria-label="切換這則新聞的語言">' +
           '<button type="button" data-lang="zh" aria-pressed="' + !isEn + '">中</button>' +
           '<button type="button" data-lang="en" aria-pressed="' + isEn + '">EN</button></div>';
    }
    h += '</div>';

    var seen = {};
    var tx = function (zhText, enText) {
      return isEn ? enHtml(enText, en.vocab, seen) : esc(zhText);
    };
    var title = isEn ? en.title : i.title;
    var t = tx(i.title, en && en.title);
    if (isEn) {
      // 英文標題的每個字都要能點來查義，所以標題本身不做成連結，只留 ↗ 連到原文
      h += '<h3>' + t + (isHttp(i.link)
          ? '<a class="ext" href="' + esc(i.link) + '" target="_blank" rel="noopener" title="Original article">↗</a>' : '') + '</h3>';
    } else {
      h += '<h3>' + (isHttp(i.link)
          ? '<a href="' + esc(i.link) + '" target="_blank" rel="noopener">' + t + '<span class="ext">↗</span></a>'
          : t) + '</h3>';
    }

    if (i.summary) h += '<p class="summary">' + tx(i.summary, en && en.summary) + '</p>';

    var kv = '';
    // 關鍵數據只填「—」時不佔一格
    if (i.metric && !/^[—–-]+$/.test(i.metric)) kv += '<div class="kv-item metric"><span class="k">' + (isEn ? 'Key figures' : '關鍵數據') +
                        '</span><span class="v">' + tx(i.metric, en && en.metric) + '</span></div>';
    if (i.impact) kv += '<div class="kv-item impact"><span class="k">' + (isEn ? 'Why it matters' : '影響觀察') +
                        '</span><span class="v">' + tx(i.impact, en && en.impact) + '</span></div>';
    if (!isEn) {
      Object.keys(i.extras).forEach(function (k) {
        kv += '<div class="kv-item"><span class="k">' + esc(k) + '</span><span class="v">' + esc(i.extras[k]) + '</span></div>';
      });
    }
    if (kv) h += '<div class="kv">' + kv + '</div>';

    if (isEn && en.vocab && en.vocab.length) {
      // 財經用語排前面；每個字卡左邊 🔊 朗讀，其餘部分點一下收藏（與原本相同）
      var vs = en.vocab.filter(isFin).concat(en.vocab.filter(function (v) { return !isFin(v); }));
      h += '<div class="vocab"><span class="vocab-k">Vocabulary</span>' + vs.map(function (v) {
        var on = !!saved[v[0].toLowerCase()];
        return '<span class="vchip' + (on ? ' is-saved' : '') + (isFin(v) ? ' fin' : '') + '">' +
               sayBtn(v[0]) +
               '<button type="button" class="vsave" data-term="' + esc(v[0]) + '" data-zh="' + esc(v[1]) +
               '" data-ctx="' + esc(title) + '"' + (isFin(v) ? ' data-fin="1"' : '') +
               ' title="' + (on ? '已收藏，點一下取消' : '點一下收藏到單字本') + '">' +
               (isFin(v) ? '<em>財經</em>' : '') +
               '<b>' + esc(v[0]) + '</b><span>' + esc(v[1]) + '</span><i>' + (on ? '★' : '☆') + '</i></button></span>';
      }).join('') + '</div>';
    }

    h += '<div class="card-foot">';
    if (i.no)     h += '<span class="no">#' + esc(i.no) + '</span>';
    if (i.source) h += '<span>' + (isEn ? 'Source: ' : '來源：') + esc(i.source) + '</span>';
    if (i.conf) {
      var conf = isEn && en.conf ? en.conf : i.conf;
      h += '<span class="badge ' + (isWarn(i.conf) ? 'warn' : 'ok') + '">' + esc(conf) + '</span>';
    }
    if (isHttp(i.link)) h += '<a class="orig" href="' + esc(i.link) + '" target="_blank" rel="noopener">' +
                             (isEn ? 'Original article' : '原文連結') + ' ↗</a>';
    h += '</div></article>';
    return h;
  }

  // 只重畫被切換的那一張卡，不動其他卡片與捲動位置
  function itemByKey(key) {
    var item = null;
    report.news.some(function (i) { if (keyOf(i) === key) { item = i; return true; } return false; });
    return item;
  }

  // 在查字小視窗收藏／取消後，同步新聞卡上同一個字的字彙卡星號
  function syncChipStars(term) {
    var k = term.toLowerCase(), on = !!saved[k];
    $$('#news-cards .vsave').forEach(function (b) {
      if (b.dataset.term.toLowerCase() !== k) return;
      b.parentNode.classList.toggle('is-saved', on);
      b.querySelector('i').textContent = on ? '★' : '☆';
    });
  }

  function rerenderCard(key) {
    var item = itemByKey(key);
    var el =$('.card[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
    if (!item || !el) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = cardHtml(item);
    el.parentNode.replaceChild(tmp.firstChild, el);
  }

  function syncAllLangBtn() {
    var withEn = report.news.filter(function (i) { return !!enOf(i); });
    var allEn = withEn.length && withEn.every(function (i) { return state.lang[keyOf(i)] === 'en'; });
    var b = $('#btn-all-lang');
    b.textContent = allEn ? '全部切回中文' : '全部切成英文';
    b.setAttribute('data-to', allEn ? 'zh' : 'en');
  }

  /* ---------- 英文字彙 ---------- */
  function reportVocab() {
    var out = [], seen = {};
    if (!report || !report.en) return out;
    report.news.forEach(function (i) {
      var en = enOf(i);
      if (!en || !en.vocab) return;
      en.vocab.forEach(function (v) {
        var k = v[0].toLowerCase();
        if (seen[k]) return;
        seen[k] = 1;
        out.push({ t: v[0], zh: v[1], ctx: en.title, cat: i.cat, fin: isFin(v) });
      });
    });
    return out;
  }

  function toggleSaved(t, zh, ctx, fin) {
    var k = t.toLowerCase();
    if (saved[k]) delete saved[k];
    else saved[k] = { t: t, zh: zh, ctx: ctx, fin: !!fin, at: Date.now() };
    storeSaved(saved);
  }

  function renderVocab() {
    var nSaved = Object.keys(saved).length;
    $('#v-saved-count').textContent = nSaved;
    var list;
    if (state.vscope === 'saved') {
      list = Object.keys(saved).map(function (k) { return saved[k]; })
        .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    } else {
      list = reportVocab();
    }
    if (state.vtype === 'fin') list = list.filter(function (v) { return v.fin; });
    else if (state.vtype === 'general') list = list.filter(function (v) { return !v.fin; });
    $('#vocab-none').hidden = list.length > 0;
    $('#vocab-none').textContent = state.vscope === 'saved'
      ? '還沒有收藏符合條件的單字。在英文模式的新聞卡上點任一個字、字彙卡或本頁字卡上的 ☆ 都能收藏。'
      : '這一期沒有符合條件的英文字彙。';
    $('#vocab-grid').classList.toggle('is-quiz', state.vhide);
    $('#vocab-grid').innerHTML = list.map(function (v) {
      var on = !!saved[v.t.toLowerCase()];
      return '<div class="vcard' + (v.cat ? ' c-' + catColor(v.cat) : '') + (v.fin ? ' fin' : '') + '">' +
        '<button type="button" class="vstar' + (on ? ' is-saved' : '') + '" data-term="' + esc(v.t) +
          '" data-zh="' + esc(v.zh) + '" data-ctx="' + esc(v.ctx || '') + '"' + (v.fin ? ' data-fin="1"' : '') +
          ' aria-label="收藏">' + (on ? '★' : '☆') + '</button>' +
        (v.fin ? '<em class="vfin">財經</em>' : '') +
        '<div class="vt" lang="en">' + sayBtn(v.t) + '<span>' + esc(v.t) + '</span></div>' +
        '<div class="vz" tabindex="0">' + esc(v.zh) + '</div>' +
        (v.ctx ? '<div class="vc" lang="en">' + esc(v.ctx) + '</div>' : '') +
      '</div>';
    }).join('');
  }

  /* ---------- 發音：瀏覽器內建的英文語音（Web Speech API），不需外部服務 ---------- */
  var canSpeak = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
  var voice = null;
  function pickVoice() {
    if (!canSpeak) return;
    var vs = speechSynthesis.getVoices().filter(function (v) { return /^en[-_]/i.test(v.lang); });
    var prefer = [/Google US English/i, /Aria/i, /Jenny/i, /Samantha/i, /Microsoft.*(Zira|Guy|Mark|David)/i];
    voice = null;
    prefer.some(function (re) { return vs.some(function (v) { if (re.test(v.name)) { voice = v; return true; } return false; }); });
    if (!voice) voice = vs.filter(function (v) { return /en[-_]US/i.test(v.lang); })[0] || vs[0] || null;
  }
  if (canSpeak) {
    pickVoice();
    if ('onvoiceschanged' in speechSynthesis) speechSynthesis.onvoiceschanged = pickVoice;
  }
  function speak(text) {
    if (!canSpeak || !text) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = voice ? voice.lang : 'en-US';
    if (voice) u.voice = voice;
    u.rate = 0.9;
    speechSynthesis.speak(u);
  }
  var SPEAK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
  function sayBtn(text) {
    if (!canSpeak) return '';
    return '<button type="button" class="say" data-say="' + esc(text) + '" aria-label="朗讀 ' + esc(text) +
           '" title="朗讀發音">' + SPEAK_ICON + '</button>';
  }

  /* ---------- 查字小視窗：英文模式點任一字（或螢光筆字彙）時顯示 ---------- */
  var pop = null, popAnchor = null;
  function closePop() {
    if (pop) pop.hidden = true;
    if (popAnchor) popAnchor.classList.remove('is-pop');
    popAnchor = null;
  }
  function openPop(anchor, word, zh, fin, ctx) {
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'wpop';
      pop.setAttribute('role', 'dialog');
      document.body.appendChild(pop);
    }
    if (popAnchor) popAnchor.classList.remove('is-pop');
    popAnchor = anchor;
    anchor.classList.add('is-pop');
    var on = !!saved[word.toLowerCase()];
    pop.innerHTML =
      '<div class="wp-head">' + sayBtn(word) + '<b lang="en">' + esc(word) + '</b>' +
        (fin ? '<em>財經</em>' : '') +
        '<button type="button" class="wp-close" aria-label="關閉">×</button></div>' +
      '<div class="wp-zh">' + esc(zh) + '</div>' +
      '<button type="button" class="wp-save' + (on ? ' is-saved' : '') + '" data-term="' + esc(word) +
        '" data-zh="' + esc(zh) + '" data-ctx="' + esc(ctx || '') + '"' + (fin ? ' data-fin="1"' : '') + '>' +
        (on ? '★ 已收藏到單字本' : '☆ 收藏到單字本') + '</button>';
    pop.hidden = false;
    // 放在字的下方；靠近視窗右緣時往左收，下方空間不夠時改放上方
    var r = anchor.getBoundingClientRect();
    var w = pop.offsetWidth, hgt = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), document.documentElement.clientWidth - w - 8);
    var top = r.bottom + 8;
    if (top + hgt > window.innerHeight - 8 && r.top - hgt - 8 > 0) top = r.top - hgt - 8;
    pop.style.left = (left + window.scrollX) + 'px';
    pop.style.top = (top + window.scrollY) + 'px';
  }

  /* ---------- 重點數據 ---------- */
  function renderData() {
    var list = report.data.filter(function (d) {
      return !state.dcats.length || state.dcats.indexOf(d.cat) >= 0;
    });
    $('#data-none').hidden = list.length > 0;
    // 數據類別不是新聞的 7 大分類，改用類別名稱穩定地輪流配色
    var palette = ['violet', 'teal', 'amber', 'sky', 'emerald', 'rose', 'fuchsia', 'orange'];
    var order = uniq(report.data.map(function (d) { return d.cat; }));
    $('#data-grid').innerHTML = list.map(function (d) {
      var c = palette[Math.max(0, order.indexOf(d.cat)) % palette.length];
      var bg = /本期背景|本週背景/.test(d.src);
      return '<div class="dcard c-' + c + (bg ? ' is-bg' : '') + '">' +
        (d.cat ? '<div class="dcat">' + esc(d.cat) + '</div>' : '') +
        '<div class="ditem">' + esc(d.item) + '</div>' +
        '<div class="dval">' + esc(d.val) + '</div>' +
        (d.desc ? '<div class="ddesc">' + esc(d.desc) + '</div>' : '') +
        (d.src ? '<div class="dsrc">' + esc(d.src) + '</div>' : '') +
      '</div>';
    }).join('');
  }

  /* ---------- 說明與方法 ---------- */
  function renderNotes() {
    var html = report.notes.map(function (line) {
      if (!line) return '<p class="blank"></p>';
      var isHead = /^【.*】/.test(line);
      var alert = /重要限制|注意|免責/.test(line);
      var cls = '';
      // 【…】開頭就是一個段落的起點；短的當標題（帶色條），長的只把括號那截加粗
      if (isHead) cls = (line.length < 40 ? 'h' : 'hx') + (alert ? ' alert' : '');
      else if (/^[\s　]*[‧·．\d]/.test(line)) cls = 'ind';   // 條列項
      else if (/^[\s　]/.test(line)) cls = 'cont';           // 上一條的續行
      var body = esc(line);
      if (isHead) body = body.replace(/^(【[^】]*】)/, '<b>$1</b>');
      return '<p class="' + cls + '">' + body + '</p>';
    }).join('');
    $('#notes-body').innerHTML = html || '<p class="muted">這份 Excel 沒有「說明與方法」分頁。</p>';
  }

  /* ---------- 讓篩選列的 sticky 位置永遠貼齊頂部列（頂部列會換行變高） ---------- */
  function syncTopbarHeight() {
    var el = $('.topbar');
    if (!el) return;
    document.documentElement.style.setProperty('--topbar-h', el.offsetHeight + 'px');
  }

  /* ============================================================
     事件
     ============================================================ */
  function bind() {
    syncTopbarHeight();
    window.addEventListener('resize', syncTopbarHeight);

    // 分頁
    var goTab = function (name) {
      $$('.tab').forEach(function (x) {
        var on = x.dataset.tab === name;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-selected', on);
      });
      state.tab = name;
      $('#panel-news').hidden  = name !== 'news';
      $('#panel-data').hidden  = name !== 'data';
      $('#panel-vocab').hidden = name !== 'vocab';
      $('#panel-notes').hidden = name !== 'notes';
      if (name === 'vocab') renderVocab();
    };
    $$('.tab').forEach(function (b) {
      b.addEventListener('click', function () { goTab(b.dataset.tab); });
    });

    // 標題區的分類圖例：直接篩選該分類
    $('#rpt-mix').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-cat]');
      if (!b) return;
      state.cats = [b.dataset.cat]; state.dates = []; state.ents = [];
      goTab('news');
      buildFilters(); renderNews();
      $('#panel-news').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // 新聞卡：中 / EN 切換（只換這一張），以及收藏字彙
    $('#news-cards').addEventListener('click', function (e) {
      var say = e.target.closest('.say');
      if (say) { speak(say.dataset.say); return; }
      var lb = e.target.closest('.lang button');
      if (lb) {
        var key = lb.closest('.card').dataset.key;
        if (lb.dataset.lang === 'en') state.lang[key] = 'en'; else delete state.lang[key];
        closePop();
        rerenderCard(key);
        syncAllLangBtn();
        return;
      }
      var vs = e.target.closest('.vsave');
      if (vs) {
        toggleSaved(vs.dataset.term, vs.dataset.zh, vs.dataset.ctx, vs.dataset.fin);
        closePop();
        rerenderCard(vs.closest('.card').dataset.key);
        $('#v-saved-count').textContent = Object.keys(saved).length;
        return;
      }
      // 英文模式：點螢光筆字彙或任一個字 → 查字小視窗
      var card = e.target.closest('.card.is-en');
      if (!card) return;
      var ctx = (enOf(itemByKey(card.dataset.key)) || {}).title || '';
      var mk = e.target.closest('mark.vw');
      if (mk) {
        e.preventDefault();
        openPop(mk, mk.dataset.t, mk.dataset.zh, !!mk.dataset.fin, ctx);
        return;
      }
      var w = e.target.closest('.w');
      if (w && gloss[w.dataset.k]) {
        e.preventDefault();
        if (popAnchor === w && !pop.hidden) { closePop(); return; }
        openPop(w, w.dataset.k, gloss[w.dataset.k], false, ctx);
      }
    });

    // 查字小視窗：朗讀、收藏、關閉；點視窗外或按 Esc 關閉
    document.addEventListener('click', function (e) {
      if (!pop || pop.hidden) return;
      if (pop.contains(e.target)) {
        var say = e.target.closest('.say');
        if (say) { speak(say.dataset.say); return; }
        if (e.target.closest('.wp-close')) { closePop(); return; }
        var sv = e.target.closest('.wp-save');
        if (sv) {
          toggleSaved(sv.dataset.term, sv.dataset.zh, sv.dataset.ctx, sv.dataset.fin);
          var on = !!saved[sv.dataset.term.toLowerCase()];
          sv.classList.toggle('is-saved', on);
          sv.textContent = on ? '★ 已收藏到單字本' : '☆ 收藏到單字本';
          syncChipStars(sv.dataset.term);
          $('#v-saved-count').textContent = Object.keys(saved).length;
        }
        return;
      }
      if (e.target.closest('.card.is-en .w, .card.is-en mark.vw')) return;
      closePop();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });
    // 只在寬度真的改變（例如手機轉向）時關閉；手機捲動時網址列收合也會觸發 resize，不能因此關掉
    var lastW = window.innerWidth;
    window.addEventListener('resize', function () {
      if (window.innerWidth !== lastW) { lastW = window.innerWidth; closePop(); }
    });
    $('#btn-all-lang').addEventListener('click', function () {
      var to = this.getAttribute('data-to');
      report.news.forEach(function (i) {
        if (!enOf(i)) return;
        if (to === 'en') state.lang[keyOf(i)] = 'en'; else delete state.lang[keyOf(i)];
      });
      renderNews();
    });

    // 字彙分頁
    $('#s-vscope').addEventListener('change', function () { state.vscope = this.value; renderVocab(); });
    $('#c-vhide').addEventListener('change', function () { state.vhide = this.checked; renderVocab(); });
    $('#s-vtype').addEventListener('change', function () { state.vtype = this.value; renderVocab(); });
    $('#vocab-grid').addEventListener('click', function (e) {
      var say = e.target.closest('.say');
      if (say) { speak(say.dataset.say); return; }
      var vt = e.target.closest('.vt');
      if (vt) { speak(vt.textContent); return; }
      var s = e.target.closest('.vstar');
      if (s) { toggleSaved(s.dataset.term, s.dataset.zh, s.dataset.ctx, s.dataset.fin); renderVocab(); return; }
      var z = e.target.closest('.vz');
      if (z) z.classList.toggle('is-shown');
    });

    // 篩選下拉選單（單選，空值代表全部）
    var selectHandler = function (sel, key, after) {
      $(sel).addEventListener('change', function () {
        state[key] = this.value ? [this.value] : [];
        after();
      });
    };
    selectHandler('#s-cat', 'cats', renderNews);
    selectHandler('#s-date', 'dates', renderNews);
    selectHandler('#s-ent', 'ents', renderNews);
    selectHandler('#s-dcat', 'dcats', renderData);

    $('#btn-reset').addEventListener('click', function () {
      state.cats = []; state.dates = []; state.ents = [];
      buildFilters(); renderNews();
    });

    // 檔案來源（拖放，或空狀態時的選檔按鈕）
    $('#btn-open-2').addEventListener('click', function () { $('#file-input').click(); });
    $('#file-input').addEventListener('change', function () {
      if (this.files && this.files[0]) loadFromFile(this.files[0]);
      this.value = '';
    });
    $('#report-select').addEventListener('change', function () {
      var opt = this.options[this.selectedIndex];
      loadFromUrl(this.value, opt.textContent).catch(function (e) {
        alert('載入失敗：' + e.message);
      });
    });

    // 拖放
    var veil = $('#drop-veil'), depth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
      depth++; veil.hidden = false;
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; veil.hidden = true; } });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); depth = 0; veil.hidden = true;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFromFile(f);
    });

    // 主題
    var applyTheme = function (t) {
      document.documentElement.setAttribute('data-theme', t);
      try { localStorage.setItem('wr-theme', t); } catch (err) {}
    };
    $('#btn-theme').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
    // 沒有手動選過時跟隨系統的深淺色
    var theme = null;
    try { theme = localStorage.getItem('wr-theme'); } catch (err) {}
    if (!theme && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme || 'light');
  }

  /* ============================================================
     啟動：讀 data/reports.json，載入清單中的第一份
     ============================================================ */
  function boot() {
    bind();
    fetch('data/reports.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('no manifest'); return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) throw new Error('empty manifest');
        var sel = $('#report-select');
        sel.innerHTML = list.map(function (x) {
          return '<option value="data/' + encodeURIComponent(x.file) + '">' + esc(x.label || x.file) + '</option>';
        }).join('');
        sel.hidden = false;
        return loadFromUrl(sel.value, list[0].label || list[0].file);
      })
      .catch(function () {
        $('#empty-hint').textContent =
          '（目前沒有從 data/reports.json 載入到報告。若你是用 file:// 直接開啟本檔，瀏覽器會擋下本機讀取——' +
          '請改用 GitHub Pages，或直接拖曳 Excel 進來。）';
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
