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
    tab: 'news', view: 'cards',
    q: '', cats: [], dates: [], ents: [],
    dq: '', dcats: []
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
  // 把搜尋關鍵字在文字中標起來（先跳脫，再插入 <mark>）
  function hl(text, q) {
    var out = esc(text);
    if (!q) return out;
    var terms = q.split(/\s+/).filter(Boolean).map(esc)
      .map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    if (!terms.length) return out;
    return out.replace(new RegExp('(' + terms.join('|') + ')', 'gi'), '<mark>$1</mark>');
  }
  function isHttp(u) { return /^https?:\/\//i.test(u); }

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
      o._hay = [o.date, o.cat, o.entity, o.title, o.summary, o.metric,
                o.impact, o.source, o.conf].join(' ').toLowerCase();
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
      o._hay = [o.cat, o.item, o.val, o.desc, o.src].join(' ').toLowerCase();
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
    var title = norm((head[0] || [])[0]) || label || '半導體產業週報';
    var sub = norm((head[1] || [])[0]);
    // 若 A1/A2 剛好就是標題列，代表這份檔沒有標題區，改用檔名
    if (/序號|日期/.test(title)) { title = label || '半導體產業週報'; sub = ''; }

    return {
      label: label,
      title: title,
      subtitle: sub,
      news: news.items,
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
    state.q = ''; state.cats = []; state.dates = []; state.ents = [];
    state.dq = ''; state.dcats = [];
    $('#q').value = ''; $('#dq').value = '';

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

    buildChips();
    buildDataChips();
    renderNotes();
    renderNews();
    renderData();
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

  /* ---------- 篩選晶片 ---------- */
  function chipHtml(value, label, count, on) {
    return '<button class="chip' + (on ? ' is-on' : '') + '" data-v="' + esc(value) + '">' +
           esc(label) + '<span class="n">' + count + '</span></button>';
  }

  function buildChips() {
    var n = report.news;

    var cats = countBy(n, 'cat');
    $('#f-cat').innerHTML = Object.keys(cats).map(function (c) {
      return chipHtml(c, c, cats[c], state.cats.indexOf(c) >= 0);
    }).join('');

    var dts = countBy(n, 'date');
    $('#f-date').innerHTML = Object.keys(dts).sort().map(function (d) {
      var wd = weekdayOf(d);
      var short = d.replace(/^\d{4}[\/\-.]/, '') + (wd ? ' ' + wd : '');
      return chipHtml(d, short, dts[d], state.dates.indexOf(d) >= 0);
    }).join('');

    // 主體用「主要關鍵字」歸戶：取斜線前的第一段，去掉股號
    var ents = {};
    n.forEach(function (i) {
      keyEntities(i.entity).forEach(function (e) { ents[e] = (ents[e] || 0) + 1; });
    });
    var top = Object.keys(ents).sort(function (a, b) { return ents[b] - ents[a]; }).slice(0, 14);
    $('#f-ent').innerHTML = top.map(function (e) {
      return chipHtml(e, e, ents[e], state.ents.indexOf(e) >= 0);
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

  function buildDataChips() {
    var cats = countBy(report.data, 'cat');
    $('#f-dcat').innerHTML = Object.keys(cats).map(function (c) {
      return chipHtml(c, c, cats[c], state.dcats.indexOf(c) >= 0);
    }).join('');
  }

  function toggle(arr, v) {
    var i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
  }

  /* ---------- 新聞 ---------- */
  function filteredNews() {
    var q = state.q.trim().toLowerCase();
    var terms = q ? q.split(/\s+/).filter(Boolean) : [];
    return report.news.filter(function (i) {
      if (state.cats.length && state.cats.indexOf(i.cat) < 0) return false;
      if (state.dates.length && state.dates.indexOf(i.date) < 0) return false;
      if (state.ents.length) {
        var ks = keyEntities(i.entity);
        if (!state.ents.some(function (e) { return ks.indexOf(e) >= 0; })) return false;
      }
      if (terms.length && !terms.every(function (t) { return i._hay.indexOf(t) >= 0; })) return false;
      return true;
    });
  }

  function renderNews() {
    var list = filteredNews();
    $('#result-count').textContent = '顯示 ' + list.length + ' / ' + report.news.length + ' 則';
    $('#news-none').hidden = list.length > 0;

    var cardsOn = state.view === 'cards';
    $('#news-cards').hidden = !cardsOn || !list.length;
    $('#news-table').hidden = cardsOn || !list.length;

    if (cardsOn) renderCards(list); else renderTable(list);
  }

  function renderCards(list) {
    var q = state.q.trim();
    var html = '', lastDate = null;
    list.forEach(function (i) {
      if (i.date !== lastDate) {
        lastDate = i.date;
        var wd = weekdayOf(i.date);
        html += '<div class="date-head"><b>' + esc(i.date || '未標日期') + '</b>' +
                (wd ? '<span>' + wd + '</span>' : '') + '</div>';
      }
      html += cardHtml(i, q);
    });
    $('#news-cards').innerHTML = html;
  }

  function cardHtml(i, q) {
    var h = '<article class="card">';
    h += '<div class="card-top">';
    if (i.no)     h += '<span class="tag no">#' + esc(i.no) + '</span>';
    if (i.cat)    h += '<span class="tag cat">' + esc(i.cat) + '</span>';
    if (i.entity) h += '<span class="tag ent">' + esc(i.entity) + '</span>';
    h += '</div>';

    var t = hl(i.title, q);
    h += '<h3>' + (isHttp(i.link)
        ? '<a href="' + esc(i.link) + '" target="_blank" rel="noopener">' + t + '<span class="ext">↗</span></a>'
        : t) + '</h3>';

    if (i.summary) h += '<p class="summary">' + hl(i.summary, q) + '</p>';

    var kv = '';
    if (i.metric) kv += '<div class="kv-item metric"><span class="k">關鍵數據</span><span class="v">' + hl(i.metric, q) + '</span></div>';
    if (i.impact) kv += '<div class="kv-item"><span class="k">影響觀察</span><span class="v">' + hl(i.impact, q) + '</span></div>';
    Object.keys(i.extras).forEach(function (k) {
      kv += '<div class="kv-item"><span class="k">' + esc(k) + '</span><span class="v">' + hl(i.extras[k], q) + '</span></div>';
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

  function renderTable(list) {
    var cols = [
      ['no', '序號'], ['date', '日期'], ['cat', '分類'], ['entity', '主體/公司'],
      ['title', '標題'], ['summary', '重點摘要'], ['metric', '關鍵數據'],
      ['impact', '影響/觀察'], ['source', '來源'], ['conf', '資料確認度']
    ];
    var h = '<table><thead><tr>' +
      cols.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') +
      '<th>連結</th></tr></thead><tbody>';
    list.forEach(function (i) {
      h += '<tr>' + cols.map(function (c) {
        return '<td>' + hl(i[c[0]] || '', state.q.trim()) + '</td>';
      }).join('');
      h += '<td>' + (isHttp(i.link)
        ? '<a href="' + esc(i.link) + '" target="_blank" rel="noopener">開啟</a>' : '') + '</td></tr>';
    });
    $('#news-table').innerHTML = h + '</tbody></table>';
  }

  /* ---------- 重點數據 ---------- */
  function renderData() {
    var q = state.dq.trim().toLowerCase();
    var list = report.data.filter(function (d) {
      if (state.dcats.length && state.dcats.indexOf(d.cat) < 0) return false;
      if (q && d._hay.indexOf(q) < 0) return false;
      return true;
    });
    $('#data-none').hidden = list.length > 0;
    $('#data-grid').innerHTML = list.map(function (d) {
      return '<div class="dcard">' +
        (d.cat ? '<div class="dcat">' + esc(d.cat) + '</div>' : '') +
        '<div class="ditem">' + hl(d.item, state.dq) + '</div>' +
        '<div class="dval">' + hl(d.val, state.dq) + '</div>' +
        (d.desc ? '<div class="ddesc">' + hl(d.desc, state.dq) + '</div>' : '') +
        (d.src ? '<div class="dsrc">' + esc(d.src) + '</div>' : '') +
      '</div>';
    }).join('');
  }

  /* ---------- 說明與方法 ---------- */
  function renderNotes() {
    var html = report.notes.map(function (line) {
      if (!line) return '<p class="blank"></p>';
      var isHead = /^【.*】/.test(line) && line.length < 40;
      var alert = /重要限制|注意|免責/.test(line);
      var cls = '';
      if (isHead) cls = 'h' + (alert ? ' alert' : '');
      else if (/^[\s　]*[‧·．\d]/.test(line)) cls = 'ind';   // 條列項
      else if (/^[\s　]/.test(line)) cls = 'cont';           // 上一條的續行
      return '<p class="' + cls + '">' + esc(line) + '</p>';
    }).join('');
    $('#notes-body').innerHTML = html || '<p class="muted">這份 Excel 沒有「說明與方法」分頁。</p>';
  }

  /* ---------- CSV 匯出 ---------- */
  function exportCsv() {
    var list = filteredNews();
    var cols = [['no', '序號'], ['date', '日期'], ['cat', '分類'], ['entity', '主體/公司'],
                ['title', '標題'], ['summary', '重點摘要'], ['metric', '關鍵數據'],
                ['impact', '影響/觀察'], ['source', '來源'], ['link', '連結'], ['conf', '資料確認度']];
    var q = function (s) { return '"' + String(s || '').replace(/"/g, '""') + '"'; };
    var rows = [cols.map(function (c) { return q(c[1]); }).join(',')];
    list.forEach(function (i) {
      rows.push(cols.map(function (c) { return q(i[c[0]]); }).join(','));
    });
    var blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (report.label || 'report') + '_篩選結果.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ============================================================
     事件
     ============================================================ */
  function bind() {
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

    // 檢視切換
    $$('.vt').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.vt').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        state.view = b.dataset.view;
        renderNews();
      });
    });

    // 搜尋
    $('#q').addEventListener('input', function () {
      state.q = this.value;
      $('#q-clear').hidden = !this.value;
      renderNews();
    });
    $('#q-clear').addEventListener('click', function () {
      $('#q').value = ''; state.q = ''; this.hidden = true; renderNews();
    });
    $('#dq').addEventListener('input', function () { state.dq = this.value; renderData(); });

    // 晶片
    var chipHandler = function (container, key, after) {
      $(container).addEventListener('click', function (e) {
        var b = e.target.closest('.chip');
        if (!b) return;
        toggle(state[key], b.dataset.v);
        b.classList.toggle('is-on');
        after();
      });
    };
    chipHandler('#f-cat', 'cats', renderNews);
    chipHandler('#f-date', 'dates', renderNews);
    chipHandler('#f-ent', 'ents', renderNews);
    chipHandler('#f-dcat', 'dcats', renderData);

    $('#btn-reset').addEventListener('click', function () {
      state.q = ''; state.cats = []; state.dates = []; state.ents = [];
      $('#q').value = ''; $('#q-clear').hidden = true;
      buildChips(); renderNews();
    });

    $('#btn-csv').addEventListener('click', exportCsv);

    // 檔案來源
    var openPicker = function () { $('#file-input').click(); };
    $('#btn-open').addEventListener('click', openPicker);
    $('#btn-open-2').addEventListener('click', openPicker);
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

    // 快捷鍵
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault();
        ($('#panel-news').hidden ? $('#dq') : $('#q')).focus();
      }
    });
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
