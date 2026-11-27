/* News Vocab — flashcards + spaced repetition over the Google Apps Script API.
 * No build step, no framework. Data flow:
 *   GET  ?action=due / stats / words   (public reads)
 *   POST review / aiExamples           (needs the token from Settings)
 * Answers go into a local queue first ("pending") and are synced in batches,
 * so studying works offline; each answer carries a rid so retries are not double-counted.
 */
(() => {
  'use strict';

  const CFG = window.NV_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).has('demo'); // reads are real, writes are simulated
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  /* ------------------------------ storage ------------------------------ */
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('nv-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem('nv-' + k, JSON.stringify(v)); } catch (e) { /* quota / private mode */ } },
    del(k) { try { localStorage.removeItem('nv-' + k); } catch (e) { /* ignore */ } },
  };

  const DEFAULTS = {
    apiUrl: CFG.apiUrl || '', token: '', newLimit: 20, autoSpeak: false,
    cat: 'all', src: 'all', aiModel: CFG.aiModel || '',
    issueUnlearnedOnly: false, issueBatch: 0,
  };
  let settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  if (!settings.apiUrl) settings.apiUrl = DEFAULTS.apiUrl;
  // Keep apiUrl out of storage unless the user typed a custom one, so a new default in config.js reaches every device.
  const saveSettings = () => {
    const s = Object.assign({}, settings);
    if (s.apiUrl === DEFAULTS.apiUrl) delete s.apiUrl;
    store.set('settings', s);
  };

  let pending = store.get('pending', []);
  let queueData = store.get('queue', null);   // last ?action=due response
  let statsData = store.get('stats', null);   // last ?action=stats response
  let wordsData = store.get('words', null);   // last ?action=words response (browse)

  /* -------------------------------- API -------------------------------- */
  class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  async function unwrap(res) {
    let j;
    try { j = await res.json(); } catch (e) {
      throw new ApiError(res.status || -1, '伺服器回應不是 JSON：請確認網址結尾是 /exec，且部署存取權為「所有人」');
    }
    if (!j.ok) throw new ApiError(j.code || 500, j.error || '未知錯誤');
    return j;
  }

  async function apiGet(params) {
    if (!settings.apiUrl) throw new ApiError(0, '尚未設定 API 網址');
    const url = new URL(settings.apiUrl);
    Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
    let res;
    try { res = await fetch(url.toString()); } catch (e) { throw new ApiError(-1, '無法連線'); }
    return unwrap(res);
  }

  async function apiPost(body) {
    if (DEMO) return demoPost(body);
    if (!settings.token) throw new ApiError(401, '尚未輸入 token');
    let res;
    try {
      res = await fetch(settings.apiUrl, {
        method: 'POST',
        // text/plain = "simple request": no CORS preflight, which Apps Script cannot answer
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ token: settings.token }, body)),
      });
    } catch (e) { throw new ApiError(-1, '無法連線'); }
    return unwrap(res);
  }

  function demoPost(body) {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    if (body.action === 'review') return wait(300).then(() => ({ ok: true, applied: body.reviews.length, skipped: 0 }));
    if (body.action === 'aiExamples') {
      return wait(800).then(() => ({
        ok: true, cached: false, model: 'demo',
        examples: [
          { en: 'Demo mode: tech example sentences appear here once the API key is configured.', zh: '示範模式：設定 API key 後，這裡會出現科技領域的例句。', field: '示範' },
        ],
      }));
    }
    return Promise.resolve({ ok: true, auth: true });
  }

  /* ------------------------------ helpers ------------------------------ */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const todayLocal = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const today = () => (queueData && queueData.today) || todayLocal();
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  function highlight(text, word) {
    const safe = esc(text);
    if (!word) return safe;
    const pat = new RegExp('(?<![A-Za-z])(' + esc(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![A-Za-z])', 'ig');
    return safe.replace(pat, '<mark>$1</mark>');
  }

  // "全球半導體代工產業快報_20261125-20261127#1" -> "快報 2026/11/25–11/27 第 1 則"
  // 出處做成連結：回快報打開那一期、切英文、捲到那一則
  function srcHtml(src) {
    const m = /^(.*)#(\d+)$/.exec(src || '');
    if (!m) return src ? `<div class="src">${esc(sourceLabel(src))}</div>` : '';
    const href = `../?r=${encodeURIComponent(m[1])}&lang=en&n=${m[2]}`;
    return `<a class="src" href="${href}" title="打開這則新聞">${esc(sourceLabel(src))} ↗</a>`;
  }

  function sourceLabel(src) {
    const m = /^(.*?)_(\d{4})(\d{2})(\d{2})-\d{4}(\d{2})(\d{2})#(\d+)$/.exec(src || '');
    if (!m) return src || '';
    const name = m[1].replace(/^全球半導體代工產業/, '').replace(/^全球晶圓代工/, '') || m[1];
    return `${name} ${m[2]}/${m[3]}/${m[4]}–${m[5]}/${m[6]} 第 ${m[7]} 則`;
  }

  // Same rules as nextSchedule_ in gas/Code.gs — only used to label the buttons.
  function previewInterval(p, grade) {
    let interval = (p && p.interval) || 0, ease = (p && p.ease) || 2.3, reps = (p && p.reps) || 0;
    if (grade === 0) return 1;
    reps += 1;
    if (reps === 1) return grade === 3 ? 3 : 1;
    if (reps === 2) return grade === 1 ? 2 : grade === 3 ? 5 : 3;
    const f = grade === 1 ? 1.2 : grade === 3 ? ease * 1.2 : ease;
    return Math.min(365, Math.max(interval + 1, Math.round(interval * f)));
  }
  const fmtDays = d => (d < 30 ? d + ' 天' : d < 365 ? Math.round(d / 30) + ' 個月' : '1 年');

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* ------------------------------ speech ------------------------------- */
  let voice = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang));
    voice = vs.find(v => /en[-_]US/i.test(v.lang) && /natural|google|samantha|aria|jenny/i.test(v.name))
      || vs.find(v => /en[-_]US/i.test(v.lang)) || vs[0] || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  const SPEAK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

  function say(text) {
    if (!('speechSynthesis' in window) || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.95;
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  }

  /* ------------------------------- sync -------------------------------- */
  let syncing = false;
  let syncError = '';
  let syncTimer;

  function answeredToday() {
    const a = store.get('answered', null);
    return a && a.date === today() ? a.ids : [];
  }
  function markAnswered(id) {
    const ids = answeredToday();
    ids.push(id);
    store.set('answered', { date: today(), ids });
  }
  function unmarkAnswered(id) {
    const ids = answeredToday();
    const pos = ids.lastIndexOf(id);
    if (pos >= 0) {
      ids.splice(pos, 1);
      store.set('answered', { date: today(), ids });
    }
  }

  function updateSyncUI() {
    const pill = $('#sync-pill');
    if (syncing) { pill.hidden = false; pill.className = 'sync-pill'; pill.textContent = '同步中…'; return; }
    if (!pending.length) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.className = 'sync-pill' + (syncError ? ' warn' : '');
    pill.textContent = (syncError ? '⚠ ' : '⟳ ') + pending.length + ' 筆待同步';
    pill.title = syncError || '點一下立即同步';
  }

  function scheduleSync(ms = 3500) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, ms);
  }

  async function sync() {
    if (syncing || !pending.length) { updateSyncUI(); return; }
    syncing = true;
    updateSyncUI();
    const batch = pending.slice(0, 200);
    let again = false;
    try {
      await apiPost({ action: 'review', reviews: batch });
      const sent = new Set(batch.map(r => r.rid));
      pending = pending.filter(r => !sent.has(r.rid));
      store.set('pending', pending);
      syncError = '';
      again = pending.length > 0;
    } catch (e) {
      if (e.code === 404) { // a word was deleted from the sheet — drop its answers and retry the rest
        const bad = String(e.message).split(': ').pop();
        pending = pending.filter(r => r.id !== bad);
        store.set('pending', pending);
        again = true;
      }
      syncError = e.code === 401 ? 'Token 錯誤或未設定：作答先存在這台裝置，到「設定」輸入後會自動同步'
        : e.code === -1 ? '目前離線：連上網路後會自動同步'
        : e.message;
    } finally {
      syncing = false;
      updateSyncUI();
    }
    if (again) return sync();
  }

  // When the app is closed or hidden, save session progress and fire-and-forget the queue.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (session) persistSession(session);
    if (!pending.length || DEMO || !settings.token || !navigator.sendBeacon) return;
    const body = JSON.stringify({ token: settings.token, action: 'review', reviews: pending.slice(0, 200) });
    navigator.sendBeacon(settings.apiUrl, new Blob([body], { type: 'text/plain;charset=utf-8' }));
  });
  window.addEventListener('pagehide', () => { if (session) persistSession(session); });
  window.addEventListener('online', () => sync());

  /* ------------------------------ routing ------------------------------ */
  const VIEWS = ['home', 'study', 'done', 'browse', 'settings'];
  function show(view) {
    closeLookup();
    VIEWS.forEach(v => { $('#view-' + v).hidden = v !== view; });
    document.body.classList.toggle('studying', view === 'study');
    $$('#tabs a, .bottomnav a[data-view]').forEach(a => {
      const on = a.dataset.view === view;
      a.classList.toggle('is-on', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
  }
  function route() {
    const v = (location.hash || '#home').slice(1);
    if (v === 'browse') { show('browse'); loadBrowse(); }
    else if (v === 'saved') { browseFilter = 'saved'; location.replace('#browse'); }   // 快報「看全部收藏」
    else if (v === 'settings') { show('settings'); fillSettings(); }
    else if (v === 'study') {
      if (!session) {
        const ak = store.get('activeSession', null);
        const raw = (ak && getSavedSession(ak)) || getSavedSession(sessionKey(settings.src, settings.cat));
        if (raw) {
          session = hydrateSession(raw);
          show('study');
          renderCard();
          return;
        }
      }
      if (session) { show('study'); }
      else { show('home'); loadHome(); }
    }
    else if (v === 'done' && $('#done-text').textContent) { show('done'); }
    else { show('home'); loadHome(); }
  }
  window.addEventListener('hashchange', route);

  /* ------------------------------- home -------------------------------- */
  function catMatch(w, cat) {
    return cat === 'all' || (cat === 'fin' ? w.category === 'fin' : w.category !== 'fin');
  }

  function buildDeck() {
    if (settings.src !== 'all') return issueDeck();
    if (!queueData) return [];
    const skip = new Set(answeredToday().concat(pending.map(r => r.id)));
    const due = queueData.due.filter(w => !skip.has(w.id) && catMatch(w, settings.cat));
    const fresh = queueData.new.filter(w => !skip.has(w.id) && catMatch(w, settings.cat));
    return due.map(w => ({ w, kind: 'review' })).concat(fresh.map(w => ({ w, kind: 'new' })));
  }

  function renderHome(errMsg) {
    $('#today-label').textContent = '今天 ' + today().replace(/-/g, '/');
    $$('#cat-seg button').forEach(b => b.classList.toggle('on', b.dataset.cat === settings.cat));

    const banner = $('#home-banner');
    if (!settings.token && !DEMO) {
      banner.hidden = false;
      banner.innerHTML = '還沒輸入 token：可以先練習，作答會暫存在這台裝置。到 <a href="#settings">設定</a> 輸入後就會同步到 Google Sheet。';
    } else if (DEMO) {
      banner.hidden = false;
      banner.textContent = '示範模式：讀取真實單字，但作答不會寫回 Sheet。';
    } else {
      banner.hidden = true;
    }

    const isIssue = settings.src !== 'all';
    const io = $('#issue-opts');
    if (io) {
      io.hidden = !isIssue;
      $('#opt-unlearned').checked = !!settings.issueUnlearnedOnly;
      $('#opt-batch').value = String(settings.issueBatch || 0);
    }
    const deck = buildDeck();
    const nDue = deck.filter(c => c.kind === 'review').length;
    const nNew = deck.length - nDue;
    $('#st-due').textContent = queueData || isIssue ? nDue : '–';
    $('#st-new').textContent = queueData || isIssue ? nNew : '–';
    $('#st-due').parentNode.querySelector('span').textContent = isIssue ? '本期已學' : '待複習';
    $('#st-new').parentNode.querySelector('span').textContent = isIssue ? '本期新字' : '今日新字';
    const sn = $('#src-note');
    sn.hidden = !isIssue;
    if (isIssue) {
      const nLocal = deck.filter(c => c.w.local).length;
      const batch = Number(settings.issueBatch) || 0;
      const poolInfo = batch && lastIssuePool > deck.length
        ? `篩選後共 ${lastIssuePool} 字，本輪先練前 ${deck.length} 張`
        : `共 ${deck.length} 個字`;
      sn.textContent = issue
        ? `${issue.label} ${poolInfo}，依新聞順序出題；作答會一起算進間隔重複。`
          + (nLocal ? `其中 ${nLocal} 個字單字本還沒有，只在這台裝置練習。` : '')
        : '載入這一期的單字中…';
    }
    $('#st-learned').textContent = statsData ? statsData.learned : '–';
    $('#st-mature').textContent = statsData ? statsData.mature : '–';

    const savedSess = getSavedSession(sessionKey(settings.src, settings.cat));
    const hasResume = !!(savedSess && (savedSess.idx > 0 || (savedSess.graded && savedSess.graded.length > 0)));
    const resumeBar = $('#resume-bar');
    if (resumeBar) {
      resumeBar.hidden = !hasResume;
      if (hasResume) {
        $('#resume-info').textContent = `上次進度 ${savedSess.idx} / ${savedSess.cards.length}（對 ${savedSess.right}・錯 ${savedSess.wrong}）`;
      }
    }

    const btn = $('#start-btn');
    if (hasResume) {
      const left = savedSess.cards.length - savedSess.idx;
      btn.disabled = false;
      btn.textContent = `繼續練習（剩 ${left} 張 · 第 ${savedSess.idx + 1}/${savedSess.cards.length}）`;
    } else if (isIssue) {
      btn.disabled = !deck.length;
      btn.textContent = !issue ? '載入中…' : deck.length ? `開始練習本期（${deck.length} 張）` : '這一期沒有符合條件的單字';
    } else if (!queueData) {
      btn.disabled = true;
      btn.textContent = errMsg ? '無法載入' : '載入中…';
    } else if (!deck.length) {
      btn.disabled = true;
      btn.textContent = '今天都完成了 ✓';
    } else {
      btn.disabled = false;
      btn.textContent = `開始練習（${deck.length} 張）`;
    }
    $('#home-note').textContent = errMsg ? errMsg + (queueData ? '（顯示上次載入的資料）' : '') : '';

    if (statsData && statsData.total) {
      const pct = Math.round((statsData.learned / statsData.total) * 100);
      $('#total-fill').style.width = pct + '%';
      $('#total-note').textContent = `已學 ${statsData.learned} / ${statsData.total} 字（${pct}%）· 熟練＝複習間隔 ≥ 21 天`;
    }
  }

  async function loadHome() {
    renderHome();
    await sync();
    try {
      const [q, st] = await Promise.all([
        apiGet({ action: 'due', limit: 300, newLimit: settings.newLimit }),
        apiGet({ action: 'stats' }),
      ]);
      queueData = q; statsData = st;
      store.set('queue', q); store.set('stats', st);
      renderHome();
    } catch (e) {
      renderHome(e.code === -1 ? '目前離線' : '載入失敗：' + e.message);
    }
  }

  $('#cat-seg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.cat = b.dataset.cat;
    saveSettings();
    renderHome();
  });
  $('#sync-pill').addEventListener('click', () => {
    if (syncError) toast(syncError, 4000);
    syncError = '';
    sync();
  });

  /* --------------------------- 練習範圍：某一期 --------------------------- */
  // 'all' = 原本的間隔重複佇列；其餘值 = 某一期的檔名（不含副檔名），練這一期新聞的全部字彙
  let reports = store.get('reports', null);   // ../data/reports.json
  let issue = null;                          // { stem, label, words: [...] }
  const issueCache = {};
  const stemOf = file => String(file || '').replace(/\.xlsx$/i, '');
  const shortLabel = lab => String(lab || '').replace(/^全球半導體代工產業快報\s*/, '快報 ');
  const makeId = w => String(w).trim().toLowerCase().replace(/\s+/g, ' ');

  function fillSrcSelect() {
    const sel = $('#src-sel');
    if (!reports) return;
    sel.innerHTML = '<option value="all">今日複習（所有單字・間隔重複）</option>' + reports.map((r, i) =>
      `<option value="${esc(stemOf(r.file))}">${esc(shortLabel(r.label || r.file))}${i === 0 ? '（最新一期）' : ''}・全部單字</option>`).join('');
    const ok = settings.src === 'all' || reports.some(r => stemOf(r.file) === settings.src);
    if (!ok) settings.src = 'all';
    sel.value = settings.src;
  }

  async function loadReports() {
    try {
      const r = await fetch('../data/reports.json', { cache: 'no-store' });
      if (!r.ok) return;
      reports = await r.json();
      store.set('reports', reports);
    } catch (e) { /* offline: keep the cached list */ }
    fillSrcSelect();
  }

  // 一則新聞裡含這個字的那一句（摘要優先），當作卡片背面的原句
  function sentenceWith(news, word) {
    const pat = new RegExp('(?<![A-Za-z])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'i');
    for (const f of ['summary', 'impact', 'title', 'metric']) {
      const hit = String(news[f] || '').split(/(?<=[.!?;])\s+(?=[A-Z0-9"'(])/).find(s => pat.test(s));
      if (hit) return hit.length > 320 ? hit.slice(0, 317) + '...' : hit;
    }
    return '';
  }

  async function loadIssue(stem) {
    if (issueCache[stem]) return issueCache[stem];
    const res = await fetch('../data/en/' + encodeURIComponent(stem) + '.json');
    if (!res.ok) throw new Error('讀不到這一期的英文對照');
    const data = await res.json();
    const seen = new Set(), words = [];
    Object.keys(data.news || {}).sort((a, b) => Number(a) - Number(b)).forEach(no => {
      const n = data.news[no];
      (n.vocab || []).forEach(v => {
        if (!v || !String(v[0] || '').trim()) return;
        const id = makeId(v[0]);
        if (seen.has(id)) return;
        seen.add(id);
        words.push({ id, word: String(v[0]).trim(), zh: String(v[1] || ''), fin: v[2] === 'fin',
          context_en: sentenceWith(n, String(v[0]).trim()), source: stem + '#' + no });
      });
    });
    const r = (reports || []).find(x => stemOf(x.file) === stem);
    return (issueCache[stem] = { stem, label: r ? shortLabel(r.label) : stem, words });
  }

  // 本期的字配上 Sheet 裡的進度與收藏；Sheet 還沒有的字（剛出刊、尚未補字）只在本機練習、不送出作答
  let lastIssuePool = 0;
  function issueDeck() {
    if (!issue) { lastIssuePool = 0; return []; }
    const byId = new Map((wordsData || []).map(w => [w.id, w]));
    let list = issue.words.map(x => {
      const sw = byId.get(x.id);
      const w = sw
        ? Object.assign({}, sw, { context_en: x.context_en || sw.context_en, source: x.context_en ? x.source : sw.source })
        : { id: x.id, word: x.word, meaning_zh: x.zh, category: x.fin ? 'fin' : '', freq: 1, context_en: x.context_en,
            source: x.source, progress: null, saved: false, local: true };
      if (!w.meaning_zh) w.meaning_zh = x.zh;
      return w;
    }).filter(w => catMatch(w, settings.cat));

    if (settings.issueUnlearnedOnly) {
      list = list.filter(w => !w.progress || daysBetween(today(), w.progress.due) <= 0);
    }
    const batch = Number(settings.issueBatch) || 0;
    if (batch > 0) {
      const skip = new Set(answeredToday().concat(pending.map(r => r.id)));
      list = list.filter(w => !skip.has(w.id));
    }
    lastIssuePool = list.length;
    if (batch > 0) list = list.slice(0, batch);
    return list.map(w => ({ w, kind: w.progress ? 'review' : 'new' }));
  }

  async function selectSource(src) {
    settings.src = src;
    saveSettings();
    issue = null;
    renderHome();
    if (src === 'all') return;
    try {
      const [iss] = await Promise.all([loadIssue(src), wordsData ? null : refreshWords()]);
      if (settings.src !== src) return;
      issue = iss;
    } catch (e) {
      $('#home-note').textContent = '載入失敗：' + e.message;
    }
    renderHome();
  }

  async function refreshWords() {
    try {
      const r = await apiGet({ action: 'words' });
      wordsData = r.words;
      store.set('words', wordsData);
    } catch (e) { /* offline: cached words (or none) are fine for practice */ }
  }

  $('#src-sel').addEventListener('change', e => selectSource(e.target.value));
  $('#opt-unlearned').addEventListener('change', e => {
    settings.issueUnlearnedOnly = e.target.checked;
    saveSettings();
    renderHome();
  });
  $('#opt-batch').addEventListener('change', e => {
    settings.issueBatch = Number(e.target.value) || 0;
    saveSettings();
    renderHome();
  });


  /* ------------------------------- study ------------------------------- */
  let session = null;

  const sessionKey = (src, cat) => {
    const s = src || 'all', c = cat || 'all';
    if (s === 'all') return `${s}::${c}`;
    return `${s}::${c}::${settings.issueUnlearnedOnly ? 1 : 0}::${Number(settings.issueBatch) || 0}`;
  };

  function loadSavedSessions() {
    const m = store.get('sessions', {});
    return m && typeof m === 'object' ? m : {};
  }
  function saveSavedSessions(map) {
    const keys = Object.keys(map).sort((a, b) => (map[b].updatedAt || 0) - (map[a].updatedAt || 0));
    const trimmed = {};
    keys.slice(0, 10).forEach(k => { trimmed[k] = map[k]; });
    store.set('sessions', trimmed);
  }
  function getSavedSession(key) {
    const map = loadSavedSessions();
    const s = map[key];
    if (!s || !Array.isArray(s.cards) || !s.cards.length || s.idx >= s.cards.length) return null;
    // 「今日複習」隔天自動過期，領取隔日新佇列；指定某一期跨天照常保留進度直到練完
    if (s.src === 'all' && s.date && s.date !== today()) {
      delete map[key];
      saveSavedSessions(map);
      return null;
    }
    return s;
  }
  function persistSession(s) {
    if (!s || !s.key) return;
    if (s.idx >= s.cards.length) { clearSavedSession(s.key); return; }
    const map = loadSavedSessions();
    map[s.key] = {
      key: s.key,
      src: s.src,
      cat: s.cat,
      date: s.date || today(),
      cards: s.cards,
      idx: s.idx,
      graded: Array.from(s.graded),
      right: s.right,
      wrong: s.wrong,
      issue: s.issue ? { stem: s.issue.stem, label: s.issue.label } : null,
      updatedAt: Date.now(),
    };
    saveSavedSessions(map);
    store.set('activeSession', s.key);
  }
  function clearSavedSession(key) {
    if (!key) return;
    const map = loadSavedSessions();
    if (key in map) {
      delete map[key];
      saveSavedSessions(map);
    }
    if (store.get('activeSession', null) === key) store.del('activeSession');
  }
  function hydrateSession(raw) {
    return {
      key: raw.key,
      src: raw.src || 'all',
      cat: raw.cat || 'all',
      date: raw.date || today(),
      cards: raw.cards,
      idx: raw.idx || 0,
      flipped: false,
      graded: new Set(raw.graded || []),
      right: raw.right || 0,
      wrong: raw.wrong || 0,
      issue: raw.issue || null,
      history: [],
    };
  }

  function startSession() {
    const key = sessionKey(settings.src, settings.cat);
    const saved = getSavedSession(key);
    if (saved && (saved.idx > 0 || (saved.graded && saved.graded.length > 0))) {
      session = hydrateSession(saved);
      store.set('activeSession', key);
      location.hash = '#study';
      show('study');
      renderCard();
      return;
    }
    const deck = buildDeck();
    if (!deck.length) return;
    session = {
      key,
      src: settings.src,
      cat: settings.cat,
      date: today(),
      cards: deck,
      idx: 0,
      flipped: false,
      graded: new Set(),
      right: 0,
      wrong: 0,
      issue: settings.src !== 'all' && issue ? { stem: issue.stem, label: issue.label } : null,
      history: [],
    };
    persistSession(session);
    location.hash = '#study';
    show('study');
    renderCard();
  }
  function startCustomSession(words) {
    if (!words.length) return;
    const cards = words.slice(0, 50).map(w => ({ w, kind: w.progress ? 'review' : 'new' }));
    const key = 'browse::' + browseFilter;
    session = {
      key,
      src: 'custom',
      cat: browseFilter,
      date: today(),
      cards,
      idx: 0,
      flipped: false,
      graded: new Set(),
      right: 0,
      wrong: 0,
      issue: null,
      history: [],
    };
    persistSession(session);
    location.hash = '#study';
    show('study');
    renderCard();
  }
  $('#start-btn').addEventListener('click', startSession);
  $('#restart-btn').addEventListener('click', () => {
    const key = sessionKey(settings.src, settings.cat);
    const saved = getSavedSession(key);
    if (saved && saved.idx > 0 && !confirm(`確定要清除目前進度（第 ${saved.idx}/${saved.cards.length} 張）從頭開始嗎？`)) return;
    clearSavedSession(key);
    renderHome();
    toast('已重置本輪進度，可從頭開始');
  });

  function updateUndoUI() {
    const ub = $('#undo-btn');
    if (ub) ub.disabled = !(session && session.history && session.history.length);
  }

  function renderCard(startFlipped) {
    const s = session;
    if (s.idx >= s.cards.length) return finishSession();
    closeLookup();
    const { w, kind, again } = s.cards[s.idx];
    s.flipped = !!startFlipped;
    if (again && !startFlipped && (s.idx === 0 || !s.cards[s.idx - 1].again)) {
      const left = s.cards.slice(s.idx).filter(c => c.again).length;
      toast(`新卡都看完了，接著複習剛才不熟的 ${left} 個字`, 2600);
    }

    const total = s.cards.length;
    $('#prog-fill').style.width = Math.round((s.idx / total) * 100) + '%';
    $('#prog-text').textContent = `${s.idx + 1} / ${total}`;
    updateUndoUI();

    const chips = [
      again ? '<span class="chip again">再練一次</span>' : kind === 'new' ? '<span class="chip new">新字</span>' : '<span class="chip">複習</span>',
      w.category === 'fin' ? '<span class="chip fin">財經</span>' : '',
      isSaved(w) ? '<span class="chip star">★ 收藏</span>' : '',
      w.freq > 1 ? `<span class="chip">新聞出現 ${w.freq} 次</span>` : '',
    ].join('');

    const card = $('#card');
    card.classList.remove('flipped', 'card-enter');
    void card.offsetWidth;
    if (s.flipped) card.classList.add('flipped');
    else card.classList.add('card-enter');
    card.innerHTML = `
      <div class="card-inner">
        <div class="face front">
          <div class="chips">${chips}</div>
          <div class="word">${esc(w.word)}</div>
          <button class="speak" type="button" data-say="${esc(w.word)}" aria-label="朗讀">${SPEAK_SVG}<span>發音</span></button>
          <div class="hint">想一想中文意思，輕點卡片翻面</div>
        </div>
        <div class="face back">
          <div class="back-word">
            <span>${esc(w.word)}</span>
            <button class="speak" type="button" data-say="${esc(w.word)}" aria-label="朗讀">${SPEAK_SVG}</button>
            <span class="back-tools">
              <button class="flip-back-btn" type="button" data-flip="1" aria-label="翻回正面">正面</button>
              ${starBtn(w)}
            </span>
          </div>
          <div class="meaning">${esc(meaningOf(w) || '（尚無中文解釋）')}</div>
          ${w.context_en ? `
          <div class="ctx">
            <div class="label">新聞原句 · 點任一個字看中文</div>
            <p>${ctxHtml(w.context_en, w.word)}</p>
            ${srcHtml(w.source)}
          </div>` : ''}
          <div class="ai" id="ai-box">${aiHtml(w)}</div>
        </div>
      </div>`;
    renderActions();
    window.scrollTo({ top: 0, behavior: 'instant' });
    card.focus({ preventScroll: true });
    if (!startFlipped && settings.autoSpeak) say(w.word);
  }

  function renderActions() {
    const s = session;
    const { w } = s.cards[s.idx];
    const box = $('#actions');
    if (!s.flipped) {
      box.className = 'actions';
      box.innerHTML = '<button class="btn primary big" type="button" data-act="flip">顯示答案</button><div class="kbd-hint">空白鍵翻面</div>';
      return;
    }
    const p = w.progress;
    box.className = 'actions three';
    box.innerHTML = `
      <button class="grade g0" type="button" data-grade="0">答錯<small>${fmtDays(previewInterval(p, 0))}後</small></button>
      <button class="grade g2" type="button" data-grade="2">答對<small>${fmtDays(previewInterval(p, 2))}後</small></button>
      <button class="grade g3" type="button" data-grade="3">很簡單<small>${fmtDays(previewInterval(p, 3))}後</small></button>
      <div class="kbd-hint" style="grid-column:1/-1">鍵盤 1 答錯 · 2 答對 · 3 很簡單 · S 發音 · Z 復原</div>`;
  }

  function flip() {
    if (!session) return;
    closeLookup();
    session.flipped = !session.flipped;
    $('#card').classList.toggle('flipped', session.flipped);
    renderActions();
  }

  function grade(g) {
    const s = session;
    if (!s || !s.flipped) return;
    const card = s.cards[s.idx];
    const w = card.w;
    const snap = {
      idx: s.idx,
      right: s.right,
      wrong: s.wrong,
      wasNewlyGraded: !s.graded.has(w.id),
      wordId: w.id,
      pendingRid: null,
      answeredAdded: false,
      againSplicedAt: null,
    };
    if (snap.wasNewlyGraded) {
      // Only the first answer of the session counts toward the schedule; re-shown cards are practice.
      s.graded.add(w.id);
      // 單字本還沒有的字只在本機練習；今天已作答過的字（例如同一期再練一次）不重複計入排程
      if (!w.local && !answeredToday().includes(w.id)) {
        const rid = uid();
        snap.pendingRid = rid;
        snap.answeredAdded = true;
        pending.push({ id: w.id, grade: g, ts: new Date().toISOString(), rid });
        store.set('pending', pending);
        markAnswered(w.id);
      }
      if (g === 0) s.wrong++; else s.right++;
      updateSyncUI();
      scheduleSync();
    }
    if (g === 0) {
      // 不熟的字排到這一輪最後：整副先看完，再回頭複習不熟的
      const at = s.cards.length;
      s.cards.splice(at, 0, { w, kind: card.kind, again: true });
      snap.againSplicedAt = at;
    }
    if (!s.history) s.history = [];
    s.history.push(snap);
    if (s.history.length > 20) s.history.shift();
    s.idx++;
    persistSession(s);
    renderCard();
  }

  function undoGrade() {
    const s = session;
    if (!s || !s.history || !s.history.length) return;
    const h = s.history.pop();
    if (h.againSplicedAt !== null && s.cards[h.againSplicedAt] && s.cards[h.againSplicedAt].again) {
      s.cards.splice(h.againSplicedAt, 1);
    }
    s.idx = h.idx;
    s.right = h.right;
    s.wrong = h.wrong;
    if (h.wasNewlyGraded) s.graded.delete(h.wordId);
    if (h.pendingRid) {
      const before = pending.length;
      pending = pending.filter(r => r.rid !== h.pendingRid);
      if (pending.length !== before) {
        store.set('pending', pending);
        updateSyncUI();
      }
    }
    if (h.answeredAdded) unmarkAnswered(h.wordId);
    persistSession(s);
    renderCard(true);
    toast('已回到上一張，請重新評分', 1800);
  }

  function finishSession() {
    const s = session;
    session = null;
    if (s && s.key) clearSavedSession(s.key);
    const n = s.right + s.wrong;
    $('#view-done h2').textContent = '這輪練習完成了';
    $('#view-done .done-emoji').textContent = '🎉';
    const acc = n ? Math.round((s.right / n) * 100) : 0;
    $('#done-text').textContent = n
      ? `這輪共完成 ${n} 個字（答對 ${s.right}・答錯 ${s.wrong}，正確率 ${acc}%）。答錯的字明天會再加強複習。`
      : '沒有新的作答。';
    const rd = $('#done-read');
    rd.hidden = !s.issue;
    $('#done-home').classList.toggle('primary', !s.issue);
    if (s.issue) {
      rd.href = '../?r=' + encodeURIComponent(s.issue.stem) + '&lang=en';
      rd.textContent = `去讀這期新聞（英文）→ ${s.issue.label}`;
    }
    location.hash = '#done';
    show('done');
    scheduleSync(0);
  }

  $('#card').addEventListener('click', e => {
    if (e.target.closest('a')) {
      if (session) persistSession(session);
      return;
    }
    const sp = e.target.closest('[data-say]');
    if (sp) { say(sp.dataset.say); return; }
    const st = e.target.closest('[data-star]');
    if (st) { if (session) toggleStar(session.cards[session.idx].w, st); return; }
    const fl = e.target.closest('[data-flip]');
    if (fl) { flip(); return; }
    const gw = e.target.closest('.gw');
    if (gw && session && session.flipped) {
      e.stopPropagation();
      lookUp(gw.dataset.k, session.cards[session.idx].w.context_en || '');
      return;
    }
    if (e.target.closest('.ai')) return;
    // 只在正面點卡片才會翻到背面；背面捲動或誤觸空白處不再意外翻回正面
    if (session && !session.flipped) flip();
  });
  $('#actions').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'flip') flip();
    else if (b.dataset.grade) grade(Number(b.dataset.grade));
  });
  $('#undo-btn').addEventListener('click', undoGrade);
  $('#quit-btn').addEventListener('click', () => {
    if (!session) { location.hash = '#home'; return; }
    const s = session;
    if (s.idx > 0 || s.graded.size > 0) {
      persistSession(s);
      store.del('activeSession');
      scheduleSync(0);
      toast(`已保存進度（${s.idx} / ${s.cards.length}），隨時可繼續`, 2400);
    } else {
      clearSavedSession(s.key);
    }
    session = null;
    location.hash = '#home';
  });
  $('#done-home').addEventListener('click', () => { location.hash = '#home'; });

  document.addEventListener('keydown', e => {
    if (!session || $('#view-study').hidden || e.target.matches('input, textarea, select')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    else if (e.key === '1') grade(0);
    else if (e.key === '2') grade(2);
    else if (e.key === '3') grade(3);
    else if (e.key.toLowerCase() === 's') say(session.cards[session.idx].w.word);
    else if (e.key.toLowerCase() === 'z' || e.key === 'Backspace') { e.preventDefault(); undoGrade(); }
    else if (e.key === 'Escape') {
      if (!$('#lookup-pop').hidden) closeLookup();
      else $('#quit-btn').click();
    }
  });

  /* ------------------------------ AI 例句 ------------------------------ */
  const aiCache = store.get('ai', {});

  // aiCache[id] = { examples, model }（舊版只存陣列）
  const cached = id => { const c = aiCache[id]; return Array.isArray(c) ? { examples: c, model: '' } : (c || null); };
  const modelName = id => { const m = (aiModelList || []).find(x => x.id === id); return m ? m.label : (id || ''); };

  function aiHtml(w) {
    const c = cached(w.id);
    const ex = (w.ai_examples && w.ai_examples.length && w.ai_examples) || (c && c.examples);
    const by = (w.ai_examples && w.ai_examples.length && w.ai_model) || (c && c.model) || '';
    if (ex && ex.length) {
      const want = settings.aiModel;
      const redo = want && by && want !== by && !DEMO
        ? ` · <button class="linkish" data-ai="force">改用 ${esc(modelName(want))} 重新產生</button>` : '';
      return '<div class="label">科技應用例句</div><ul class="ai-list">' + ex.map(x => `
        <li><div class="en">${x.field ? `<span class="chip">${esc(x.field)}</span>` : ''}${highlight(x.en, w.word)}
          <button class="speak" type="button" data-say="${esc(x.en)}" aria-label="朗讀例句">${SPEAK_SVG}</button></div>
          <div class="zh">${esc(x.zh)}</div></li>`).join('') + '</ul>' +
        (by ? `<p class="ai-by">由 ${esc(modelName(by))} 產生${redo}</p>` : '');
    }
    return '<button class="ai-btn" data-ai="1">✨ 產生科技／工程領域例句' +
      (settings.aiModel ? `<small>（${esc(modelName(settings.aiModel))}）</small>` : '') + '</button>';
  }

  $('#card').addEventListener('click', async e => {
    const b = e.target.closest('[data-ai]');
    if (!b || !session) return;
    const w = session.cards[session.idx].w;
    const force = b.dataset.ai === 'force';
    if (force) $('#ai-box').innerHTML = '<button class="ai-btn" disabled>產生中…（約 5–15 秒）</button>';
    else { b.disabled = true; b.textContent = '產生中…（約 5–15 秒）'; }
    const body = { action: 'aiExamples', id: w.id, force };
    if (settings.aiModel) body.model = settings.aiModel;
    try {
      const r = await apiPost(body);
      if (!DEMO) { aiCache[w.id] = { examples: r.examples, model: r.model }; store.set('ai', aiCache); } // never persist demo text
      w.ai_examples = r.examples;
      w.ai_model = r.model;
      if (session && session.cards[session.idx].w.id === w.id) $('#ai-box').innerHTML = aiHtml(w);
    } catch (err) {
      if (err.code === 404 && body.model) { aiBlocked[body.model] = Date.now(); store.set('aiBlocked', aiBlocked); }
      const msg = err.code === 501 ? 'AI 尚未設定：在 Apps Script 的「指令碼屬性」加入 GEMINI_API_KEY 後即可使用。'
        : err.code === 401 ? '需要先到「設定」輸入 token。'
        : err.code === -1 ? '目前離線，連上網路再試。'
        : '產生失敗：' + err.message;
      $('#ai-box').innerHTML = `<p class="ai-err">${esc(msg)}</p>`;
    }
  });

  /* ------------------------- AI 模型清單（設定頁） ------------------------- */
  let aiModelList = store.get('aiModels', null);   // 上次拿到的清單：離線時也能顯示模型名稱
  const aiBlocked = store.get('aiBlocked', {});     // 實際呼叫回 404 的模型（金鑰看得到但不能用）

  async function loadAiModels() {
    const sel = $('#set-ai-model');
    try {
      const r = await apiGet({ action: 'aiModels' });
      aiModelList = r.models || [];
      store.set('aiModels', aiModelList);
      fillAiModels(r.default);
    } catch (e) {
      if (aiModelList) fillAiModels('');
      else sel.innerHTML = '<option value="">（讀不到模型清單：後端還沒更新，或目前離線）</option>';
    }
  }

  function fillAiModels(backendDefault) {
    const sel = $('#set-ai-model');
    const fmt = m => {
      if (m.provider === 'claude') return `${m.label}（Claude）`;
      const tags = [m.free ? '免費' : '需付費', aiBlocked[m.id] ? '你的金鑰不能用' : m.listed === false ? '你的金鑰看不到' : ''].filter(Boolean).join('・');
      return `${m.label}　$${m.in.toFixed(2)} / $${m.out.toFixed(2)}　${tags}`;
    };
    const known = aiModelList.some(m => m.id === settings.aiModel);
    sel.innerHTML = `<option value="">後端預設${backendDefault ? `（${esc(modelName(backendDefault))}）` : ''}</option>` +
      aiModelList.map(m => `<option value="${esc(m.id)}">${esc(fmt(m))}</option>`).join('') +
      '<option value="__custom">自訂模型代號…</option>';
    sel.value = !settings.aiModel ? '' : known ? settings.aiModel : '__custom';
    $('#set-ai-custom').hidden = sel.value !== '__custom';
    if (sel.value === '__custom') $('#set-ai-custom').value = settings.aiModel;
    showModelNote();
  }

  function showModelNote() {
    const m = (aiModelList || []).find(x => x.id === $('#set-ai-model').value);
    $('#ai-model-note').textContent = m && m.note ? `${m.label}：${m.note}`
      : '價格為 Google 付費方案每 100 萬 token 的輸入 / 輸出（美元）；標「免費」的模型用免費額度就能產生。';
  }

  $('#set-ai-model').addEventListener('change', e => {
    $('#set-ai-custom').hidden = e.target.value !== '__custom';
    if (e.target.value === '__custom') $('#set-ai-custom').focus();
    showModelNote();
  });

  /* ------------------- 共用字典（快報網站的 glossary.json） ------------------- */
  // 與快報網站點字查義是同一份字典：../data/en/glossary.json（{ 小寫單字: 中文 }）
  let gloss = null;
  fetch('../data/en/glossary.json').then(r => (r.ok ? r.json() : null)).then(g => {
    gloss = g || null;
    if (gloss && session && session.flipped) { renderCard(); flip(); }
  }).catch(() => { /* offline: the card still shows the Sheet meaning */ });

  const meaningOf = w => w.meaning_zh || (gloss && gloss[w.id]) || '';

  // 與快報一致的查字規則：支援縮寫原樣（TSMC、CoWoS）、小寫、所有格 's 與連字號拆分
  function glossLookup(tok) {
    if (!gloss) return null;
    const clean = String(tok || '').replace(/’/g, "'");
    const stripped = clean.replace(/'s$/i, '');
    for (const c of [clean, clean.toLowerCase(), stripped, stripped.toLowerCase()]) {
      if (Object.prototype.hasOwnProperty.call(gloss, c)) return c;
    }
    return null;
  }
  function wrapGlossPiece(piece) {
    if (!/^[A-Za-z]/.test(piece)) return esc(piece);
    const k = glossLookup(piece);
    if (k) return `<span class="gw" data-k="${esc(k)}">${esc(piece)}</span>`;
    if (piece.includes('-')) return piece.split('-').map(wrapGlossPiece).join('-');
    return esc(piece);
  }

  // 原句逐字包成可點的字（字典有的才可點），本卡的單字照舊標黃
  function ctxHtml(text, word) {
    const marks = [];
    if (word) {
      const pat = new RegExp('(?<![A-Za-z])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'ig');
      let m;
      while ((m = pat.exec(text))) { marks.push([m.index, m.index + m[0].length]); if (!m[0].length) break; }
    }
    const inMark = i => marks.some(([a, b]) => i >= a && i < b);
    let out = '', open = false;
    const re = /[A-Za-z][A-Za-z'’-]*|[^A-Za-z]+/g;
    let t;
    while ((t = re.exec(text))) {
      const piece = t[0];
      const mk = inMark(t.index);
      if (mk && !open) { out += '<mark>'; open = true; }
      if (!mk && open) { out += '</mark>'; open = false; }
      out += wrapGlossPiece(piece);
    }
    if (open) out += '</mark>';
    return out;
  }

  function closeLookup() {
    const pop = $('#lookup-pop');
    if (pop) pop.hidden = true;
  }

  function lookUp(k, ctxText) {
    const zh = gloss && gloss[k];
    if (!zh) return;
    const pop = $('#lookup-pop');
    if (!pop) return;
    const savedOn = Wordbook.has(k);
    pop.innerHTML = `
      <div class="lookup-head">
        <b lang="en">${esc(k)}</b>
        <button class="speak" type="button" data-say="${esc(k)}" aria-label="朗讀">${SPEAK_SVG}</button>
        <button class="lookup-close" type="button" aria-label="關閉">×</button>
      </div>
      <div class="lookup-zh">${esc(zh)}</div>
      <button class="star-btn${savedOn ? ' on' : ''}" type="button" data-lstar="${esc(k)}" data-lzh="${esc(zh)}" data-lctx="${esc(ctxText || '')}">${savedOn ? '★ 已收藏到單字本' : '☆ 收藏到單字本'}</button>`;
    pop.hidden = false;
    if (settings.autoSpeak) say(k);
  }

  $('#lookup-pop').addEventListener('click', e => {
    e.stopPropagation();
    const sp = e.target.closest('[data-say]');
    if (sp) { say(sp.dataset.say); return; }
    if (e.target.closest('.lookup-close')) { closeLookup(); return; }
    const st = e.target.closest('[data-lstar]');
    if (st) {
      const on = Wordbook.toggle({ t: st.dataset.lstar, zh: st.dataset.lzh, ctx: st.dataset.lctx, fin: false });
      st.classList.toggle('on', on);
      st.textContent = on ? '★ 已收藏到單字本' : '☆ 收藏到單字本';
    }
  });
  document.addEventListener('click', e => {
    const pop = $('#lookup-pop');
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target) || e.target.closest('.gw')) return;
    closeLookup();
  });

  /* ------------------- 收藏（與快報共用 ../assets/wordbook.js） ------------------- */
  // 收藏狀態一律以共用單字本為準（本機＋Sheet 合併後的結果），同步、重送、離線佇列都由它處理
  if (DEMO) Wordbook.setOffline(true);
  const isSaved = w => Wordbook.has(w.word);
  const starBtn = w => `<button class="star-btn${isSaved(w) ? ' on' : ''}" data-star="1" aria-label="收藏">${isSaved(w) ? '★ 已收藏' : '☆ 收藏'}</button>`;

  function toggleStar(w, btn) {
    const on = Wordbook.toggle({ t: w.word, zh: meaningOf(w), ctx: w.context_en || '', fin: w.category === 'fin' });
    w.saved = on;
    if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '★ 已收藏' : '☆ 收藏'; }
    if (!DEMO && !Wordbook.status().configured) toast('收藏已存在這台裝置；到「設定」輸入 token 後會同步到單字本', 3500);
  }
  // 雲端合併或另一個分頁（例如快報）改了收藏：單字本頁面跟著更新
  Wordbook.onChange((kind, from) => {
    if (kind === 'saved' && from !== 'local' && !$('#view-browse').hidden) loadBrowse();
  });

  /* ------------------------------ browse ------------------------------- */
  let browseFilter = 'all';
  let browseLimit = 100;
  let lastBrowseRows = [];

  async function loadBrowse() {
    $$('#browse-seg button').forEach(b => b.classList.toggle('on', b.dataset.f === browseFilter));
    renderBrowse();
    try {
      const r = await apiGet({ action: 'words' });
      wordsData = r.words;
      store.set('words', wordsData);
      renderBrowse();
    } catch (e) {
      if (!wordsData) $('#browse-count').textContent = '載入失敗：' + e.message;
    }
  }

  function statusOf(w) {
    const p = w.progress;
    if (!p) return '<span class="wl-status new">新字</span>';
    const d = daysBetween(today(), p.due);
    if (d <= 0) return '<span class="wl-status due">今天複習</span>';
    return `<span class="wl-status">${d} 天後</span>`;
  }

  function renderBrowse() {
    const list = $('#word-list');
    if (!wordsData) { $('#browse-count').textContent = '載入中…'; list.innerHTML = ''; return; }
    const q = $('#q').value.trim().toLowerCase();
    let rows = wordsData.filter(w => {
      if (browseFilter === 'fin' && w.category !== 'fin') return false;
      if (browseFilter === 'learned' && !w.progress) return false;
      if (browseFilter === 'hard' && !(w.progress && w.progress.lapses > 0)) return false;
      if (browseFilter === 'saved' && !isSaved(w)) return false;
      return !q || w.word.toLowerCase().includes(q) || (w.meaning_zh || '').includes(q);
    });
    const sort = $('#sort').value;
    const cmp = {
      recent: (a, b) => (b.last_seen > a.last_seen ? 1 : b.last_seen < a.last_seen ? -1 : b.freq - a.freq),
      freq: (a, b) => b.freq - a.freq,
      due: (a, b) => ((a.progress ? a.progress.due : '9') > (b.progress ? b.progress.due : '9') ? 1 : -1),
      az: (a, b) => a.word.localeCompare(b.word),
    }[sort];
    rows = rows.slice().sort(cmp);
    lastBrowseRows = rows;
    $('#browse-count').textContent = `${rows.length} 個字`;
    const drillBtn = $('#browse-drill');
    if (drillBtn) {
      const showDrill = rows.length > 0 && (browseFilter !== 'all' || !!q);
      drillBtn.hidden = !showDrill;
      if (showDrill) {
        const n = Math.min(rows.length, 50);
        drillBtn.textContent = `練習這批（${n} 張）→`;
      }
    }
    list.innerHTML = rows.slice(0, browseLimit).map(w => `
      <li data-id="${esc(w.id)}">
        <div class="wl-top"><span class="wl-word">${isSaved(w) ? '★ ' : ''}${esc(w.word)}</span><span class="wl-mean">${esc(meaningOf(w))}</span>${statusOf(w)}</div>
      </li>`).join('');
    $('#more-btn').hidden = rows.length <= browseLimit;
  }

  $('#word-list').addEventListener('click', e => {
    const sp = e.target.closest('[data-say]');
    if (sp) { say(sp.dataset.say); return; }
    const st = e.target.closest('[data-star]');
    if (st) {
      const w = wordsData.find(x => x.id === st.closest('li').dataset.id);
      if (w) { toggleStar(w, st); const ww = st.closest('li').querySelector('.wl-word'); if (ww) ww.textContent = (isSaved(w) ? '★ ' : '') + w.word; }
      return;
    }
    const gw = e.target.closest('.gw');
    if (gw) {
      e.stopPropagation();
      const li = gw.closest('li');
      const w = li && wordsData ? wordsData.find(x => x.id === li.dataset.id) : null;
      lookUp(gw.dataset.k, w ? w.context_en : '');
      return;
    }
    const li = e.target.closest('li');
    if (!li || e.target.closest('.wl-detail')) return;
    const open = li.querySelector('.wl-detail');
    if (open) { open.remove(); return; }
    const w = wordsData.find(x => x.id === li.dataset.id);
    if (!w) return;
    const p = w.progress;
    li.insertAdjacentHTML('beforeend', `
      <div class="wl-detail">
        <div class="back-word">${esc(w.word)} <button class="speak" type="button" data-say="${esc(w.word)}" aria-label="朗讀">${SPEAK_SVG}</button>
          ${w.category === 'fin' ? '<span class="chip fin">財經</span>' : ''} ${starBtn(w)}</div>
        <div class="meaning">${esc(meaningOf(w))}</div>
        ${w.context_en ? `<div class="ctx"><p>${ctxHtml(w.context_en, w.word)}</p>${srcHtml(w.source)}</div>` : ''}
        <div class="small muted">出現 ${w.freq} 次 · 最近 ${esc(w.last_seen)}${p ? ` · 已複習 ${p.total_reviews} 次、答錯 ${p.lapses} 次、間隔 ${p.interval} 天` : ''}</div>
      </div>`);
  });
  $('#q').addEventListener('input', () => { browseLimit = 100; renderBrowse(); });
  $('#sort').addEventListener('change', renderBrowse);
  $('#browse-seg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    browseFilter = b.dataset.f;
    browseLimit = 100;
    $$('#browse-seg button').forEach(x => x.classList.toggle('on', x === b));
    renderBrowse();
  });
  $('#more-btn').addEventListener('click', () => { browseLimit += 200; renderBrowse(); });
  $('#browse-drill').addEventListener('click', () => {
    if (!lastBrowseRows.length) return;
    startCustomSession(lastBrowseRows);
  });

  /* ----------------------------- settings ------------------------------ */
  function fillSettings() {
    $('#set-url').value = settings.apiUrl;
    $('#set-token').value = settings.token;
    $('#set-new').value = settings.newLimit;
    $('#set-speak').checked = !!settings.autoSpeak;
    if (aiModelList) fillAiModels('');
    loadAiModels();
    $('#set-msg').textContent = '';
    $('#version-label').textContent = `版本 ${CFG.version || '-'}${DEMO ? '（示範模式）' : ''} · ${pending.length} 筆作答待同步`;
  }
  function readSettings() {
    settings.apiUrl = $('#set-url').value.trim();
    settings.token = $('#set-token').value.trim();
    settings.newLimit = Math.max(0, Math.min(200, parseInt($('#set-new').value, 10) || 0));
    settings.autoSpeak = $('#set-speak').checked;
    const am = $('#set-ai-model').value;
    if (am !== '' || aiModelList) {   // 清單沒載入時不要把選擇清掉
      settings.aiModel = am === '__custom' ? $('#set-ai-custom').value.trim().toLowerCase() : am;
    }
    saveSettings();
  }
  function setMsg(text, ok) {
    const m = $('#set-msg');
    m.textContent = text;
    m.className = 'small ' + (ok ? 'ok' : 'err');
  }

  $('#settings-form').addEventListener('submit', e => {
    e.preventDefault();
    readSettings();
    setMsg('已儲存', true);
    syncError = '';
    sync();
    Wordbook.sync();   // 剛填好 token：把之前只存在本機的收藏補送上去
  });
  $('#toggle-token').addEventListener('click', e => {
    const i = $('#set-token');
    i.type = i.type === 'password' ? 'text' : 'password';
    e.target.textContent = i.type === 'password' ? '顯示' : '隱藏';
  });
  $('#test-btn').addEventListener('click', async () => {
    readSettings();
    setMsg('測試中…', true);
    try {
      const st = await apiGet({ action: 'stats' });
      try {
        await apiPost({ action: 'auth' });
      } catch (e) {
        // An older backend without "auth" still checks the token first, so "unknown action" means the token is valid.
        if (!(e.code === 400 && /unknown action/.test(e.message))) throw e;
      }
      setMsg(`連線成功：Sheet 共 ${st.total} 字，token 正確，作答可以寫回。`, true);
      syncError = '';
      sync();
    } catch (e) {
      setMsg(e.code === 401 ? '讀取正常，但 token 不正確（或尚未輸入）。' : '連線失敗：' + e.message, false);
    }
  });
  $('#clear-cache').addEventListener('click', () => {
    if (pending.length && !confirm(`還有 ${pending.length} 筆作答沒同步，清除快取會保留它們。繼續？`)) return;
    ['queue', 'stats', 'words', 'ai', 'answered'].forEach(store.del);
    queueData = statsData = wordsData = null;
    toast('已清除快取（設定與待同步作答保留）');
  });

  /* ------------------------------- boot -------------------------------- */
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* not fatal */ });
  }
  // 深淺色：與快報共用 wr-theme，並同步更新 iOS 狀態列 theme-color
  function applyTheme(t, persist) {
    document.documentElement.setAttribute('data-theme', t);
    const mt = document.getElementById('meta-theme');
    if (mt) mt.setAttribute('content', t === 'dark' ? '#090b10' : '#f6f6f3');
    if (persist) { try { localStorage.setItem('wr-theme', t); } catch (e) { /* ignore */ } }
  }
  $('#btn-theme').addEventListener('click', () => {
    const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(t, true);
  });
  window.addEventListener('storage', e => {
    if (e.key === 'wr-theme' && e.newValue) applyTheme(e.newValue, false);
  });

  // 從快報「先練這期單字」進來：?src=<那一期的檔名>
  const qsSrc = new URLSearchParams(location.search).get('src');
  if (qsSrc) {
    settings.src = qsSrc;
    saveSettings();
    history.replaceState(null, '', location.pathname + (DEMO ? '?demo' : '') + '#home');
  }

  updateSyncUI();
  fillSrcSelect();
  loadReports().then(() => { if (settings.src !== 'all') selectSource(settings.src); });
  route();
})();
