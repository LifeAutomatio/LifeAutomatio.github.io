/* '나' 탭: 자기 모델(사실, 가치 순위, 원천 지도), 검사 묶음, 프로필 카드.
 * 검사 답은 10문항마다, 그리고 끝날 때 assessment 기록으로 보낸다. 점수는 저장하지 않고 계산한다.
 * 채점 규칙은 config/instruments/*.json 의 key(+/-) 와 facet 을 따르며, 파이썬(lifeauto/assess.py)과 같은 결과를 낸다.
 * 사실·가치·원천은 밤 점검이 만든 파일(self/facts.jsonl, state/values.json, state/sources.json)을 읽어 보여 주기만 한다.
 */
LA.me = (function () {
  'use strict';
  var A = LA.app, C = LA.core, h = A.h, S = A.state;
  var M = { view: 'home', index: null, profile: null, inst: {}, quizId: null, module: null, editing: null };
  var STATUS_KO = { hypothesis: '가설', confirmed: '확인', rejected: '기각', reverify: '재확인 필요', on_hold: '보류' };

  function loadIndex() {
    if (M.index) return Promise.resolve(M.index);
    return Promise.all([fetch('forms/instruments.index.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }),
                        fetch('forms/profile.v1.json', { cache: 'no-cache' }).then(function (r) { return r.json(); })])
      .then(function (res) { M.index = res[0]; M.profile = res[1]; return M.index; });
  }
  function loadInstrument(id) {
    if (M.inst[id]) return Promise.resolve(M.inst[id]);
    return fetch('forms/instruments/' + id + '.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('검사 파일을 불러오지 못했습니다');
      return r.json();
    }).then(function (d) {
      d.items.sort(function (a, b) { return a.order - b.order; });
      M.inst[id] = d; return d;
    });
  }
  function all(id) { return (M.index.battery || []).concat(M.index.quick || []).filter(function (x) { return x.id === id; })[0]; }

  function render(box) {
    loadIndex().then(function () {
      A.clear(box);
      if (M.view === 'quiz') return renderQuiz(box);
      if (M.view === 'result') return renderResult(box, M.quizId);
      if (M.view === 'module') return renderModule(box);
      renderHome(box);
    }, function (e) { box.appendChild(h('p', { class: 'muted', text: String(e.message || e) })); });
  }
  function rerender() { A.renderTab(); window.scrollTo(0, 0); }

  // ------------------------------------------------------------ 첫 화면
  function renderHome(box) {
    box.appendChild(h('div', { class: 'top' }, [h('h1', { text: '나' }), h('span', { id: 'sync-pill', class: 'pill', text: '…' })]));
    if (!A.store.get('mbtiSeen', false) && M.profile.mbti_notice_ko) {
      box.appendChild(h('div', { class: 'card intro' }, [h('p', { text: M.profile.mbti_notice_ko }),
        h('button', { type: 'button', text: '확인', onclick: function () { A.store.set('mbtiSeen', true); rerender(); } })]));
    }
    var grid = h('div', { class: 'grid2' });
    grid.appendChild(deadlinesCard());
    grid.appendChild(factsCard());
    grid.appendChild(valuesCard());
    grid.appendChild(sourcesCard());
    grid.appendChild(assessCard());
    box.appendChild(grid);
    box.appendChild(profileCard());
    box.appendChild(h('p', { class: 'small', text: 'MBTI 같은 자기소개는 측정값이 아니라 자기소개로만 적습니다. 외모 분석은 Claude 에게 사진을 보여 주고 결론만 카드에 옮기세요. 사진은 보관하지 않습니다.' }));
    refreshRemote();
    A.updateStatusPill();
  }

  function refreshRemote() {
    if (M.refreshing) return;
    M.refreshing = true;
    Promise.all([
      A.cacheJSON('state/assessments.json', 'assessments'), A.cacheJSON('state/profile.json', 'profile'),
      A.cacheJSON('registry/deadlines.json', 'registry'),
      A.cacheJSON('state/values.json', 'values'), A.cacheJSON('state/sources.json', 'sources'),
      A.cacheJSON('state/questions.json', 'questions'), A.cacheJSON('state/reviews.json', 'reviews'),
      S.gh.getText('self/facts.jsonl').then(function (r) {
        if (!r.ok || typeof r.text !== 'string') return;
        var facts = [];
        r.text.split('\n').forEach(function (l) { if (l.trim()) { try { facts.push(JSON.parse(l)); } catch (e) { /* 깨진 줄은 건너뜀 */ } } });
        A.store.set('cache.facts', facts);
      })
    ]).then(function () {
      M.refreshing = false;
      if (S.tab === 'me' && M.view === 'home' && !M.refreshed) { M.refreshed = true; rerender(); }
    }, function () { M.refreshing = false; });
  }

  /* 다가오는 기한: 기록 저장소의 registry/deadlines.json (비자, 세금, 자격증). 날짜가 있는 비자 항목은 구글 캘린더에도 있다. */
  function deadlinesCard() {
    var reg = A.store.get('cache.registry', null), today = A.todayLocal();
    var card = h('div', { class: 'card' }, [h('h2', { text: '다가오는 기한' })]);
    if (!reg) { card.appendChild(h('p', { class: 'small', text: '불러오는 중…' })); return card; }
    var STATUS = { to_verify: '확인 필요', to_decide: '결정 필요' };
    function safeLink(u) { return /^https:\/\//.test(String(u || '')) ? u : null; }
    function row(d) {
      var left = d.date ? C.daysBetween(today, d.date) : null;
      var when = d.date ? d.date + ' · ' + (left === 0 ? '오늘' : left + '일 남음') : '날짜 없음';
      var extra = [];
      if (d.note) extra.push(h('p', { class: 'small', text: d.note }));
      if (safeLink(d.source_url)) extra.push(h('a', { class: 'small', href: d.source_url, target: '_blank', rel: 'noopener noreferrer', text: '출처' }));
      return h('div', { class: 'item' }, [
        h('div', { text: d.title }),
        h('div', { class: 'small', text: when + (STATUS[d.status] ? ' · ' + STATUS[d.status] : '') + (d.calendar ? ' · 캘린더에 있음' : '') }),
        extra.length ? h('details', {}, [h('summary', { class: 'small', text: '자세히' })].concat(extra)) : null
      ]);
    }
    var upcoming = (reg.deadlines || []).filter(function (d) { return d.date && d.date >= today; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    upcoming.slice(0, 5).forEach(function (d) { card.appendChild(row(d)); });
    if (!upcoming.length) card.appendChild(h('p', { class: 'small', text: '앞으로 남은 기한이 없습니다.' }));
    var rest = upcoming.slice(5).concat((reg.deadlines || []).filter(function (d) { return !d.date; }));
    var rules = reg.standing_rules || [];
    if (rest.length || rules.length) {
      var more = h('div', {});
      rest.forEach(function (d) { more.appendChild(row(d)); });
      if (rules.length) {
        var ul = h('ul', {});
        rules.forEach(function (r) { ul.appendChild(h('li', { class: 'small', text: r.title })); });
        more.appendChild(h('h3', { text: '늘 지킬 규칙' }));
        more.appendChild(ul);
      }
      card.appendChild(h('details', {}, [h('summary', { text: '전체 보기 · 기한 ' + rest.length + '개 더, 규칙 ' + rules.length + '개' }), more]));
    }
    card.appendChild(h('p', { class: 'small', text: '확인 항목일 뿐 법률·세무 조언이 아닙니다. 날짜가 바뀌면 Claude 에게 말하면 목록과 캘린더를 함께 고칩니다.' }));
    return card;
  }

  /* 나에 대한 사실: 확인, 가설(사실 후보), 재확인 필요. 사실 후보와 재확인은 한 번 눌러 답한다. */
  function factsCard() {
    var facts = A.store.get('cache.facts', []) || [];
    var answered = A.store.get('factAnswers', {});
    var card = h('div', { class: 'card' }, [h('h2', { text: '나에 대한 사실' })]);
    if (!facts.length) {
      card.appendChild(h('p', { class: 'small', text: '아직 없습니다. 검사를 하거나, 리포트의 가설에 답하거나, Claude 에게 말로 불러 주면 쌓입니다.' }));
      return card;
    }
    var ask = facts.filter(function (f) { return (f.status === 'reverify' || f.status === 'hypothesis') && !answered[f.fact_id]; });
    ask.slice(0, 3).forEach(function (f) {
      var opts = f.status === 'reverify' ? [['still_true', '여전히 맞음'], ['changed', '바뀌었음'], ['depends', '상황에 따라 다름']]
                                         : [['yes', '맞음'], ['no', '아님'], ['unsure', '모르겠음']];
      var row = h('div', { class: 'row' });
      opts.forEach(function (o) {
        row.appendChild(h('button', { type: 'button', class: 'opt small', onclick: function () {
          A.enqueueRecord('feedback', { target_kind: 'fact', target_id: f.fact_id, answer: o[0], report_id: null, statement_ko: f.statement_ko.slice(0, 300) },
                          { label: '사실 ' + o[1] + ': ' + f.statement_ko });
          answered[f.fact_id] = o[0]; A.store.set('factAnswers', answered); rerender();
        } }, [h('span', { text: o[1] })]));
      });
      card.appendChild(h('div', { class: 'q' }, [
        h('div', { class: 'small', text: (f.status === 'reverify' ? '다시 확인해 주세요' + (f.contradicted_by ? ' (최근 기록이 반대로 나옴)' : '') : '사실 후보') + ' · ' + f.category_ko }),
        h('div', { class: 'q-title', text: f.statement_ko }), row]));
    });
    var byCat = {};
    facts.forEach(function (f) { (byCat[f.category_ko] = byCat[f.category_ko] || []).push(f); });
    var list = h('div', {});
    Object.keys(byCat).forEach(function (cat) {
      var ul = h('ul', {});
      byCat[cat].forEach(function (f) {
        ul.appendChild(h('li', { class: 'small', text: '[' + STATUS_KO[f.status] + (f.locked_by_user ? ' · 본인 확인' : '') + '] ' + f.statement_ko + (f.condition_ko ? ' (조건: ' + f.condition_ko + ')' : '') }));
      });
      list.appendChild(h('div', {}, [h('h3', { text: cat }), ul]));
    });
    card.appendChild(h('details', {}, [h('summary', { text: '모두 보기 · ' + facts.length + '건' }), list]));
    return card;
  }

  /* 가치 순위: 45쌍 한 바퀴를 모두 답하면 9번 중 이긴 횟수와 일관성. 일관성 0.5 미만이면 세 묶음. */
  function valuesCard() {
    var v = A.store.get('cache.values', null);
    var card = h('div', { class: 'card' }, [h('h2', { text: '가치 순위' })]);
    if (!v) { card.appendChild(h('p', { class: 'small', text: '월·수·금·토의 가치 질문에 답하면 쌓입니다.' })); return card; }
    var labels = v.labels || {};
    var shown = v.complete ? v : v.last_complete;
    var pct = Math.round(100 * v.answered / (v.total || 45));
    var bar = h('div', { class: 'bar' }, [h('i', {})]); bar.firstChild.style.width = pct + '%';
    card.appendChild(h('p', { class: 'small', text: (v.round_index ? (v.round_index + 1) + '번째 바퀴 · ' : '') + v.answered + '/' + v.total + '쌍 답함' + (v.complete ? '' : ' · 한 바퀴를 모두 답하면 순위가 열립니다') }));
    card.appendChild(bar);
    if (shown && shown.ranking) {
      if (shown.groups) {
        card.appendChild(h('p', { class: 'small', text: '답의 일관성이 ' + shown.consistency.toFixed(1) + '(0.5 미만)이라 순위 대신 세 묶음으로 봅니다.' }));
        ['위', '가운데', '아래'].forEach(function (name, i) {
          card.appendChild(h('p', { text: name + ': ' + shown.groups[i].map(function (c) { return labels[c] || c; }).join(', ') }));
        });
      } else {
        var ol = h('ol', {});
        shown.ranking.forEach(function (c) { ol.appendChild(h('li', { text: (labels[c] || c) + ' · ' + shown.wins[c] + '승' })); });
        card.appendChild(ol);
        card.appendChild(h('p', { class: 'small', text: '9번 중 이긴 횟수 · 일관성 ' + shown.consistency.toFixed(1) + (shown.repeats && shown.repeats.asked ? ' · 다시 물은 ' + shown.repeats.asked + '쌍 중 ' + shown.repeats.same + '쌍 같은 답' : '') }));
      }
      if (!v.complete) card.appendChild(h('p', { class: 'small', text: '지난 바퀴 결과입니다. 새 바퀴가 진행 중입니다.' }));
    }
    if (v.confirmed_drift && v.confirmed_drift.length) {
      card.appendChild(h('p', { class: 'small', text: '두 바퀴 넘게 이어진 변화: ' + v.confirmed_drift.map(function (c) { return labels[c] || c; }).join(', ') }));
    }
    card.appendChild(h('p', { class: 'small', text: '다른 사람과 비교하는 점수가 아니라 나의 순위입니다.' }));
    return card;
  }

  /* 스트레스와 행복의 원천 지도 (최근 90일). 28일 원천 실험은 1년에 두 번까지. */
  function sourcesCard() {
    var s = A.store.get('cache.sources', null), q = A.store.get('cache.questions', null);
    var card = h('div', { class: 'card' }, [h('h2', { text: '스트레스와 행복의 원천' })]);
    var maps = (s && s.last_90_days) || [];
    var any = maps.some(function (m) { return m.answered > 0; });
    if (!any) card.appendChild(h('p', { class: 'small', text: '처음 8주는 화·목에 원천 질문을 묻습니다. 답이 쌓이면 여기에 원천별 횟수와 그날의 기분이 보입니다.' }));
    maps.forEach(function (m) {
      if (!m.answered) return;
      var ul = h('ul', {});
      m.cells.filter(function (c) { return c.count > 0; }).sort(function (a, b) { return b.count - a.count; }).forEach(function (c) { ul.appendChild(h('li', { class: 'small', text: c.display_ko })); });
      card.appendChild(h('details', {}, [h('summary', { text: m.prompt + ' · 답 ' + m.answered + '번' }), ul]));
    });
    if (q) {
      var active = q.experiment_active, exps = q.experiments || [];
      var pending = A.store.get('expPending', null);
      if (pending && exps.some(function (e) { return e.start === pending; })) A.store.set('expPending', null);   // 밤 점검이 반영함
      var cur = exps.filter(function (e) { return e.start <= A.todayLocal() && A.todayLocal() <= e.end; })[0];
      if (active && cur) {
        card.appendChild(h('div', { class: 'notice ok', text: '원천 실험 중입니다 (' + cur.start + ' ~ ' + cur.end + '). 이 기간에는 매일 원천 질문을 묻습니다.' }));
        card.appendChild(h('button', { type: 'button', class: 'link', text: '실험 멈추기', onclick: function () {
          if (!confirm('원천 실험을 멈출까요?')) return;
          A.enqueueRecord('setting', { key: 'experiment', value: { active: false } }); A.store.set('expPending', null); rerender();
        } }));
      } else if (A.store.get('expPending', null)) {
        card.appendChild(h('p', { class: 'small', text: '실험 시작을 보냈습니다. 다음 밤 점검부터 매일 원천 질문이 나옵니다.' }));
      } else if (q.experiments_left_this_year > 0 && !q.in_source_weeks) {
        var days = h('select', {}, [28, 56].map(function (n) { return h('option', { value: n, text: n + '일' }); }));
        card.appendChild(h('p', { class: 'small', text: '더 빨리 알고 싶으면 질문 칸을 일정 기간 원천 질문에만 쓰는 실험을 합니다. 올해 ' + q.experiments_left_this_year + '번 남음.' }));
        card.appendChild(h('div', { class: 'row' }, [days, h('button', { type: 'button', text: '원천 실험 시작', onclick: function () {
          var start = C.addDays(A.todayLocal(), 1);
          A.enqueueRecord('setting', { key: 'experiment', value: { active: true, kind: 'sources', days: parseInt(days.value, 10), start: start } });
          A.store.set('expPending', start); rerender();
        } })]));
      }
    }
    return card;
  }

  function assessCard() {
    var remote = A.store.get('cache.assessments', null), rev = A.store.get('cache.reviews', null) || S.reviews;
    var due = ((rev && rev.assessments_due) || []).map(function (a) { return a.instrument; });
    var card = h('div', { class: 'card' }, [h('h2', { text: '검사 묶음' }),
      h('p', { class: 'small', text: '처음 한 번과 매년 1월에 합니다. 나눠서 해도 되고, 중간에 멈추면 이어서 합니다.' })]);
    var batteryDue = M.index.battery.filter(function (b) { return due.indexOf(b.id) >= 0; });
    var anyDone = remote && remote.instruments && Object.keys(remote.instruments).length;
    if (anyDone && batteryDue.length) card.appendChild(h('div', { class: 'notice ok', text: '다시 할 때가 된 검사가 ' + batteryDue.length + '개 있습니다. 지난 결과와 나란히 봅니다.' }));
    M.index.battery.concat(M.index.quick).forEach(function (b) {
      var st = A.store.get('assess.' + b.id, null), line;
      var done = st && st.completedAt, n = st ? Object.keys(st.answers || {}).length : 0;
      var remoteLast = remote && remote.instruments && remote.instruments[b.id] && remote.instruments[b.id].filter(function (x) { return x.completed_at; })[0];
      if (done) line = '완료 ' + C.ymd(new Date(st.completedAt));
      else if (n) line = '진행 중 · ' + n + '문항 답함';
      else if (remoteLast) line = '완료 ' + String(remoteLast.completed_at || '').slice(0, 10) + ' (다른 기기)';
      else line = '약 ' + b.minutes + '분';
      card.appendChild(h('div', { class: 'row spread item' }, [
        h('div', {}, [h('div', { text: b.title_ko }), h('div', { class: 'small', text: line })]),
        h('div', { class: 'row' }, [
          (done || remoteLast) ? h('button', { type: 'button', text: '결과', onclick: function () { M.quizId = b.id; M.view = 'result'; rerender(); } }) : null,
          h('button', { type: 'button', text: done || remoteLast ? '다시 하기' : (n ? '이어서' : '시작'), onclick: function () {
            if ((done || remoteLast) && !confirm('새로 검사할까요? 지난 결과는 기록에 남아 나란히 봅니다.')) return;
            if (done) A.store.del('assess.' + b.id);
            M.quizId = b.id; M.view = 'quiz'; rerender();
          } })
        ])
      ]));
    });
    (M.index.disabled || []).forEach(function (d) { card.appendChild(h('p', { class: 'small', text: d.reason_ko })); });
    return card;
  }

  function profileCard() {
    var pc = h('div', { class: 'card' }, [h('h2', { text: '프로필 카드' }),
      h('p', { class: 'small', text: '잘 안 바뀌는 사실과 취향을 적어 둡니다. 고치면 새 카드가 옛 카드를 대신하고 이력은 남습니다.' })]);
    var cards = currentCards();
    var grid = h('div', { class: 'opts c3' });
    M.profile.modules.forEach(function (m) {
      var count = cards.filter(function (c) { return c.payload.module === m.module; }).length;
      grid.appendChild(h('button', { type: 'button', class: 'opt', onclick: function () { M.module = m.module; M.view = 'module'; M.editing = null; rerender(); } },
        [h('span', { text: m.title_ko }), h('span', { class: 'lab', text: count ? count + '장' : m.card })]));
    });
    pc.appendChild(grid);
    return pc;
  }

  // ------------------------------------------------------------ 검사
  function quizState(id) {
    var st = A.store.get('assess.' + id, null);
    if (!st) st = { session: 's-' + A.todayLocal() + '-' + C.randHex(4), answers: {}, rts: {}, shown: {}, saved: [], startedAt: Date.now(), completedAt: null };
    return st;
  }

  function saveChunk(id, inst, st, complete) {
    var pending = inst.items.filter(function (it) { return st.answers[it.id] !== undefined && st.saved.indexOf(it.id) < 0; });
    if (!pending.length && !complete) return;
    A.enqueueRecord('assessment', {
      instrument: inst.instrument, instrument_version: inst.version, session_id: st.session, complete: !!complete,
      items: pending.map(function (it) { return { id: it.id, value: st.answers[it.id], shown: (st.shown[it.id] || '').slice(0, 300), rt_ms: st.rts[it.id] || null }; })
    });
    pending.forEach(function (it) { st.saved.push(it.id); });
    A.store.set('assess.' + id, st);
  }

  function renderQuiz(box) {
    var id = M.quizId, meta = all(id);
    box.appendChild(h('p', { class: 'muted', text: '불러오는 중…' }));
    loadInstrument(id).then(function (inst) {
      A.clear(box);
      var st = quizState(id);
      var idx = 0;
      while (idx < inst.items.length && st.answers[inst.items[idx].id] !== undefined) idx++;
      if (M.back !== undefined && M.back !== null) { idx = M.back; M.back = null; }
      if (idx >= inst.items.length) {
        saveChunk(id, inst, st, true);
        st.completedAt = Date.now(); A.store.set('assess.' + id, st);
        M.view = 'result'; return rerender();
      }
      var it = inst.items[idx], shownText = it.ko_alt || it.ko, t0 = Date.now();
      var pct = Math.round(100 * idx / inst.items.length);
      var bar = h('div', { class: 'bar' }, [h('i', {})]);
      bar.firstChild.style.width = pct + '%';
      var opts = h('div', { class: 'opts c1' });
      for (var v = inst.scale.min; v <= inst.scale.max; v++) {
        (function (v) {
          var label = inst.scale.labels_ko[v - inst.scale.min];
          opts.appendChild(h('button', { type: 'button', class: 'opt', 'aria-pressed': st.answers[it.id] === v ? 'true' : 'false', onclick: function () {
            st.answers[it.id] = v; st.rts[it.id] = Math.min(3600000, Date.now() - t0); st.shown[it.id] = shownText;
            var i = st.saved.indexOf(it.id); if (i >= 0) st.saved.splice(i, 1);   // 고친 답은 다시 보낸다
            A.store.set('assess.' + id, st);
            if (Object.keys(st.answers).length % 10 === 0) saveChunk(id, inst, st, false);
            rerender();
          } }, [h('span', { text: label })]));
        })(v);
      }
      box.appendChild(h('div', { class: 'top' }, [h('div', {}, [h('div', { class: 'small', text: meta.title_ko }), h('h1', { text: (idx + 1) + ' / ' + inst.items.length })]),
        h('span', { id: 'sync-pill', class: 'pill', text: '…' })]));
      box.appendChild(bar);
      // 안내문은 모든 문항에서 같은 자리에 둔다. 버튼 위치가 바뀌지 않아야 연속으로 누르기 쉽다
      box.appendChild(h('p', { class: 'small', text: (inst.time_frame_ko ? inst.time_frame_ko + ' · ' : '') + (meta.intro_ko || inst.instructions_ko) }));
      box.appendChild(h('div', { class: 'card' }, [h('p', { text: shownText }), h('p', { class: 'small', text: it.en }), opts]));
      box.appendChild(h('div', { class: 'row spread' }, [
        h('button', { type: 'button', class: 'link', text: '이전', disabled: idx === 0 ? true : null, onclick: function () { M.back = idx - 1; rerender(); } }),
        h('button', { type: 'button', class: 'link', text: '나중에 이어서', onclick: function () { saveChunk(id, inst, st, false); M.view = 'home'; rerender(); } })
      ]));
      if (meta.credit) box.appendChild(h('p', { class: 'small', text: meta.credit }));
      A.updateStatusPill();
    }, function (e) { A.clear(box).appendChild(h('p', { class: 'muted', text: String(e.message || e) })); });
  }

  function band3(mean, min, max) {
    var third = (max - min) / 3;
    return mean < min + third ? '낮은 편' : (mean > max - third ? '높은 편' : '중간');
  }

  /* 끝낸 검사들 (최신 먼저, 최대 3번). 이 기기의 방금 끝낸 결과가 아직 밤 점검에 반영되지 않았으면 맨 앞에 둔다. */
  function sessionsFor(id, inst) {
    var out = [];
    var st = A.store.get('assess.' + id, null);
    var remote = A.store.get('cache.assessments', null);
    var list = ((remote && remote.instruments && remote.instruments[id]) || []).filter(function (x) { return x.completed_at; });
    if (st && st.completedAt && !list.some(function (x) { return x.session_id === st.session; })) {
      out.push({ label: C.ymd(new Date(st.completedAt)) + ' (이 기기)', scores: C.scoreInstrument(inst, st.answers) });
    }
    list.forEach(function (x) { out.push({ label: String(x.completed_at).slice(0, 10), scores: x.scores }); });
    if (!out.length && st && Object.keys(st.answers || {}).length) out.push({ label: '진행 중', scores: C.scoreInstrument(inst, st.answers) });
    return out.slice(0, 3);
  }

  function renderResult(box, id) {
    var meta = all(id);
    loadInstrument(id).then(function (inst) {
      A.clear(box);
      box.appendChild(h('div', { class: 'top' }, [h('h1', { text: meta.title_ko })]));
      var sessions = sessionsFor(id, inst);
      if (!sessions.length) { box.appendChild(h('p', { class: 'muted', text: '결과가 없습니다.' })); return; }
      var score = sessions[0].scores;
      var card = h('div', { class: 'card' });
      var doms = inst.domains || {};
      if (Object.keys(doms).length) {
        var perDomain = inst.items.length / Object.keys(doms).length;
        Object.keys(doms).forEach(function (dk) {
          var sum = score.domains[dk]; if (sum === undefined) return;
          var mean = sum / perDomain, pct = Math.round(100 * (mean - inst.scale.min) / (inst.scale.max - inst.scale.min));
          var bar = h('div', { class: 'bar' }, [h('i', {})]); bar.firstChild.style.width = pct + '%';
          card.appendChild(h('div', { class: 'q' }, [h('div', { class: 'row spread' }, [h('strong', { text: doms[dk].ko }), h('span', { class: 'small', text: band3(mean, inst.scale.min, inst.scale.max) + ' · 평균 ' + mean.toFixed(1) + ' / ' + inst.scale.max })]), bar]));
        });
        box.appendChild(card);
        if (sessions.length > 1) box.appendChild(historyTable(sessions, Object.keys(doms).map(function (dk) {
          return [doms[dk].ko, function (sc) { return sc.domains[dk] === undefined ? '-' : (sc.domains[dk] / perDomain).toFixed(1); }];
        })));
        if (inst.facets && Object.keys(inst.facets).length) {
          var tbl = h('table', { class: 't' });
          Object.keys(inst.facets).forEach(function (fk) {
            var f = inst.facets[fk], sum = score.facets[fk]; if (sum === undefined) return;
            tbl.appendChild(h('tr', {}, [h('th', { text: doms[f.domain].ko + ' · ' + f.ko }), h('td', { text: (sum / 4).toFixed(1) + ' (' + band3(sum / 4, inst.scale.min, inst.scale.max) + ')' })]));
          });
          box.appendChild(h('details', {}, [h('summary', { text: '세부 특성 30가지' }), tbl]));
        }
        if (/^(ipip|mini_ipip)/.test(id)) box.appendChild(h('p', { class: 'small', text: 'IPIP 는 공식 규준(다른 사람과의 비교표)을 제공하지 않습니다. 그래서 여기서는 문항 척도 안에서의 위치(낮은 편·중간·높은 편)만 보여 주고, 해마다 나의 변화를 봅니다.' }));
      } else if (id === 'who5') {
        var pct5 = score.total * 4;
        card.appendChild(h('p', {}, [h('strong', { text: '안녕감 ' + pct5 + ' / 100' })]));
        card.appendChild(h('p', { class: 'small', text: '공개 기준(참고): WHO 는 50 미만을 추가 확인이 필요한 신호로 봅니다. 진단 기준이 아닙니다.' }));
        if (pct5 < 50) card.appendChild(h('div', { class: 'notice', text: '최근 2주 안녕감이 낮게 나왔습니다. 이것은 진단이 아닙니다. 필요하면 믿을 만한 사람이나 전문가와 이야기해 보세요. 위급할 때: 미국 988, 한국 109.' }));
        box.appendChild(card);
        if (sessions.length > 1) box.appendChild(historyTable(sessions, [['안녕감', function (sc) { return String(sc.total * 4); }]]));
      } else {
        var bandName = '';
        ((inst.scoring && inst.scoring.bands) || []).forEach(function (b) { if (score.total >= b.min && score.total <= b.max) bandName = b.ko; });
        card.appendChild(h('p', {}, [h('strong', { text: '합계 ' + score.total + ' (' + (inst.scale.min * inst.items.length) + '~' + (inst.scale.max * inst.items.length) + ')' })]));
        if (bandName) card.appendChild(h('p', { class: 'small', text: '공개 구간(참고, 저자 제시): ' + bandName }));
        else card.appendChild(h('p', { class: 'small', text: '이 검사에는 공개된 기준이 없습니다. 해마다 나의 변화만 봅니다.' }));
        box.appendChild(card);
        if (sessions.length > 1) box.appendChild(historyTable(sessions, [['합계', function (sc) { return String(sc.total); }]]));
      }
      box.appendChild(h('p', { class: 'small', text: M.index.result_note_ko }));
      box.appendChild(h('button', { type: 'button', class: 'link', text: '← 나', onclick: function () { M.view = 'home'; rerender(); } }));
    });
  }

  function historyTable(sessions, rows) {
    var tbl = h('table', { class: 't' });
    tbl.appendChild(h('tr', {}, [h('th', { text: '' })].concat(sessions.map(function (s) { return h('th', { text: s.label }); }))));
    rows.forEach(function (r) {
      tbl.appendChild(h('tr', {}, [h('th', { text: r[0] })].concat(sessions.map(function (s) { return h('td', { text: r[1](s.scores) }); }))));
    });
    return h('div', { class: 'card' }, [h('h2', { text: '지난 결과와 나란히' }), tbl]);
  }

  // ------------------------------------------------------------ 프로필 카드
  function currentCards() {
    var remote = A.store.get('cache.profile', null), byId = {};
    ((remote && remote.cards) || []).forEach(function (c) { byId[c.payload.item_id] = c; });
    var local = A.store.get('profileLocal', {});
    Object.keys(local).forEach(function (k) {
      var l = local[k], r = byId[k];
      if (!r || l.captured_at > r.captured_at) byId[k] = l;
    });
    return Object.keys(byId).map(function (k) { return byId[k]; }).filter(function (c) { return c.payload.status === 'active'; });
  }

  function cardTitle(mod, attrs) {
    if (mod.title_fixed) return mod.title_fixed;
    var parts = (mod.title_fields || []).map(function (k) { return attrs[k]; }).filter(Boolean);
    return parts.join(' ') || mod.title_ko;
  }

  /* 구글맵 링크: 붙여 넣은 공유 링크 > 저장한 위치 > 이름과 동네로 검색. API 키가 필요 없는 공식 지도 주소 형식만 쓴다. */
  var MAPS_OK = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps)\//;
  function mapsSearch(q) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q); }
  function mapLink(map, attrs) {
    var url = String(attrs[map.url] || '').trim();
    if (MAPS_OK.test(url)) return url;
    var geo = String(attrs[map.geo] || '');
    if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(geo)) return mapsSearch(geo);
    var name = String(attrs[map.name] || '').trim();
    if (!name) return null;
    var area = (map.area || []).map(function (k) { return attrs[k]; }).filter(Boolean)[0] || '';
    return mapsSearch(name + (area ? ' ' + area : ''));
  }

  function fieldVisible(f, attrs) {
    if (!f.show_if) return true;
    return Object.keys(f.show_if).every(function (k) { return f.show_if[k].indexOf(attrs[k]) >= 0; });
  }

  function renderModule(box) {
    var mod = M.profile.modules.filter(function (m) { return m.module === M.module; })[0];
    box.appendChild(h('div', { class: 'top' }, [h('h1', { text: mod.title_ko }), h('span', { id: 'sync-pill', class: 'pill', text: '…' })]));
    var cards = currentCards().filter(function (c) { return c.payload.module === mod.module; });
    if (M.editing !== null) { box.appendChild(cardForm(mod, M.editing)); A.updateStatusPill(); return; }
    if (mod.note_ko) box.appendChild(h('p', { class: 'small', text: mod.note_ko }));
    var CONF = { low: '확신 낮음', medium: '확신 중간', high: '확신 높음' };
    var EV = {};
    M.profile.evidence.forEach(function (e) { EV[e.value] = e.label; });
    cards.forEach(function (c) {
      var p = c.payload, attrs = p.attributes || {}, lines = [];
      mod.fields.forEach(function (f) {
        var v = attrs[f.key];
        if (!v || (Array.isArray(v) && !v.length) || !fieldVisible(f, attrs)) return;
        if (f.type === 'location' || (mod.map && f.key === mod.map.url)) return;   // 지도 링크로 보여 준다
        lines.push(f.label + ': ' + (Array.isArray(v) ? v.join(', ') : v));
      });
      var mapHref = mod.map ? mapLink(mod.map, attrs) : null;
      if (p.liked) lines.push('좋아함 ' + p.liked + '/5');
      if (p.suits) lines.push('어울림 ' + p.suits + '/5');
      if (p.confidence) lines.push(CONF[p.confidence]);
      if (p.evidence && p.evidence.length) lines.push('근거: ' + p.evidence.map(function (e) { return EV[e] || e; }).join(', '));
      var ai = (p.evidence || []).indexOf('ai') >= 0;
      box.appendChild(h('div', { class: 'card' }, [h('h2', { text: p.title }),
        ai ? h('span', { class: 'pill warn', text: 'AI 분석 포함 · 참고용' }) : null,
        h('p', { class: 'small', text: lines.join(' · ') }), p.notes ? h('p', { class: 'small', text: p.notes }) : null,
        h('div', { class: 'row' }, [
          mapHref ? h('a', { class: 'small', href: mapHref, target: '_blank', rel: 'noopener noreferrer', text: '구글맵에서 보기' }) : null,
          h('button', { type: 'button', class: 'link', text: '고치기', onclick: function () { M.editing = c; rerender(); } })])]));
    });
    if (!cards.length) box.appendChild(h('p', { class: 'muted', text: '아직 카드가 없습니다.' }));
    if (!(mod.single && cards.length)) box.appendChild(h('button', { type: 'button', class: 'primary', text: '카드 추가', onclick: function () { M.editing = false; rerender(); } }));
    else box.appendChild(h('p', { class: 'small', text: '요약 한 장만 두는 영역입니다. 바뀌면 위 카드를 고치세요.' }));
    box.appendChild(h('button', { type: 'button', class: 'link', text: '← 나', onclick: function () { M.view = 'home'; rerender(); } }));
    A.updateStatusPill();
  }

  function cardForm(mod, existing) {
    var p = existing ? existing.payload : { attributes: {}, evidence: [] }, attrs = JSON.parse(JSON.stringify(p.attributes || {})), inputs = {};
    var form = h('div', { class: 'card' }, [h('h2', { text: existing ? '카드 고치기' : '새 카드' })]);
    var wraps = {};
    function refresh() {
      mod.fields.forEach(function (f) { if (wraps[f.key]) wraps[f.key].className = 'field' + (fieldVisible(f, attrs) ? '' : ' hidden'); });
    }
    mod.fields.forEach(function (f) {
      var el;
      if (f.type === 'select') {
        el = h('select', {}, [h('option', { value: '', text: '—' })].concat(f.options.map(function (o) { return h('option', { value: o, text: o, selected: attrs[f.key] === o ? true : null }); })));
        el.addEventListener('change', function () { attrs[f.key] = el.value; refresh(); });
      } else if (f.type === 'multi') {
        el = h('div', { class: 'opts c4' });
        var chosen = (attrs[f.key] || []).slice();
        f.options.forEach(function (o) {
          el.appendChild(h('button', { type: 'button', class: 'opt', 'aria-pressed': chosen.indexOf(o) >= 0 ? 'true' : 'false', onclick: function (ev) {
            var i = chosen.indexOf(o); if (i >= 0) chosen.splice(i, 1); else chosen.push(o);
            ev.currentTarget.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
          } }, [h('span', { text: o })]));
        });
        el.getValue = function () { return chosen; };
      } else if (f.type === 'date') {
        el = h('input', { type: 'date' });
        el.value = attrs[f.key] || '';
      } else if (f.type === 'location') {
        // 폰의 위치를 한 번 읽어 '위도,경도' 글자로 저장한다. 사진처럼 계속 추적하지 않는다
        var geoVal = attrs[f.key] || '';
        var geoText = h('span', { class: 'small', text: geoVal ? '위치 저장됨' : '저장 안 됨' });
        var geoBtn = h('button', { type: 'button', text: '지금 위치 저장', onclick: function () {
          if (!navigator.geolocation) { geoText.textContent = '이 브라우저는 위치를 알려 주지 않습니다'; return; }
          geoText.textContent = '위치 확인 중…';
          navigator.geolocation.getCurrentPosition(function (pos) {
            geoVal = pos.coords.latitude.toFixed(5) + ',' + pos.coords.longitude.toFixed(5);
            geoText.textContent = '위치 저장됨 (정확도 약 ' + Math.round(pos.coords.accuracy) + 'm)';
          }, function () { geoText.textContent = '위치를 읽지 못했습니다. 위치 권한을 확인하세요'; },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
        } });
        var geoClear = h('button', { type: 'button', class: 'link small', text: '지우기', onclick: function () { geoVal = ''; geoText.textContent = '저장 안 됨'; } });
        el = h('div', { class: 'row' }, [geoBtn, geoText, geoClear]);
        el.getValue = function () { return geoVal; };
      } else {
        el = h('input', { type: 'text', maxlength: 200, placeholder: f.placeholder || '' });
        el.value = attrs[f.key] || '';
      }
      inputs[f.key] = el;
      wraps[f.key] = h('label', { class: 'field' }, [h('span', { text: f.label }), el]);
      form.appendChild(wraps[f.key]);
    });
    refresh();
    if (mod.map) {
      form.appendChild(h('button', { type: 'button', class: 'link small', text: '구글맵에서 찾기', onclick: function () {
        var cur = {};
        mod.fields.forEach(function (f) { if (inputs[f.key] && !inputs[f.key].getValue) cur[f.key] = inputs[f.key].value.trim(); });
        var link = mapLink(mod.map, cur);
        if (link) window.open(link, '_blank', 'noopener');
      } }));
      form.appendChild(h('p', { class: 'small', text: '찾은 가게의 공유 링크를 복사해 구글맵 링크 칸에 붙여 넣으면 다음부터 바로 그 가게가 열립니다.' }));
    }
    function scaleSel(label, cur) {
      return h('select', { 'aria-label': label }, [h('option', { value: '', text: label + ' —' })].concat([1, 2, 3, 4, 5].map(function (v) { return h('option', { value: v, text: label + ' ' + v, selected: cur === v ? true : null }); })));
    }
    var liked = mod.liked ? scaleSel('좋아함', p.liked) : null, suits = mod.suits ? scaleSel('어울림', p.suits) : null;
    var conf = h('select', { 'aria-label': '확신' }, [h('option', { value: '', text: '확신 —' })].concat(M.profile.confidence.map(function (o) { return h('option', { value: o.value, text: o.label, selected: p.confidence === o.value ? true : null }); })));
    form.appendChild(h('div', { class: 'row' }, [liked, suits, conf]));
    var ev = h('div', { class: 'opts c4' }), evChosen = (p.evidence || []).slice();
    M.profile.evidence.forEach(function (o) {
      ev.appendChild(h('button', { type: 'button', class: 'opt', 'aria-pressed': evChosen.indexOf(o.value) >= 0 ? 'true' : 'false', onclick: function (e2) {
        var i = evChosen.indexOf(o.value); if (i >= 0) evChosen.splice(i, 1); else evChosen.push(o.value);
        e2.currentTarget.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
      } }, [h('span', { text: o.label })]));
    });
    form.appendChild(h('label', { class: 'field' }, [h('span', { text: '근거' }), ev]));
    form.appendChild(h('p', { class: 'small', text: M.profile.ai_note_ko }));
    var notes = h('textarea', { maxlength: 2000, placeholder: '메모' }); notes.value = p.notes || '';
    form.appendChild(notes);
    var msg = h('p', { class: 'small' });
    form.appendChild(msg);
    function save(status) {
      var a = {};
      mod.fields.forEach(function (f) {
        var v = inputs[f.key].getValue ? inputs[f.key].getValue() : inputs[f.key].value.trim();
        if (v && (!Array.isArray(v) || v.length) && fieldVisible(f, attrs)) a[f.key] = v;
      });
      if (!Object.keys(a).length && !notes.value.trim()) { msg.textContent = '한 칸 이상 채워 주세요.'; return; }
      var payload = {
        item_id: existing ? p.item_id : mod.module + '.' + C.randHex(6), module: mod.module, title: cardTitle(mod, a).slice(0, 100),
        attributes: a, liked: liked && liked.value ? parseInt(liked.value, 10) : null, suits: suits && suits.value ? parseInt(suits.value, 10) : null,
        evidence: evChosen, confidence: conf.value || null, notes: notes.value.trim() || null, status: status
      };
      var rec = A.enqueueRecord('profile_item', payload, { supersedes: existing ? existing.id : null });
      var local = A.store.get('profileLocal', {}); local[payload.item_id] = rec; A.store.set('profileLocal', local);
      M.editing = null; rerender();
    }
    form.appendChild(h('button', { type: 'button', class: 'primary', text: '저장', onclick: function () { save('active'); } }));
    form.appendChild(h('div', { class: 'row spread' }, [
      h('button', { type: 'button', class: 'link', text: '취소', onclick: function () { M.editing = null; rerender(); } }),
      existing ? h('button', { type: 'button', class: 'link danger', text: '이 카드 내리기', onclick: function () { if (confirm('카드를 내릴까요? 이력은 남습니다.')) save('retired'); } }) : null
    ]));
    return form;
  }

  return { render: render };
})();
