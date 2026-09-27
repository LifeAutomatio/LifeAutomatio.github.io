/* GitHub 연결부. 저장 서비스를 바꾸려면 이 파일만 바꾼다.
 * 쓰는 API: 저장소 정보, 폴더 목록, 파일 읽기, 새 파일 만들기 (REST API 버전 2022-11-28, 2028-03-10 까지 지원).
 * 새 파일 만들기는 동시에 여러 개를 보내면 충돌하므로 반드시 하나씩 보낸다.
 */
var LA = (typeof LA !== 'undefined') ? LA : {};
LA.github = function (cfg) {
  'use strict';
  var base = (cfg.apiBase || 'https://api.github.com').replace(/\/$/, '');
  var repoPath = '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo);

  function headers(accept) {
    return {
      'Accept': accept || 'application/vnd.github+json',
      'Authorization': 'Bearer ' + cfg.token,
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  function req(method, url, opts) {
    opts = opts || {};
    var init = { method: method, headers: headers(opts.accept), cache: 'no-store' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.keepalive) init.keepalive = true;
    return fetch(base + url, init).then(function (r) {
      var ct = r.headers.get('Content-Type') || '';
      var parse = ct.indexOf('json') >= 0 && opts.accept !== 'application/vnd.github.raw+json' ? r.json() : r.text();
      return parse.then(function (data) { return { status: r.status, ok: r.ok, data: data }; },
                        function () { return { status: r.status, ok: r.ok, data: null }; });
    }, function (e) {
      return { status: 0, ok: false, data: null, error: String(e && e.message || e) };
    });
  }

  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  return {
    /* 연결 확인. 기록 저장소는 열려야 하고 비공개여야 하며 쓰기 권한이 있어야 한다. */
    probe: function (forbiddenRepo) {
      return req('GET', repoPath).then(function (r) {
        if (r.status === 401) return { ok: false, reason: '접근 키가 틀렸거나 만료됐습니다.' };
        if (r.status === 404) return { ok: false, reason: '기록 저장소를 찾을 수 없습니다. 두 가지를 확인하세요. ① 사용자 이름이 조직 이름이 아니라 개인 GitHub 아이디이고, 저장소 이름이 맞는지. ② 키의 Permissions 에 Contents(Read and write)가 들어 있는지. 키 설정을 고쳐도 키 문자열은 그대로 씁니다.' };
        if (!r.ok) return { ok: false, reason: '연결 실패 (' + (r.status || '네트워크') + ')' };
        if (!r.data || r.data.private !== true) return { ok: false, reason: '기록 저장소가 비공개가 아닙니다. 바로 비공개로 바꾸세요.' };
        if (r.data.permissions && r.data.permissions.push === false) return { ok: false, reason: '이 키에는 쓰기 권한이 없습니다. Contents 를 Read and write 로 주세요.' };
        if (!forbiddenRepo) return { ok: true };
        return req('GET', '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(forbiddenRepo)).then(function (r2) {
          if (r2.ok) return { ok: false, reason: '이 키는 다른 저장소까지 열 수 있습니다. 저장소를 ' + cfg.repo + ' 하나만 골라 다시 발급하세요.' };
          return { ok: true };
        });
      });
    },

    listDir: function (path) {
      return req('GET', repoPath + '/contents/' + encPath(path)).then(function (r) {
        if (r.status === 404) return { ok: true, items: [] };
        if (!r.ok || !Array.isArray(r.data)) return { ok: false, status: r.status, items: [] };
        return { ok: true, items: r.data.map(function (x) { return { name: x.name, path: x.path, type: x.type }; }) };
      });
    },

    getText: function (path) {
      return req('GET', repoPath + '/contents/' + encPath(path), { accept: 'application/vnd.github.raw+json' }).then(function (r) {
        if (r.status === 404) return { ok: true, text: null };
        if (!r.ok) return { ok: false, status: r.status, text: null };
        return { ok: true, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
      });
    },

    getJSON: function (path) {
      return this.getText(path).then(function (r) {
        if (!r.ok || r.text === null) return { ok: r.ok, status: r.status, data: null };
        try { return { ok: true, data: JSON.parse(r.text) }; } catch (e) { return { ok: false, data: null }; }
      });
    },

    /* 새 파일 만들기. 이미 같은 내용의 파일이 있으면 성공으로 본다 (앞선 전송이 사실은 성공했던 경우). */
    createFile: function (path, text, message, opts) {
      var self = this;
      return req('PUT', repoPath + '/contents/' + encPath(path), {
        body: { message: message, content: LA.core.utf8ToBase64(text) },
        keepalive: opts && opts.keepalive
      }).then(function (r) {
        if (r.status === 201 || r.status === 200) return { ok: true };
        if (r.status === 422) {
          return self.getText(path).then(function (g) {
            if (g.ok && g.text !== null && g.text === text) return { ok: true, duplicate: true };
            return { ok: false, status: 422, fatal: true, reason: '같은 이름의 다른 파일이 이미 있습니다' };
          });
        }
        var fatal = r.status === 401 || r.status === 403 || r.status === 404;
        return { ok: false, status: r.status, fatal: fatal, reason: fatal ? '접근 키를 확인하세요 (' + r.status + ')' : '잠시 후 다시 보냅니다' };
      });
    }
  };
};
