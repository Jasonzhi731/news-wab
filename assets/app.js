/* ============================================================
   半導體產業週報閱讀器
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

  /* ---------- 狀態 ---------- */
  var report = null;                       // 解析後的整份週報
  var state = {
    tab: 'news',
    cats: [], dates: [], ents: [],
    dcats: []
  };

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

  function loadFromUrl(url, label) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      show(parseWorkbook(readWorkbook(buf), label || url.split('/').pop()));
    });
  }

  function loadFromFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        show(parseWorkbook(readWorkbook(fr.result), file.name.replace(/\.[^.]+$/, '')));
      } catch (e) {
        alert('無法解析這個檔案：' + e.message);
      }
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

    $('#stage-empty').hidden = true;
    $('#stage-report').hidden = false;

    $('#rpt-title').textContent = rpt.title;
    $('#rpt-sub').textContent = rpt.subtitle;
    $('#foot-src').textContent = '資料來源：' + rpt.label + '（' + rpt.sheetNames.join('、') + '）';
    document.title = rpt.title;

    // 日期欄可能出現「本週背景」這類非日期字樣，算範圍時只取真的日期
    var dates = uniq(rpt.news.map(function (n) { return n.date; }))
      .filter(function (d) { return /^\d{4}[\/\-.]\d{1,2}/.test(d); }).sort();
    $('#rpt-stats').innerHTML =
      stat('新聞', rpt.news.length + ' 則') +
      stat('數據', rpt.data.length + ' 筆') +
      (dates.length ? stat('日期範圍', dates[0] + ' – ' + dates[dates.length - 1]) : '') +
      stat('分類', uniq(rpt.news.map(function (n) { return n.cat; })).filter(Boolean).length + ' 類');

    $('#tabcount-news').textContent = rpt.news.length;
    $('#tabcount-data').textContent = rpt.data.length;

    buildFilters();
    buildDataFilter();
    renderNotes();
    renderNews();
    renderData();
    syncTopbarHeight();
    window.scrollTo(0, 0);
  }

  function stat(k, v) { return '<span class="stat">' + esc(k) + ' <b>' + esc(v) + '</b></span>'; }

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
        return optionHtml(d, d.replace(/^\d{4}[\/\-.]/, '') + (wd ? ' ' + wd : ''),
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
    renderCards(list);
  }

  function renderCards(list) {
    var html = '', lastDate = null;
    list.forEach(function (i) {
      if (i.date !== lastDate) {
        lastDate = i.date;
        var wd = weekdayOf(i.date);
        html += '<div class="date-head"><b>' + esc(i.date || '未標日期') + '</b>' +
                (wd ? '<span>' + wd + '</span>' : '') + '</div>';
      }
      html += cardHtml(i);
    });
    $('#news-cards').innerHTML = html;
  }

  function cardHtml(i) {
    var h = '<article class="card">';
    h += '<div class="card-top">';
    if (i.no)     h += '<span class="tag no">#' + esc(i.no) + '</span>';
    if (i.cat)    h += '<span class="tag cat">' + esc(i.cat) + '</span>';
    if (i.entity) h += '<span class="tag ent">' + esc(i.entity) + '</span>';
    h += '</div>';

    var t = esc(i.title);
    h += '<h3>' + (isHttp(i.link)
        ? '<a href="' + esc(i.link) + '" target="_blank" rel="noopener">' + t + '<span class="ext">↗</span></a>'
        : t) + '</h3>';

    if (i.summary) h += '<p class="summary">' + esc(i.summary) + '</p>';

    var kv = '';
    if (i.metric) kv += '<div class="kv-item metric"><span class="k">關鍵數據</span><span class="v">' + esc(i.metric) + '</span></div>';
    if (i.impact) kv += '<div class="kv-item"><span class="k">影響觀察</span><span class="v">' + esc(i.impact) + '</span></div>';
    Object.keys(i.extras).forEach(function (k) {
      kv += '<div class="kv-item"><span class="k">' + esc(k) + '</span><span class="v">' + esc(i.extras[k]) + '</span></div>';
    });
    if (kv) h += '<div class="kv">' + kv + '</div>';

    h += '<div class="card-foot">';
    if (i.source) h += '<span>來源：' + esc(i.source) + '</span>';
    if (i.conf) {
      var warn = /待確認|預估|傳聞|未證實|揣測|非公司公告|草案/.test(i.conf);
      h += '<span class="badge ' + (warn ? 'warn' : 'ok') + '">' + esc(i.conf) + '</span>';
    }
    if (isHttp(i.link)) h += '<a href="' + esc(i.link) + '" target="_blank" rel="noopener">原文連結</a>';
    h += '</div></article>';
    return h;
  }

  /* ---------- 重點數據 ---------- */
  function renderData() {
    var list = report.data.filter(function (d) {
      return !state.dcats.length || state.dcats.indexOf(d.cat) >= 0;
    });
    $('#data-none').hidden = list.length > 0;
    $('#data-grid').innerHTML = list.map(function (d) {
      return '<div class="dcard">' +
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
    $$('.tab').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.tab').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        state.tab = b.dataset.tab;
        $('#panel-news').hidden  = state.tab !== 'news';
        $('#panel-data').hidden  = state.tab !== 'data';
        $('#panel-notes').hidden = state.tab !== 'notes';
      });
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
    try {
      var saved = localStorage.getItem('wr-theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (err) {}
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
          '（目前沒有從 data/reports.json 載入到週報。若你是用 file:// 直接開啟本檔，瀏覽器會擋下本機讀取——' +
          '請改用 GitHub Pages，或直接拖曳 Excel 進來。）';
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
