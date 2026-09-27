/* 뉴스 탭과 리포트 탭. 저장소에서 읽은 글은 모두 textContent 로만 넣는다. */
LA.views = (function () {
  'use strict';
  var A = LA.app, C = LA.core, h = A.h, S = A.state;

  function latestFile(dirs, suffix) {
    return Promise.all(dirs.map(function (d) { return S.gh.listDir(d); })).then(function (lists) {
      var names = [];
      lists.forEach(function (l, i) {
        (l.items || []).forEach(function (x) { if (x.type === 'file' && x.name.slice(-suffix.length) === suffix) names.push(dirs[i] + '/' + x.name); });
      });
      names.sort();
      return names.length ? names[names.length - 1] : null;
    });
  }

  // ------------------------------------------------------------ 뉴스
  function renderNews(box) {
    box.appendChild(h('div', { class: 'top' }, [h('h1', { text: '아침 브리핑' }), h('span', { id: 'sync-pill', class: 'pill', text: '…' })]));
    var body = h('div', {});
    box.appendChild(body);
    var cached = A.store.get('cache.briefing', null);
    if (cached) drawBriefing(body, cached);
    else body.appendChild(h('p', { class: 'muted', text: '불러오는 중…' }));
    var today = A.todayLocal();
    var dirs = A.monthDirs(today, 1).map(function (m) { return 'briefings/' + m; });
    latestFile(dirs, '.json').then(function (path) {
      if (!path) { A.clear(body).appendChild(h('div', { class: 'card' }, [h('p', { text: '아직 브리핑이 없습니다.' }), h('p', { class: 'small', text: '매일 아침 6시 전후에 만들어져 알림으로 옵니다.' })])); return; }
      return S.gh.getJSON(path).then(function (r) {
        if (!r.ok || !r.data) return;
        A.store.set('cache.briefing', r.data);
        if (S.tab === 'news') drawBriefing(A.clear(body), r.data);
      });
    });
    A.updateStatusPill();
  }

  function drawBriefing(body, b) {
    var when = b.generated_at ? new Date(b.generated_at) : null;
    body.appendChild(h('p', { class: 'muted', text: C.koDateLabel(b.date) + (when ? ' · ' + C.hhmm(when) + ' 작성' : '') }));
    if (b.headline_ko) body.appendChild(h('div', { class: 'card' }, [h('strong', { text: b.headline_ko })]));
    if (b.status === 'titles_only') {
      var off = b.llm && b.llm.off;
      body.appendChild(h('div', { class: 'notice', text: off ? 'AI 요약을 끈 상태라 원문 제목만 보여 줍니다.' : '오늘은 요약을 만들지 못해 원문 제목만 보여 줍니다.' }));
    }
    if (b.status === 'empty') body.appendChild(h('div', { class: 'notice', text: '지난 브리핑 이후 새 기사가 없습니다.' }));
    else if (b.few_articles) body.appendChild(h('div', { class: 'notice ok', text: '새 기사가 적은 날입니다. 고를 수 있는 기사만 담았습니다.' }));
    var grid = h('div', { class: 'grid2' });
    (b.sections || []).forEach(function (sec) {
      if (!sec.items || !sec.items.length) return;
      var card = h('div', { class: 'card' }, [h('h2', { text: sec.title_ko })]);
      sec.items.forEach(function (it) {
        var src = h('div', { class: 'src' });
        (it.sources || []).forEach(function (s) {
          if (!/^https?:\/\//.test(s.url)) return;
          src.appendChild(h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.name }));
        });
        card.appendChild(h('div', { class: 'news-item' }, [
          h('div', { class: 't', text: it.title }),
          it.summary ? h('div', { class: 's', text: it.summary }) : null,
          it.why ? h('div', { class: 'w', text: '→ ' + it.why }) : null,
          src
        ]));
      });
      grid.appendChild(card);
    });
    body.appendChild(grid);
    var failed = (b.feeds || []).filter(function (f) { return f.status !== 'ok'; }).map(function (f) { return f.name; });
    if (failed.length) body.appendChild(h('p', { class: 'small', text: '수집 실패: ' + failed.join(', ') }));
    if (b.llm && b.llm.model) body.appendChild(h('p', { class: 'small', text: '요약: ' + (b.llm.served_model || b.llm.model) + ' · 원문에 있는 내용만 옮기도록 지시했지만 틀릴 수 있습니다. 중요한 내용은 원문을 확인하세요.' }));
  }

  // ------------------------------------------------------------ 리포트
  function renderReport(box) {
    box.appendChild(h('div', { class: 'top' }, [h('h1', { text: '리포트' }), h('span', { id: 'sync-pill', class: 'pill', text: '…' })]));
    var body = h('div', {});
    box.appendChild(body);
    var cached = A.store.get('cache.report', null);
    if (cached) drawReport(body, cached);
    else drawMaturity(body);
    var y = A.todayLocal().slice(0, 4);
    latestFile(['journal/weekly/' + y, 'journal/weekly/' + (+y - 1)], '.json').then(function (path) {
      if (!path) { if (S.tab === 'report') drawMaturity(A.clear(body)); return; }
      return S.gh.getJSON(path).then(function (r) {
        if (!r.ok || !r.data) return;
        A.store.set('cache.report', r.data);
        if (S.tab === 'report') drawReport(A.clear(body), r.data);
      });
    });
    A.updateStatusPill();
  }

  function drawMaturity(body, compact) {
    var hb = S.heartbeat, m = hb && hb.maturity;
    var card = h('div', { class: 'card' }, [h('h2', { text: '쌓일수록 열리는 분석' })]);
    if (!m || !m.stages) {
      card.appendChild(h('p', { class: 'muted', text: '첫 밤 점검이 끝나면 여기에 진행 상황이 보입니다.' }));
    } else {
      card.appendChild(h('p', { text: '기록한 날 ' + m.days_recorded + '일' }));
      if (m.next) {
        var pct = Math.min(100, Math.round(100 * m.next.have / m.next.need));
        var bar = h('div', { class: 'bar', role: 'img', 'aria-label': pct + '%' }, [h('i', {})]);
        bar.firstChild.style.width = pct + '%';
        card.appendChild(bar);
        card.appendChild(h('p', { class: 'small', text: '다음: ' + m.next.name + ' · ' + m.next.have + '/' + m.next.need + m.next.unit_ko + ' · ' + m.next.remaining + '일 더 기록하면 열립니다' }));
      }
      if (!compact) {
        var ul = h('ul', { class: 'stages' });
        m.stages.forEach(function (s) { ul.appendChild(h('li', { class: 'small' + (s.reached ? ' reached' : ''), text: (s.reached ? '열림 · ' : '') + s.name + ' — ' + s.opens })); });
        card.appendChild(h('details', {}, [h('summary', { text: '단계 전체 보기' }), ul]));
      }
    }
    if (!compact) card.appendChild(h('p', { class: 'small', text: '첫 주간 리포트는 기록을 시작하고 2주가 지난 일요일 저녁에 나옵니다. 기록이 4일 미만인 주는 원래 값만 보여 줍니다.' }));
    body.appendChild(card);
    if (!compact) body.appendChild(h('p', { class: 'small', text: S.form.disclaimer }));
  }

  function rowsTable(rows) {
    var tbl = h('table', { class: 't' });
    rows.forEach(function (s) { tbl.appendChild(h('tr', {}, [h('th', { text: s.label_ko }), h('td', { text: s.display_ko })])); });
    return tbl;
  }

  function drawReport(body, r) {
    var p = r.period || {};
    body.appendChild(h('p', { class: 'muted', text: '주간 리포트 · ' + (p.from || '') + ' ~ ' + (p.to || '') }));
    if (r.synthetic) body.appendChild(h('div', { class: 'notice', text: '합성 데이터 예시 — 실제 기록이 아닙니다' }));
    var cov = r.coverage || {};
    body.appendChild(h('p', { class: 'small', text: '기록 ' + cov.days_recorded + '/' + cov.days_in_period + '일' + (cov.rate_pct !== null && cov.rate_pct !== undefined ? ' (쉰 날 뺀 기록률 ' + cov.rate_pct + '%)' : '') + ' · 누적 ' + cov.total_recorded + '일' + (cov.days_paused ? ' · 쉰 날 ' + cov.days_paused + '일' : '') }));
    (r.notices || []).forEach(function (n) {
      if (n === r.disclaimer_ko || n === S.form.disclaimer) return;   // 고지는 맨 아래에 한 번만
      body.appendChild(h('div', { class: 'notice', text: n }));
    });
    if (r.mode === 'raw') body.appendChild(h('div', { class: 'notice ok', text: '이번 주는 기록이 4일 미만이라 원래 값만 보여 줍니다.' }));
    if (r.conclusion && r.conclusion.lines && r.conclusion.lines.length) {
      var concl = h('div', { class: 'card' }, [h('h2', { text: r.mode === 'raw' ? '이번 주 원래 값' : '결론' + (r.conclusion.author === 'ai' ? ' (AI 작성, 숫자는 코드 계산)' : '') })]);
      var ol = h('ol', {});
      r.conclusion.lines.forEach(function (l) { ol.appendChild(h('li', { text: l })); });
      concl.appendChild(ol);
      body.appendChild(concl);
    }
    if (r.hypotheses && r.hypotheses.length) body.appendChild(drawHypotheses(r));
    var grid = h('div', { class: 'grid2' });
    if (r.stats && r.stats.length) grid.appendChild(h('div', { class: 'card' }, [h('h2', { text: '숫자 (코드 계산 · 기록한 날 기준)' }), rowsTable(r.stats)]));
    if (r.narrative && r.narrative.bullets && r.narrative.bullets.length) {
      var nl = h('ul', {});
      r.narrative.bullets.forEach(function (b) { nl.appendChild(h('li', { text: b })); });
      grid.appendChild(h('div', { class: 'card' }, [h('h2', { text: r.narrative.label_ko }), nl]));
    }
    body.appendChild(grid);
    if (r.locked && r.locked.length) {
      var ul = h('ul', {});
      r.locked.forEach(function (l) { ul.appendChild(h('li', { class: 'small', text: l.display_ko })); });
      body.appendChild(h('details', {}, [h('summary', { text: '아직 잠긴 분석 ' + r.locked.length + '개' }), ul]));
    }
    if (r.monthly) body.appendChild(drawMonthly(r.monthly));
    if (r.quarterly) body.appendChild(drawQuarterly(r.quarterly));
    if (r.next_action && r.next_action.then_ko) {
      body.appendChild(h('div', { class: 'card' }, [h('h2', { text: '다음 주 단 하나' }),
        h('p', { text: (r.next_action.if_ko ? '만약 ' + r.next_action.if_ko + ' → ' : '') + r.next_action.then_ko }),
        r.next_action.linked_goal ? h('p', { class: 'small', text: '연결된 분기 목표: ' + r.next_action.linked_goal }) : null]));
    }
    if (r.ai_status === 'off') body.appendChild(h('p', { class: 'small', text: 'AI 해석이 꺼져 있어 코드가 계산한 숫자만 보여 줍니다.' }));
    var pv = r.provenance || {};
    body.appendChild(h('p', { class: 'small', text: '작성: ' + (pv.generator === 'ai' ? 'AI ' + (pv.model_id || '') + ' · 지시문 ' + (pv.prompt_version || '-') : '코드') + ' · 통계 코드 ' + (pv.stats_code_version || '-') + ' · 규칙 ' + (pv.rulebook_version || '-') }));
    body.appendChild(h('p', { class: 'small', text: r.disclaimer_ko || S.form.disclaimer }));
    drawMaturity(body, true);
  }

  /* 가설: 규칙이 올린 것(최대 2개). 한 번 눌러 답하면 feedback 기록이 남고, 맞다고 답한 것은 자기 모델의 사실이 된다. */
  function drawHypotheses(r) {
    var card = h('div', { class: 'card' }, [h('h2', { text: '가설 (확인 전)' }),
      h('p', { class: 'small', text: '기록에서 함께 나타난 경향입니다. 원인이라는 뜻이 아닙니다. 나에게 맞는지 한 번 눌러 주세요.' })]);
    var answered = A.store.get('hypAnswers', {});
    var CONF = { low: '신뢰도 낮음', medium: '신뢰도 중간', high: '신뢰도 높음' };
    r.hypotheses.forEach(function (hy) {
      var ev = hy.evidence || {};
      var mine = answered[hy.hypothesis_id + '|' + r.report_id];
      var row = h('div', { class: 'row' });
      [['yes', '맞음'], ['no', '아님'], ['unsure', '모르겠음']].forEach(function (o) {
        row.appendChild(h('button', { type: 'button', class: 'opt small', 'aria-pressed': mine === o[0] ? 'true' : 'false', onclick: function () {
          A.enqueueRecord('feedback', { target_kind: 'hypothesis', target_id: hy.hypothesis_id, answer: o[0], report_id: r.report_id, statement_ko: hy.statement_ko.slice(0, 300) },
                          { label: '가설 ' + o[1] + ': ' + hy.statement_ko });
          answered[hy.hypothesis_id + '|' + r.report_id] = o[0];
          A.store.set('hypAnswers', answered);
          A.renderTab();
        } }, [h('span', { text: o[1] })]));
      });
      card.appendChild(h('div', { class: 'q' }, [
        h('div', { class: 'q-title', text: hy.statement_ko }),
        h('p', { class: 'small', text: CONF[hy.confidence] + ' · 근거 ' + (ev.analysis_id || '') + ' n=' + (ev.n || '-') + (ev.n_eff ? ', 유효 표본 ' + Math.round(ev.n_eff) : '') + (ev.from ? ' · ' + ev.from + '~' + ev.to : '') + ' · 올린 횟수 ' + hy.times_asked }),
        row, mine ? h('p', { class: 'small', text: '답을 남겼습니다. 다음 밤 점검 뒤 나 탭의 사실 목록에 반영됩니다.' }) : null
      ]));
    });
    return card;
  }

  function drawMonthly(m) {
    var card = h('div', { class: 'card' }, [h('h2', { text: m.month.slice(0, 4) + '년 ' + (+m.month.slice(5)) + '월 요약' })]);
    if (m.focus_ko) card.appendChild(h('p', {}, [h('strong', { text: '이번 달 단 하나: ' + m.focus_ko })]));
    card.appendChild(rowsTable(m.rows || []));
    var vp = m.values_progress || {};
    var lines = ['가치 질문 ' + vp.answered + '/' + vp.total + '쌍' + (vp.complete ? ' (한 바퀴 끝남)' : ''),
                 '스트레스 질문 답 ' + ((m.questions || {}).stress_answers || 0) + '번 · 원천 질문 답 ' + ((m.questions || {}).source_answers || 0) + '번'];
    if (m.cost && m.cost.display_ko) lines.push(m.cost.display_ko);
    var ul = h('ul', {});
    lines.forEach(function (l) { ul.appendChild(h('li', { class: 'small', text: l })); });
    (m.decisions_due || []).forEach(function (d) { ul.appendChild(h('li', { class: 'small', text: '다시 볼 결정: ' + d.decision + ' (' + d.review_date + ')' })); });
    (m.deadlines_90d || []).forEach(function (d) { ul.appendChild(h('li', { class: 'small', text: '90일 안 기한: ' + d.title + ' · ' + d.date + ' (' + d.days_left + '일 남음)' })); });
    (m.fact_suggestions || []).forEach(function (f) { ul.appendChild(h('li', { class: 'small', text: '자기 모델 확인 요청: ' + f.statement_ko + ' (나 탭)' })); });
    (m.hypotheses || []).forEach(function (x) { ul.appendChild(h('li', { class: 'small', text: '가설 장부: ' + (x.statement_ko || x.hypothesis_id) + ' · ' + ({ hypothesis: '확인 전', confirmed: '맞음', rejected: '아님', on_hold: '보류', reverify: '재확인 필요' }[x.status] || x.status) })); });
    card.appendChild(ul);
    return card;
  }

  function drawQuarterly(q) {
    var card = h('div', { class: 'card' }, [h('h2', { text: q.quarter.replace('-Q', '년 ') + '분기 요약' })]);
    card.appendChild(rowsTable(q.rows || []));
    if (q.say_do) card.appendChild(h('p', { class: 'small', text: '말과 행동: ' + q.say_do.display_ko + (q.say_do.work_only_share_pct !== null && q.say_do.work_only_share_pct !== undefined ? ' · 일만 한 날 ' + q.say_do.work_only_share_pct + '%' : '') }));
    (q.source_map || []).forEach(function (s) {
      var ul = h('ul', {});
      s.cells.forEach(function (c) { ul.appendChild(h('li', { class: 'small', text: c.display_ko })); });
      card.appendChild(h('details', {}, [h('summary', { text: '원천 지도 · ' + s.prompt + ' (답 ' + s.answered + '번)' }), ul]));
    });
    if (q.life_events && q.life_events.length) {
      var le = h('ul', {});
      q.life_events.forEach(function (e) { le.appendChild(h('li', { class: 'small', text: e.date + ' ' + e.kind + (e.note ? ' · ' + e.note : '') })); });
      card.appendChild(h('div', {}, [h('h3', { text: '큰 일' }), le]));
    }
    if (q.resume_candidates && q.resume_candidates.length) {
      var rc = h('ul', {});
      q.resume_candidates.forEach(function (w) { rc.appendChild(h('li', { class: 'small', text: w.date + ' ' + w.text + (w.metric ? ' (' + w.metric + ')' : '') })); });
      card.appendChild(h('div', {}, [h('h3', { text: '이력서 후보 성과' }), rc]));
    }
    if (q.goal_review_ko) card.appendChild(h('p', { class: 'small', text: q.goal_review_ko }));
    return card;
  }

  return { renderNews: renderNews, renderReport: renderReport };
})();
