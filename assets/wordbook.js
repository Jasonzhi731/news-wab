/* ============================================================
   單字本（收藏）— 快報與單字複習共用的唯一一份同步程式
   - 收藏存在本機 localStorage 'wr-vocab-saved'：{ 小寫單字: { t, zh, ctx, fin, at } }
   - 有 token（單字複習「設定」填的 nv-settings）時，收藏／取消排進佇列 'wr-vocab-ops'，
     背景整批 POST saveWords 到 Apps Script；離線或失敗就留在佇列，之後任一頁都會補送。
   - 合併規則：本機還沒送出的動作優先，其餘以時間較新的一方為準（後端 saved_at）。
   - 兩頁同網域，另一個分頁改了收藏，這裡會透過 storage 事件即時跟上。
   用法：Wordbook.map()（即時的收藏物件）、has(word)、toggle({t, zh, ctx, fin})、
         set(item, on)、sync()、status()、onChange(fn(kind, from))，kind = 'saved' | 'status'，from = 'local'（本頁按的）| 'remote'
   ============================================================ */
(function () {
  'use strict';
  var DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbxalrfuFwsbJEhjpo27_edPrggbT-7JY2vlO8P4T49Dl57JelsW0Q6X0E-5RhtXBGjD/exec';
  var SAVED_KEY = 'wr-vocab-saved', OPS_KEY = 'wr-vocab-ops', SEEDED_KEY = 'wr-vocab-seeded';

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  function keyOf(t) { return String(t || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  var saved = lsGet(SAVED_KEY, {}) || {};      // 同一個物件一路沿用，呼叫端可以直接拿來查
  var st = { ops: lsGet(OPS_KEY, []) || [], busy: false, err: '', ok: false, timer: null, offline: false };
  var listeners = [];
  function emit(kind, from) { listeners.forEach(function (fn) { try { fn(kind, from); } catch (e) { /* listener error */ } }); }

  function cfg() {
    if (st.offline) return null;
    var s = lsGet('nv-settings', {}) || {};
    return s.token ? { url: s.apiUrl || DEFAULT_URL, token: s.token } : null;
  }

  function opOf(v, on, ts) {
    return { word: v.t, meaning_zh: v.zh || '', context_en: v.ctx || '', category: v.fin ? 'fin' : '',
      saved: on, ts: ts || new Date().toISOString() };
  }

  function set(v, on) {
    var k = keyOf(v.t);
    if (!k) return;
    if (on) saved[k] = { t: String(v.t).trim(), zh: v.zh || '', ctx: v.ctx || '', fin: !!v.fin, at: Date.now() };
    else delete saved[k];
    lsSet(SAVED_KEY, saved);
    if (!st.offline) {
      st.ops.push(opOf(v, on));
      lsSet(OPS_KEY, st.ops);
    }
    emit('saved', 'local');
    if (cfg()) { clearTimeout(st.timer); st.timer = setTimeout(sync, 1200); }
    emit('status');
  }

  function toggle(v) {
    var on = !saved[keyOf(v.t)];
    set(v, on);
    return on;
  }

  function post(c, body) {
    return fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 簡單請求：Apps Script 不必回 CORS preflight
      body: JSON.stringify(Object.assign({ token: c.token }, body))
    }).then(function (r) { return r.json(); });
  }

  function sync() {
    var c = cfg();
    if (!c || st.busy) return;
    // 第一次啟用：把啟用前就收藏的字補送上去（用當初收藏的時間）
    if (!lsGet(SEEDED_KEY, false)) {
      var queued = {};
      st.ops.forEach(function (op) { queued[keyOf(op.word)] = 1; });
      Object.keys(saved).forEach(function (k) {
        if (queued[k]) return;                            // 佇列裡已有這個字的動作，不重送
        st.ops.unshift(opOf(saved[k], true, new Date(saved[k].at || Date.now()).toISOString()));
      });
      lsSet(OPS_KEY, st.ops);
      lsSet(SEEDED_KEY, true);
    }
    st.busy = true;
    emit('status');
    var batch = st.ops.slice(0, 200);
    var req = batch.length
      ? post(c, { action: 'saveWords', items: batch })
      : fetch(c.url + (c.url.indexOf('?') < 0 ? '?' : '&') + 'action=saved').then(function (r) { return r.json(); });
    req.then(function (res) {
      if (!res.ok) {
        throw new Error(/unknown action/.test(res.error || '') ? '單字本後端還沒更新到新版'
          : /token/i.test(res.error || '') ? 'token 不正確，請到單字複習「設定」重新輸入' : (res.error || '同步失敗'));
      }
      if (batch.length) {
        // 送出期間別的分頁可能又加了動作：以 localStorage 的最新佇列扣掉已送出的部分
        st.ops = (lsGet(OPS_KEY, []) || []).slice(batch.length);
        lsSet(OPS_KEY, st.ops);
      }
      st.err = ''; st.ok = true;
      merge(res.saved || []);
    }).catch(function (e) {
      st.err = e instanceof SyntaxError ? '單字本暫時連不上（回應不是 JSON），稍後會自動重試'
        : (e && e.message && !/fetch|network/i.test(e.message)) ? e.message : '目前離線，連上網路後會自動同步';
    }).then(function () {
      st.busy = false;
      emit('status');
      if (!st.err && st.ops.length) sync();
    });
  }

  function merge(list) {
    var waiting = {};
    st.ops.forEach(function (op) { waiting[keyOf(op.word)] = 1; });
    var changed = false;
    list.forEach(function (w) {
      var k = keyOf(w.word || w.id);
      if (!k || waiting[k]) return;                       // 本機還沒送出的動作優先
      var at = Date.parse(w.saved_at) || 0, loc = saved[k];
      if (w.saved && !loc) {
        saved[k] = { t: w.word, zh: w.meaning_zh || '', ctx: w.context_en || '', fin: w.category === 'fin', at: at };
        changed = true;
      } else if (!w.saved && loc && (loc.at || 0) <= at) {
        delete saved[k];
        changed = true;
      }
    });
    if (!changed) return;
    lsSet(SAVED_KEY, saved);
    emit('saved', 'remote');
  }

  function reload() {
    var fresh = lsGet(SAVED_KEY, {}) || {};
    Object.keys(saved).forEach(function (k) { if (!(k in fresh)) delete saved[k]; });
    Object.keys(fresh).forEach(function (k) { saved[k] = fresh[k]; });
    st.ops = lsGet(OPS_KEY, []) || [];
  }

  window.addEventListener('storage', function (e) {
    if (e.key === SAVED_KEY || e.key === OPS_KEY) { reload(); emit('saved', 'remote'); emit('status'); }
    else if (e.key === 'nv-settings') { emit('status'); sync(); }
  });
  window.addEventListener('online', sync);

  window.Wordbook = {
    map: function () { return saved; },
    has: function (t) { return !!saved[keyOf(t)]; },
    count: function () { return Object.keys(saved).length; },
    set: set,
    toggle: toggle,
    sync: sync,
    // 單字複習的示範模式（?demo）：收藏只改這台裝置、不送出
    setOffline: function (b) { st.offline = !!b; },
    status: function () {
      return { configured: !!cfg(), pending: st.ops.length, busy: st.busy, err: st.err, ok: st.ok };
    },
    onChange: function (fn) { listeners.push(fn); }
  };
  // 頁面載入後先同步一次（沒有 token 時什麼都不做）
  setTimeout(sync, 0);
})();
