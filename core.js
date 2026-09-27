/* 체크인 화면의 계산 로직. 화면(DOM)과 네트워크를 전혀 쓰지 않는다.
 * 브라우저와 맥의 JavaScriptCore(jsc) 양쪽에서 돌도록 옛 문법만 쓴다.
 * 기록 형식은 contracts/ 폴더의 정의와 같아야 하며, tests/test_web_core.py 가 파이썬 검사기로 확인한다.
 */
var LA = (typeof LA !== 'undefined') ? LA : {};
LA.core = (function () {
  'use strict';

  var APP_VERSION = '1.1.0';
  var MAX_QUESTIONS = 3;   // 하루 질문은 주 질문 하나와 '질문 하나 더' 둘
  var KO_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  function pad(n, w) {
    var s = String(Math.abs(n));
    while (s.length < (w || 2)) s = '0' + s;
    return s;
  }

  // ------------------------------------------------------------ 시각과 날짜
  function offsetMinutes(d) { return -d.getTimezoneOffset(); }
  function offsetString(d, colon) {
    var m = offsetMinutes(d), sign = m < 0 ? '-' : '+';
    m = Math.abs(m);
    return sign + pad(Math.floor(m / 60)) + (colon ? ':' : '') + pad(m % 60);
  }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isoLocal(d) {
    return ymd(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + offsetString(d, true);
  }
  function compactStamp(d) {
    return ymd(d) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + offsetString(d, false);
  }
  function parseHHMM(s) { var p = String(s || '04:00').split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
  /* 이 기록이 속한 하루. 벽시계(현지 시각) 기준으로 하루 시작 전이면 전날이다.
   * 절대 시간에서 4시간을 빼면 서머타임이 바뀌는 밤에 파이썬(timeutil.logical_date)과 결과가 달라지므로 쓰지 않는다. */
  function logicalDate(d, dayStart) {
    var today = ymd(d);
    return (d.getHours() * 60 + d.getMinutes()) < parseHHMM(dayStart) ? addDays(today, -1) : today;
  }
  /* '어제 기록하기'를 보여 줄지: 논리적 오늘의 until(기본 12:00) 전까지만. 새벽 0~4시는 논리적 오늘이 아직 어제라서 보이지 않는다. */
  function yesterdayAllowed(now, dayStart, until) {
    var today = logicalDate(now, dayStart);
    if (ymd(now) !== today) return false;
    return (now.getHours() * 60 + now.getMinutes()) < parseHHMM(until || '12:00');
  }
  /* 가치 쌍의 좌우 순서. 같은 날 같은 질문은 늘 같은 순서가 되도록 날짜와 ID 로 정한다. */
  function hashStr(s) {   // FNV-1a 뒤에 섞기(murmur3 fmix32). 아래쪽 비트도 고르게 나오게
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }
  function valueSwap(qid, localDate) { return (hashStr(qid + '|' + localDate) & 1) === 1; }
  function ymdToUTC(s) { var p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) {
    var t = new Date(ymdToUTC(s) + n * 86400000);
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  function daysBetween(a, b) { return Math.round((ymdToUTC(b) - ymdToUTC(a)) / 86400000); }
  function weekdayMon0(s) { return (new Date(ymdToUTC(s)).getUTCDay() + 6) % 7; }
  function koDateLabel(s) {
    var p = s.split('-');
    return (+p[1]) + '월 ' + (+p[2]) + '일 (' + KO_WEEKDAYS[new Date(ymdToUTC(s)).getUTCDay()] + ')';
  }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  // ------------------------------------------------------------ 기록 만들기
  function randHex(n, rnd) {
    var s = '', r = rnd || Math.random;
    for (var i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16);
    return s;
  }
  function recordId(type, d, rand) { return compactStamp(d) + '_' + type + '_' + rand; }
  function recordPath(id) { return 'records/' + id.slice(0, 4) + '/' + id.slice(5, 7) + '/' + id + '.json'; }

  /* opts: {type, payload, now(Date), tz, dayStart, lag, form, supersedes, rand, device} */
  function buildRecord(opts) {
    var d = opts.now, rand = opts.rand || randHex(4);
    var id = recordId(opts.type, d, rand);
    var localDate = logicalDate(d, opts.dayStart);
    if (opts.lag) localDate = addDays(localDate, -opts.lag);
    return {
      schema: opts.type + '.v1',
      id: id,
      captured_at: isoLocal(d),
      tz: opts.tz || 'UTC',
      local_date: localDate,
      day_start: opts.dayStart || '04:00',
      form: opts.form || null,
      source: { client: 'web', app_version: APP_VERSION, device: opts.device || null },
      supersedes: opts.supersedes || null,
      payload: opts.payload
    };
  }

  /* draft: {answers:{mood:{value,label,prompt},...}, qotd:[...], note, mode, lag, startedAt} */
  function checkinPayload(draft, nowMs) {
    var answers = {};
    var keys = ['mood', 'energy', 'focus', 'study_bucket'];
    for (var i = 0; i < keys.length; i++) {
      var a = draft.answers && draft.answers[keys[i]];
      if (a && a.value !== undefined && a.value !== null) answers[keys[i]] = { value: a.value, label: a.label, prompt: a.prompt };
    }
    if (draft.qotd && draft.qotd.length) answers.qotd = draft.qotd.slice(0, MAX_QUESTIONS);
    var p = { mode: draft.mode === 'single_tap' ? 'single_tap' : 'full', answers: answers };
    var note = (draft.note || '').replace(/^\s+|\s+$/g, '');
    if (note) p.note = note.slice(0, 200);
    if (draft.lag) p.recall_lag_days = draft.lag;
    if (draft.startedAt && nowMs) p.duration_sec = Math.max(0, Math.min(86400, Math.round((nowMs - draft.startedAt) / 1000)));
    return p;
  }

  function isCheckinEmpty(payload) {
    var n = 0;
    for (var k in payload.answers) if (payload.answers.hasOwnProperty(k)) n++;
    return n === 0 && !payload.note;
  }

  function requiredDone(draft) {
    var a = draft.answers || {};
    if (draft.mode === 'single_tap') return !!a.mood;
    return !!(a.mood && a.energy && a.focus && a.study_bucket && draft.qotd && draft.qotd.length);
  }

  // ------------------------------------------------------------ 기록 파일 이름 읽기
  var NAME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})([+-]\d{4})_([a-z_]+)_([0-9a-f]{4,8})\.json$/;
  function parseRecordName(name, dayStart) {
    var m = NAME_RE.exec(name);
    if (!m) return null;
    var mins = parseInt(m[4], 10) * 60 + parseInt(m[5], 10);
    var date = m[1] + '-' + m[2] + '-' + m[3];
    if (mins < parseHHMM(dayStart)) date = addDays(date, -1);
    return { id: name.replace(/\.json$/, ''), type: m[8], stamp: name.slice(0, 22), localDate: date };
  }

  function missedDays(lastLocalDate, today) {
    if (!lastLocalDate) return null;
    return Math.max(0, daysBetween(lastLocalDate, today));
  }
  function formMode(missed, threshold, forcedFull) {
    if (forcedFull) return 'full';
    return (missed !== null && missed >= (threshold || 3)) ? 'single_tap' : 'full';
  }

  // ------------------------------------------------------------ 보낼 대기열
  function queueAdd(queue, item) {
    var out = [];
    for (var i = 0; i < queue.length; i++) if (queue[i].path !== item.path) out.push(queue[i]);
    out.push(item);
    return out;
  }
  function queueRemove(queue, path) {
    var out = [];
    for (var i = 0; i < queue.length; i++) if (queue[i].path !== path) out.push(queue[i]);
    return out;
  }

  // ------------------------------------------------------------ UTF-8 과 base64 (jsc 에는 TextEncoder 와 btoa 가 없다)
  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function utf8Decode(bytes) {
    var s = '', i = 0;
    while (i < bytes.length) {
      var b = bytes[i++], c;
      if (b < 0x80) c = b;
      else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      if (c > 0xffff) { c -= 0x10000; s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); }
      else s += String.fromCharCode(c);
    }
    return s;
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64FromBytes(b) {
    var out = '', i;
    for (i = 0; i + 2 < b.length; i += 3) {
      var n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    var rest = b.length - i;
    if (rest === 1) { var n1 = b[i] << 16; out += B64[n1 >> 18] + B64[(n1 >> 12) & 63] + '=='; }
    if (rest === 2) { var n2 = (b[i] << 16) | (b[i + 1] << 8); out += B64[n2 >> 18] + B64[(n2 >> 12) & 63] + B64[(n2 >> 6) & 63] + '='; }
    return out;
  }
  function bytesFromBase64(s) {
    s = s.replace(/[^A-Za-z0-9+/]/g, '');
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64.indexOf(s.charAt(i)); bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
    }
    return out;
  }
  function utf8ToBase64(str) { return base64FromBytes(utf8Encode(str)); }
  function base64ToUtf8(s) { return utf8Decode(bytesFromBase64(s)); }

  // ------------------------------------------------------------ 오늘의 질문
  function questionView(bank, qid) {
    if (!qid) return null;
    if (qid.indexOf('v.pair.') === 0) {
      var codes = qid.slice(7).split('-'), items = {};
      for (var i = 0; i < bank.values.items.length; i++) items[bank.values.items[i].code] = bank.values.items[i];
      if (!items[codes[0]] || !items[codes[1]]) return null;
      return { qid: qid, prompt: bank.values.prompt, wording_version: bank.values.wording_version, kind: 'value',
               options: [{ value: codes[0], label: items[codes[0]].label, desc: items[codes[0]].desc },
                         { value: codes[1], label: items[codes[1]].label, desc: items[codes[1]].desc }] };
    }
    for (var j = 0; j < bank.situational.length; j++) {
      var q = bank.situational[j];
      if (q.id === qid) return { qid: qid, prompt: q.prompt, wording_version: q.wording_version, kind: q.kind, options: q.options };
    }
    return null;
  }

  /* 밤 점검이 만든 계획(state/qotd.json)이 없을 때의 대체 규칙. */
  function fallbackQid(bank, localDate) {
    var wd = weekdayMon0(localDate), n = Math.floor(ymdToUTC(localDate) / 86400000), plan = bank.plan;
    function pick(list) { return list.length ? list[n % list.length] : null; }
    var today = [], general = [];
    for (var i = 0; i < bank.situational.length; i++) {
      var q = bank.situational[i];
      if (q.status !== 'active') continue;
      (q.kind === 'today' ? today : general).push(q.id);
    }
    if (plan.value_weekdays.indexOf(wd) >= 0) return pick(bank.values.pair_order);
    if (plan.source_weekdays.indexOf(wd) >= 0) return pick(bank.sources);
    if (plan.general_weekdays.indexOf(wd) >= 0) return pick(general);
    return pick(today);
  }

  /* 오늘 보여 줄 질문 목록: [주 질문, 추가 질문...]. answered 는 오늘 이미 답한 qid 목록 */
  function questionsFor(bank, qotdState, localDate, answered) {
    var entry = null, list = [];
    if (qotdState && qotdState.days) {
      for (var i = 0; i < qotdState.days.length; i++) if (qotdState.days[i].date === localDate) entry = qotdState.days[i];
    }
    if (entry) {
      if (entry.qid) list.push(entry.qid);
      for (var j = 0; j < (entry.extras || []).length; j++) list.push(entry.extras[j]);
    } else {
      var f = fallbackQid(bank, localDate);
      if (f) list.push(f);
    }
    var seen = {}, out = [];
    for (var k = 0; k < list.length; k++) {
      if (!seen[list[k]] && questionView(bank, list[k])) { seen[list[k]] = true; out.push(list[k]); }
    }
    for (var a = 0; a < (answered || []).length; a++) if (!seen[answered[a]]) out.unshift(answered[a]);
    return out;
  }

  // ------------------------------------------------------------ 검사 점수 (config/instruments 의 채점표를 따른다)
  function scoreInstrument(inst, answers) {
    var min = inst.scale.min, max = inst.scale.max, facets = {}, domains = {}, total = 0, n = 0;
    for (var i = 0; i < inst.items.length; i++) {
      var it = inst.items[i], v = answers[it.id];
      if (v === undefined || v === null) continue;
      var s = it.key === '-' ? (min + max - v) : v;
      total += s; n++;
      if (it.facet) facets[it.facet] = (facets[it.facet] || 0) + s;
      if (it.domain) domains[it.domain] = (domains[it.domain] || 0) + s;
    }
    return { answered: n, of: inst.items.length, complete: n === inst.items.length, total: total, facets: facets, domains: domains };
  }

  function tokenAgeDays(registered, today) { return registered ? daysBetween(registered, today) : null; }

  /* 철회 기록: 겉봉투의 supersedes 와 target_id 가 같아야 한다 (contracts/retraction.v1). */
  function retractionPayload(targetId, reason) { return { target_id: targetId, reason_ko: reason || null }; }

  /* 파일 이름으로 본 날짜가 today 이거나 today 다음 날인 체크인: 내용을 읽어 local_date 를 확인해야 하는 후보.
   * 어제 기록(recall_lag 1)은 오늘 시각에 저장되므로 이름만으로는 날짜를 알 수 없다. */
  function checkinCandidates(names, dayStart, today) {
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var p = parseRecordName(names[i], dayStart);
      if (p && p.type === 'checkin' && (p.localDate === today || p.localDate === addDays(today, 1))) out.push(p);
    }
    out.sort(function (a, b) { return a.stamp < b.stamp ? -1 : 1; });
    return out;
  }

  return {
    APP_VERSION: APP_VERSION, pad: pad, ymd: ymd, isoLocal: isoLocal, compactStamp: compactStamp, hhmm: hhmm,
    logicalDate: logicalDate, addDays: addDays, daysBetween: daysBetween, weekdayMon0: weekdayMon0, koDateLabel: koDateLabel,
    randHex: randHex, recordId: recordId, recordPath: recordPath, buildRecord: buildRecord,
    checkinPayload: checkinPayload, isCheckinEmpty: isCheckinEmpty, requiredDone: requiredDone,
    parseRecordName: parseRecordName, missedDays: missedDays, formMode: formMode,
    queueAdd: queueAdd, queueRemove: queueRemove,
    utf8ToBase64: utf8ToBase64, base64ToUtf8: base64ToUtf8,
    questionView: questionView, fallbackQid: fallbackQid, questionsFor: questionsFor,
    scoreInstrument: scoreInstrument, tokenAgeDays: tokenAgeDays, yesterdayAllowed: yesterdayAllowed,
    valueSwap: valueSwap, retractionPayload: retractionPayload, checkinCandidates: checkinCandidates, MAX_QUESTIONS: MAX_QUESTIONS
  };
})();
