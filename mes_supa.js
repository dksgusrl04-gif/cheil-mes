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

  /* 로그인 상태 — 새로고침해도 유지되도록 localStorage 에 둔다 */
  const SESSION_KEY = 'mes_session';
  let SESSION = null;
  try { SESSION = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { SESSION = null; }

  let SNAPSHOT = null;          // 집계본 (한 번 받아 계속 쓴다)
  let LOADED = false;

  function saveSession(s) {
    SESSION = s;
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }

  function headers(json) {
    const h = { apikey: KEY };
    if (SESSION && SESSION.access_token) h.Authorization = 'Bearer ' + SESSION.access_token;
    else h.Authorization = 'Bearer ' + KEY;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async function db(method, path, body, prefer) {
    const opt = { method, headers: headers(!!body) };
    if (prefer) opt.headers.Prefer = prefer;
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await realFetch(REST + path, opt);
    const txt = await r.text();
    if (!r.ok) {
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
        return ok({
          log: rows, store: { backend: 'Supabase', online: true, url: REST },
          agent: { provider: '웹 버전 미지원', online: false, model: null },
        });
      }
      // 웹에서는 안 되는 것들 — 화면이 깨지지 않게 빈 응답을 준다
      case path === '/api/uploads':
        return ok({
          files: [], standard: {},
          rebuild: { running: false, lines: [], pandas: false, code: null },
          built: (SNAPSHOT && SNAPSHOT.built) || '',
          sources: (SNAPSHOT && SNAPSHOT.sources) || [],
          web: true,
        });
      case path === '/api/rebuild/status':
        return ok({ running: false, lines: [], code: null, pandas: false });
      case path === '/api/reports':
        return ok({ templates: window.MES_TEMPLATES || [], dir: 'templates', allowed: [] });
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

    if (path === '/api/ask') {
      return err({
        error: '웹 버전에서는 질의 기능을 쓸 수 없습니다',
        hint: 'Claude API 키를 브라우저에 두면 노출되기 때문입니다. 현장 서버에서 사용하세요.',
      }, 501);
    }
    if (path === '/api/rebuild') {
      return err({
        error: '웹 버전에서는 재집계를 할 수 없습니다',
        hint: '현장 PC 에서 mes_rebuild.py 실행 후 upload_snapshot.py 로 올리세요.',
      }, 501);
    }
    if (path === '/api/upload' || path === '/api/upload/confirm') {
      return err({ error: '웹 버전에서는 파일 업로드를 쓸 수 없습니다' }, 501);
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
      console.error('[MES]', path, e);
      return err({ error: e.message || String(e) }, 500);
    }
  };

  window.MES_SUPA = { db, log, session: () => SESSION, snapshot: () => SNAPSHOT };
})();
