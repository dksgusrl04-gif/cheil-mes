/* ═══════════════════════════════════════════════════════════════
 * 종합 대시보드 — 주차별 추이 · 이상 급증 · 구간 버튼
 * ═══════════════════════════════════════════════════════════════
 * 흩어져 있는 것을 한 화면에 모은다. 사람이 제일 먼저 알고 싶은 것은
 * "지금 이상한 데가 있나" 이고, 그다음이 "추세가 어떤가" 다. 그 순서로 놓는다.
 *
 * 그림은 전부 직접 그린 SVG 다. 외부 라이브러리를 쓰면 인터넷이 끊긴
 * 공장에서 화면이 비어 버린다.
 *
 * mes.html 은 고치지 않는다. 상단 메뉴에 버튼 하나를 붙이고,
 * 눌렀을 때 화면 영역만 우리가 그린다.
 *
 * 판정 규칙은 전부 여기 적어 둔다 — 왜 경고가 떴는지 사람이 따라올 수 있어야 한다.
 */
(function (root) {
  'use strict';

  /* ── 이상 판정 기준 ──────────────────────────────────────────
     시간당 마모량(raw ÷ 절삭시간)을 본다. 그냥 마모량을 보면 오래 돌린 날이
     무조건 커져서 '많이 돌렸다' 와 '이상하다' 를 구분 못 한다. */
  const RULES = {
    lookback: 5,        // 직전 며칠을 정상 범위로 볼 것인가
    spike: 1.8,         // 그 중앙값의 몇 배부터 급증인가
    drop: 0.45,         // 몇 배 아래부터 급감인가
    minHours: 0.05,     // 이보다 적게 돈 날은 판정하지 않는다 (표본이 모자람)
  };

  /* 일자 한 줄에서 '그날 닳은 양' 을 꺼낸다.

     자리에 따라 이름이 다르다 — 집계본에는 원시값 raw 로, 화면 조회(/api/overview)
     에는 기준을 적용한 마모율 wear 로 들어 있다. 둘은 상수배 관계라 급증 판정
     결과는 같지만, 화면에는 사람이 보는 값(wear) 을 쓰는 편이 낫다. */
  const val = d => (d && d.wear != null ? d.wear : ((d && d.raw) || 0));

  const median = a => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const f2 = v => (v == null ? '-' : (+v).toFixed(2));
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ── 주차별로 묶기 ───────────────────────────────────────────
     월요일 시작. 실제 조업 주와 맞춰야 사람이 읽는다.

     날짜 계산은 반드시 UTC 로 해야 한다. toISOString() 은 UTC 로 바꿔서 내주는데,
     한국(UTC+9)에서 만든 자정 시각을 그렇게 돌리면 전날이 되어 주차가 하루씩
     밀린다. 브라우저 시간대에 따라 값이 달라지면 안 된다. */
  function weekKey(dateStr) {
    const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
    const t = Date.UTC(y, m - 1, d);
    const dow = (new Date(t).getUTCDay() + 6) % 7;      // 월=0
    return new Date(t - dow * 86400000).toISOString().slice(0, 10);
  }
  function weeks(days) {
    const m = new Map();
    for (const d of (days || [])) {
      const k = weekKey(d.date);
      let w = m.get(k);
      if (!w) { w = { week: k, days: [], raw: 0, cut_h: 0, rows: 0, parts: 0 }; m.set(k, w); }
      w.days.push(d.date);
      w.raw += val(d);
      w.cut_h += d.cut_h || 0;
      w.rows += d.rows || 0;
      w.parts += d.parts || 0;
    }
    const out = Array.from(m.values()).sort((a, b) => (a.week < b.week ? -1 : 1));
    out.forEach(w => {
      w.perH = w.cut_h > 0 ? w.raw / w.cut_h : 0;
      w.from = w.days[0];
      w.to = w.days[w.days.length - 1];
      w.label = `${w.from.slice(5)}~${w.to.slice(5)}`;
    });
    return out;
  }

  /* ── 이상한 날 찾기 ──────────────────────────────────────────
     직전 며칠의 시간당 마모량 중앙값을 정상으로 보고, 거기서 얼마나
     벗어났는지로 판정한다. 평균이 아니라 중앙값을 쓰는 이유는
     하루 튄 값에 기준 자체가 끌려가면 안 되기 때문이다. */
  function anomalies(days, opt) {
    const R = Object.assign({}, RULES, opt || {});
    const D = (days || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const out = [];

    for (let i = 0; i < D.length; i++) {
      const d = D[i];
      const perH = d.cut_h > 0 ? val(d) / d.cut_h : 0;

      /* 돌긴 돌았는데 절삭이 없는 날 — 설비가 섰거나 수집이 끊긴 것이다 */
      if ((d.rows || 0) > 0 && !(d.cut_h > 0)) {
        out.push({
          date: d.date, kind: 'idle', level: 'warn',
          title: '절삭 없음',
          why: `수집은 ${(d.rows || 0).toLocaleString()}행 되었는데 절삭 시간이 0입니다. `
            + '설비가 섰거나 공구 정보가 안 잡힌 날입니다.',
          value: 0, base: null, ratio: null,
        });
        continue;
      }
      if (!(d.cut_h >= R.minHours)) continue;      // 너무 짧게 돈 날은 판정 보류

      const prev = D.slice(Math.max(0, i - R.lookback), i)
        .filter(x => x.cut_h >= R.minHours)
        .map(x => val(x) / x.cut_h);
      if (prev.length < 2) continue;               // 비교할 이력이 모자람
      const base = median(prev);
      if (!(base > 0)) continue;
      const ratio = perH / base;

      if (ratio >= R.spike) {
        out.push({
          date: d.date, kind: 'spike', level: ratio >= R.spike * 1.5 ? 'danger' : 'warn',
          title: '마모 급증',
          why: `시간당 마모량이 직전 ${prev.length}일 중앙값의 ${f2(ratio)}배입니다. `
            + `절삭 ${f2(d.cut_h)}h 동안 평소보다 빨리 닳았습니다.`,
          value: perH, base: base, ratio: ratio,
        });
      } else if (ratio <= R.drop) {
        out.push({
          date: d.date, kind: 'drop', level: 'info',
          title: '마모 급감',
          why: `시간당 마모량이 직전 ${prev.length}일 중앙값의 ${f2(ratio)}배로 떨어졌습니다. `
            + '가공 내용이 바뀌었거나 공구를 교체했을 수 있습니다.',
          value: perH, base: base, ratio: ratio,
        });
      }
    }
    return out.reverse();                          // 최근 것을 위로
  }

  /* ── 막대 + 꺾은선 그림 ──────────────────────────────────────
     주차별 마모량(막대)과 절삭시간(선)을 겹쳐 본다.
     마모가 늘었을 때 '많이 돌려서' 인지 '빨리 닳아서' 인지 갈라 보려는 것이다. */
  function chartSVG(rows, opt) {
    opt = opt || {};
    const W = opt.width || 720, H = opt.height || 210;
    const P = { t: 14, r: 46, b: 34, l: 48 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    if (!rows.length) {
      return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
        <text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#98a6b2"
          font-size="13">표시할 자료가 없습니다</text></svg>`;
    }
    const maxRaw = Math.max(...rows.map(r => r.raw), 1e-12);
    const maxH = Math.max(...rows.map(r => r.cut_h), 1e-12);
    const n = rows.length;
    const bw = Math.min(52, iw / n * 0.62);
    const cx = i => P.l + iw * (i + 0.5) / n;
    const by = v => P.t + ih - ih * (v / maxRaw);
    const ly = v => P.t + ih - ih * (v / maxH);

    const bars = rows.map((r, i) => {
      const h = Math.max(1, ih * (r.raw / maxRaw));
      const hot = opt.hot && opt.hot.has(r.week);
      return `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${(P.t + ih - h).toFixed(1)}"
        width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"
        fill="${hot ? '#e8b4b8' : '#c7d7ea'}" stroke="${hot ? '#c0392b' : '#9fb6cf'}"
        stroke-width="${hot ? 1.4 : 0.8}"><title>${esc(r.label)}
마모량 ${r.raw.toFixed(6)}
절삭 ${f2(r.cut_h)}h
시간당 ${r.perH.toFixed(6)}</title></rect>`;
    }).join('');

    const pts = rows.map((r, i) => `${cx(i).toFixed(1)},${ly(r.cut_h).toFixed(1)}`).join(' ');
    const dots = rows.map((r, i) =>
      `<circle cx="${cx(i).toFixed(1)}" cy="${ly(r.cut_h).toFixed(1)}" r="3.2"
        fill="#fff" stroke="#1b365d" stroke-width="1.6"/>`).join('');

    const grid = [0, 0.5, 1].map(f => {
      const y = P.t + ih - ih * f;
      return `<line x1="${P.l}" y1="${y}" x2="${P.l + iw}" y2="${y}"
        stroke="#eef2f6" stroke-width="1"/>
        <text x="${P.l - 7}" y="${y + 3.5}" text-anchor="end" font-size="9.5"
          fill="#98a6b2">${(maxRaw * f).toFixed(3)}</text>
        <text x="${P.l + iw + 7}" y="${y + 3.5}" font-size="9.5"
          fill="#7f96ad">${(maxH * f).toFixed(1)}h</text>`;
    }).join('');

    const labels = rows.map((r, i) =>
      `<text x="${cx(i).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="9.5"
        fill="#6b7d8c">${esc(r.label)}</text>`).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="주차별 마모량과 절삭시간">
      ${grid}${bars}
      <polyline points="${pts}" fill="none" stroke="#1b365d" stroke-width="1.8"/>
      ${dots}${labels}
    </svg>`;
  }

  /* ── 일자별 잔선 — 이상한 날에 표시를 찍는다 ───────────────── */
  function sparkSVG(days, marks, opt) {
    opt = opt || {};
    const W = opt.width || 720, H = opt.height || 116;
    /* 높이를 넉넉히 주면 위아래 여백도 같이 키운다. 안 그러면 선만 늘어나
       옆 그래프와 나란히 뒀을 때 눈금이 붕 떠 보인다. */
    const pad = H > 160 ? 22 : 12;
    const P = { t: pad, r: 12, b: pad + 10, l: 48 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const D = (days || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    if (D.length < 2) {
      return `<svg viewBox="0 0 ${W} ${H}" width="100%"><text x="${W / 2}" y="${H / 2}"
        text-anchor="middle" fill="#98a6b2" font-size="13">일자가 부족합니다</text></svg>`;
    }
    const per = D.map(d => (d.cut_h > 0 ? val(d) / d.cut_h : 0));
    const mx = Math.max(...per, 1e-12);
    const x = i => P.l + iw * i / (D.length - 1);
    const y = v => P.t + ih - ih * (v / mx);
    const M = new Map((marks || []).map(m => [m.date, m]));

    const line = D.map((d, i) => `${x(i).toFixed(1)},${y(per[i]).toFixed(1)}`).join(' ');
    const area = `${P.l},${P.t + ih} ${line} ${(P.l + iw).toFixed(1)},${P.t + ih}`;
    const dots = D.map((d, i) => {
      const m = M.get(d.date);
      if (!m) return '';
      const col = m.level === 'danger' ? '#c0392b' : m.level === 'warn' ? '#d68910' : '#5a7fa6';
      return `<circle cx="${x(i).toFixed(1)}" cy="${y(per[i]).toFixed(1)}" r="4.5"
        fill="${col}" stroke="#fff" stroke-width="1.6"><title>${esc(d.date)} · ${esc(m.title)}
${esc(m.why)}</title></circle>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="일자별 시간당 마모량">
      <polygon points="${area}" fill="#eaf1f8"/>
      <polyline points="${line}" fill="none" stroke="#5a7fa6" stroke-width="1.6"/>
      ${dots}
      <text x="${P.l - 7}" y="${P.t + 4}" text-anchor="end" font-size="9.5"
        fill="#98a6b2">${mx.toFixed(4)}</text>
      <text x="${P.l - 7}" y="${P.t + ih + 3}" text-anchor="end" font-size="9.5" fill="#98a6b2">0</text>
      <text x="${P.l}" y="${H - 7}" font-size="9.5" fill="#6b7d8c">${esc(D[0].date)}</text>
      <text x="${P.l + iw}" y="${H - 7}" text-anchor="end" font-size="9.5"
        fill="#6b7d8c">${esc(D[D.length - 1].date)}</text>
    </svg>`;
  }

  /* ═══════════════════════════════════════════════════════════════
   * 화면 — 상단 메뉴에 «종합» 을 붙이고 눌리면 여기서 그린다
   * ═══════════════════════════════════════════════════════════════ */
  const CSS = `
  #mesdash .row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px}
  #mesdash .box{background:#fff;border:1px solid #e2e8ee;border-radius:8px;padding:14px 16px}
  #mesdash .box.grow{flex:1 1 340px;min-width:0}
  /* 그래프 두 개를 한 줄에. 화면이 좁으면 알아서 위아래로 내려간다. */
  #mesdash .row.two > .box{display:flex;flex-direction:column}
  #mesdash .row.two > .box .hint{margin-top:auto}
  @media (max-width:860px){ #mesdash .row.two > .box{flex:1 1 100%} }
  #mesdash h4 .sub{font-weight:400;color:#8c9ba5;margin-left:6px}
  #mesdash h4{font-size:12.5px;color:#41525f;margin:0 0 10px;font-weight:600}
  #mesdash .hint{font-size:11px;color:#8c9ba5;margin-top:8px;line-height:1.65}
  #mesdash .an{display:flex;gap:10px;align-items:flex-start;padding:9px 0;
    border-bottom:1px solid #f0f3f6}
  #mesdash .an:last-child{border-bottom:0}
  #mesdash .an .d{font-size:11.5px;color:#41525f;font-weight:600;min-width:78px}
  #mesdash .an .t{font-size:12px;font-weight:600;min-width:70px}
  #mesdash .an .w{font-size:11.5px;color:#6b7d8c;line-height:1.6;flex:1}
  #mesdash .an.danger .t{color:#c0392b}
  #mesdash .an.warn .t{color:#b9770e}
  #mesdash .an.info .t{color:#5a7fa6}
  #mesdash .segbtns{display:flex;gap:7px;flex-wrap:wrap}
  #mesdash .segbtns button, #basis .segbtns button{
    font:inherit;font-size:12px;padding:6px 13px;border:1px solid #c3ced8;border-radius:6px;
    background:#fff;color:#41525f;cursor:pointer;transition:all .12s}
  #mesdash .segbtns button:hover, #basis .segbtns button:hover{
    background:#eef3fa;border-color:#9fb6cf}
  #mesdash .segbtns button[data-on], #basis .segbtns button[data-on]{
    background:#1b365d;border-color:#1b365d;color:#fff;font-weight:600}
  #basis .segbtns{display:flex;gap:6px;align-items:center}
  `;
  function addCss() {
    if (document.getElementById('mesdash-style')) return;
    const s = document.createElement('style');
    s.id = 'mesdash-style'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  const $ = id => document.getElementById(id);
  let ACTIVE = false;

  const q = () => (typeof window.qs === 'function' ? window.qs() : '');
  const get = p => fetch(p + (p.includes('?') ? '&' : '?') + q()).then(r => r.json());

  /* ── 구간을 버튼으로 ─────────────────────────────────────────
     기준 막대의 구간 드롭다운은 눌러야 열리고 골라야 닫힌다.
     구간은 두세 개뿐이라 버튼으로 두면 한 번에 바뀐다. */
  function segButtons(where, B) {
    const list = (B && B.segments) || [];
    if (!list.length) return '';
    return `<div class="segbtns">` + list.map(s =>
      `<button type="button" data-seg="${esc(s.key)}"
        ${s.key === B.segment ? 'data-on="1"' : ''}
        title="${esc(s.period || '')} · 공구 ${s.tools}종 · 절삭 ${f2(s.hours)}h"
      >${esc(s.label)}</button>`).join('') + `</div>`;
  }
  function wireSegButtons(scope) {
    (scope || document).querySelectorAll('[data-seg]').forEach(b => {
      if (b.dataset.mesWired) return;
      b.dataset.mesWired = '1';
      b.addEventListener('click', () => {
        const sel = $('b_seg');
        if (sel) { sel.value = b.dataset.seg; }
        if (typeof window.setBasis === 'function') window.setBasis();
        else if (typeof window.reload === 'function') window.reload();
        if (ACTIVE) setTimeout(draw, 60);
      });
    });
  }

  /* 기준 막대에도 구간 버튼을 달아 둔다 — 어느 탭에서든 바로 바꿀 수 있게 */
  function ensureBasisSegButtons(B) {
    const basis = $('basis');
    if (!basis || !B || !B.segments) return;
    let box = basis.querySelector('.segbtns');
    if (!box) {
      const wrap = document.createElement('div');
      wrap.className = 'bset';
      wrap.innerHTML = '<span>구간 바로가기</span>' + segButtons('basis', B);
      const note = $('bnote');
      if (note && note.parentNode === basis) basis.insertBefore(wrap, note);
      else basis.appendChild(wrap);
      box = wrap.querySelector('.segbtns');
    } else {
      box.querySelectorAll('[data-seg]').forEach(b => {
        if (b.dataset.seg === B.segment) b.setAttribute('data-on', '1');
        else b.removeAttribute('data-on');
      });
    }
    wireSegButtons(basis);
  }

  async function draw() {
    const main = $('main'), side = $('side');
    if (!main) return;
    addCss();
    main.innerHTML = '<div id="mesdash"><div class="box">불러오는 중…</div></div>';

    let ov, tools;
    try {
      ov = await get('/api/overview');
      tools = await get('/api/tools');
    } catch (e) {
      main.innerHTML = `<div id="mesdash"><div class="box">불러오지 못했습니다 — ${esc(e.message)}</div></div>`;
      return;
    }
    const B = ov.basis || {};
    const days = ov.days || [];
    const W = weeks(days);
    const A = anomalies(days);
    const hot = new Set(A.filter(a => a.level !== 'info').map(a => weekKey(a.date)));

    const over = tools.filter(t => (t.wear || 0) >= 70);
    const worst = tools[0];
    const lastW = W[W.length - 1], prevW = W[W.length - 2];
    const trend = (lastW && prevW && prevW.perH > 0)
      ? (lastW.perH / prevW.perH - 1) * 100 : null;

    const card = (k, v, u, cls) =>
      `<div class="card ${cls || ''}"><div class="k">${esc(k)}</div>
        <div class="v">${esc(v)}<span class="u">${esc(u || '')}</span></div></div>`;

    main.innerHTML = `<div id="mesdash">
      <h2>종합 대시보드</h2>
      <div class="desc">${esc(B.segment_label || '')} · ${esc(B.segment_period || '')}
        ${B.sliced ? ` · <b>${esc(B.from)} 이후</b>` : ''}</div>

      <div class="row">${segButtons('main', B)}</div>

      <div class="cards" style="margin-bottom:14px">
        ${card('이상 징후', A.filter(a => a.level !== 'info').length, '건',
          A.some(a => a.level === 'danger') ? 'warn' : (A.length ? '' : 'ok'))}
        ${card('마모율 70% 이상', over.length, '종', over.length ? 'warn' : 'ok')}
        ${card('최근 주 시간당 마모', lastW ? lastW.perH.toFixed(5) : '-', '',
          trend != null && trend > 20 ? 'warn' : '')}
        ${card('전주 대비', trend == null ? '-' : (trend >= 0 ? '+' : '') + trend.toFixed(1), '%',
          trend != null && trend > 20 ? 'warn' : '')}
        ${card('절삭 시간', f2(B.observed_hours), 'h')}
        ${card('공구', tools.length, '종')}
      </div>

      <div class="row two">
        <div class="box grow">
          <h4>주차별 추이 <span class="sub">막대 = 마모량 · 선 = 절삭시간</span></h4>
          ${chartSVG(W, { hot, width: 520, height: 236 })}
          <div class="hint">막대만 높으면 <b>많이 돌려서</b>, 선은 그대로인데 막대가 솟으면
            <b>같은 시간에 더 빨리</b> 닳은 것입니다. 후자가 의심할 자리입니다.
            붉은 막대는 이상 징후가 있던 주입니다.</div>
        </div>
        <div class="box grow">
          <h4>일자별 시간당 마모량 <span class="sub">점 = 이상 징후</span></h4>
          ${sparkSVG(days, A, { width: 520, height: 236 })}
          <div class="hint">시간당으로 보는 이유는 오래 돌린 날이 무조건 커 보이는 것을
            걷어내기 위해서입니다. 점에 마우스를 올리면 판정 근거가 나옵니다.</div>
        </div>
      </div>

      <div class="row">
        <div class="box grow">
          <h4>이상 징후 ${A.length ? `(${A.length})` : ''}</h4>
          ${A.length ? A.map(a => `<div class="an ${a.level}">
              <div class="d">${esc(a.date)}</div>
              <div class="t">${esc(a.title)}</div>
              <div class="w">${esc(a.why)}</div>
            </div>`).join('')
            : '<div class="hint">직전 며칠과 견줘 크게 벗어난 날이 없습니다.</div>'}
          <div class="hint">판정 — 시간당 마모량이 직전 ${RULES.lookback}일 중앙값의
            <b>${RULES.spike}배 이상</b>이면 급증, <b>${RULES.drop}배 이하</b>면 급감입니다.
            평균이 아니라 중앙값을 쓰는 이유는 하루 튄 값에 기준이 끌려가지 않게 하려는 것입니다.
            절삭 ${RULES.minHours}h 미만인 날은 표본이 모자라 판정하지 않습니다.</div>
        </div>
      </div>
    </div>`;

    if (side) {
      side.innerHTML = `<h3>주차 요약</h3>` +
        (W.length ? W.slice().reverse().map(w =>
          `<div class="item">${esc(w.label)}<span class="m">${f2(w.cut_h)}h ·
            시간당 ${w.perH.toFixed(5)}</span></div>`).join('')
          : '<div class="item muted">자료 없음</div>') +
        `<h3>가장 닳은 공구</h3>` +
        (worst ? `<div class="item">T${worst.tool} ${esc(worst.name)}
          <span class="m">마모율 ${f2(worst.wear)}% · 사용강도 ${f2(worst.intensity)}배</span></div>`
          : '<div class="item muted">자료 없음</div>');
    }

    wireSegButtons(main);
    ensureBasisSegButtons(B);
  }

  /* 상단 메뉴에 버튼 하나를 붙인다. 원래 있던 버튼들은 화면 코드가
     자기 핸들러를 달아 두었으므로, 우리 버튼만 우리가 맡는다. */
  function addTab() {
    const nav = document.querySelector('nav');
    if (!nav || $('mesdash-tab')) return;
    const first = nav.querySelector('button');
    const b = document.createElement('button');
    b.id = 'mesdash-tab';
    b.textContent = '종합';
    b.addEventListener('click', () => {
      nav.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      ACTIVE = true;
      draw();
    });
    nav.insertBefore(b, first ? first.nextSibling : null);

    /* 다른 탭을 누르면 우리 화면은 접는다 */
    nav.querySelectorAll('button').forEach(x => {
      if (x === b) return;
      x.addEventListener('click', () => { ACTIVE = false; }, true);
    });
  }

  let tries = 0;
  function start() {
    addTab();
    /* 기준 막대의 구간 버튼은 종합 탭이 아니어도 쓸 수 있게 미리 붙여 둔다 */
    if (window.BASIS) { addCss(); ensureBasisSegButtons(window.BASIS); }
    if ($('mesdash-tab') && window.BASIS) return;
    if (++tries > 80) return;
    setTimeout(start, 250);
  }

  /* 계산 부분(주차 묶기·이상 감지·그림)은 화면 없이도 돌아야 한다.
     그래야 브라우저 없이 시험할 수 있고, 숫자를 따로 검증할 수 있다. */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  const api = {
    weeks, anomalies, chartSVG, sparkSVG, weekKey, median, RULES,
    draw, active: () => ACTIVE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MESDASH = api;
})(typeof self !== 'undefined' ? self : this);
