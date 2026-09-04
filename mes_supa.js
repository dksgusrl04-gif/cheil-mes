/* ═══════════════════════════════════════════════════════════════
 * Supabase 직결 층 — fetch 가로채기
 * ═══════════════════════════════════════════════════════════════
 * 화면(mes.html)은 지금까지 파이썬 서버에 /api/... 로 물어봤다.
 * 이 파일은 그 요청을 가로채 Supabase + mes_calc.js 로 직접 처리한다.
 *
 * 덕분에 화면 코드를 한 줄도 고치지 않는다. 1,200줄을 다시 쓰지 않아도 되고,
 * 나중에 서버로 되돌리고 싶으면 이 script 태그만 빼면 된다.
 *
 * 응답 모양은 파이썬 서버와 똑같이 맞췄다. 다르면 화면이 깨진다.
 *
 * 쓰는 법 (mes.html 의 <script> 앞에 넣는다)
 *   <script src="config.js"></script>
 *   <script src="mes_calc.js"></script>
 *   <script src="mes_supa.js"></script>
 */
(function () {
  'use strict';

  const CFG = window.MES_CONFIG || {};
  const BASE = (CFG.SUPABASE_URL || '').replace(/\/$/, '');
  const REST = BASE + '/rest/v1';
  const AUTH = BASE + '/auth/v1';
  const KEY = CFG.SUPABASE_ANON_KEY || '';
  const SNAP = CFG.SNAPSHOT_NAME || 'snapshot';

  const realFetch = window.fetch.bind(window);

  /* ── 로그인 유지 범위 ────────────────────────────────────────
     config.js 의 SESSION_MODE 로 정한다.

       'tab'      기본. 탭을 닫으면 로그아웃된다. 새로 열면 다시 로그인.
                  새로고침이나 탭 안에서의 이동은 유지된다 — 시연 중에
                  실수로 F5 를 눌러도 끊기지 않는다.
       'always'   페이지를 새로 그릴 때마다 로그인. 새로고침도 로그아웃.
       'remember' 브라우저를 껐다 켜도 유지 (예전 방식).

     sessionStorage 는 탭 단위 저장소라 탭을 닫으면 브라우저가 알아서 지운다. */
  const SESSION_KEY = 'mes_session';
  const MODE = CFG.SESSION_MODE || 'tab';
  const STORE = (MODE === 'remember') ? localStorage : sessionStorage;

  let SESSION = null;
  if (MODE !== 'always') {
    try { SESSION = JSON.parse(STORE.getItem(SESSION_KEY) || 'null'); } catch (e) { SESSION = null; }
  }
  // 저장 방식을 바꾼 뒤에도 예전 localStorage 기록이 남아 자동 로그인되면 안 된다
  if (MODE !== 'remember') { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 무시 */ } }
  if (MODE === 'always') { try { STORE.removeItem(SESSION_KEY); } catch (e) { /* 무시 */ } }

  const URL_BASE = BASE;        // Edge Function 주소를 만들 때 쓴다

  let SNAPSHOT = null;          // 집계본 (한 번 받아 계속 쓴다)
  let LOADED = false;
  let TEMPLATES = null;         // 서류 양식 목록 (한 번 읽어 캐시)

  /* 화면이 고른 CSV 파일을 여기에 둔다. fetch 본문으로는 File 을 넘길 수 없어서
     이 자리를 약속해 두고 주고받는다. mes.html 의 <input type=file> 이 채운다. */
  window.MES_PENDING_FILE = window.MES_PENDING_FILE || null;

  function saveSession(s) {
    SESSION = s;
    if (MODE === 'always') return;          // 아무 데도 남기지 않는다
    if (s) STORE.setItem(SESSION_KEY, JSON.stringify(s));
    else STORE.removeItem(SESSION_KEY);
  }

  function headers(json) {
    const h = { apikey: KEY };
    if (SESSION && SESSION.access_token) h.Authorization = 'Bearer ' + SESSION.access_token;
    else h.Authorization = 'Bearer ' + KEY;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /* 접근 토큰은 1시간이면 만료된다. 갱신 토큰으로 조용히 새로 받는다.
     실패하면 세션을 지운다 — 그래야 화면이 로그인으로 되돌아간다.
     지우지 않으면 localStorage 의 user 때문에 '로그인된 것처럼' 보이면서
     모든 조회가 401 로 깨진다. */
  const EXPIRED = '__mes_expired__';

  async function refreshSession() {
    if (!SESSION || !SESSION.refresh_token) return false;
    try {
      const r = await realFetch(`${AUTH}/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: SESSION.refresh_token }),
      });
      if (!r.ok) return false;
      const j = await r.json();
      if (!j.access_token) return false;
      saveSession(Object.assign({}, SESSION, {
        access_token: j.access_token,
        refresh_token: j.refresh_token || SESSION.refresh_token,
      }));
      return true;
    } catch (e) { return false; }
  }

  async function db(method, path, body, prefer, retried) {
    const opt = { method, headers: headers(!!body) };
    if (prefer) opt.headers.Prefer = prefer;
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await realFetch(REST + path, opt);
    const txt = await r.text();
    if (!r.ok) {
      if (r.status === 401 && SESSION && !retried) {
        if (await refreshSession()) return db(method, path, body, prefer, true);
        saveSession(null);
        LOADED = false;
        throw new Error(EXPIRED);
      }
      let msg = txt;
      try { msg = JSON.parse(txt).message || txt; } catch (e) { /* 원문 사용 */ }
      throw new Error(msg || ('HTTP ' + r.status));
    }
    return txt.trim() ? JSON.parse(txt) : [];
  }

  const ok = (obj) => new Response(JSON.stringify(obj), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  const err = (obj, code) => new Response(JSON.stringify(obj), {
    status: code, headers: { 'Content-Type': 'application/json' },
  });

  /* ── 집계본 ─────────────────────────────────────────────── */
  async function ensureSnapshot() {
    if (LOADED) return;
    const rows = await db('GET', `/mes_docs?name=eq.${encodeURIComponent(SNAP)}&select=data&limit=1`);
    if (!rows.length) {
      throw new Error('집계본이 없습니다. 현장 PC 에서 upload_snapshot.py 를 실행하세요.');
    }
    SNAPSHOT = rows[0].data;
    MES.load(SNAPSHOT);
    LOADED = true;
  }

  function basisFrom(qs) {
    return new MES.Basis({
      seg: qs.get('seg'), life: qs.get('life'),
      week: qs.get('week'), anchor: qs.get('anchor'),
    });
  }

  /* ── 인증 ───────────────────────────────────────────────── */
  function toEmail(id) {
    return id.includes('@') ? id : `${id}@${CFG.EMAIL_DOMAIN || 'local'}`;
  }

  async function login(id, pw) {
    const r = await realFetch(`${AUTH}/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: toEmail(id), password: pw }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.msg || '아이디 또는 비밀번호가 올바르지 않습니다');
    saveSession({ access_token: j.access_token, refresh_token: j.refresh_token, uid: j.user.id });
    // 역할은 mes_profiles 에서 읽는다 (RLS 로 자기 것만 보인다)
    const p = await db('GET', `/mes_profiles?id=eq.${j.user.id}&select=name,role&limit=1`);
    const prof = p[0] || { name: '사용자', role: 'operator' };
    const user = { id: j.user.id, name: prof.name, role: prof.role, email: j.user.email };
    saveSession(Object.assign({}, SESSION, { user }));
    return user;
  }

  async function currentUser() {
    if (!SESSION || !SESSION.user) return null;
    return SESSION.user;
  }

  /* ── 활동 로그 ──────────────────────────────────────────── */
  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  async function log(action, detail) {
    const u = SESSION && SESSION.user;
    if (!u) return;
    try {
      await db('POST', '/mes_audit', [{
        at: now(), user: u.name, user_id: u.id, role: u.role,
        action: action, detail: (detail || '').slice(0, 200),
      }]);
    } catch (e) { console.warn('로그 기록 실패', e.message); }
  }

  const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  /* ── 알림 집계 (mes_alerts.py 의 규칙을 옮긴 것) ────────── */
  const WEAR_LEVELS = [[100, '교체', 'danger'], [90, '교체 준비', 'danger'], [70, '주의', 'warn']];
  const INTENSITY_WARN = 2.0;
  const DEAD_COL = {
    Vib_KurtX: ['critical', '진동 첨도 X — 파손 전조 감지의 핵심 채널'],
    Vib_KurtY: ['critical', '진동 첨도 Y — 파손 전조 감지의 핵심 채널'],
    Vib_KurtZ: ['critical', '진동 첨도 Z — 파손 전조 감지의 핵심 채널'],
    Vib_VrmsX: ['warn', '진동 실효값 X 미수집'], Vib_VrmsY: ['warn', '진동 실효값 Y 미수집'],
    Vib_VrmsZ: ['warn', '진동 실효값 Z 미수집'], Vib_DrmsX: ['warn', '변위 실효값 X 미수집'],
    Vib_DrmsY: ['warn', '변위 실효값 Y 미수집'], Vib_DrmsZ: ['warn', '변위 실효값 Z 미수집'],
    Vib_AccAmpX: ['warn', '가속도 진폭 X 미수집'], Vib_AccAmpY: ['warn', '가속도 진폭 Y 미수집'],
    Vib_AccAmpZ: ['warn', '가속도 진폭 Z 미수집'],
  };
  const WEAK_COL = { SpindleLoad: ['critical', '주축 부하 — 절반 이상이 0. 전류로 대체 중'] };

  function autoAlerts(b) {
    const out = [];
    const tools = MES.toolList(b);
    for (const t of tools) {
      for (const [thr, name, level] of WEAR_LEVELS) {
        if (t.wear >= thr) {
          out.push({
            kind: 'wear', level, tool: t.tool,
            title: `T${t.tool} ${t.name} — ${name}`,
            body: `마모율 ${t.wear.toFixed(2)}% (기준 ${thr}% 초과) · 기여도 ${t.share.toFixed(2)}%`,
            evidence: `앵커 ${b.anchorLabel} = ${b.lifeDays.toFixed(0)}일`,
          });
          break;
        }
      }
    }
    for (const t of tools) {
      if ((t.intensity || 0) >= INTENSITY_WARN && !out.some(o => o.tool === t.tool)) {
        out.push({
          kind: 'intensity', level: 'warn', tool: t.tool,
          title: `T${t.tool} ${t.name} — 사용강도 과다`,
          body: `평균 공구의 ${t.intensity.toFixed(1)}배로 소모 중 · 기여도 ${t.share.toFixed(2)}%`,
          evidence: '일괄 교체 주기 안에 먼저 닳는 공구',
        });
      }
    }
    const q = (SNAPSHOT && SNAPSHOT.quality) || {};
    (q.dead || []).forEach(col => {
      const m = DEAD_COL[col];
      if (!m) return;
      out.push({
        kind: 'quality', level: m[0] === 'critical' ? 'danger' : 'warn', tool: null,
        title: `${col} — 전량 0`, body: m[1],
        evidence: `절삭 ${(q.cut_rows || 0).toLocaleString()}행 전부 0`,
      });
    });
    (q.weak || []).forEach(w => {
      const m = WEAK_COL[w.col];
      if (!m) return;
      out.push({
        kind: 'quality', level: 'danger', tool: null,
        title: `${w.col} — 비영률 ${w.nonzero.toFixed(1)}%`, body: m[1],
        evidence: '절반 이상이 0',
      });
    });
    (b.seg.events || []).slice(0, 10).forEach(e => {
      const emg = (e.type || '').includes('알람') || (e.type || '').includes('비상');
      out.push({
        kind: 'event', level: emg ? 'danger' : 'warn', tool: e.tool,
        title: `T${e.tool} ${e.name || ''} — ${e.type}`,
        body: `${e.time} · 프로그램 ${e.prog}`,
        evidence: `마모 증가 ${b.wear(e.raw).toFixed(6)}%`,
      });
    });
    const ord = { danger: 0, warn: 1, info: 2 };
    out.sort((a, c) => (ord[a.level] ?? 3) - (ord[c.level] ?? 3));
    return out;
  }

  /* ═══════════════════════════ 질의 ═══════════════════════════
     Edge Function 이 API 키를 들고 대신 Anthropic 을 부른다.
     여기서는 로그인 토큰만 실어 보낸다. 키는 브라우저에 없다. */
  const FN = () => `${URL_BASE}/functions/v1/${CFG.ASK_FUNCTION || 'mes-ask'}`;

  /* 집계본을 통째로 보내면 요금이 커진다. 물어볼 만한 것만 추린다. */
  function askContext(qs) {
    if (!SNAPSHOT) return {};
    const b = basisFrom(qs || new URLSearchParams());
    const i = b.info();
    const tools = MES.toolList(b).slice(0, 20);
    return {
      기준: {
        구간: i.segment_label, 기간: i.segment_period,
        기준수명일: i.life_days, 주간가동시간: i.week_hours,
        앵커: i.anchor_label, 관측절삭시간h: i.observed_hours,
      },
      전환: SNAPSHOT.switch,
      가중치: SNAPSHOT.weights,
      임계값: SNAPSHOT.thresholds,
      공구: tools.map(t => ({
        번호: t.tool, 이름: t.name, 부류: t.cls === 'breakage' ? '파손형' : '마모형',
        마모율: t.wear, 사용강도: t.intensity, 기여도: t.share, 절삭시간h: t.hours,
      })),
      일자별: (b.seg.days || []).map(d => ({
        날짜: d.date, 절삭h: d.cut_h, 행수: d.rows, 생산: d.parts,
      })),
      프로그램: (b.seg.progs || []).slice(0, 10).map(p => ({
        이름: p.prog, 메인: p.main, 절삭h: p.hours,
      })),
      비고: b.seg.parts_note || '',
    };
  }

  /* Edge Function 이 배포돼 있는가. 한 번만 확인하고 기억한다.
     배포가 안 돼 있으면 브라우저는 404 대신 'Failed to fetch' 를 던진다.
     CORS 헤더가 없는 응답이라 그렇다. 그래서 예외도 '없음' 으로 친다. */
  let FN_OK = null;
  async function probeFn() {
    if (FN_OK !== null) return FN_OK;
    try {
      const r = await realFetch(FN(), { method: 'OPTIONS' });
      FN_OK = r.ok || r.status === 204;
    } catch (e) { FN_OK = false; }
    return FN_OK;
  }

  async function askClaude(q, context) {
    if (!SESSION || !SESSION.access_token) {
      throw Object.assign(new Error('로그인이 필요합니다'), { status: 401 });
    }
    let r;
    try {
      r = await realFetch(FN(), {
        method: 'POST',
        headers: {
          apikey: KEY, Authorization: 'Bearer ' + SESSION.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q, context }),
      });
    } catch (e) {
      FN_OK = false;
      throw Object.assign(new Error('질의 기능이 아직 설정되지 않았습니다'), {
        status: 501,
        hint: 'supabase functions deploy mes-ask 를 한 번 실행하면 Claude 가 답합니다.',
      });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 404) {
        FN_OK = false;
        throw Object.assign(new Error('질의 기능이 아직 설정되지 않았습니다'), {
          status: 501,
          hint: 'supabase functions deploy mes-ask 를 한 번 실행하면 켜집니다.',
        });
      }
      throw Object.assign(new Error(j.error || `질의 실패 (HTTP ${r.status})`), {
        status: r.status, hint: j.hint || '',
      });
    }
    FN_OK = true;
    return { answer: j.answer, model: j.model, usage: j.usage, fallback: false };
  }

  /* 규칙 기반 답. 자료는 여기서 모아 넘긴다. */
  async function askRule(q, qs) {
    const b = basisFrom(qs || new URLSearchParams());
    let orders = null, alerts = null;
    try {
      if (/발주|주문|누가|구매/.test(q)) {
        orders = MES.orders(b, await db('GET', '/mes_orders?select=*&order=at.desc&limit=500'));
      }
      if (/경보|알림|위험|이상/.test(q)) alerts = { auto: autoAlerts(b) };
    } catch (e) { /* 못 읽으면 그 부분만 비운다 */ }
    return MESASK.answer(q, {
      MES, basis: b, snapshot: SNAPSHOT, orders, alerts,
    });
  }

  /* ═══════════════════════════ 재집계 ═══════════════════════════ */
  const JOB = { running: false, lines: [], code: null, pct: 0 };

  function say(s) {
    JOB.lines.push(s);
    if (JOB.lines.length > 400) JOB.lines.shift();
  }

  async function runRebuild(file, user) {
    JOB.running = true; JOB.lines = []; JOB.code = null; JOB.pct = 0;
    const t0 = Date.now();
    say(`[읽기] ${file.name} · ${(file.size / 1048576).toFixed(1)} MB`);

    /* 1) 머리글과 표본 200행만 먼저 읽어 컬럼을 맞춘다 */
    const head = await readHead(file, 200);
    const match = await MESMATCH.matchColumns(head.headers, head.samples, null);
    say(`[매칭] 컬럼 ${match.total}개 → ${match.mapped}개 대응 ` +
      `(사전 ${match.by_dict} · 유사도 ${match.by_sim} · 미확정 ${match.unmatched})`);
    if (match.missing_required.length) {
      JOB.running = false; JOB.code = 1;
      say('[중단] 필수 컬럼 없음 — ' + match.missing_required.join(', '));
      return;
    }
    JOB.match = match;

    /* 2) 전체를 흘려 읽으며 집계 */
    say('[집계] 시작');
    const snap = await MESAGG.run(file, {
      columns: match.columns,
      onProgress: p => {
        JOB.pct = Math.round(100 * p.bytes / p.total);
        if (JOB.pct % 10 === 0) say(`[집계] ${JOB.pct}% · ${p.rows.toLocaleString()}행`);
      },
    });
    for (const k of Object.keys(snap.segments)) {
      const s = snap.segments[k];
      say(`   ${s.label} — ${s.rows.toLocaleString()}행 · 절삭 ${s.cut_h}h · 공구 ${s.tools.length}종`);
    }

    /* 3) 기존 집계본과 합쳐 올린다. 새 주차가 더해지는 형태다. */
    const merged = MESAGG.merge(SNAPSHOT, snap);
    say('[저장] Supabase 에 올리는 중');
    await db('POST', '/mes_docs?on_conflict=name', [{
      name: SNAP, data: merged, updated_at: now(),
    }], 'resolution=merge-duplicates,return=minimal');

    SNAPSHOT = merged;
    MES.load(merged);
    LOADED = true;
    await log('재집계', `${file.name} · ${snap.source.rows.toLocaleString()}행`);

    JOB.pct = 100; JOB.running = false; JOB.code = 0;
    say(`[완료] ${((Date.now() - t0) / 1000).toFixed(1)}초 · 화면을 새로고침하면 반영됩니다`);
    window.MES_PENDING_FILE = null;
  }

  /* 머리글 + 앞쪽 몇 행만 떼어 본다. 매칭에는 그거면 충분하다. */
  async function readHead(file, n) {
    const chunk = await file.slice(0, Math.min(file.size, 1 << 20)).arrayBuffer();
    const text = new TextDecoder('utf-8').decode(chunk);
    const lines = text.split('\n').slice(0, n + 1)
      .map(l => (l.charCodeAt(l.length - 1) === 13 ? l.slice(0, -1) : l))
      .filter(l => l.length);
    const headers = MESAGG.splitLine(lines[0]).map(s => s.trim());
    const samples = {};
    headers.forEach((h, i) => { samples[h] = []; });
    for (let r = 1; r < lines.length; r++) {
      const a = MESAGG.splitLine(lines[r]);
      headers.forEach((h, i) => samples[h].push(a[i]));
    }
    return { headers, samples };
  }

  /* ═══════════════════════════ 서류 ═══════════════════════════ */
  async function listTemplates() {
    if (TEMPLATES) return TEMPLATES;
    TEMPLATES = [];
    for (const name of (CFG.TEMPLATES || ['order'])) {
      try {
        const r = await realFetch(`templates/${name}.html`, { cache: 'no-store' });
        if (!r.ok) continue;
        const src = await r.text();
        const m = MESDOC.meta(src);
        TEMPLATES.push({ key: m.key || name, title: m.title || name, role: m.role || '',
          note: m.note || '', data: m.data || '', file: `${name}.html`, src });
      } catch (e) { /* 없으면 넘어간다 */ }
    }
    return TEMPLATES;
  }

  /* ── 라우팅 ─────────────────────────────────────────────── */
  async function handleGet(path, qs) {
    if (path === '/api/me') return ok({ user: await currentUser() });

    const u = await currentUser();
    if (!u) return err({ error: '로그인이 필요합니다' }, 401);

    await ensureSnapshot();
    const b = basisFrom(qs);

    switch (true) {
      case path === '/api/basis':     return ok(b.info());
      case path === '/api/overview':  return ok(MES.overview(b));
      case path === '/api/tools':     return ok(MES.toolList(b));
      case path === '/api/programs':  return ok(MES.programs(b));
      case path === '/api/sales':     return ok(MES.sales(b));
      case path === '/api/health':    return ok(MES.health(b));
      case path === '/api/oee':       return ok(MES.oee(b));
      case path === '/api/machining': return ok(MES.machining(b));
      case path.startsWith('/api/tool/'): {
        const r = MES.toolDetail(b, parseInt(path.split('/').pop(), 10));
        return r ? ok(r) : err({ error: '해당 공구 없음' }, 404);
      }
      case path.startsWith('/api/program/'): {
        const r = MES.programDetail(b, decodeURIComponent(path.split('/api/program/')[1]));
        return r ? ok(r) : err({ error: '해당 프로그램 없음' }, 404);
      }
      case path === '/api/orders': {
        const rows = await db('GET', '/mes_orders?select=*&order=at.desc&limit=500');
        return ok(MES.orders(b, rows));
      }
      case path === '/api/alerts': {
        const rows = await db('GET', '/mes_alerts?select=*&order=at.desc&limit=500');
        const inbox = rows.filter(x => {
          const t = x.to || 'all';
          return t === 'all' || t === u.role || t === u.id;
        }).map(x => Object.assign({}, x, { unread: !(x.read_by || []).includes(u.id) }));
        const auto = autoAlerts(b);
        return ok({
          auto, manual: inbox,
          counts: {
            danger: auto.filter(a => a.level === 'danger').length,
            warn: auto.filter(a => a.level === 'warn').length,
            unread: inbox.filter(m => m.unread).length,
          },
          rules: {
            wear: WEAR_LEVELS.map(([t, n]) => ({ threshold: t, name: n })),
            intensity: INTENSITY_WARN,
          },
        });
      }
      case path === '/api/audit': {
        const rows = await db('GET', '/mes_audit?select=*&order=at.desc&limit=200');
        const fn = await probeFn();
        return ok({
          log: rows, store: { backend: 'Supabase', online: true, url: REST },
          agent: {
            provider: fn ? 'Claude (Supabase Edge Function)' : '규칙 기반 (내장)',
            online: fn, model: fn ? 'claude-sonnet-5' : null,
          },
        });
      }
      case path === '/api/uploads': {
        const f = window.MES_PENDING_FILE;
        return ok({
          files: f ? [{ name: f.name, size: f.size,
            at: new Date(f.lastModified || Date.now()).toISOString().slice(0, 19).replace('T', ' ') }] : [],
          standard: MESMATCH.STANDARD,
          match: JOB.match || null,
          rebuild: { running: JOB.running, lines: JOB.lines, pandas: true, code: JOB.code, pct: JOB.pct },
          built: (SNAPSHOT && SNAPSHOT.built) || '',
          sources: (SNAPSHOT && SNAPSHOT.source) ? [SNAPSHOT.source] : [],
          web: true,
        });
      }
      case path === '/api/rebuild/status':
        return ok({ running: JOB.running, lines: JOB.lines, code: JOB.code,
          pandas: true, pct: JOB.pct });
      case path === '/api/reports': {
        const t = await listTemplates();
        return ok({
          templates: t.map(x => ({ key: x.key, title: x.title, role: x.role,
            note: x.note, data: x.data, file: x.file })),
          dir: 'templates',
          allowed: t.filter(x => !x.role || x.role === u.role).map(x => x.key),
        });
      }
      /* 서류 출력 — 양식에 자료를 끼워 완성된 HTML 을 돌려준다 */
      case path.startsWith('/api/report/'): {
        const key = decodeURIComponent(path.split('/api/report/')[1]);
        const t = (await listTemplates()).find(x => x.key === key);
        if (!t) return err({ error: '양식을 찾지 못했습니다: ' + key }, 404);
        if (t.role && t.role !== u.role) {
          return err({ error: `이 서류는 ${t.role === 'manager' ? '관리자' : '작업자'}만 출력할 수 있습니다` }, 403);
        }
        let orders = [];
        if (t.data === 'order') {
          const batch = qs.get('batch'), id = qs.get('id');
          const rows = await db('GET', '/mes_orders?select=*&order=at.desc&limit=500');
          orders = batch ? rows.filter(r => r.batch === batch)
            : id ? rows.filter(r => r.id === id)
              : rows.filter(r => r.status === '발주');
        }
        let alerts = null;
        if (t.data === 'alert') alerts = { auto: autoAlerts(b) };
        const out = MESDOC.build(t.src, {
          MES, basis: b, user: u, orders,
          batch: qs.get('batch') || (orders[0] && orders[0].batch) || null,
          alerts,
        });
        await log('서류 출력', t.title);
        return new Response(out.html, {
          status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      default:
        return err({ error: 'not found' }, 404);
    }
  }

  async function handlePost(path, qs, body) {
    if (path === '/api/login') {
      try {
        const user = await login(String(body.id || ''), String(body.pw || ''));
        await log('로그인', '');
        return ok({ ok: true, user });
      } catch (e) {
        return err({ error: e.message }, 401);
      }
    }
    if (path === '/api/logout') {
      saveSession(null);
      LOADED = false;
      return ok({ ok: true });
    }

    const u = await currentUser();
    if (!u) return err({ error: '로그인이 필요합니다' }, 401);

    if (path.startsWith('/api/alert/') && path.endsWith('/read')) {
      const id = path.split('/')[3];
      try {
        const rows = await db('GET', `/mes_alerts?id=eq.${id}&select=read_by&limit=1`);
        if (!rows.length) return ok({ ok: false });
        const rb = rows[0].read_by || [];
        if (!rb.includes(u.id)) {
          rb.push(u.id);
          await db('PATCH', `/mes_alerts?id=eq.${id}`, { read_by: rb }, 'return=minimal');
        }
        return ok({ ok: true });
      } catch (e) { return err({ error: e.message }, 500); }
    }

    /* ── 질의 ─────────────────────────────────────────────────
       Edge Function 이 있으면 Claude 가, 없으면 규칙이 답한다.
       규칙도 못 알아들으면 그때 안내를 띄운다. */
    if (path === '/api/ask') {
      const q = String(body.q || '').trim();
      if (!q) return err({ error: '질문을 입력하세요' }, 400);

      if (await probeFn()) {
        try {
          const r = await askClaude(q, body.context !== undefined ? body.context : askContext(qs));
          await log('질의', q.slice(0, 80));
          return ok(r);
        } catch (e) {
          if (e.status !== 501) return err({ error: e.message, hint: e.hint || '' }, e.status || 502);
          // 501 이면 아래 규칙으로 내려간다
        }
      }

      let r = null;
      try { r = await askRule(q, qs); } catch (e) { /* 아래에서 안내 */ }
      if (r) {
        await log('질의', q.slice(0, 80));
        return ok({ answer: r.answer, model: null, fallback: true, how: r.how });
      }
      return ok({
        fallback: true, model: null,
        answer: ['이 질문은 규칙으로 답할 수 없습니다.', '',
          'Claude 질의를 켜면 자유로운 질문에 답할 수 있습니다 — ',
          '`supabase functions deploy mes-ask` 한 번이면 됩니다.',
          '', '지금 답할 수 있는 것은 이런 형태입니다.', '',
          ...MESASK.CAN.map(s => '- ' + s)].join('\n'),
      });
    }

    /* ── 업로드 + 재집계 — 브라우저가 CSV 를 직접 읽는다 ─────────
       파일 본문은 fetch 로 넘어오지 않는다(화면이 File 객체를 따로 건네준다).
       진행 상황은 PROGRESS 에 쌓고 /api/rebuild/status 로 보여준다. */
    if (path === '/api/upload' || path === '/api/rebuild') {
      if (u.role !== 'manager') return err({ error: '관리자만 사용할 수 있습니다' }, 403);
      const file = window.MES_PENDING_FILE;
      if (!file) {
        return err({
          error: '파일이 선택되지 않았습니다',
          hint: '«데이터 추가» 탭에서 CSV 를 고른 뒤 다시 누르세요.',
        }, 400);
      }
      if (JOB.running) return err({ error: '이미 집계가 돌고 있습니다' }, 409);
      runRebuild(file, u).catch(e => {
        JOB.running = false;
        JOB.code = 1;
        JOB.lines.push('[중단] ' + (e.message || e));
      });
      return ok({ ok: true, started: true, file: file.name, size: file.size });
    }
    if (path === '/api/upload/confirm') {
      return ok({ ok: true, note: '웹 버전은 매칭 확인 후 바로 집계합니다' });
    }

    if (u.role !== 'manager') return err({ error: '관리자만 사용할 수 있습니다' }, 403);

    if (path === '/api/alert/send') {
      if (!String(body.title || '').trim()) return err({ error: '제목을 입력하세요' }, 400);
      const item = {
        id: hex(4), kind: 'manual', level: String(body.level || 'info'),
        title: String(body.title), body: String(body.body || ''),
        tool: /^\d+$/.test(String(body.tool || '')) ? parseInt(body.tool, 10) : null,
        to: String(body.to || 'all'), by: u.name, by_id: u.id, at: now(), read_by: [],
      };
      try {
        await db('POST', '/mes_alerts', [item], 'return=minimal');
        await log('알림 전송', `${item.to} · ${item.title}`);
        return ok({ ok: true, alert: item });
      } catch (e) { return err({ error: '알림 저장 실패 — ' + e.message }, 500); }
    }

    if (path === '/api/order') {
      let items = Array.isArray(body.items) && body.items.length ? body.items : [body];
      const batch = items.length > 1 ? hex(3) : null;
      const at = now();
      const added = [];
      for (const it of items) {
        const tno = parseInt(it.tool, 10);
        if (!(tno > 0)) continue;
        added.push({
          id: hex(4), tool: tno, name: String(it.name || ''),
          qty: Math.max(1, parseInt(it.qty, 10) || 1),
          note: String(it.note !== undefined ? it.note : (body.note || '')),
          by: u.name, at, status: '발주', batch,
        });
      }
      if (!added.length) return err({ error: '발주할 공구가 없습니다' }, 400);
      try {
        await db('POST', '/mes_orders', added, 'return=minimal');
        await log('발주 등록', added.map(r => `T${r.tool} ${r.name} × ${r.qty}`).join(' · '));
        return ok({ ok: true, added: added.length });
      } catch (e) { return err({ error: '발주 저장 실패 — ' + e.message }, 500); }
    }

    if (path.startsWith('/api/order/') && path.endsWith('/status')) {
      const oid = path.split('/')[3];
      const st = String(body.status || '입고');
      try {
        await db('PATCH', `/mes_orders?id=eq.${oid}`, { status: st }, 'return=minimal');
        await log('발주 상태 변경', `${oid} → ${st}`);
        return ok({ ok: true });
      } catch (e) { return err({ error: e.message }, 500); }
    }

    return err({ error: 'not found' }, 404);
  }

  /* ── fetch 가로채기 ─────────────────────────────────────── */
  window.fetch = async function (input, init) {
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    if (!/^\/api\//.test(url)) return realFetch(input, init);

    const [path, query] = url.split('?');
    const qs = new URLSearchParams(query || '');
    const method = ((init && init.method) || 'GET').toUpperCase();
    let body = {};
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) { body = {}; } }

    try {
      return method === 'GET' ? await handleGet(path, qs) : await handlePost(path, qs, body);
    } catch (e) {
      if (e && e.message === EXPIRED) {
        return err({ error: '로그인이 만료되었습니다. 다시 로그인해 주세요.' }, 401);
      }
      console.error('[MES]', path, e);
      return err({ error: e.message || String(e) }, 500);
    }
  };

  /* ── 화면이 고른 파일 붙잡기 ─────────────────────────────────
     화면 코드는 파일을 FormData 로 보내는데, 웹 버전은 서버가 없어서
     그걸 받을 곳이 없다. 대신 파일 선택 자체를 여기서 엿듣는다.
     덕분에 mes.html 을 고치지 않아도 된다. */
  if (typeof document !== 'undefined') {
    document.addEventListener('change', e => {
      const t = e.target;
      if (t && t.type === 'file' && t.files && t.files.length) {
        window.MES_PENDING_FILE = t.files[0];
      }
    }, true);
  }

  window.MES_SUPA = {
    db, log, askClaude, runRebuild, listTemplates,
    session: () => SESSION, snapshot: () => SNAPSHOT, job: () => JOB,
  };
})();
