/**
 * News Vocab SRS — Google Apps Script backend (REST API over Google Sheets)
 *
 * Sheets (created by setup()):
 *   Words    — vocabulary content (written by the importer / AI cache; safe to hand-edit)
 *   Progress — SRS state per word (written only by the app via POST review)
 *   Log      — append-only review history
 *
 * GET  ?action=ping | words | due | stats | saved
 * POST body (Content-Type: text/plain, JSON):
 *   { token, action: "review",      reviews: [{ id, grade(0-3), ts, rid }] }
 *   { token, action: "upsertWords", words:   [{ word, meaning_zh, ... }] }
 *   { token, action: "aiExamples",  id, force }
 *   { token, action: "saveWords",   items:   [{ word, meaning_zh, context_en, category, source, saved, ts }] }
 *        -> star / unstar from the news site; adds unknown words, last write (by ts) wins
 *   { token, action: "auth" }       -> { ok: true } when the token is valid
 *
 * Script Properties:
 *   API_TOKEN            required for every POST (setup() generates one)
 *   READ_TOKEN_REQUIRED  "true" to also require ?token= on GET (default off)
 *   GEMINI_API_KEY       enables aiExamples with Gemini (Google AI Studio key; server-side only)
 *   GEMINI_MODEL         default gemini-3.8-flash
 *   GEMINI_THINKING      default low
 *   ANTHROPIC_API_KEY    enables aiExamples with Claude instead
 *   AI_MODEL             Claude model, default claude-opus-5-5
 *   AI_EFFORT            Claude effort, default low
 *   AI_PROVIDER          gemini | claude (default: gemini when GEMINI_API_KEY is set)
 *   SPREADSHEET_ID       only needed if this script is NOT bound to the spreadsheet
 */

const CFG = {
  TZ: 'Asia/Taipei',
  WORDS: 'Words',
  PROGRESS: 'Progress',
  LOG: 'Log',
  WORD_COLS: ['id', 'word', 'meaning_zh', 'category', 'first_seen', 'last_seen', 'freq',
    'context_en', 'source', 'ai_examples', 'ai_model', 'ai_updated_at', 'added_at', 'active',
    'saved', 'saved_at'],
  PROGRESS_COLS: ['id', 'due', 'interval', 'ease', 'reps', 'lapses', 'last_review',
    'last_grade', 'total_reviews', 'created'],
  LOG_COLS: ['ts', 'id', 'grade', 'prev_interval', 'new_interval', 'due', 'client_ts', 'rid'],
  // Columns stored as plain text so Sheets never turns "2026-11-25" into a Date
  TEXT_COLS: {
    Words: ['id', 'word', 'first_seen', 'last_seen', 'ai_updated_at', 'added_at', 'saved_at'],
    Progress: ['id', 'due', 'last_review', 'created'],
    Log: ['ts', 'id', 'due', 'client_ts', 'rid'],
  },
  DEFAULT_EASE: 2.5,
  MIN_EASE: 1.3,
  MAX_INTERVAL: 365,
  NEW_PER_DAY: 20,
  RID_LOOKBACK: 2000,
  ANTHROPIC_URL: 'https://api.anthropic.com/v1/messages',
  GEMINI_URL: 'https://generativelanguage.googleapis.com/v1beta/models/',
  ANTHROPIC_VERSION: '2026-10-21',
};

/* ============================== HTTP entry points ============================== */

function doGet(e) {
  return respond_(() => {
    const p = (e && e.parameter) || {};
    if (prop_('READ_TOKEN_REQUIRED') === 'true') checkToken_(p.token);
    switch (p.action || 'ping') {
      case 'ping':  return { today: today_() };
      case 'words': return { today: today_(), words: listWords_(p.all === '1') };
      case 'due':   return dueQueue_(int_(p.limit, 50), int_(p.newLimit, CFG.NEW_PER_DAY));
      case 'stats': return stats_();
      case 'saved': return { today: today_(), saved: listSaved_() };
      default: throw apiError_(400, 'unknown action: ' + p.action);
    }
  });
}

function doPost(e) {
  return respond_(() => {
    let body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      throw apiError_(400, 'body must be JSON');
    }
    checkToken_(body.token);
    switch (body.action) {
      case 'auth':        return { auth: true }; // token check only (Settings → 測試連線)
      case 'review':      return withLock_(() => applyReviews_(body.reviews || []));
      case 'upsertWords': return withLock_(() => upsertWords_(body.words || []));
      case 'aiExamples':  return aiExamples_(String(body.id || ''), !!body.force);
      case 'saveWords':   return withLock_(() => saveWords_(body.items || []));
      default: throw apiError_(400, 'unknown action: ' + body.action);
    }
  });
}

/* ================================== Reads ================================== */

function listWords_(includeInactive) {
  const W = table_(CFG.WORDS);
  const P = table_(CFG.PROGRESS);
  return W.rows
    .filter(r => String(r[W.col.id] || '') && (includeInactive || isActive_(r[W.col.active])))
    .map(r => {
      const w = wordObj_(W, r);
      const pi = P.byId.get(w.id);
      w.progress = pi == null ? null : progressObj_(P, P.rows[pi]);
      return w;
    });
}

/** Today's study queue: due reviews first (oldest due, hardest first), then capped new words. */
function dueQueue_(limit, newLimit) {
  const today = today_();
  const words = listWords_(false);
  const due = words
    .filter(w => w.progress && w.progress.due && w.progress.due <= today)
    .sort((a, b) => cmp_(a.progress.due, b.progress.due) || a.progress.ease - b.progress.ease);
  const fresh = words
    .filter(w => !w.progress)
    // starred words first, then newest news, then the words that show up most often
    .sort((a, b) => (b.saved - a.saved) || cmp_(b.last_seen, a.last_seen) || b.freq - a.freq);
  const P = table_(CFG.PROGRESS);
  const newToday = P.rows.filter(r => fmtDate_(r[P.col.created]) === today).length;
  const newRemaining = Math.max(0, newLimit - newToday);
  return {
    today,
    due: due.slice(0, limit),
    new: fresh.slice(0, newRemaining),
    counts: { due: due.length, new: fresh.length, newToday, newRemaining },
  };
}

function stats_() {
  const today = today_();
  const words = listWords_(false);
  const learned = words.filter(w => w.progress);
  return {
    today,
    total: words.length,
    learned: learned.length,
    due: learned.filter(w => w.progress.due <= today).length,
    mature: learned.filter(w => w.progress.interval >= 21).length,
    byCategory: words.reduce((acc, w) => {
      const k = w.category || 'general';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  };
}

/* ================================== Writes ================================== */

/**
 * Apply a batch of reviews (supports an offline queue: sorted by client ts, de-duplicated by rid).
 * grade: 0 = again (wrong), 1 = hard, 2 = good (right), 3 = easy
 */
function applyReviews_(reviews) {
  if (!Array.isArray(reviews) || !reviews.length) throw apiError_(400, 'reviews must be a non-empty array');
  const W = table_(CFG.WORDS);
  const P = table_(CFG.PROGRESS);
  const logSh = sheet_(CFG.LOG);
  const seenRids = recentRids_(logSh);
  const today = today_();
  const nowIso = nowIso_();
  const logRows = [];
  const results = [];
  let skipped = 0;

  reviews
    .slice()
    .sort((a, b) => cmp_(String(a.ts || ''), String(b.ts || '')))
    .forEach(rv => {
      const id = String(rv.id || '');
      const grade = Number(rv.grade);
      const rid = rv.rid ? String(rv.rid) : '';
      if (!W.byId.has(id)) throw apiError_(404, 'unknown word id: ' + id);
      if (![0, 1, 2, 3].includes(grade)) throw apiError_(400, 'grade must be 0-3: ' + id);
      if (rid && seenRids.has(rid)) { skipped++; return; }
      if (rid) seenRids.add(rid);

      let pi = P.byId.get(id);
      if (pi == null) {
        const blank = P.header.map(() => '');
        blank[P.col.id] = id;
        blank[P.col.created] = today;
        P.rows.push(blank);
        pi = P.rows.length - 1;
        P.byId.set(id, pi);
      }
      const row = P.rows[pi];
      const prev = progressObj_(P, row);
      const next = nextSchedule_(prev, grade, today);

      row[P.col.due] = next.due;
      row[P.col.interval] = next.interval;
      row[P.col.ease] = next.ease;
      row[P.col.reps] = next.reps;
      row[P.col.lapses] = next.lapses;
      row[P.col.last_review] = nowIso;
      row[P.col.last_grade] = grade;
      row[P.col.total_reviews] = (prev.total_reviews || 0) + 1;

      logRows.push([nowIso, id, grade, prev.interval, next.interval, next.due, String(rv.ts || ''), rid]);
      results.push(Object.assign({ id }, progressObj_(P, row)));
    });

  if (P.rows.length) P.sh.getRange(2, 1, P.rows.length, P.header.length).setValues(P.rows);
  if (logRows.length) {
    logSh.getRange(logSh.getLastRow() + 1, 1, logRows.length, CFG.LOG_COLS.length).setValues(logRows);
  }
  return { applied: results.length, skipped, progress: results };
}

/**
 * SM-2 style scheduler (pure function — unit-testable outside Apps Script).
 * prev: {interval, ease, reps, lapses}; returns the new state + due date (yyyy-MM-dd).
 */
function nextSchedule_(prev, grade, todayStr) {
  let interval = Number(prev && prev.interval) || 0;
  let ease = Number(prev && prev.ease) || CFG.DEFAULT_EASE;
  let reps = Number(prev && prev.reps) || 0;
  let lapses = Number(prev && prev.lapses) || 0;

  if (grade === 0) {
    reps = 0;
    lapses += 1;
    ease = Math.max(CFG.MIN_EASE, ease - 0.2);
    interval = 1;
  } else {
    reps += 1;
    if (reps === 1) {
      interval = grade === 3 ? 4 : 1;
    } else if (reps === 2) {
      interval = grade === 1 ? 3 : grade === 3 ? 8 : 6;
    } else {
      const factor = grade === 1 ? 1.2 : grade === 3 ? ease * 1.3 : ease;
      interval = Math.max(interval + 1, Math.round(interval * factor));
    }
    ease = Math.max(CFG.MIN_EASE, ease + (grade === 1 ? -0.15 : grade === 3 ? 0.15 : 0));
    interval = Math.min(CFG.MAX_INTERVAL, interval);
  }
  return {
    interval,
    ease: Math.round(ease * 100) / 100,
    reps,
    lapses,
    due: addDays_(todayStr, interval),
  };
}

/**
 * Add new words / refresh existing ones from the news importer.
 * Never touches Progress. Hand-edited meaning_zh / context_en are kept (only filled when empty),
 * unless a word carries context_refresh: true (exporter --refresh-context), which replaces context_en/source.
 */
function upsertWords_(words) {
  if (!Array.isArray(words) || !words.length) throw apiError_(400, 'words must be a non-empty array');
  const W = table_(CFG.WORDS);
  const nowIso = nowIso_();
  let added = 0, updated = 0;

  words.forEach(src => {
    const word = String(src.word || '').trim();
    if (!word) return;
    const id = String(src.id || makeId_(word));
    const first = String(src.first_seen || '');
    const last = String(src.last_seen || first);
    const pi = W.byId.get(id);

    if (pi == null) {
      const row = W.header.map(() => '');
      const set = (k, v) => { if (k in W.col) row[W.col[k]] = v; };
      set('id', id);
      set('word', word);
      set('meaning_zh', src.meaning_zh || '');
      set('category', src.category || '');
      set('first_seen', first);
      set('last_seen', last);
      set('freq', Number(src.freq) || 1);
      set('context_en', src.context_en || '');
      set('source', src.source || '');
      set('added_at', nowIso);
      set('active', true);
      W.rows.push(row);
      W.byId.set(id, W.rows.length - 1);
      added++;
      return;
    }

    const row = W.rows[pi];
    const c = W.col;
    let changed = false;
    const put = (k, v) => { if (row[c[k]] !== v) { row[c[k]] = v; changed = true; } };
    if (!row[c.meaning_zh] && src.meaning_zh) put('meaning_zh', src.meaning_zh);
    if (src.context_en && (!row[c.context_en] || src.context_refresh)) {
      put('context_en', src.context_en);
      if (src.source) put('source', src.source);
    }
    if (src.category === 'fin' && row[c.category] !== 'fin') put('category', 'fin');
    if (first && (!fmtDate_(row[c.first_seen]) || first < fmtDate_(row[c.first_seen]))) put('first_seen', first);
    if (last && last > fmtDate_(row[c.last_seen])) put('last_seen', last);
    if (src.freq != null && Number(src.freq) !== Number(row[c.freq])) put('freq', Number(src.freq));
    if (changed) updated++;
  });

  if (W.rows.length) W.sh.getRange(2, 1, W.rows.length, W.header.length).setValues(W.rows);
  return { added, updated, total: W.rows.length };
}

/** Every word that has ever been starred or unstarred (saved_at set), for merging with the site's local copy. */
function listSaved_() {
  const W = table_(CFG.WORDS);
  if (!('saved_at' in W.col)) return [];
  return W.rows
    .filter(r => String(r[W.col.id] || '') && String(r[W.col.saved_at] || ''))
    .map(r => {
      const w = wordObj_(W, r);
      return { id: w.id, word: w.word, meaning_zh: w.meaning_zh, context_en: w.context_en,
        category: w.category, saved: w.saved, saved_at: String(r[W.col.saved_at]) };
    });
}

/**
 * Star / unstar from the news site (offline queue: last write by client ts wins, older ones are skipped).
 * Unknown words are added (source "saved"); a word that only exists because it was starred is
 * deactivated when unstarred and never studied, so it leaves the deck again.
 */
function saveWords_(items) {
  if (!Array.isArray(items) || !items.length) throw apiError_(400, 'items must be a non-empty array');
  ensureCols_(CFG.WORDS, CFG.WORD_COLS);
  const W = table_(CFG.WORDS);
  const P = table_(CFG.PROGRESS);
  const c = W.col;
  const today = today_();
  const nowIso = nowIso_();
  let applied = 0, added = 0, skipped = 0;

  items
    .slice()
    .sort((a, b) => cmp_(String(a.ts || ''), String(b.ts || '')))
    .forEach(src => {
      const word = String(src.word || '').trim();
      if (!word) return;
      const id = makeId_(word);
      const on = src.saved !== false;
      const ts = String(src.ts || nowIso);
      let pi = W.byId.get(id);
      if (pi == null) {
        if (!on) { skipped++; return; }
        const row = W.header.map(() => '');
        const set = (k, v) => { if (k in c) row[c[k]] = v; };
        set('id', id);
        set('word', word);
        set('meaning_zh', String(src.meaning_zh || ''));
        set('category', src.category === 'fin' ? 'fin' : '');
        set('first_seen', today);
        set('last_seen', today);
        set('freq', 0);
        set('context_en', String(src.context_en || ''));
        set('source', String(src.source || 'saved'));
        set('added_at', nowIso);
        set('active', true);
        W.rows.push(row);
        pi = W.rows.length - 1;
        W.byId.set(id, pi);
        added++;
      }
      const row = W.rows[pi];
      if (String(row[c.saved_at] || '') > ts) { skipped++; return; } // a newer star/unstar already won
      row[c.saved] = on;
      row[c.saved_at] = ts;
      if (!row[c.meaning_zh] && src.meaning_zh) row[c.meaning_zh] = String(src.meaning_zh);
      if (!row[c.context_en] && src.context_en) row[c.context_en] = String(src.context_en);
      const starOnly = String(row[c.source] || '') === 'saved' || String(row[c.source] || '').indexOf('saved:') === 0;
      if (starOnly && !P.byId.has(id)) row[c.active] = on;
      else if (on) row[c.active] = true;
      applied++;
    });

  if (W.rows.length) W.sh.getRange(2, 1, W.rows.length, W.header.length).setValues(W.rows);
  return { applied, added, skipped, saved: listSaved_() };
}

/** Appends any missing header columns (so a new Code.gs works without re-running setup()). */
function ensureCols_(name, cols) {
  const sh = sheet_(name);
  const width = sh.getLastColumn();
  const header = width ? sh.getRange(1, 1, 1, width).getValues()[0].map(String) : [];
  const missing = cols.filter(k => !header.includes(k));
  if (!missing.length) return;
  sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
  (CFG.TEXT_COLS[name] || []).filter(k => missing.includes(k)).forEach(k => {
    sh.getRange(1, header.length + 1 + missing.indexOf(k), sh.getMaxRows(), 1).setNumberFormat('@');
  });
}

/* ============================ AI example sentences ============================ */

/** Tech / engineering example sentences for one word, cached in Words.ai_examples. */
function aiExamples_(id, force) {
  if (!id) throw apiError_(400, 'id is required');
  const W = table_(CFG.WORDS);
  const pi = W.byId.get(id);
  if (pi == null) throw apiError_(404, 'unknown word id: ' + id);
  const w = wordObj_(W, W.rows[pi]);
  if (w.ai_examples && w.ai_examples.length && !force) {
    return { id, cached: true, model: w.ai_model, examples: w.ai_examples };
  }

  const out = callAi_(w); // slow network call — done outside the lock

  return withLock_(() => {
    const T = table_(CFG.WORDS);
    const row = T.byId.get(id);
    if (row == null) throw apiError_(404, 'word removed while generating: ' + id);
    const r = row + 2;
    T.sh.getRange(r, T.col.ai_examples + 1).setValue(JSON.stringify(out.examples));
    T.sh.getRange(r, T.col.ai_model + 1).setValue(out.model);
    T.sh.getRange(r, T.col.ai_updated_at + 1).setValue(nowIso_());
    return { id, cached: false, model: out.model, examples: out.examples };
  });
}

/** Which AI writes the examples: Script Property AI_PROVIDER = gemini | claude.
 *  Without it: Gemini when GEMINI_API_KEY is set, otherwise Claude. */
function aiProvider_() {
  const p = String(prop_('AI_PROVIDER') || '').trim().toLowerCase();
  if (p === 'gemini' || p === 'claude') return p;
  return prop_('GEMINI_API_KEY') ? 'gemini' : 'claude';
}

function callAi_(w) {
  return aiProvider_() === 'gemini' ? callGemini_(w) : callClaude_(w);
}

const AI_SYSTEM_ =
  'You write example sentences for a Taiwanese semiconductor-industry analyst who is learning English. ' +
  'Write exactly 2 natural, professional sentences (12-28 words each) that use the target word in the same ' +
  'sense as its Chinese meaning, each set in a different technology or engineering context ' +
  '(e.g. wafer fabrication, advanced packaging, chip design, data centers, equipment, supply chain). ' +
  'Do not copy the news context sentence. "zh" is a fluent Traditional Chinese (Taiwan) translation; ' +
  '"field" is a short Traditional Chinese label for the context, such as 晶圓製造 or 先進封裝.';

function aiUserText_(w) {
  return 'Target word: ' + w.word + '\n' +
    'Chinese meaning: ' + (w.meaning_zh || '(none)') + '\n' +
    'Seen in this news sentence: ' + (w.context_en || '(none)');
}

function parseExamples_(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { throw apiError_(502, 'model did not return JSON'); }
  const ex = (parsed.examples || []).filter(e => e && e.en);
  if (!ex.length) throw apiError_(502, 'model returned no examples');
  return ex.map(e => ({ en: String(e.en), zh: String(e.zh || ''), field: String(e.field || '') }));
}

/* ---- Gemini (Google AI Studio key) ---- */
function callGemini_(w) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw apiError_(501, 'AI not configured: set GEMINI_API_KEY in Script Properties');
  const model = prop_('GEMINI_MODEL') || 'gemini-3.8-flash';
  const payload = {
    systemInstruction: { parts: [{ text: AI_SYSTEM_ }] },
    contents: [{ role: 'user', parts: [{ text: aiUserText_(w) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      // OpenAPI-style schema (Gemini does not accept additionalProperties)
      responseSchema: {
        type: 'OBJECT',
        required: ['examples'],
        properties: {
          examples: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['en', 'zh', 'field'],
              properties: { en: { type: 'STRING' }, zh: { type: 'STRING' }, field: { type: 'STRING' } },
            },
          },
        },
      },
      maxOutputTokens: 4000,
      thinkingConfig: { thinkingLevel: prop_('GEMINI_THINKING') || 'low' },
    },
  };
  const url = CFG.GEMINI_URL + encodeURIComponent(model) + ':generateContent';
  const send = p => UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },   // key in a header, not in the URL (keeps it out of logs)
    payload: JSON.stringify(p),
    muteHttpExceptions: true,
  });
  let res = send(payload);
  // Older models do not know thinkingLevel: retry once without it
  if (res.getResponseCode() === 400 && /thinking/i.test(res.getContentText())) {
    delete payload.generationConfig.thinkingConfig;
    res = send(payload);
  }
  const code = res.getResponseCode();
  let body;
  try { body = JSON.parse(res.getContentText()); } catch (err) { body = {}; }
  if (code !== 200) {
    const msg = (body.error && body.error.message) || res.getContentText().slice(0, 300);
    if (code === 400 && /API key/i.test(msg)) throw apiError_(502, 'Gemini API key 無效：請到 Google AI Studio 重新複製金鑰');
    if (code === 429) throw apiError_(429, 'Gemini 免費額度暫時用完，稍後再試');
    throw apiError_(502, 'Gemini API ' + code + ': ' + msg);
  }
  if (body.promptFeedback && body.promptFeedback.blockReason) {
    throw apiError_(422, 'model declined to generate examples for this word');
  }
  const cand = (body.candidates || [])[0] || {};
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'RECITATION') {
    throw apiError_(422, 'model declined to generate examples for this word');
  }
  if (cand.finishReason === 'MAX_TOKENS') throw apiError_(502, 'model output was cut off (max tokens)');
  const text = ((cand.content && cand.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  return { model: body.modelVersion || model, examples: parseExamples_(text) };
}

/* ---- Claude ---- */
function callClaude_(w) {
  const key = prop_('ANTHROPIC_API_KEY');
  if (!key) throw apiError_(501, 'AI not configured: set GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Script Properties');
  const model = prop_('AI_MODEL') || 'claude-opus-5-5';

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['examples'],
    properties: {
      examples: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['en', 'zh', 'field'],
          properties: {
            en: { type: 'string' },
            zh: { type: 'string' },
            field: { type: 'string' },
          },
        },
      },
    },
  };

  const payload = {
    model,
    max_tokens: 8000,
    output_config: { effort: prop_('AI_EFFORT') || 'low', format: { type: 'json_schema', schema } },
    system: AI_SYSTEM_,
    messages: [{ role: 'user', content: aiUserText_(w) }],
  };
  const headers = { 'x-api-key': key, 'anthropic-version': CFG.ANTHROPIC_VERSION };
  // Server-side refusal fallback (not offered on Haiku)
  if (!/haiku/.test(model)) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const res = UrlFetchApp.fetch(CFG.ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let body;
  try { body = JSON.parse(res.getContentText()); } catch (err) { body = {}; }
  if (code !== 200) {
    throw apiError_(502, 'Claude API ' + code + ': ' + ((body.error && body.error.message) || res.getContentText().slice(0, 300)));
  }
  if (body.stop_reason === 'refusal') throw apiError_(422, 'model declined to generate examples for this word');
  if (body.stop_reason === 'max_tokens') throw apiError_(502, 'model output was cut off (max_tokens)');

  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { model: body.model || model, examples: parseExamples_(text) };
}

/* ============================ One-time setup / tests ============================ */

/** Run once from the editor: creates the three sheets, headers, text formats and an API token. */
function setup() {
  const ss = ss_();
  [[CFG.WORDS, CFG.WORD_COLS], [CFG.PROGRESS, CFG.PROGRESS_COLS], [CFG.LOG, CFG.LOG_COLS]].forEach(([name, cols]) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const existing = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    const missing = cols.filter(c => !existing.includes(c));
    if (!existing.filter(String).length) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    } else if (missing.length) {
      sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
    const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    (CFG.TEXT_COLS[name] || []).forEach(c => {
      const i = header.indexOf(c);
      if (i >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#e8eaf6');
  });
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  Logger.log('Setup done. API_TOKEN = ' + props.getProperty('API_TOKEN'));
}

/** Editor smoke test for the scheduler. */
function testSchedule() {
  let s = { interval: 0, ease: CFG.DEFAULT_EASE, reps: 0, lapses: 0 };
  [2, 2, 2, 0, 2, 3].forEach(g => {
    s = nextSchedule_(s, g, '2026-11-27');
    Logger.log('grade ' + g + ' -> ' + JSON.stringify(s));
  });
}

/** Editor smoke test for the AI call (uses the first word in the sheet; does not write). */
function testAi() {
  const W = table_(CFG.WORDS);
  if (!W.rows.length) throw new Error('Words sheet is empty');
  Logger.log('provider: ' + aiProvider_());
  Logger.log(JSON.stringify(callAi_(wordObj_(W, W.rows[0])), null, 2));
}

/* ================================== Helpers ================================== */

function respond_(fn) {
  let out;
  try {
    out = Object.assign({ ok: true }, fn());
  } catch (err) {
    out = { ok: false, code: err.code || 500, error: String((err && err.message) || err) };
    if (!err.code) console.error(err && err.stack);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function apiError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function checkToken_(token) {
  const expected = prop_('API_TOKEN');
  if (!expected) throw apiError_(500, 'API_TOKEN not set — run setup() once');
  if (String(token || '') !== expected) throw apiError_(401, 'invalid token');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_(503, 'busy, try again');
  try { return fn(); } finally { lock.releaseLock(); }
}

function ss_() {
  const id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw apiError_(500, 'missing sheet "' + name + '" — run setup()');
  return sh;
}

/** Reads a sheet into memory; columns are located by header text, so users may reorder them. */
function table_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const header = (values.shift() || []).map(String);
  const col = {};
  header.forEach((h, i) => { if (h) col[h] = i; });
  // Keep blank rows so array index i always maps to sheet row i + 2 (writes go back in place)
  const rows = values;
  rows.forEach(r => { while (r.length < header.length) r.push(''); }); // writes need a rectangle
  const byId = new Map();
  rows.forEach((r, i) => { const id = String(r[col.id] || ''); if (id) byId.set(id, i); });
  return { sh, header, col, rows, byId };
}

function wordObj_(W, r) {
  const g = k => (k in W.col ? r[W.col[k]] : '');
  let ai = null;
  const raw = g('ai_examples');
  if (raw) { try { ai = JSON.parse(raw); } catch (err) { ai = null; } }
  return {
    id: String(g('id')),
    word: String(g('word')),
    meaning_zh: String(g('meaning_zh')),
    category: String(g('category')),
    first_seen: fmtDate_(g('first_seen')),
    last_seen: fmtDate_(g('last_seen')),
    freq: Number(g('freq')) || 0,
    context_en: String(g('context_en')),
    source: String(g('source')),
    ai_examples: ai,
    ai_model: String(g('ai_model')),
    saved: isTrue_(g('saved')),
  };
}

function progressObj_(P, r) {
  const g = k => (k in P.col ? r[P.col[k]] : '');
  return {
    due: fmtDate_(g('due')),
    interval: Number(g('interval')) || 0,
    ease: Number(g('ease')) || CFG.DEFAULT_EASE,
    reps: Number(g('reps')) || 0,
    lapses: Number(g('lapses')) || 0,
    last_review: String(g('last_review')),
    last_grade: g('last_grade') === '' ? null : Number(g('last_grade')),
    total_reviews: Number(g('total_reviews')) || 0,
  };
}

function recentRids_(logSh) {
  const last = logSh.getLastRow();
  const n = Math.min(CFG.RID_LOOKBACK, last - 1);
  if (n <= 0) return new Set();
  const ridCol = CFG.LOG_COLS.indexOf('rid') + 1;
  return new Set(logSh.getRange(last - n + 1, ridCol, n, 1).getValues().map(r => String(r[0])).filter(String));
}

/** Must match tools/export_vocab.py make_id(). */
function makeId_(word) {
  return String(word).trim().toLowerCase().replace(/\s+/g, ' ');
}

function isTrue_(v) {
  return v === true || /^(true|1|yes)$/i.test(String(v));
}

function isActive_(v) {
  return !(v === false || /^(false|0|no)$/i.test(String(v)));
}

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
  return String(v || '');
}

function today_() {
  return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
}

function nowIso_() {
  return Utilities.formatDate(new Date(), CFG.TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** yyyy-MM-dd + n days, timezone-independent. */
function addDays_(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function cmp_(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function int_(v, dflt) {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}

function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}
