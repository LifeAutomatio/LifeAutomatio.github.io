/* 체크인 화면 본체: 연결 설정, 기록 탭, 보낼 대기열, 상태 탭, 탭 이동.
 * 뉴스와 리포트 탭은 views.js, 나(검사, 프로필, 자기 모델) 탭은 me.js 에 있다.
 * 보안 규칙: 저장소에서 읽은 글은 모두 textContent 로만 넣는다. innerHTML 을 쓰지 않는다.
 */
(function () {
  'use strict';
  if (window.top !== window.self) { document.documentElement.textContent = ''; return; }

  var C = LA.core;
  var APP = LA.app = {};
  var S = APP.state = {
    cfg: null, token: null, form: null, bank: null, gh: null,
    tab: 'checkin', today: null, draft: null, qotd: null, heartbeat: null, reviews: null,
    lastCheckin: null, remoteChecked: false, flushing: false, lastError: null, statusNote: null,
    uploadTimer: null, retryTimer: null, undo: []
  };
  var root = document.getElementById('app');
  var RETRACTABLE = ['note', 'decision', 'life_event', 'body_event', 'event', 'fact', 'decision_review', 'feedback'];

  // ------------------------------------------------------------ 저장 공간 (막혀 있어도 화면은 돈다)
  // '이 기기에 저장하지 않기'를 고르면 모든 것을 창을 닫으면 지워지는 sessionStorage 에 둔다 (회사 컴퓨터 등).
  function isEphemeral() { try { return sessionStorage.getItem('la.ephemeral') === 'true'; } catch (e) { return false; } }
  function backend() { return isEphemeral() ? sessionStorage : localStorage; }
  var store = APP.store = {
    get: function (k, d) { try { var v = backend().getItem('la.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { backend().setItem('la.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { backend().removeItem('la.' + k); } catch (e) { /* 무시 */ } },
    ephemeral: isEphemeral
  };

  // ------------------------------------------------------------ DOM 도우미
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (!attrs.hasOwnProperty(k)) continue;
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
    (Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids])).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return e;
  }
  APP.h = h;
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
  APP.clear = clear;

  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }
  APP.tz = tz;
  function dayStart() { return (S.form && S.form.day_start) || '04:00'; }
  function todayLocal() { return C.logicalDate(new Date(), dayStart()); }
  APP.todayLocal = todayLocal;

  // ------------------------------------------------------------ 시작
  function parseHash() {
    var raw = (location.hash || '').replace(/^#/, ''), parts = raw.split('&'), out = { tab: parts[0] || '' };
    for (var i = 1; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv.length === 2) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
    }
    return out;
  }

  function apiBase() {
    var hp = parseHash(), host = location.hostname;
    if ((host === 'localhost' || host === '127.0.0.1') && hp.api) return hp.api;
    if (host === 'localhost' || host === '127.0.0.1') return location.origin + '/github-api';
    return 'https://api.github.com';
  }

  function loadJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  function boot() {
    Promise.all([loadJSON('forms/checkin.v1.json'), loadJSON('forms/questions.v1.json')]).then(function (res) {
      S.form = res[0]; S.bank = res[1];
      S.cfg = store.get('cfg', null);
      S.token = store.get('token', null);
      var hp = parseHash();
      if (!S.cfg || !S.token || hp.tab === 'setup') return renderSetup(hp);
      connect();
      S.tab = ['checkin', 'news', 'report', 'me', 'status'].indexOf(hp.tab) >= 0 ? hp.tab : 'checkin';
      render();
      startSync();
    }, function (e) {
      clear(root).appendChild(h('div', { class: 'card' }, [h('h2', { text: '화면을 불러오지 못했습니다' }), h('p', { class: 'muted', text: String(e.message || e) })]));
    });
  }

  function connect() {
    S.gh = LA.github({ apiBase: S.cfg.apiBase || apiBase(), owner: S.cfg.owner, repo: S.cfg.repo, token: S.token });
  }

  // ------------------------------------------------------------ 연결 설정
  function renderSetup(hp) {
    var cfg = store.get('cfg', {}) || {};
    var owner = hp.owner || cfg.owner || '', repo = hp.repo || cfg.repo || 'life-automation-data', probe = hp.probe || cfg.probe || 'life-automation';
    var msg = h('p', { class: 'small' });
    var ownerIn = h('input', { type: 'text', name: 'owner', value: owner, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' });
    var repoIn = h('input', { type: 'text', name: 'repo', value: repo, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' });
    var userIn = h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'life-checkin', class: 'hidden', 'aria-hidden': 'true' });
    var tokenIn = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'github_pat_…' });
    var noSave = h('input', { type: 'checkbox', name: 'nosave' });
    var btn = h('button', { class: 'primary', type: 'submit', text: '연결' });
    noSave.addEventListener('change', function () {
      tokenIn.setAttribute('autocomplete', noSave.checked ? 'off' : 'current-password');
      msg.textContent = noSave.checked ? '이 창을 닫으면 키와 보내지 못한 기록이 지워집니다. 브라우저가 암호 저장을 물으면 "저장 안 함"을 누르세요.' : '';
    });
    var formEl = h('form', { onsubmit: function (ev) {
      ev.preventDefault();
      var t = (tokenIn.value || '').trim(), o = ownerIn.value.trim(), r = repoIn.value.trim();
      if (!t || !o || !r) { msg.textContent = '세 칸을 모두 채우세요.'; return; }
      btn.disabled = true; msg.textContent = '확인하는 중…';
      var gh = LA.github({ apiBase: apiBase(), owner: o, repo: r, token: t });
      gh.probe(probe).then(function (res) {
        btn.disabled = false;
        if (!res.ok) { msg.textContent = res.reason; return; }
        try { if (noSave.checked) sessionStorage.setItem('la.ephemeral', 'true'); else sessionStorage.removeItem('la.ephemeral'); } catch (e) { /* 무시 */ }
        var first = !store.get('token', null);
        S.cfg = { owner: o, repo: r, probe: probe, registered: C.ymd(new Date()) };
        if (apiBase() !== 'https://api.github.com') S.cfg.apiBase = apiBase();
        S.token = t;
        store.set('cfg', S.cfg); store.set('token', t);
        connect();
        if (!noSave.checked) enqueueRecord('setting', { key: 'token_registered', value: { date: S.cfg.registered, first: first } });
        history.replaceState(null, '', location.pathname + '#checkin');
        S.tab = 'checkin';
        render();
        startSync();
      });
    } }, [
      userIn,
      h('label', { class: 'field' }, [h('span', { text: 'GitHub 사용자 이름' }), ownerIn]),
      h('label', { class: 'field' }, [h('span', { text: '기록 저장소 이름' }), repoIn]),
      h('label', { class: 'field' }, [h('span', { text: '폰 접근 키' }), tokenIn]),
      h('label', { class: 'check' }, [noSave, h('span', { text: '이 기기에 저장하지 않기 (회사 컴퓨터 등)' })]),
      btn, msg
    ]);
    clear(root).appendChild(h('div', {}, [
      h('div', { class: 'top' }, [h('h1', { text: '연결 설정' })]),
      h('div', { class: 'card' }, [
        h('p', { class: 'muted', text: '기록 저장소 하나만 읽고 쓸 수 있는 접근 키를 붙여 넣으세요. 키는 이 기기에만 저장됩니다.' }),
        h('p', { class: 'small', text: '내 폰과 내 컴퓨터에서는 연결한 뒤 암호를 저장하겠냐고 물으면 저장하세요. 다음에 키가 지워져도 자동 입력으로 바로 복구됩니다.' }),
        formEl
      ]),
      h('p', { class: 'small', text: '처음 설정 방법은 코드 저장소의 docs/USER_MANUAL.md 에 있습니다.' })
    ]));
  }

  // ------------------------------------------------------------ 기록 보내기
  function enqueueRecord(type, payload, extra) {
    extra = extra || {};
    var rec = C.buildRecord({ type: type, payload: payload, now: extra.now || new Date(), tz: tz(), dayStart: dayStart(),
                              lag: extra.lag || 0, form: extra.form || null, supersedes: extra.supersedes || null,
                              device: /iPhone|iPad/.test(navigator.userAgent) ? 'ios' : (/Android/.test(navigator.userAgent) ? 'android' : 'desktop') });
    var item = { path: C.recordPath(rec.id), id: rec.id, text: JSON.stringify(rec, null, 2) + '\n', message: 'record: ' + type + ' ' + rec.local_date, created: Date.now() };
    var q = C.queueAdd(store.get('queue', []), item);
    if (!store.set('queue', q)) S.lastError = '기기 저장 공간에 쓸 수 없습니다';
    if (RETRACTABLE.indexOf(type) >= 0 && extra.label !== false) rememberRecent(rec, extra.label);
    flushQueue();
    return rec;
  }
  APP.enqueueRecord = enqueueRecord;

  function rememberRecent(rec, label) {
    var list = store.get('recent', []).filter(function (x) { return Date.now() - x.at < 30 * 86400000; });
    list.unshift({ id: rec.id, type: rec.schema.split('.v')[0], label: String(label || '').slice(0, 60), date: rec.local_date, at: Date.now(), retracted: false });
    store.set('recent', list.slice(0, 20));
  }

  function dropQueued(id) {
    var q = store.get('queue', []), out = [], dropped = false;
    for (var i = 0; i < q.length; i++) { if (q[i].id === id) dropped = true; else out.push(q[i]); }
    store.set('queue', out);
    return dropped;
  }

  /* 기록 철회: 아직 보내지 않았으면 대기열에서 빼고, 보냈으면 철회 기록을 새로 남긴다. */
  function retract(id, reason) {
    if (dropQueued(id)) return 'dropped';
    enqueueRecord('retraction', C.retractionPayload(id, reason || null), { supersedes: id, label: false });
    return 'retracted';
  }
  APP.retract = retract;

  function flushQueue(keepalive) {
    if (S.flushing || !S.gh) return Promise.resolve();
    var q = store.get('queue', []);
    if (!q.length) { updateStatusPill(); return Promise.resolve(); }
    S.flushing = true; updateStatusPill();
    var item = q[0];
    return S.gh.createFile(item.path, item.text, item.message, { keepalive: keepalive }).then(function (r) {
      S.flushing = false;
      if (r.ok) {
        store.set('queue', C.queueRemove(store.get('queue', []), item.path));
        S.lastError = null;
        return flushQueue(keepalive);
      }
      S.lastError = r.reason || '보내기 실패';
      if (r.fatal) { S.fatal = true; updateStatusPill(); return; }
      updateStatusPill();
      clearTimeout(S.retryTimer);
      S.retryTimer = setTimeout(function () { flushQueue(); }, 30000);
    });
  }
  APP.flushQueue = flushQueue;

  function updateStatusPill() {
    var pill = document.getElementById('sync-pill');
    if (!pill) return;
    var q = store.get('queue', []);
    pill.className = 'pill';
    if (S.fatal) { pill.className = 'pill bad'; pill.textContent = '키 확인 필요'; return; }
    if (S.flushing) { pill.textContent = '보내는 중…'; return; }
    if (q.length) { pill.className = 'pill warn'; pill.textContent = '보낼 기록 ' + q.length + '건'; return; }
    var d = S.draft;
    if (d && d.savedAt) { pill.className = 'pill ok'; pill.textContent = '저장됨 ' + C.hhmm(new Date(d.savedAt)); return; }
    pill.textContent = '연결됨';
  }
  APP.updateStatusPill = updateStatusPill;

  // ------------------------------------------------------------ 저장소에서 읽어 오기
  function cacheJSON(path, key) {
    return S.gh.getJSON(path).then(function (r) {
      if (r.ok && r.data) { store.set('cache.' + key, r.data); return r.data; }
      return store.get('cache.' + key, null);
    });
  }
  APP.cacheJSON = cacheJSON;

  function monthDirs(localDate, back) {
    var out = [], y = +localDate.slice(0, 4), m = +localDate.slice(5, 7);
    for (var i = 0; i <= back; i++) {
      var mm = m - i, yy = y;
      while (mm <= 0) { mm += 12; yy -= 1; }
      out.push(yy + '/' + C.pad(mm));
    }
    return out;
  }
  APP.monthDirs = monthDirs;

  function startSync() {
    flushQueue();
    S.qotd = store.get('cache.qotd', null);
    S.heartbeat = store.get('cache.heartbeat', null);
    S.reviews = store.get('cache.reviews', null);
    cacheJSON('state/qotd.json', 'qotd').then(function (d) { S.qotd = d; if (S.tab === 'checkin') renderTab(); });
    cacheJSON('state/heartbeat.json', 'heartbeat').then(function (d) { S.heartbeat = d; if (S.tab === 'status') renderTab(); });
    cacheJSON('state/reviews.json', 'reviews').then(function (d) { S.reviews = d; if (S.tab === 'checkin' || S.tab === 'status') renderTab(); });
    S.links = store.get('cache.links', null);
    cacheJSON('self/links.json', 'links').then(function (d) { S.links = d; renderNavLinks(); if (S.tab === 'status') renderTab(); });
    S.calState = store.get('cache.calstate', null);
    S.schedCfg = store.get('cache.schedcfg', null);
    cacheJSON('state/calendar.json', 'calstate').then(function (d) { S.calState = d; if (S.tab === 'checkin' || S.tab === 'status') renderTab(); });
    cacheJSON('self/schedule.json', 'schedcfg').then(function (d) { S.schedCfg = d; if (S.tab === 'checkin') renderTab(); });
    syncRemoteCheckins();
  }

  /* 이번 달과 지난달 기록 목록을 보고, 마지막 체크인 날짜와 다른 기기에서 한 오늘 기록을 찾는다.
   * 파일 이름의 날짜는 저장한 시각의 날짜라서, 어제 기록(recall_lag 1)은 내용의 local_date 를 읽어야 구별된다. */
  function syncRemoteCheckins() {
    var today = todayLocal(), dirs = monthDirs(today, 1);
    Promise.all(dirs.map(function (d) { return S.gh.listDir('records/' + d); })).then(function (lists) {
      if (!lists.every(function (l) { return l.ok; })) return;
      var names = [], last = store.get('lastCheckin', null);
      lists.forEach(function (l) { l.items.forEach(function (f) { names.push(f.name); }); });
      names.forEach(function (n) {
        var p = C.parseRecordName(n, dayStart());
        if (p && p.type === 'checkin' && p.localDate < today && (!last || p.localDate > last)) last = p.localDate;
      });
      var cands = C.checkinCandidates(names, dayStart(), today);
      return Promise.all(cands.map(function (c) { return S.gh.getJSON(C.recordPath(c.id)); })).then(function (res) {
        var todays = [];
        res.forEach(function (r) {
          if (!r.ok || !r.data) return;
          var ld = r.data.local_date;
          if (ld === today) todays.push(r.data);
          else if (ld < today && (!last || ld > last)) last = ld;
        });
        S.lastCheckin = last; store.set('lastCheckin', last);
        S.remoteChecked = true;
        todays.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        var latest = todays[todays.length - 1];
        var d = loadDraft(today);
        var ids = todays.map(function (t) { return t.id; });
        if (latest && d.lastId !== latest.id && ids.indexOf(d.lastId) < 0) {
          adoptRemote(d, latest);
          if (S.draft && S.draft.localDate === today) S.draft = d;
        }
        if (S.tab === 'checkin') renderTab();
      });
    });
  }

  function adoptRemote(d, rec) {
    var p = rec.payload || {}, a = p.answers || {};
    var hadLocal = Object.keys(d.answers || {}).length > 0 || (d.qotd || []).length > 0 || !!d.note;
    var merged = {};
    ['mood', 'energy', 'focus', 'study_bucket'].forEach(function (k) { if (a[k]) merged[k] = a[k]; });
    for (var k in d.answers) if (d.answers.hasOwnProperty(k)) merged[k] = d.answers[k];
    d.answers = merged;
    if (!d.qotd || !d.qotd.length) d.qotd = a.qotd || [];
    if (!d.note && p.note) d.note = p.note;
    d.lastId = rec.id;
    d.uploadedHash = d.uploadedHash || null;
    if (!hadLocal) {
      // 다른 기기에서 이미 끝낸 기록: 완료 화면을 보여 주고 같은 내용을 다시 보내지 않는다
      d.mode = p.mode === 'single_tap' ? 'single_tap' : 'full'; d.modeChosen = true;
      d.savedAt = Date.parse(rec.captured_at) || Date.now();
      d.uploadedHash = draftHash({ mode: d.mode, answers: a, note: p.note || '' });
    }
    saveDraftLocal(d);
  }

  // ------------------------------------------------------------ 체크인 초안
  function loadDraft(localDate, lag) {
    var d = store.get('draft.' + localDate, null);
    if (!d) d = { localDate: localDate, lag: lag || 0, answers: {}, qotd: [], note: '', mode: null, startedAt: null, lastId: null, uploadedHash: null, savedAt: null, shown: 1 };
    return d;
  }
  function saveDraftLocal(d) { store.set('draft.' + d.localDate, d); }
  APP.loadDraft = loadDraft;

  function draftHash(p) { return JSON.stringify([p.mode, p.answers, p.note || '']); }

  function scheduleUpload(delay) {
    clearTimeout(S.uploadTimer);
    S.uploadTimer = setTimeout(function () { uploadDraft(false); }, delay);
  }

  function uploadDraft(force) {
    clearTimeout(S.uploadTimer);
    var d = S.draft;
    if (!d) return;
    var now = new Date(), lag = C.daysBetween(d.localDate, todayLocal());
    if (lag < 0 || lag > 1) { S.statusNote = '이 기록은 날짜가 지나 저장할 수 없습니다.'; renderTab(); return; }
    var payload = C.checkinPayload({ answers: d.answers, qotd: d.qotd, note: d.note, mode: d.mode, lag: lag, startedAt: d.startedAt }, now.getTime());
    if (C.isCheckinEmpty(payload)) {
      // 되돌리기로 모든 답을 지웠고 이미 보낸 기록이 있으면 철회한다
      if (d.lastId) {
        retract(d.lastId, '되돌리기로 모든 답을 지움');
        d.lastId = null; d.prevSupersedes = null; d.uploadedHash = null; d.savedAt = null;
        saveDraftLocal(d);
      }
      return;
    }
    var hash = draftHash(payload);
    if (hash === d.uploadedHash && !force) return;
    var supersedes = d.lastId;
    if (supersedes && dropQueued(supersedes)) supersedes = d.prevSupersedes || null;   // 아직 안 보낸 앞 기록은 버리고 대신한다
    var rec = enqueueRecord('checkin', payload, { lag: lag, form: S.form.form, supersedes: supersedes, now: now });
    d.prevSupersedes = supersedes; d.lastId = rec.id; d.uploadedHash = hash; d.savedAt = now.getTime();
    saveDraftLocal(d);
    updateStatusPill();
    if (S.tab === 'checkin') renderTab();
  }

  /* 답을 바꾸기 직전 상태를 쌓아 두었다가 '되돌리기'로 한 단계씩 되돌린다 (최대 20단계, 이 화면을 여는 동안만). */
  function snapshot(d) {
    S.undo.push(JSON.stringify({ date: d.localDate, answers: d.answers, qotd: d.qotd, note: d.note, mode: d.mode, shown: d.shown }));
    if (S.undo.length > 20) S.undo.shift();
  }
  function undo() {
    var d = S.draft;
    while (S.undo.length) {
      var snap = JSON.parse(S.undo.pop());
      if (snap.date !== d.localDate) continue;
      d.answers = snap.answers; d.qotd = snap.qotd; d.note = snap.note; d.mode = snap.mode; d.shown = snap.shown;
      d.savedAt = null; S.editing = true;
      saveDraftLocal(d);
      scheduleUpload(1200);
      renderTab();
      return;
    }
  }

  function onAnswer() {
    var d = S.draft;
    if (!d.startedAt) d.startedAt = Date.now();
    d.savedAt = null;
    saveDraftLocal(d);
    scheduleUpload(C.requiredDone(d) ? 1200 : 10000);
    updateStatusPill();
  }

  // ------------------------------------------------------------ 기록 탭
  function optionButton(label, sub, pressed, onclick, extraClass) {
    return h('button', { type: 'button', class: 'opt' + (extraClass ? ' ' + extraClass : ''), 'aria-pressed': pressed ? 'true' : 'false', onclick: onclick },
      [h('span', { class: sub !== null && sub !== undefined ? 'num' : '', text: label }), sub ? h('span', { class: 'lab', text: sub }) : null]);
  }

  function renderItem(item, d, container) {
    var cols = item.options.length === 5 ? 'c5' : (item.options.length === 8 || item.options.length === 4 ? 'c4' : 'c2');
    var cur = d.answers[item.key];
    var grid = h('div', { class: 'opts ' + cols, role: 'group', 'aria-label': item.prompt });
    item.options.forEach(function (o) {
      var isScale = typeof o.value === 'number' && item.options.length === 5;
      grid.appendChild(optionButton(isScale ? String(o.value) : o.label, isScale ? o.label : null, cur && cur.value === o.value, function () {
        snapshot(d);
        if (cur && cur.value === o.value) delete d.answers[item.key];
        else d.answers[item.key] = { value: o.value, label: o.label, prompt: item.prompt };
        onAnswer(); renderTab();
      }));
    });
    container.appendChild(h('div', { class: 'q' }, [h('div', { class: 'q-title', text: item.prompt }), grid]));
  }

  function renderQuestion(qid, d, container) {
    var view = C.questionView(S.bank, qid);
    if (!view) return;
    var opts = view.options.slice();
    if (view.kind === 'value' && C.valueSwap(qid, d.localDate)) opts.reverse();   // 가치 쌍의 좌우는 날마다 섞는다
    var shownView = { qid: view.qid, prompt: view.prompt, wording_version: view.wording_version, options: opts };
    var answered = null;
    (d.qotd || []).forEach(function (a) { if (a.qid === qid) answered = a; });
    var many = opts.length > 4;
    var grid = h('div', { class: 'opts ' + (view.kind === 'value' ? 'c2' : (many ? 'c2' : 'c' + Math.max(2, opts.length))), role: 'group', 'aria-label': view.prompt });
    opts.forEach(function (o) {
      grid.appendChild(h('button', { type: 'button', class: 'opt', 'aria-pressed': answered && !answered.skipped && answered.value === o.value ? 'true' : 'false', onclick: function () {
        setQotd(d, shownView, o.value, o.label, false);
      } }, [h('span', { text: o.label }), o.desc ? h('span', { class: 'desc', text: o.desc }) : null]));
    });
    container.appendChild(h('div', { class: 'q' }, [
      h('div', { class: 'row spread' }, [h('div', { class: 'q-title', text: view.prompt }),
        h('button', { type: 'button', class: 'link small', text: answered && answered.skipped ? '건너뜀' : '건너뛰기', onclick: function () { setQotd(d, shownView, null, null, true); } })]),
      grid
    ]));
  }

  function setQotd(d, view, value, label, skipped) {
    snapshot(d);
    var list = [], found = false;
    (d.qotd || []).forEach(function (a) {
      if (a.qid === view.qid) {
        found = true;
        if (!skipped && a.value === value && !a.skipped) return;   // 같은 답을 다시 누르면 취소
        list.push(entry());
      } else list.push(a);
    });
    if (!found) list.push(entry());
    function entry() {
      return { qid: view.qid, wording_version: view.wording_version, prompt: view.prompt, value: skipped ? null : value, label: skipped ? null : label,
               options: view.options.map(function (o) { return { value: o.value, label: o.label }; }), skipped: !!skipped };
    }
    d.qotd = list.slice(0, C.MAX_QUESTIONS);
    onAnswer(); renderTab();
  }

  function renderCheckin(box) {
    var today = todayLocal();
    var yesterdayMode = S.yesterdayMode && S.yesterdayMode === C.addDays(today, -1);
    var date = yesterdayMode ? S.yesterdayMode : today;
    if (!S.draft || S.draft.localDate !== date) S.draft = loadDraft(date, yesterdayMode ? 1 : 0);
    var d = S.draft;
    var missed = C.missedDays(S.lastCheckin || store.get('lastCheckin', null), today);
    // 모드는 첫 답을 누르기 전까지 매번 다시 정한다 (저장소 목록이 늦게 도착할 수 있으므로)
    if (!d.startedAt && !d.modeChosen) d.mode = yesterdayMode ? 'full' : C.formMode(missed, S.form.single_tap_after_missed_days, store.get('forceFull.' + date, false));

    box.appendChild(h('div', { class: 'top' }, [
      h('div', {}, [h('div', { class: 'small', text: yesterdayMode ? '어제 기록' : '오늘 기록' }), h('h1', { text: C.koDateLabel(date) })]),
      h('span', { id: 'sync-pill', class: 'pill', text: '…' })
    ]));
    if (!store.get('introSeen', false)) {
      box.appendChild(h('div', { class: 'card intro' }, [
        h('p', { text: S.form.intro_ko || '' }), h('p', { class: 'small', text: S.form.disclaimer }),
        h('button', { type: 'button', text: '확인', onclick: function () { store.set('introSeen', true); renderTab(); } })
      ]));
    }
    if (S.statusNote) box.appendChild(h('div', { class: 'notice', text: S.statusNote }));

    var quick = (S.form.quick_buttons.catalog || []).filter(function (b) { return b.enabled; }).slice(0, S.form.quick_buttons.max_enabled);
    if (quick.length && !yesterdayMode) {
      var qb = h('div', { class: 'opts c' + Math.max(2, quick.length) });
      quick.forEach(function (b) {
        qb.appendChild(h('button', { type: 'button', class: 'opt', onclick: function (ev) {
          var now = new Date();
          enqueueRecord('event', { kind: b.kind, at: C.isoLocal(now), source: 'button', detail: null }, { label: b.label });
          ev.currentTarget.lastChild.textContent = '기록됨 ' + C.hhmm(now);
        } }, [h('span', { text: b.label }), h('span', { class: 'lab', text: '누르면 지금 시각 기록' })]));
      });
      box.appendChild(h('div', { class: 'card' }, [h('h3', { text: '빠른 기록' }), qb]));
    }

    var card = h('div', { class: 'card' });
    var done = C.requiredDone(d) && d.savedAt && !S.editing;
    var undoBtn = S.undo.length ? h('button', { type: 'button', class: 'link', text: '되돌리기', onclick: undo }) : null;
    if (done) {
      card.appendChild(h('div', { class: 'done' }, [
        h('div', { class: 'big', text: (yesterdayMode ? '어제' : '오늘') + ' 기록 완료' }),
        h('div', { class: 'muted', text: summaryLine(d) }),
        h('div', { class: 'row center' }, [h('button', { type: 'button', class: 'link', text: '고치기', onclick: function () { S.editing = true; renderTab(); } }), undoBtn])
      ]));
      box.appendChild(card);
    } else {
      if (d.mode === 'single_tap') {
        card.appendChild(h('div', { class: 'notice ok', text: missed !== null && missed >= S.form.single_tap_after_missed_days && !d.modeChosen ? '며칠 쉬었네요. 기분만 눌러도 됩니다.' : '오늘은 기분만 남깁니다.' }));
      }
      S.form.items.forEach(function (item) {
        if (d.mode === 'single_tap' && item.key !== 'mood') return;
        if (item.slot === 'question') {
          var answered = (d.qotd || []).map(function (a) { return a.qid; });
          var qids = C.questionsFor(S.bank, S.qotd, date, answered);
          var limit = Math.min(qids.length, C.MAX_QUESTIONS, 1 + S.bank.plan.extra_per_day);
          var shown = Math.min(limit, Math.max(1, d.shown || 1));
          for (var i = 0; i < shown; i++) renderQuestion(qids[i], d, card);
          var allAnswered = qids.slice(0, shown).every(function (q) { return answered.indexOf(q) >= 0; });
          if (allAnswered && shown < limit) {
            card.appendChild(h('button', { type: 'button', class: 'link', text: '질문 하나 더', onclick: function () { d.shown = shown + 1; saveDraftLocal(d); renderTab(); } }));
          }
          return;
        }
        renderItem(item, d, card);
      });
      if (d.mode === 'single_tap') {
        card.appendChild(h('button', { type: 'button', class: 'link', text: '전체 기록 열기', onclick: function () {
          snapshot(d); d.mode = 'full'; d.modeChosen = true; store.set('forceFull.' + date, true); saveDraftLocal(d); renderTab();
        } }));
      } else {
        var note = h('textarea', { maxlength: S.form.note.max_length, placeholder: '오늘 한 줄 (선택)' });
        note.value = d.note || '';
        var noteSnapped = false;
        note.addEventListener('input', function () { if (!noteSnapped) { snapshot(d); noteSnapped = true; } d.note = note.value; onAnswer(); });
        card.appendChild(h('details', { open: d.note ? true : null }, [h('summary', { text: S.form.note.prompt }), note]));
        if (!yesterdayMode) {
          card.appendChild(h('button', { type: 'button', class: 'link', text: '오늘 기분만', onclick: function () {
            snapshot(d); d.mode = 'single_tap'; d.modeChosen = true; store.del('forceFull.' + date); saveDraftLocal(d);
            if (d.answers.mood) { S.editing = false; uploadDraft(true); } else renderTab();
          } }));
        }
      }
      card.appendChild(h('button', { type: 'button', class: 'primary', text: '저장', onclick: function () { S.editing = false; uploadDraft(true); } }));
      if (undoBtn) card.appendChild(undoBtn);
      box.appendChild(card);
    }

    if (!yesterdayMode && S.remoteChecked) {
      var y = C.addDays(today, -1), yd = store.get('draft.' + y, null);
      if (S.lastCheckin !== y && !(yd && yd.savedAt) && S.lastCheckin !== null &&
          C.yesterdayAllowed(new Date(), dayStart(), S.form.yesterday_allowed_until)) {
        box.appendChild(h('button', { type: 'button', class: 'link', text: '어제 기록하기', onclick: function () { S.yesterdayMode = y; S.draft = null; renderTab(); } }));
      }
    }
    if (yesterdayMode) box.appendChild(h('button', { type: 'button', class: 'link', text: '오늘 기록으로 돌아가기', onclick: function () { S.yesterdayMode = null; S.draft = null; renderTab(); } }));

    var reviewCard = renderDecisionReviews();
    if (reviewCard) box.appendChild(reviewCard);
    renderChecklists().forEach(function (c) { box.appendChild(c); });
    if (LA.schedule && !yesterdayMode) {
      var sp = LA.schedule.promptCard();
      if (sp) box.appendChild(sp);
      box.appendChild(LA.schedule.section());
    }
    box.appendChild(renderExtras());
    updateStatusPill();
  }

  function summaryLine(d) {
    var a = d.answers, parts = [];
    if (a.mood) parts.push('기분 ' + a.mood.label);
    if (a.energy) parts.push('에너지 ' + a.energy.label);
    if (a.focus) parts.push(a.focus.label);
    if (a.study_bucket) parts.push('공부 ' + a.study_bucket.label);
    return parts.join(' · ');
  }

  // ------------------------------------------------------------ 부가 기록 (생각, 배운 것, 업무 성과, 몸 이상, 큰 일)
  function splitList(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 10); }

  function renderExtras() {
    var wrap = h('details', { class: 'extras' }, [h('summary', { text: '다른 기록 남기기' })]);
    var kind = S.extraKind || 'thought';
    var x = S.form.extras.filter(function (e) { return e.kind === kind; })[0] || S.form.extras[0];
    var chips = h('div', { class: 'opts c3' });
    S.form.extras.forEach(function (e) {
      chips.appendChild(h('button', { type: 'button', class: 'opt', 'aria-pressed': x.kind === e.kind ? 'true' : 'false', onclick: function () { S.extraKind = e.kind; renderTab(); } }, [h('span', { text: e.label })]));
    });
    var msg = h('p', { class: 'small' });
    var body = h('div', {});
    var f = {};
    if (x.hint) body.appendChild(h('p', { class: 'small', text: x.hint }));
    if (x.record === 'note') {
      f.text = h('textarea', { maxlength: 1000, placeholder: x.label });
      body.appendChild(f.text);
      (x.fields || []).forEach(function (k) {
        if (k === 'resume_candidate') {
          f[k] = h('input', { type: 'checkbox' });
          body.appendChild(h('label', { class: 'check' }, [f[k], h('span', { text: '이력서에 쓸 만한 성과' })]));
          return;
        }
        var labels = { source_url: ['출처 주소 (선택)', 'https://'], tags: ['꼬리표 (쉼표로)', '예: 옵션, 세법'], metric: ['수치 (선택)', '예: 처리 시간 30% 단축'], skills: ['관련 역량 (쉼표로)', '예: Python, VBA'] };
        f[k] = h('input', { type: 'text', maxlength: k === 'source_url' ? 500 : 200, placeholder: labels[k][1] });
        body.appendChild(h('label', { class: 'field' }, [h('span', { text: labels[k][0] }), f[k]]));
      });
      if (x.confirm_ko) {
        f.confirm = h('input', { type: 'checkbox' });
        body.appendChild(h('label', { class: 'check' }, [f.confirm, h('span', { text: x.confirm_ko })]));
      }
    } else {
      f.kind = h('select', {}, x.kinds.map(function (k) { return h('option', { value: k[0], text: k[1] }); }));
      f.date = h('input', { type: 'date' }); f.date.value = todayLocal();
      f.note = h('textarea', { maxlength: 500, placeholder: '메모 (선택)' });
      body.appendChild(h('div', { class: 'row' }, [f.kind, f.date]));
      body.appendChild(f.note);
      // 할 일 목록이 있는 종류(예: 이사)는 고르는 순간 목록을 미리 보여 준다. 남기면 기록 탭에 마감과 함께 뜬다
      var preview = h('div', {});
      var showPreview = function () {
        clear(preview);
        var spec = (x.checklists || {})[f.kind.value];
        if (!spec) return;
        var ul = h('ul', {});
        spec.items.forEach(function (it) {
          ul.appendChild(h('li', { class: 'small', text: it.text_ko + ' · ' + (it.due_days !== null && it.due_days !== undefined ? (it.due_days === 0 ? '이사하는 날까지' : it.due_days + '일 안') : (it.when_ko || '할 수 있을 때')) }));
        });
        preview.appendChild(h('div', { class: 'notice ok' }, [h('strong', { text: spec.title_ko }), ul,
          h('p', { class: 'small', text: '남기면 날짜에 맞춘 마감과 함께 기록 탭에 30일 동안 보입니다.' })]));
      };
      f.kind.addEventListener('change', showPreview);
      body.appendChild(preview);
      showPreview();
    }
    var save = h('button', { type: 'button', class: 'primary', text: '남기기', onclick: function () {
      var payload, label;
      if (x.record === 'note') {
        var t = f.text.value.trim();
        if (!t) { msg.textContent = '내용을 적어 주세요.'; return; }
        if (f.confirm && !f.confirm.checked) { msg.textContent = '고객·딜 이름과 미공개 정보가 없는지 확인하고 체크해 주세요.'; return; }
        payload = { kind: x.kind, text: t };
        if (f.source_url && f.source_url.value.trim()) payload.source_url = f.source_url.value.trim();
        if (f.tags && splitList(f.tags.value).length) payload.tags = splitList(f.tags.value);
        if (f.metric && f.metric.value.trim()) payload.metric = f.metric.value.trim();
        if (f.skills && splitList(f.skills.value).length) payload.skills = splitList(f.skills.value);
        if (f.resume_candidate) payload.resume_candidate = f.resume_candidate.checked;
        if (f.confirm) payload.confidential_checked = true;
        label = x.label + ': ' + t;
      } else {
        if (!f.date.value) { msg.textContent = '날짜를 골라 주세요.'; return; }
        payload = { kind: f.kind.value, date: f.date.value, note: f.note.value.trim() || null };
        label = x.label + ': ' + f.kind.options[f.kind.selectedIndex].text + (payload.note ? ' · ' + payload.note : '');
      }
      var saved = enqueueRecord(x.record, payload, { label: label });
      if (x.record === 'life_event' && (x.checklists || {})[payload.kind]) {
        var loc = store.get('checklists', []);
        loc.push({ record_id: saved.id, kind: payload.kind, date: payload.date });
        store.set('checklists', loc.slice(-10));
      }
      msg.textContent = '남겼습니다 · ' + C.hhmm(new Date());
      S.extraKind = x.kind;
      setTimeout(renderTab, 600);
    } });
    wrap.appendChild(h('div', { class: 'card' }, [chips, body, msg, save]));
    wrap.appendChild(renderDecision());
    wrap.appendChild(renderRecent());
    if (S.extraKind) wrap.open = true;
    return wrap;
  }

  function renderDecision() {
    var f = {
      decision: h('input', { type: 'text', maxlength: 300, placeholder: '무엇을 결정했나' }),
      alternatives: h('input', { type: 'text', maxlength: 400, placeholder: '다른 선택지 (쉼표로 구분)' }),
      reasons: h('textarea', { maxlength: 1000, placeholder: '이유' }),
      expected: h('input', { type: 'text', maxlength: 500, placeholder: '예상하는 결과' }),
      confidence: h('select', {}, [50, 60, 70, 80, 90, 95].map(function (v) { return h('option', { value: v, text: '확신 ' + v + '%' }); })),
      review: h('input', { type: 'date' }),
      domain: h('select', {}, [['career', '커리어'], ['status', '체류 신분'], ['health', '건강'], ['relationship', '관계'], ['money', '돈'], ['other', '기타']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }))
    };
    f.review.value = C.addDays(todayLocal(), 90);
    var msg = h('p', { class: 'small' });
    return h('details', {}, [h('summary', { text: '결정 기록' }), h('div', { class: 'card' }, [
      h('label', { class: 'field' }, [h('span', { text: '결정' }), f.decision]),
      h('label', { class: 'field' }, [h('span', { text: '대안' }), f.alternatives]),
      h('label', { class: 'field' }, [h('span', { text: '이유' }), f.reasons]),
      h('label', { class: 'field' }, [h('span', { text: '예상 결과' }), f.expected]),
      h('div', { class: 'row' }, [f.confidence, f.domain]),
      h('label', { class: 'field' }, [h('span', { text: '다시 볼 날짜' }), f.review]),
      msg,
      h('button', { type: 'button', class: 'primary', text: '결정 남기기', onclick: function () {
        var dec = f.decision.value.trim();
        if (!dec || !f.review.value) { msg.textContent = '결정과 다시 볼 날짜를 채워 주세요.'; return; }
        enqueueRecord('decision', {
          decision: dec,
          alternatives: splitList(f.alternatives.value).slice(0, 5),
          reasons: f.reasons.value.trim() || null, expected_outcome: f.expected.value.trim() || null,
          confidence_pct: parseInt(f.confidence.value, 10), review_date: f.review.value, domain: f.domain.value
        }, { label: '결정: ' + dec });
        f.decision.value = ''; f.alternatives.value = ''; f.reasons.value = ''; f.expected.value = '';
        msg.textContent = '남겼습니다. ' + f.review.value + ' 에 다시 봅니다.';
      } })
    ])]);
  }

  /* 다시 볼 날짜가 된 결정 (밤 점검이 state/reviews.json 에 적는다). 결과와 과정을 따로 채점한다. */
  function renderDecisionReviews() {
    var due = ((S.reviews && S.reviews.decisions_due) || []).filter(function (x) { return store.get('reviewed', []).indexOf(x.decision_id) < 0; });
    if (!due.length) return null;
    var card = h('div', { class: 'card' }, [h('h2', { text: '다시 볼 결정 ' + due.length + '건' }),
      h('p', { class: 'small', text: '결과가 맞았는지와, 그때 가진 정보로 같은 결정을 다시 하겠는지를 따로 봅니다.' })]);
    due.slice(0, 3).forEach(function (x) {
      var hit = h('select', {}, [['', '예상한 결과가 맞았나 —'], ['yes', '맞음'], ['partly', '일부'], ['no', '아님'], ['unknown', '아직 모름']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
      var again = h('select', {}, [['', '같은 결정을 다시? —'], ['yes', '다시 하겠다'], ['no', '안 하겠다'], ['unsure', '모르겠다']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
      var note = h('input', { type: 'text', maxlength: 500, placeholder: '메모 (선택)' });
      var msg = h('p', { class: 'small' });
      card.appendChild(h('div', { class: 'q' }, [
        h('div', { class: 'q-title', text: x.decision }),
        h('p', { class: 'small', text: x.made_on + ' 결정 · 확신 ' + x.confidence_pct + '%' + (x.expected_outcome ? ' · 예상: ' + x.expected_outcome : '') }),
        h('div', { class: 'row' }, [hit, again]), note, msg,
        h('button', { type: 'button', text: '채점 남기기', onclick: function () {
          if (!hit.value || !again.value) { msg.textContent = '두 칸을 골라 주세요.'; return; }
          enqueueRecord('decision_review', { decision_id: x.decision_id, outcome_hit: hit.value, would_repeat: again.value, note: note.value.trim() || null }, { label: '결정 채점: ' + x.decision });
          var r = store.get('reviewed', []); r.push(x.decision_id); store.set('reviewed', r.slice(-50));
          renderTab();
        } })
      ]));
    });
    return card;
  }

  /* 큰 일의 할 일 목록 (예: 이사하면 알릴 곳). 밤 점검이 만든 state/reviews.json 과 이 기기에서 방금 남긴 것을 합친다.
   * 항목마다 마감(큰 일 날짜 + 며칠)과 '했음' 표시, 마감이 있는 항목은 구글 캘린더에 넣는 링크를 둔다. */
  function lifeSpec() {
    var x = (S.form.extras || []).filter(function (e) { return e.record === 'life_event'; })[0];
    return (x && x.checklists) || {};
  }
  function gcalLink(title, day, details) {
    var d0 = day.replace(/-/g, ''), d1 = C.addDays(day, 1).replace(/-/g, '');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) +
           '&dates=' + d0 + '/' + d1 + '&details=' + encodeURIComponent(details);
  }
  function renderChecklists() {
    var specs = lifeSpec(), today = todayLocal(), byId = {};
    ((S.reviews && S.reviews.checklists) || []).forEach(function (c) { byId[c.record_id] = { record_id: c.record_id, kind: c.kind, date: c.date }; });
    store.get('checklists', []).forEach(function (c) { if (!byId[c.record_id]) byId[c.record_id] = c; });
    var done = store.get('checklistDone', {}), cards = [];
    Object.keys(byId).forEach(function (rid) {
      var c = byId[rid], spec = specs[c.kind];
      if (!spec || C.daysBetween(c.date, today) > (spec.show_days || 30)) return;
      var mine = done[rid] || [];
      if (mine.indexOf('__hidden') >= 0) return;
      var card = h('div', { class: 'card' }, [h('h2', { text: spec.title_ko + ' · ' + C.koDateLabel(c.date) })]);
      spec.items.forEach(function (it) {
        var due = (it.due_days !== null && it.due_days !== undefined) ? C.addDays(c.date, it.due_days) : null;
        var isDone = mine.indexOf(it.id) >= 0;
        var left = due ? C.daysBetween(today, due) : null;
        var when = due ? (left < 0 ? '마감 지남 (' + due + ')' : due + '까지 · ' + left + '일 남음') : (it.when_ko || '할 수 있을 때');
        var row = h('div', { class: 'row spread item' }, [
          h('div', {}, [h('div', { class: isDone ? 'small done-text' : '', text: it.text_ko }), h('div', { class: 'small', text: isDone ? '했음' : when })]),
          h('div', { class: 'row' }, [
            due && !isDone && it.calendar ? h('a', { class: 'small', href: gcalLink('[비자] ' + (it.short_ko || it.text_ko) + ' 마감', due,
              it.text_ko + ' (' + spec.title_ko + ' ' + c.date + ')'), target: '_blank', rel: 'noopener noreferrer', text: '캘린더에 넣기' }) : null,
            h('button', { type: 'button', class: 'opt small', 'aria-pressed': isDone ? 'true' : 'false', onclick: function () {
              var d2 = store.get('checklistDone', {}), list = d2[rid] || [], i = list.indexOf(it.id);
              if (i >= 0) list.splice(i, 1); else list.push(it.id);
              d2[rid] = list; store.set('checklistDone', d2); renderTab();
            } }, [h('span', { text: isDone ? '했음' : '했음 표시' })])
          ])
        ]);
        card.appendChild(row);
      });
      card.appendChild(h('button', { type: 'button', class: 'link small', text: '이 목록 숨기기', onclick: function () {
        var d2 = store.get('checklistDone', {}); d2[rid] = (d2[rid] || []).concat(['__hidden']); store.set('checklistDone', d2); renderTab();
      } }));
      if (spec.note_ko) card.appendChild(h('p', { class: 'small', text: spec.note_ko }));
      cards.push(card);
    });
    return cards;
  }

  /* 이 기기에서 최근 30일 안에 남긴 기록. 잘못 남긴 것은 철회한다 (기록은 지워지지 않고 철회 기록이 더해진다). */
  function renderRecent() {
    var list = store.get('recent', []).filter(function (x) { return Date.now() - x.at < 30 * 86400000; });
    var ul = h('div', {});
    if (!list.length) ul.appendChild(h('p', { class: 'small', text: '이 기기에서 최근에 남긴 기록이 없습니다.' }));
    list.forEach(function (x) {
      ul.appendChild(h('div', { class: 'row spread recent' }, [
        h('span', { class: 'small', text: x.date + ' · ' + (x.label || x.type) }),
        x.retracted ? h('span', { class: 'small', text: '철회함' }) : h('button', { type: 'button', class: 'link small danger', text: '철회', onclick: function () {
          if (!confirm('이 기록을 철회할까요? 원본은 남고 철회 기록이 더해집니다.')) return;
          retract(x.id, '화면에서 철회');
          var all = store.get('recent', []);
          all.forEach(function (y) { if (y.id === x.id) y.retracted = true; });
          store.set('recent', all);
          renderTab();
        } })
      ]));
    });
    return h('details', {}, [h('summary', { text: '최근 남긴 기록' }), h('div', { class: 'card' }, [ul])]);
  }

  // ------------------------------------------------------------ 상태 탭
  function renderStatus(box) {
    var hb = S.heartbeat, q = store.get('queue', []), today = todayLocal();
    box.appendChild(h('div', { class: 'top' }, [h('h1', { text: '상태' }), h('span', { id: 'sync-pill', class: 'pill', text: '…' })]));
    var age = C.tokenAgeDays(S.cfg.registered, C.ymd(new Date()));
    var items = [];
    if (S.fatal) items.push(h('div', { class: 'notice', text: '접근 키로 저장소에 쓸 수 없습니다. 키가 폐기됐거나 권한이 바뀌었을 수 있습니다. 아래에서 키를 다시 입력하세요.' }));
    if (store.ephemeral()) items.push(h('div', { class: 'notice ok', text: '이 기기에 저장하지 않는 모드입니다. 창을 닫으면 키와 보내지 못한 기록이 지워집니다.' }));
    if (age !== null && age >= 365) items.push(h('div', { class: 'notice', text: '접근 키를 쓴 지 ' + age + '일이 지났습니다. 1월 정기 관리 때 새 키로 바꾸세요.' }));
    if (hb) {
      var hbAge = (Date.now() - new Date(hb.generated_at).getTime()) / 3600000;
      if (hbAge > 36) items.push(h('div', { class: 'notice', text: '밤 점검이 ' + Math.round(hbAge) + '시간째 돌지 않았습니다. 컴퓨터에서 python3 -m lifeauto doctor 를 실행해 보세요.' }));
      if (hb.integrity && hb.integrity.violations && hb.integrity.violations.length) items.push(h('div', { class: 'notice', text: '기록 저장소 점검 경고가 있습니다. 본인이 한 변경이 아니면 접근 키를 바꾸세요.' }));
      if (hb.checkins && hb.checkins.auto_paused) items.push(h('div', { class: 'notice ok', text: '기록이 14일 넘게 없어 자동으로 쉬어가기 중입니다 (' + hb.checkins.auto_paused_since + '부터). 알림은 한 달에 한 번, 두 번까지만 옵니다. 기분 한 번 누르면 다시 시작합니다.' }));
    }
    items.forEach(function (x) { box.appendChild(x); });

    var jan = S.reviews && S.reviews.january;
    if (jan && jan.length && today.slice(5, 7) === '01') {
      var ul = h('ul', {});
      jan.forEach(function (x) { ul.appendChild(h('li', { class: 'small', text: x })); });
      box.appendChild(h('div', { class: 'card' }, [h('h2', { text: today.slice(0, 4) + '년 1월 점검' }), ul,
        h('p', { class: 'small', text: '자세한 방법은 코드 저장소의 docs/MAINTENANCE.md 에 있습니다.' })]));
    }

    var dl = h('dl', { class: 'kv' });
    function kv(k, v) { dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', { text: v })); }
    kv('기록 저장소', S.cfg.owner + '/' + S.cfg.repo);
    kv('접근 키 등록', (S.cfg.registered || '알 수 없음') + (age !== null ? ' (' + age + '일 전)' : ''));
    kv('보낼 기록', q.length + '건' + (S.lastError ? ' · ' + S.lastError : ''));
    var todayDraft = store.get('draft.' + today, null);
    kv('마지막 체크인', todayDraft && todayDraft.savedAt ? today + ' (오늘)' : (S.lastCheckin || '없음'));
    if (hb) {
      kv('마지막 밤 점검', new Date(hb.generated_at).toLocaleString('ko-KR'));
      kv('기록한 날', (hb.checkins ? hb.checkins.days_recorded : 0) + '일');
      kv('마지막 브리핑', (hb.briefing && hb.briefing.last_date) || '없음');
    } else kv('밤 점검', '아직 결과 없음');
    if (LA.schedule) kv('구글 캘린더', LA.schedule.statusText());
    kv('기기 시간대', tz());
    kv('화면 버전', C.APP_VERSION);
    box.appendChild(h('div', { class: 'card' }, [h('h2', { text: '연결' }), dl,
      h('div', { class: 'row', style: null }, [
        h('button', { type: 'button', text: '지금 보내기', onclick: function () { S.fatal = false; flushQueue(); } }),
        h('button', { type: 'button', text: '새로 고침', onclick: function () { startSync(); renderTab(); } })
      ])]));

    var links = ((S.links && S.links.links) || []);
    if (links.length) {
      var lc = h('div', { class: 'card' }, [h('h2', { text: '바로 가기' })]);
      links.forEach(function (l) {
        var u = linkFor(l);
        lc.appendChild(h('div', { class: 'item' }, [
          u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text: l.title_ko || l.label_ko }) : h('div', { text: l.title_ko || l.label_ko }),
          l.note_ko ? h('div', { class: 'small', text: l.note_ko }) : null,
          u ? null : h('div', { class: 'small', text: '이 기기에서는 열 수 있는 주소가 없습니다.' })
        ]));
      });
      box.appendChild(lc);
    }

    var tzSel = h('select', {}, [['auto', '자동 (기기 시간대)'], ['America/New_York', '뉴욕'], ['America/Toronto', '토론토'], ['Asia/Seoul', '서울']].map(function (o) {
      return h('option', { value: o[0], text: o[1], selected: store.get('scheduleTz', 'America/New_York') === o[0] ? true : null });
    }));
    var tzMsg = h('p', { class: 'small', text: '아침 뉴스와 밤 점검이 이 시간대의 시각에 맞춰 돕니다.' });
    tzSel.addEventListener('change', function () {
      enqueueRecord('setting', { key: 'schedule_tz', value: tzSel.value });
      store.set('scheduleTz', tzSel.value); tzMsg.textContent = '바꿨습니다. 다음 자동 실행부터 적용됩니다.';
    });
    var paused = store.get('pause', null);
    var pauseUntil = h('input', { type: 'date' });
    var pauseBtn = h('button', { type: 'button', text: paused && paused.active ? '다시 시작' : '쉬어가기 시작', onclick: function () {
      var v = paused && paused.active ? { active: false } : { active: true, until: pauseUntil.value || null };
      enqueueRecord('setting', { key: 'pause', value: v });
      store.set('pause', v); renderTab();
    } });
    box.appendChild(h('div', { class: 'card' }, [h('h2', { text: '설정' }),
      h('label', { class: 'field' }, [h('span', { text: '자동 실행 시간대' }), tzSel]), tzMsg,
      h('h3', { text: '쉬어가기' }),
      h('p', { class: 'small', text: paused && paused.active ? '쉬는 중입니다' + (paused.until ? ' (' + paused.until + '까지)' : '') + '. 알림이 오지 않고, 돌아와도 밀린 입력을 묻지 않습니다.' : '여행이나 바쁜 시기에 알림을 끕니다. 끝나는 날은 비워 둬도 됩니다.' }),
      paused && paused.active ? null : h('label', { class: 'field' }, [h('span', { text: '끝나는 날 (선택)' }), pauseUntil]),
      pauseBtn,
      h('h3', { text: '알림 시각' }),
      h('p', { class: 'small', text: '매일 밤 10시 30분 알림은 iPhone 단축어의 개인용 자동화가 이 화면을 여는 방식입니다. 시각은 단축어 앱에서 바꿉니다.' })
    ]));

    box.appendChild(h('div', { class: 'card' }, [h('h2', { text: '접근 키' }),
      h('p', { class: 'small', text: '키는 이 기기에만 있습니다. 새 키로 바꾸거나 이 기기의 연결을 끊을 수 있습니다.' }),
      h('div', { class: 'row' }, [
        h('button', { type: 'button', text: '키 바꾸기', onclick: function () { location.hash = 'setup'; renderSetup(parseHash()); } }),
        h('button', { type: 'button', class: 'danger', text: '이 기기 연결 끊기', onclick: function () {
          if (!confirm('이 기기에서 접근 키를 지울까요? 보내지 못한 기록 ' + store.get('queue', []).length + '건도 함께 지워집니다.')) return;
          store.del('token'); store.del('queue');
          try { if (store.ephemeral()) { sessionStorage.clear(); } } catch (e) { /* 무시 */ }
          location.hash = 'setup'; location.reload();
        } })
      ])]));
    box.appendChild(h('p', { class: 'small', text: S.form.disclaimer }));
    updateStatusPill();
  }

  // ------------------------------------------------------------ 탭
  var TABS = [['checkin', '기록'], ['news', '뉴스'], ['report', '리포트'], ['me', '나'], ['status', '상태']];

  function render() {
    clear(root);
    var nav = h('nav', { class: 'tabs', 'aria-label': '탭' });
    TABS.forEach(function (t) {
      nav.appendChild(h('button', { type: 'button', 'aria-current': S.tab === t[0] ? 'page' : null, text: t[1], onclick: function () {
        if (S.tab === t[0]) return;
        S.tab = t[0]; history.replaceState(null, '', '#' + t[0]); render();
      } }));
    });
    root.appendChild(h('main', { id: 'tab-body', class: 'tab-' + S.tab }));
    root.appendChild(nav);
    renderNavLinks();
    renderTab();
  }

  /* 바로 가기 (예: 자산 관리). 개인 주소는 공개 페이지에 넣지 않으려고 기록 저장소의 self/links.json 에서 읽는다.
   * 폰에서는 url, 컴퓨터에서는 mac_url(없으면 url)을 연다. 열 주소가 없으면 탭에 보이지 않는다. */
  var LINK_OK = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/;
  function linkFor(l) {
    var mobile = /iPhone|iPad|Android/.test(navigator.userAgent);
    var u = mobile ? l.url : (l.mac_url || l.url);
    return LINK_OK.test(String(u || '')) ? u : null;
  }
  function renderNavLinks() {
    var nav = document.querySelector('nav.tabs');
    if (!nav) return;
    Array.prototype.slice.call(nav.querySelectorAll('a.navlink')).forEach(function (a) { nav.removeChild(a); });
    ((S.links && S.links.links) || []).forEach(function (l) {
      var u = linkFor(l);
      if (!u || l.nav === false) return;
      nav.appendChild(h('a', { class: 'navlink', href: u, target: '_blank', rel: 'noopener noreferrer', text: (l.label_ko || '링크') + ' ↗' }));
    });
  }

  function renderTab() {
    var box = document.getElementById('tab-body');
    if (!box) return;
    var y = window.scrollY;
    clear(box);
    try {
      if (S.tab === 'checkin') renderCheckin(box);
      else if (S.tab === 'news') LA.views.renderNews(box);
      else if (S.tab === 'report') LA.views.renderReport(box);
      else if (S.tab === 'me') LA.me.render(box);
      else if (S.tab === 'status') renderStatus(box);
    } catch (e) {
      box.appendChild(h('div', { class: 'card' }, [h('h2', { text: '화면 오류' }), h('p', { class: 'small', text: String(e && e.message || e) })]));
    }
    window.scrollTo(0, y);
  }
  APP.renderTab = renderTab;

  window.addEventListener('hashchange', function () {
    var hp = parseHash();
    if (hp.tab === 'setup') return renderSetup(hp);
    if (S.token && ['checkin', 'news', 'report', 'me', 'status'].indexOf(hp.tab) >= 0 && hp.tab !== S.tab) { S.tab = hp.tab; render(); }
  });
  window.addEventListener('online', function () { flushQueue(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (S.draft && S.uploadTimer) uploadDraft(false);
      flushQueue(true);
    } else if (S.token) {
      if (S.draft && S.draft.localDate !== todayLocal() && !S.yesterdayMode) { S.draft = null; S.undo = []; renderTab(); }
      flushQueue();
    }
  });
  window.addEventListener('pagehide', function () { if (S.draft && S.uploadTimer) uploadDraft(false); flushQueue(true); });

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') setTimeout(boot, 0);
})();
