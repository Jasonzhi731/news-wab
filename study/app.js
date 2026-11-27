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

  const DEFAULTS = { apiUrl: CFG.apiUrl || '', token: '', newLimit: 20, autoSpeak: false, cat: 'all', src: 'all' };
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
    let interval = (p && p.interval) || 0, ease = (p && p.ease) || 2.5, reps = (p && p.reps) || 0;
    if (grade === 0) return 1;
    reps += 1;
    if (reps === 1) return grade === 3 ? 4 : 1;
    if (reps === 2) return grade === 1 ? 3 : grade === 3 ? 8 : 6;
    const f = grade === 1 ? 1.2 : grade === 3 ? ease * 1.3 : ease;
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

  function updateSyncUI() {
    const pill = $('#sync-pill');
    if (syncing) { pill.hidden = false; pill.className = 'sync-pill'; pill.textContent = '同步中…'; return; }
    if (!pending.length) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.className = 'sync-pill' + (syncError ? ' warn' : '');
    pill.textContent = (syncError ? '⚠ ' : '⟳ ') + pending.length + ' 筆待同步';
    pill.title = syncError || '點一下立即同步';
  }

  function scheduleSync(ms = 1500) {
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

  // When the app is closed or hidden, fire-and-forget the queue. It stays in `pending`;
  // the next normal sync re-sends it and the server skips rids it already has.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !pending.length || DEMO || !settings.token || !navigator.sendBeacon) return;
    const body = JSON.stringify({ token: settings.token, action: 'review', reviews: pending.slice(0, 200) });
    navigator.sendBeacon(settings.apiUrl, new Blob([body], { type: 'text/plain;charset=utf-8' }));
  });
  window.addEventListener('online', () => sync());

  /* ------------------------------ routing ------------------------------ */
  const VIEWS = ['home', 'study', 'done', 'browse', 'settings'];
  function show(view) {
    VIEWS.forEach(v => { $('#view-' + v).hidden = v !== view; });
    document.body.classList.toggle('studying', view === 'study');
    $$('#tabs a').forEach(a => a.classList.toggle('is-on', a.dataset.view === view));
    window.scrollTo(0, 0);
  }
  function route() {
    const v = (location.hash || '#home').slice(1);
    if (v === 'browse') { show('browse'); loadBrowse(); }
    else if (v === 'settings') { show('settings'); fillSettings(); }
    else if (v === 'study' && session) { show('study'); }
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

    const deck = buildDeck();
    const nDue = deck.filter(c => c.kind === 'review').length;
    const nNew = deck.length - nDue;
    const isIssue = settings.src !== 'all';
    $('#st-due').textContent = queueData || isIssue ? nDue : '–';
    $('#st-new').textContent = queueData || isIssue ? nNew : '–';
    $('#st-due').parentNode.querySelector('span').textContent = isIssue ? '本期已學' : '待複習';
    $('#st-new').parentNode.querySelector('span').textContent = isIssue ? '本期新字' : '今日新字';
    const sn = $('#src-note');
    sn.hidden = !isIssue;
    if (isIssue) {
      const nLocal = deck.filter(c => c.w.local).length;
      sn.textContent = issue
        ? `${issue.label} 共 ${deck.length} 個字，依新聞順序出題；作答會一起算進間隔重複。`
          + (nLocal ? `其中 ${nLocal} 個字單字本還沒有，只在這台裝置練習。` : '')
        : '載入這一期的單字中…';
    }
    $('#st-learned').textContent = statsData ? statsData.learned : '–';
    $('#st-mature').textContent = statsData ? statsData.mature : '–';

    const btn = $('#start-btn');
    if (isIssue) {
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
  function issueDeck() {
    if (!issue) return [];
    const byId = new Map((wordsData || []).map(w => [w.id, w]));
    return issue.words.map(x => {
      const sw = byId.get(x.id);
      const w = sw
        ? Object.assign({}, sw, { context_en: x.context_en || sw.context_en, source: x.context_en ? x.source : sw.source })
        : { id: x.id, word: x.word, meaning_zh: x.zh, category: x.fin ? 'fin' : '', freq: 1, context_en: x.context_en,
            source: x.source, progress: null, saved: false, local: true };
      if (!w.meaning_zh) w.meaning_zh = x.zh;
      return w;
    }).filter(w => catMatch(w, settings.cat))
      .map(w => ({ w, kind: w.progress ? 'review' : 'new' }));
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


  /* ------------------------------- study ------------------------------- */
  let session = null;

  function startSession() {
    const deck = buildDeck();
    if (!deck.length) return;
    session = { cards: deck, idx: 0, flipped: false, graded: new Set(), right: 0, wrong: 0,
      issue: settings.src !== 'all' && issue ? issue : null };
    location.hash = '#study';
    show('study');
    renderCard();
  }
  $('#start-btn').addEventListener('click', startSession);

  function renderCard() {
    const s = session;
    if (s.idx >= s.cards.length) return finishSession();
    const { w, kind, again } = s.cards[s.idx];
    s.flipped = false;

    const total = s.cards.length;
    $('#prog-fill').style.width = Math.round((s.idx / total) * 100) + '%';
    $('#prog-text').textContent = `${s.idx + 1} / ${total}`;

    const chips = [
      again ? '<span class="chip again">再練一次</span>' : kind === 'new' ? '<span class="chip new">新字</span>' : '<span class="chip">複習</span>',
      w.category === 'fin' ? '<span class="chip fin">財經</span>' : '',
      w.saved ? '<span class="chip star">★ 收藏</span>' : '',
      w.freq > 1 ? `<span class="chip">新聞出現 ${w.freq} 次</span>` : '',
    ].join('');

    const card = $('#card');
    card.classList.remove('flipped');
    card.innerHTML = `
      <div class="card-inner">
        <div class="face front">
          <div class="chips">${chips}</div>
          <div class="word">${esc(w.word)}</div>
          <button class="speak" data-say="${esc(w.word)}" aria-label="朗讀">🔊 發音</button>
          <div class="hint">想一想中文意思，再點卡片翻面</div>
        </div>
        <div class="face back">
          <div class="back-word">${esc(w.word)} <button class="speak" data-say="${esc(w.word)}" aria-label="朗讀">🔊</button>
            ${starBtn(w)}</div>
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
    card.focus({ preventScroll: true });
    if (settings.autoSpeak) say(w.word);
  }

  function renderActions() {
    const s = session;
    const { w } = s.cards[s.idx];
    const box = $('#actions');
    if (!s.flipped) {
      box.className = 'actions';
      box.innerHTML = '<button class="btn primary big" data-act="flip">顯示答案</button><div class="kbd-hint">空白鍵翻面</div>';
      return;
    }
    const p = w.progress;
    box.className = 'actions three';
    box.innerHTML = `
      <button class="grade g0" data-grade="0">答錯<small>${fmtDays(previewInterval(p, 0))}後</small></button>
      <button class="grade g2" data-grade="2">答對<small>${fmtDays(previewInterval(p, 2))}後</small></button>
      <button class="grade g3" data-grade="3">很簡單<small>${fmtDays(previewInterval(p, 3))}後</small></button>
      <div class="kbd-hint" style="grid-column:1/-1">鍵盤 1 答錯 · 2 答對 · 3 很簡單 · S 發音</div>`;
  }

  function flip() {
    if (!session) return;
    session.flipped = !session.flipped;
    $('#card').classList.toggle('flipped', session.flipped);
    renderActions();
  }

  function grade(g) {
    const s = session;
    if (!s || !s.flipped) return;
    const card = s.cards[s.idx];
    const w = card.w;
    if (!s.graded.has(w.id)) {
      // Only the first answer of the session counts toward the schedule; re-shown cards are practice.
      s.graded.add(w.id);
      // 單字本還沒有的字只在本機練習；今天已作答過的字（例如同一期再練一次）不重複計入排程
      if (!w.local && !answeredToday().includes(w.id)) {
        pending.push({ id: w.id, grade: g, ts: new Date().toISOString(), rid: uid() });
        store.set('pending', pending);
        markAnswered(w.id);
      }
      if (g === 0) s.wrong++; else s.right++;
      updateSyncUI();
      scheduleSync();
    }
    if (g === 0) {
      const at = Math.min(s.idx + 4, s.cards.length);
      s.cards.splice(at, 0, { w, kind: card.kind, again: true });
    }
    s.idx++;
    renderCard();
  }

  function finishSession() {
    const s = session;
    session = null;
    const n = s.right + s.wrong;
    const early = s.idx < s.cards.length;
    $('#view-done h2').textContent = early ? '先休息一下' : '今天的進度完成了';
    $('#view-done .done-emoji').textContent = early ? '☕' : '🎉';
    $('#done-text').textContent = n
      ? `這輪共 ${n} 個字：答對 ${s.right}、答錯 ${s.wrong}。答錯的字明天會再出現。${early ? '剩下的卡片回首頁可以繼續。' : ''}`
      : '沒有新的作答。';
    const rd = $('#done-read');
    rd.hidden = !s.issue;
    if (s.issue) {
      rd.href = '../?r=' + encodeURIComponent(s.issue.stem) + '&lang=en';
      rd.textContent = `去讀這期新聞（英文）→ ${s.issue.label}`;
    }
    location.hash = '#done';
    show('done');
    scheduleSync(0);
  }

  $('#card').addEventListener('click', e => {
    if (e.target.closest('a')) return;
    const sp = e.target.closest('[data-say]');
    if (sp) { say(sp.dataset.say); return; }
    const st = e.target.closest('[data-star]');
    if (st) { if (session) toggleStar(session.cards[session.idx].w, st); return; }
    const gw = e.target.closest('.gw');
    if (gw && session && session.flipped) { lookUp(gw.dataset.k); return; }
    if (e.target.closest('.ai')) return;
    flip();
  });
  $('#actions').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'flip') flip();
    else if (b.dataset.grade) grade(Number(b.dataset.grade));
  });
  $('#quit-btn').addEventListener('click', () => {
    if (!session) return;
    if (session.graded.size) finishSession();
    else { session = null; location.hash = '#home'; }
  });
  $('#done-home').addEventListener('click', () => { location.hash = '#home'; });

  document.addEventListener('keydown', e => {
    if (!session || $('#view-study').hidden || e.target.matches('input, textarea, select')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!session.flipped) flip(); }
    else if (e.key === '1') grade(0);
    else if (e.key === '2') grade(2);
    else if (e.key === '3') grade(3);
    else if (e.key.toLowerCase() === 's') say(session.cards[session.idx].w.word);
    else if (e.key === 'Escape') $('#quit-btn').click();
  });

  /* ------------------------------ AI 例句 ------------------------------ */
  const aiCache = store.get('ai', {});

  function aiHtml(w) {
    const ex = (w.ai_examples && w.ai_examples.length && w.ai_examples) || aiCache[w.id];
    if (ex && ex.length) {
      return '<div class="label">科技應用例句</div><ul class="ai-list">' + ex.map(x => `
        <li><div class="en">${x.field ? `<span class="chip">${esc(x.field)}</span>` : ''}${highlight(x.en, w.word)}
          <button class="speak" data-say="${esc(x.en)}" aria-label="朗讀例句">🔊</button></div>
          <div class="zh">${esc(x.zh)}</div></li>`).join('') + '</ul>';
    }
    return '<button class="ai-btn" data-ai="1">✨ 產生科技／工程領域例句</button>';
  }

  $('#card').addEventListener('click', async e => {
    const b = e.target.closest('[data-ai]');
    if (!b || !session) return;
    const w = session.cards[session.idx].w;
    b.disabled = true;
    b.textContent = '產生中…（約 5–15 秒）';
    try {
      const r = await apiPost({ action: 'aiExamples', id: w.id });
      if (!DEMO) { aiCache[w.id] = r.examples; store.set('ai', aiCache); } // never persist demo text
      w.ai_examples = r.examples;
      if (session && session.cards[session.idx].w.id === w.id) $('#ai-box').innerHTML = aiHtml(w);
    } catch (err) {
      const msg = err.code === 501 ? 'AI 尚未設定：在 Apps Script 的「指令碼屬性」加入 ANTHROPIC_API_KEY 後即可使用。'
        : err.code === 401 ? '需要先到「設定」輸入 token。'
        : err.code === -1 ? '目前離線，連上網路再試。'
        : '產生失敗：' + err.message;
      $('#ai-box').innerHTML = `<p class="ai-err">${esc(msg)}</p>`;
    }
  });

  /* ------------------- 共用字典（快報網站的 glossary.json） ------------------- */
  // 與快報網站點字查義是同一份字典：../data/en/glossary.json（{ 小寫單字: 中文 }）
  let gloss = null;
  fetch('../data/en/glossary.json').then(r => (r.ok ? r.json() : null)).then(g => {
    gloss = g || null;
    if (gloss && session && session.flipped) { renderCard(); flip(); }
  }).catch(() => { /* offline: the card still shows the Sheet meaning */ });

  const meaningOf = w => w.meaning_zh || (gloss && gloss[w.id]) || '';

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
    const re = /[A-Za-z][A-Za-z'-]*|[^A-Za-z]+/g;
    let t;
    while ((t = re.exec(text))) {
      const piece = t[0];
      const mk = inMark(t.index);
      if (mk && !open) { out += '<mark>'; open = true; }
      if (!mk && open) { out += '</mark>'; open = false; }
      const k = piece.toLowerCase();
      out += /^[A-Za-z]/.test(piece) && gloss && gloss[k] ? `<span class="gw" data-k="${esc(k)}">${esc(piece)}</span>` : esc(piece);
    }
    if (open) out += '</mark>';
    return out;
  }

  function lookUp(k) {
    const zh = gloss && gloss[k];
    if (!zh) return;
    say(k);
    toast(`${k}：${zh}`, 3500);
  }

  /* ------------------- 收藏（與快報網站共用同一份單字本） ------------------- */
  const starBtn = w => `<button class="star-btn${w.saved ? ' on' : ''}" data-star="1" aria-label="收藏">${w.saved ? '★ 已收藏' : '☆ 收藏'}</button>`;

  // 收藏寫進 Sheet（saveWords），同時更新快報網站存在本機的單字本，兩邊立即一致。
  // 送不出去時排進快報網站的同步佇列（wr-vocab-ops），之後由快報頁補送。
  async function toggleStar(w, btn) {
    const on = !w.saved;
    const item = { word: w.word, meaning_zh: meaningOf(w), context_en: w.context_en || '', category: w.category || '',
      saved: on, ts: new Date().toISOString() };
    w.saved = on;
    if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '★ 已收藏' : '☆ 收藏'; }
    try {
      const local = JSON.parse(localStorage.getItem('wr-vocab-saved') || '{}') || {};
      const k = w.word.toLowerCase();
      if (on) local[k] = { t: w.word, zh: item.meaning_zh, ctx: item.context_en, fin: w.category === 'fin', at: Date.now() };
      else delete local[k];
      localStorage.setItem('wr-vocab-saved', JSON.stringify(local));
    } catch (e) { /* storage blocked */ }
    if (wordsData) store.set('words', wordsData);
    if (DEMO) return;
    try {
      await apiPost({ action: 'saveWords', items: [item] });
    } catch (e) {
      try {
        const ops = JSON.parse(localStorage.getItem('wr-vocab-ops') || '[]') || [];
        ops.push(item);
        localStorage.setItem('wr-vocab-ops', JSON.stringify(ops));
      } catch (err) { /* ignore */ }
      toast(e.code === 401 ? '收藏已存在這台裝置；到「設定」輸入 token 後會同步'
        : /unknown action/.test(e.message) ? '收藏已存在這台裝置；單字本後端更新到新版後會同步'
        : '收藏已存在這台裝置，連上網路後會同步', 3500);
    }
  }

  /* ------------------------------ browse ------------------------------- */
  let browseFilter = 'all';
  let browseLimit = 100;

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
      if (browseFilter === 'saved' && !w.saved) return false;
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
    $('#browse-count').textContent = `${rows.length} 個字`;
    list.innerHTML = rows.slice(0, browseLimit).map(w => `
      <li data-id="${esc(w.id)}">
        <div class="wl-top"><span class="wl-word">${w.saved ? '★ ' : ''}${esc(w.word)}</span><span class="wl-mean">${esc(meaningOf(w))}</span>${statusOf(w)}</div>
      </li>`).join('');
    $('#more-btn').hidden = rows.length <= browseLimit;
  }

  $('#word-list').addEventListener('click', e => {
    const sp = e.target.closest('[data-say]');
    if (sp) { say(sp.dataset.say); return; }
    const st = e.target.closest('[data-star]');
    if (st) {
      const w = wordsData.find(x => x.id === st.closest('li').dataset.id);
      if (w) { toggleStar(w, st); const ww = st.closest('li').querySelector('.wl-word'); if (ww) ww.textContent = (w.saved ? '★ ' : '') + w.word; }
      return;
    }
    const gw = e.target.closest('.gw');
    if (gw) { lookUp(gw.dataset.k); return; }
    const li = e.target.closest('li');
    if (!li || e.target.closest('.wl-detail')) return;
    const open = li.querySelector('.wl-detail');
    if (open) { open.remove(); return; }
    const w = wordsData.find(x => x.id === li.dataset.id);
    if (!w) return;
    const p = w.progress;
    li.insertAdjacentHTML('beforeend', `
      <div class="wl-detail">
        <div class="back-word">${esc(w.word)} <button class="speak" data-say="${esc(w.word)}">🔊</button>
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

  /* ----------------------------- settings ------------------------------ */
  function fillSettings() {
    $('#set-url').value = settings.apiUrl;
    $('#set-token').value = settings.token;
    $('#set-new').value = settings.newLimit;
    $('#set-speak').checked = !!settings.autoSpeak;
    $('#set-msg').textContent = '';
    $('#version-label').textContent = `版本 ${CFG.version || '-'}${DEMO ? '（示範模式）' : ''} · ${pending.length} 筆作答待同步`;
  }
  function readSettings() {
    settings.apiUrl = $('#set-url').value.trim();
    settings.token = $('#set-token').value.trim();
    settings.newLimit = Math.max(0, Math.min(200, parseInt($('#set-new').value, 10) || 0));
    settings.autoSpeak = $('#set-speak').checked;
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
  // 深淺色：與快報共用 wr-theme
  $('#btn-theme').addEventListener('click', () => {
    const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('wr-theme', t); } catch (e) { /* ignore */ }
  });
  window.addEventListener('storage', e => {
    if (e.key === 'wr-theme' && e.newValue) document.documentElement.setAttribute('data-theme', e.newValue);
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
