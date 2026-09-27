/* 일정 · 구글 캘린더 (기록 탭). 당직은 한 달 치를 달력에서 누르거나 말로 적어 넣고, 일정은 하나씩 넣는다.
 * 넣은 것은 schedule 기록(contracts/schedule.v1)으로 저장되고, 자동 실행(lifeauto/calsync.py)이 한 시간 안에 구글 캘린더에 넣는다.
 * 반영 상태는 자동 실행이 쓰는 state/calendar.json 에서 읽는다. 당직 제목·역할·시간 같은 개인 기본값은
 * 공개 페이지에 두지 않으려고 기록 저장소의 self/schedule.json 에서 읽는다.
 * 보안 규칙: 저장소에서 읽은 글은 textContent 로만 넣는다.
 */
LA.schedule = (function () {
  'use strict';
  var A = LA.app, C = LA.core, h = A.h, S = A.state;
  var V = { view: null, draft: null, brush: null, form: null, msg: null, quick: '', qmsg: null, open: false };
  var STATUS = { synced: ['캘린더 ✓', 'ok'], pending: ['대기', 'warn'], error: ['오류', 'bad'], deleted_by_user: ['캘린더에서 지움', ''] };
  var TZS = [['America/New_York', '뉴욕'], ['America/Toronto', '토론토'], ['Asia/Seoul', '서울']];
  var REMIND = [['default', '기본'], ['0', '시작할 때'], ['10', '10분 전'], ['60', '1시간 전'], ['day', '하루 전'], ['none', '없음']];
  var WEEK = 7 * 86400000;

  // ------------------------------------------------------------ 읽기
  function cfg() {
    var c = S.schedCfg || A.store.get('cache.schedcfg', null) || {}, ev = c.event || {};
    var duty = c.duty && c.duty.roles && c.duty.roles.length ? c.duty : null;
    return { duty: duty, event: { tz: ev.tz || 'America/New_York', timed: ev.remind_timed_min || [30], allDay: ev.remind_all_day_min || [900] } };
  }
  function cal() {
    var s = S.calState || A.store.get('cache.calstate', null) || {};
    return { items: s.items || {}, months: s.months || {}, bridge: s.bridge || {}, updated: s.updated_at ? Date.parse(s.updated_at) : 0 };
  }
  /* 이 기기에서 저장했지만 자동 실행이 아직 반영하지 않은 것. 반영됐거나 일주일이 지나면 지운다. */
  function local() {
    var l = A.store.get('sched.local', null) || {}, s = cal(), changed = false;
    l.months = l.months || {}; l.events = l.events || {};
    Object.keys(l.months).forEach(function (m) {
      var st = s.months[m], lm = l.months[m];
      if ((st && (st.record_id === lm.record_id || Date.parse(st.captured_at) > lm.saved_at)) || Date.now() - lm.saved_at > WEEK) { delete l.months[m]; changed = true; }
    });
    Object.keys(l.events).forEach(function (id) {
      var st = s.items['event:' + id], le = l.events[id];
      var seen = st ? st.record_id === le.record_id : (le.payload.cancelled && s.updated > le.saved_at);
      if (seen || Date.now() - le.saved_at > WEEK) { delete l.events[id]; changed = true; }
    });
    if (changed) A.store.set('sched.local', l);
    return l;
  }
  function saveLocal(fn) { var l = local(); fn(l); A.store.set('sched.local', l); }
  function monthItems(m) {
    var lm = local().months[m];
    if (lm) return { items: lm.items, record_id: lm.record_id };
    var st = cal().months[m];
    return st ? { items: st.items || [], record_id: st.record_id } : { items: [], record_id: null };
  }
  function knownMonths() { return Object.keys(cal().months).concat(Object.keys(local().months)); }
  function hint() {
    var b = cal().bridge;
    return b.configured && !b.error ? '한 시간 안에 구글 캘린더에 들어갑니다.' : '캘린더를 연결하면 바로 들어갑니다.';
  }

  /* 앞으로 days 일의 일정: 자동 실행이 반영한 것에 이 기기에서 방금 저장한 것을 덮어 보여 준다. */
  function upcoming(days) {
    var s = cal(), l = local(), today = A.todayLocal(), until = C.addDays(today, days), rows = [];
    var dutyTitle = (cfg().duty && cfg().duty.title) || '당직';
    function inRange(d) { return d && d >= today && d <= until; }
    Object.keys(s.items).forEach(function (k) {
      var it = s.items[k];
      if (!inRange(it.date) || (it.kind === 'duty' && l.months[it.month]) || (it.kind === 'event' && l.events[it.item_id])) return;
      rows.push({ kind: it.kind, date: it.date, time: it.time, label: it.label, status: it.status, error: it.error, item: it });
    });
    Object.keys(l.months).forEach(function (m) {
      l.months[m].items.forEach(function (x) {
        if (inRange(x.date)) rows.push({ kind: 'duty', date: x.date, time: x.start + '–' + x.end, label: C.dutyTitle(l.months[m].title || dutyTitle, x.role, x.note), status: 'pending' });
      });
    });
    Object.keys(l.events).forEach(function (id) {
      var p = l.events[id].payload;
      if (p.cancelled || !inRange(p.date)) return;
      rows.push({ kind: 'event', date: p.date, time: p.start ? (p.end ? p.start + '–' + p.end : p.start) : null, label: p.title, status: 'pending',
                  item: { item_id: id, date: p.date, title: p.title, start: p.start, end: p.end, note: p.note, remind_min: p.remind_min, tz: p.tz, record_id: l.events[id].record_id } });
    });
    rows.sort(function (a, b) { var x = a.date + (a.time || ''), y = b.date + (b.time || ''); return x < y ? -1 : (x > y ? 1 : 0); });
    return rows;
  }

  // ------------------------------------------------------------ 기록 탭에 붙는 것
  /* 달이 바뀔 무렵(25일부터 다음 달 7일까지) 그달 당직을 아직 안 넣었으면 한 번 알려 준다. */
  function promptCard() {
    var dc = cfg().duty;
    if (!dc || !dc.prompt || V.view === 'duty') return null;
    var today = A.todayLocal();
    var m = C.dutyPromptMonth(today, dc.prompt.from_day || 25, dc.prompt.until_day || 7, knownMonths());
    var snooze = A.store.get('sched.snooze', null);
    if (!m || (snooze && snooze.month === m && today < snooze.until)) return null;
    return h('div', { class: 'card' }, [
      h('p', { text: C.monthLabel(m) + ' 당직을 아직 넣지 않았어요.' }),
      h('p', { class: 'small', text: '당직표를 받았으면 달력에서 날짜를 누르거나 "20 정, 22 부"처럼 적으면 구글 캘린더에 들어갑니다.' }),
      h('button', { type: 'button', class: 'primary', text: C.monthLabel(m) + ' 당직 넣기', onclick: function () { openDuty(m); } }),
      h('div', { class: 'row' }, [
        h('button', { type: 'button', class: 'link', text: C.monthLabel(m) + '은 당직 없음', onclick: function () { saveDuty(m, {}, monthItems(m).record_id); } }),
        h('button', { type: 'button', class: 'link', text: '사흘 뒤에 다시', onclick: function () { A.store.set('sched.snooze', { month: m, until: C.addDays(today, 3) }); A.renderTab(); } })
      ])
    ]);
  }

  function section() {
    var d = h('details', { class: 'extras', open: (V.open || V.view) ? true : null }, [h('summary', { text: '일정 · 구글 캘린더' })]);
    d.addEventListener('toggle', function () { V.open = d.open; });
    var card = h('div', { class: 'card' }), b = cal().bridge;
    if (b.error) card.appendChild(h('div', { class: 'notice', text: '구글 캘린더에 넣지 못하고 있습니다: ' + b.error }));
    else if (!b.configured) card.appendChild(h('p', { class: 'small', text: '구글 캘린더 연결 전입니다. 넣은 일정은 저장해 두었다가, 맥에서 캘린더를 한 번 연결하면 바로 들어갑니다.' }));
    else card.appendChild(h('p', { class: 'small', text: '넣은 일정은 한 시간 안에 구글 캘린더에 들어갑니다. 고치거나 지울 때도 여기서 하세요.' }));
    if (V.msg) card.appendChild(h('div', { class: 'notice ok', text: V.msg }));
    var rows = upcoming(30);
    rows.slice(0, 12).forEach(function (r) { card.appendChild(row(r)); });
    if (!rows.length) card.appendChild(h('p', { class: 'small', text: '앞으로 30일 안에 넣은 일정이 없습니다.' }));
    else if (rows.length > 12) card.appendChild(h('p', { class: 'small', text: '그 뒤로 ' + (rows.length - 12) + '개 더 있습니다.' }));
    var btns = h('div', { class: 'row' });
    if (cfg().duty) btns.appendChild(h('button', { type: 'button', text: '당직 넣기', onclick: function () { openDuty(null); } }));
    btns.appendChild(h('button', { type: 'button', text: '일정 하나 넣기', onclick: function () { openEvent(null); } }));
    card.appendChild(btns);
    d.appendChild(card);
    if (V.view === 'duty' && V.draft && cfg().duty) d.appendChild(dutyEditor());
    if (V.view === 'event' && V.form) d.appendChild(eventForm());
    return d;
  }

  /* 다리를 연결하기 전이면, 전에 손으로 넣어 둔 기한은 '대기'가 아니라 이미 캘린더에 있다 */
  function statusOf(status, item) {
    if (status === 'pending' && item && item.preexisting && !cal().bridge.configured) return ['캘린더', ''];
    return STATUS[status] || [status || '', ''];
  }
  function row(r) {
    var st = statusOf(r.status, r.item);
    var right = h('div', { class: 'row' }, [h('span', { class: 'pill ' + st[1], text: st[0] })]);
    if (r.kind === 'event' && r.item) right.appendChild(h('button', { type: 'button', class: 'link small', text: '고치기', onclick: function () { openEvent(r.item); } }));
    if (r.kind === 'duty') right.appendChild(h('button', { type: 'button', class: 'link small', text: '고치기', onclick: function () { openDuty(r.date.slice(0, 7)); } }));
    return h('div', { class: 'row spread item' }, [
      h('div', { class: 'grow' }, [h('div', { text: r.label }), h('div', { class: 'small', text: C.koDateLabel(r.date) + ' · ' + (r.time || '종일') +
        (r.kind === 'deadline' ? ' · 기한' : '') + (r.error ? ' · ' + r.error : '') })]),
      right
    ]);
  }

  // ------------------------------------------------------------ 당직 (한 달 치)
  function openDuty(month) {
    var today = A.todayLocal();
    var m = month || (+today.slice(8, 10) >= 20 ? C.addMonths(today.slice(0, 7), 1) : today.slice(0, 7));
    loadDraft(m);
    V.view = 'duty'; V.open = true; V.msg = null; V.qmsg = null; V.quick = '';
    A.renderTab();
  }
  function loadDraft(m) {
    var cur = monthItems(m), items = {}, dc = cfg().duty;
    cur.items.forEach(function (x) { items[x.date] = { role: x.role, start: x.start, end: x.end, note: x.note || null }; });
    V.draft = { month: m, items: items, base: cur.record_id, had: cur.items.length > 0 };
    if (!V.brush && V.brush !== '') V.brush = dc.roles[0].code;
  }
  function role(code) {
    return cfg().duty.roles.filter(function (r) { return r.code === code; })[0] || { code: code, start: '17:00', end: '21:00' };
  }
  function setDay(ds, code) {
    var it = V.draft.items[ds], r = role(code);
    if (it && it.role === code) return;
    V.draft.items[ds] = { role: code, start: r.start, end: r.end, note: it ? it.note : null };
  }
  function tap(ds) {
    var it = V.draft.items[ds];
    if (!V.brush || (it && it.role === V.brush)) delete V.draft.items[ds];
    else setDay(ds, V.brush);
    V.qmsg = null;
    A.renderTab();
  }

  function dutyEditor() {
    var dc = cfg().duty, dr = V.draft, today = A.todayLocal(), m = dr.month, thisMonth = today.slice(0, 7);
    var card = h('div', { class: 'card' }, [h('h2', { text: C.monthLabel(m) + ' 당직' })]);
    var mrow = h('div', { class: 'opts c3' });
    [thisMonth, C.addMonths(thisMonth, 1), C.addMonths(thisMonth, 2)].forEach(function (mm) {
      mrow.appendChild(h('button', { type: 'button', class: 'opt small', 'aria-pressed': mm === m ? 'true' : 'false',
        onclick: function () { loadDraft(mm); V.qmsg = null; A.renderTab(); } }, [h('span', { text: C.monthLabel(mm) })]));
    });
    card.appendChild(mrow);

    card.appendChild(h('p', { class: 'small', text: '역할을 고르고 날짜를 누르세요. 같은 역할로 다시 누르면 빠집니다.' }));
    var brushes = h('div', { class: 'opts c' + Math.min(4, dc.roles.length + 1) });
    dc.roles.forEach(function (r) {
      brushes.appendChild(h('button', { type: 'button', class: 'opt small', 'aria-pressed': V.brush === r.code ? 'true' : 'false',
        onclick: function () { V.brush = r.code; A.renderTab(); } }, [h('span', { text: r.code }), h('span', { class: 'lab', text: r.start + '–' + r.end })]));
    });
    brushes.appendChild(h('button', { type: 'button', class: 'opt small', 'aria-pressed': V.brush === '' ? 'true' : 'false',
      onclick: function () { V.brush = ''; A.renderTab(); } }, [h('span', { text: '빼기' })]));
    card.appendChild(brushes);

    var grid = h('div', { class: 'cal', role: 'group', 'aria-label': C.monthLabel(m) + ' 달력' });
    ['일', '월', '화', '수', '목', '금', '토'].forEach(function (w) { grid.appendChild(h('div', { class: 'cal-h', text: w })); });
    C.monthGrid(m).forEach(function (week) {
      week.forEach(function (ds, i) {
        if (!ds) { grid.appendChild(h('div', {})); return; }
        var it = dr.items[ds];
        grid.appendChild(h('button', { type: 'button', class: 'cal-d' + (it ? ' on' : '') + (i === 0 || i === 6 ? ' we' : ''),
          disabled: ds < today ? true : null, 'aria-pressed': it ? 'true' : 'false', 'aria-label': C.koDateLabel(ds) + (it ? ' ' + it.role : ''),
          onclick: function () { tap(ds); } }, [h('span', { text: String(+ds.slice(8)) }), h('b', { text: it ? it.role : '' })]));
      });
    });
    card.appendChild(grid);

    var quick = h('input', { type: 'text', placeholder: '말로 적기: 20 정, 22 부', autocomplete: 'off', enterkeyhint: 'done' });
    quick.value = V.quick;
    quick.addEventListener('input', function () { V.quick = quick.value; });
    var apply = function () {
      var res = C.parseDutyText(quick.value, m, dc.roles.map(function (r) { return r.code; }));
      var used = res.items.filter(function (x) { return x.date >= today; });
      used.forEach(function (x) { setDay(x.date, x.role); });
      var skipped = res.items.length - used.length;
      V.qmsg = (used.length ? used.length + '일을 채웠습니다.' : '채운 날이 없습니다.') + (skipped ? ' 지난 날 ' + skipped + '일은 뺐습니다.' : '') +
               (res.errors.length ? ' ' + res.errors.join(' · ') : '');
      if (!res.errors.length) V.quick = '';
      A.renderTab();
    };
    quick.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    card.appendChild(h('div', { class: 'row' }, [quick, h('button', { type: 'button', text: '채우기', onclick: apply })]));
    if (V.qmsg) card.appendChild(h('p', { class: 'small', text: V.qmsg }));

    var dates = Object.keys(dr.items).sort();
    dates.forEach(function (ds) {
      var it = dr.items[ds], past = ds < today;
      var s = h('input', { type: 'time', value: it.start, disabled: past ? true : null, 'aria-label': '시작' });
      var e = h('input', { type: 'time', value: it.end, disabled: past ? true : null, 'aria-label': '끝' });
      var note = h('input', { type: 'text', maxlength: 60, placeholder: '메모 (선택, 예: 컴퓨터 가져가기)', disabled: past ? true : null });
      note.value = it.note || '';
      s.addEventListener('change', function () { it.start = s.value; });
      e.addEventListener('change', function () { it.end = e.value; });
      note.addEventListener('input', function () { it.note = note.value; });
      card.appendChild(h('div', { class: 'duty-row' }, [
        h('div', { class: 'small', text: C.koDateLabel(ds) + ' · ' + C.dutyTitle(dc.title, it.role, it.note) + (past ? ' · 지난 날' : '') }),
        h('div', { class: 'row' }, [s, h('span', { class: 'small', text: '–' }), e]), note
      ]));
    });

    var msg = h('p', { class: 'small' });
    var label = dates.length ? '캘린더에 넣기 · ' + dates.length + '일' : (dr.had ? C.monthLabel(m) + ' 당직 모두 빼기' : C.monthLabel(m) + '은 당직 없음으로 저장');
    card.appendChild(msg);
    card.appendChild(h('button', { type: 'button', class: 'primary', text: label, onclick: function () {
      for (var i = 0; i < dates.length; i++) {
        var it = dr.items[dates[i]];
        if (!C.isHHMM(it.start) || !C.isHHMM(it.end) || it.end <= it.start) { msg.textContent = C.koDateLabel(dates[i]) + ': 끝 시각이 시작보다 늦어야 합니다.'; return; }
      }
      if (!dates.length && dr.had && !confirm(C.monthLabel(m) + ' 당직을 모두 뺄까요? 앞으로의 당직 일정이 캘린더에서 지워집니다.')) return;
      saveDuty(m, dr.items, dr.base);
    } }));
    card.appendChild(h('button', { type: 'button', class: 'link small', text: '닫기', onclick: function () { V.view = null; A.renderTab(); } }));
    return card;
  }

  function saveDuty(m, itemsByDate, base) {
    var dc = cfg().duty;
    var items = Object.keys(itemsByDate).sort().map(function (ds) { var it = itemsByDate[ds]; return { date: ds, role: it.role, start: it.start, end: it.end, note: it.note }; });
    var payload = C.dutyPayload({ month: m, tz: dc.tz || 'America/New_York', title: dc.title, remindMin: dc.remind_min || [0], busy: !!dc.busy, items: items });
    var rec = A.enqueueRecord('schedule', payload, { supersedes: base || null, label: false });
    saveLocal(function (l) { l.months[m] = { record_id: rec.id, items: payload.items, title: dc.title, saved_at: Date.now() }; });
    V.view = null; V.open = true;
    V.msg = C.monthLabel(m) + ' 당직 ' + items.length + '일을 저장했습니다. ' + (items.length ? hint() : '');
    A.renderTab();
  }

  // ------------------------------------------------------------ 일정 하나
  function remindList(key, timed) {
    var c = cfg().event;
    if (key === 'default') return timed ? c.timed : c.allDay;
    if (key === 'none') return [];
    if (key === 'day') return timed ? [1440] : [900];
    return [parseInt(key, 10)];
  }
  function remindKey(list, timed) {
    var keys = REMIND.map(function (o) { return o[0]; });
    for (var i = 0; i < keys.length; i++) if (JSON.stringify(remindList(keys[i], timed)) === JSON.stringify(list || [])) return keys[i];
    return 'default';
  }
  function openEvent(item) {
    V.form = item ? { itemId: item.item_id, title: item.title || item.label || '', date: item.date, start: item.start || '', end: item.end || '', note: item.note || '',
                      tz: item.tz || cfg().event.tz, remind: remindKey(item.remind_min, !!item.start), base: item.record_id, editing: true }
                  : { itemId: C.newItemId(), title: '', date: A.todayLocal(), start: '', end: '', note: '', tz: cfg().event.tz, remind: 'default', base: null, editing: false };
    V.view = 'event'; V.open = true; V.msg = null;
    A.renderTab();
  }
  function eventForm() {
    var f = V.form;
    var title = h('input', { type: 'text', maxlength: 100, placeholder: '예: 치과' });
    var date = h('input', { type: 'date' }), start = h('input', { type: 'time' }), end = h('input', { type: 'time' });
    var remind = h('select', {}, REMIND.map(function (o) { return h('option', { value: o[0], text: o[1], selected: f.remind === o[0] ? true : null }); }));
    var tzSel = h('select', {}, TZS.map(function (o) { return h('option', { value: o[0], text: o[1] + ' 시각', selected: f.tz === o[0] ? true : null }); }));
    var note = h('textarea', { maxlength: 500, placeholder: '메모 (선택)' });
    title.value = f.title; date.value = f.date; start.value = f.start; end.value = f.end; note.value = f.note;
    var read = function () { f.title = title.value; f.date = date.value; f.start = start.value; f.end = end.value; f.note = note.value; f.remind = remind.value; f.tz = tzSel.value; };
    [title, date, start, end, note, remind, tzSel].forEach(function (x) { x.addEventListener('input', read); x.addEventListener('change', read); });
    var msg = h('p', { class: 'small' });
    return h('div', { class: 'card' }, [h('h2', { text: f.editing ? '일정 고치기' : '일정 하나 넣기' }),
      h('label', { class: 'field' }, [h('span', { text: '제목' }), title]),
      h('label', { class: 'field' }, [h('span', { text: '날짜' }), date]),
      h('div', { class: 'row' }, [h('label', { class: 'field half' }, [h('span', { text: '시작 (비우면 종일)' }), start]),
                                  h('label', { class: 'field half' }, [h('span', { text: '끝 (선택)' }), end])]),
      h('div', { class: 'row' }, [h('label', { class: 'field half' }, [h('span', { text: '알림' }), remind]),
                                  h('label', { class: 'field half' }, [h('span', { text: '시간대' }), tzSel])]),
      note, msg,
      h('button', { type: 'button', class: 'primary', text: '캘린더에 넣기', onclick: function () { read(); saveEvent(false, msg); } }),
      h('div', { class: 'row spread' }, [
        f.editing ? h('button', { type: 'button', class: 'link small danger', text: '이 일정 지우기', onclick: function () {
          if (confirm('이 일정을 지울까요? 한 시간 안에 캘린더에서도 빠집니다.')) saveEvent(true, msg);
        } }) : h('span', {}),
        h('button', { type: 'button', class: 'link small', text: '닫기', onclick: function () { V.view = null; A.renderTab(); } })
      ])
    ]);
  }
  function saveEvent(cancel, msg) {
    var f = V.form, today = A.todayLocal();
    if (!cancel) {
      if (!f.title.replace(/\s/g, '')) { msg.textContent = '제목을 적어 주세요.'; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { msg.textContent = '날짜를 골라 주세요.'; return; }
      if (f.date < today) { msg.textContent = '지난 날짜는 캘린더에 넣지 않습니다.'; return; }
      if (f.end && !f.start) { msg.textContent = '끝 시각만 있으면 안 됩니다. 시작도 넣거나 둘 다 비우세요.'; return; }
      if (f.start && f.end && f.end <= f.start) { msg.textContent = '끝 시각이 시작보다 늦어야 합니다.'; return; }
    }
    var timed = !!f.start;
    var payload = C.eventPayload({ itemId: f.itemId, tz: f.tz, date: f.date, title: f.title, start: f.start, end: f.end, note: f.note,
                                   remindMin: remindList(f.remind, timed), busy: timed, cancelled: cancel });
    var rec = A.enqueueRecord('schedule', payload, { supersedes: f.base || null, label: false });
    saveLocal(function (l) { l.events[f.itemId] = { record_id: rec.id, payload: payload, saved_at: Date.now() }; });
    V.view = null; V.form = null; V.open = true;
    V.msg = cancel ? '지웠습니다. 한 시간 안에 캘린더에서도 빠집니다.' : '저장했습니다: ' + payload.title + '. ' + hint();
    A.renderTab();
  }

  /* 상태 탭의 한 줄 */
  function statusText() {
    var b = cal().bridge;
    if (b.error) return '오류 · ' + b.error;
    if (!b.configured) return '연결 전 (맥에서 캘린더 연결)';
    return '연결됨' + (b.calendar ? ' · ' + b.calendar : '');
  }
  /* 나 탭의 기한 줄: 그 기한의 캘린더 반영 상태 */
  function deadlineStatus(id) {
    var it = cal().items['deadline:' + id];
    return it ? statusOf(it.status, it)[0] : null;
  }

  return { promptCard: promptCard, section: section, statusText: statusText, deadlineStatus: deadlineStatus };
})();
