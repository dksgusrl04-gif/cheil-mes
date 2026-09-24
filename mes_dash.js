/* ═══════════════════════════════════════════════════════════════
 * 종합 대시보드 — 주차별 추이 · 이상 급증 · 구간 버튼
 * ═══════════════════════════════════════════════════════════════
 * 흩어져 있는 것을 한 화면에 모은다. 사람이 제일 먼저 알고 싶은 것은
 * "지금 이상한 데가 있나" 이고, 그다음이 "추세가 어떤가" 다. 그 순서로 놓는다.
 *
 * 그림은 전부 직접 그린 SVG 다. 외부 라이브러리를 쓰면 인터넷이 끊긴
 * 공장에서 화면이 비어 버린다.
 *
 * mes.html 은 고치지 않는다. 왼쪽 메뉴 기둥에 버튼 하나를 붙이고,
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
      if (!w) { w = { week: k, days: [], states: [], raw: 0, cut_h: 0, rows: 0, parts: 0 }; m.set(k, w); }
      w.days.push(d.date);
      if (d.states) w.states.push(d.states);   // 가동 상태 그림이 쓴다
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
      /* 08-06~08-09 처럼 길게 적으면 주가 예닐곱 개만 돼도 축에서 겹친다.
         끝 날짜는 «일» 만 적는다 — 같은 달인 경우가 대부분이다. */
      w.label = w.from.slice(0, 2) === w.to.slice(0, 2) || w.from.slice(5, 7) === w.to.slice(5, 7)
        ? `${w.from.slice(5)}~${w.to.slice(8)}`
        : `${w.from.slice(5)}~${w.to.slice(5)}`;
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

    /* 안 돌린 날을 모았다가 끊길 때 한 건으로 내놓는다 */
    let idle = [];
    const flushIdle = () => {
      if (!idle.length) return;
      const a = idle[0], z = idle[idle.length - 1];
      const rows = idle.reduce((t, x) => t + (x.rows || 0), 0);
      out.push({
        date: z.date, kind: 'idle', level: 'info',
        days: idle.length,
        title: idle.length > 1 ? `절삭 없음 ${idle.length}일` : '절삭 없음',
        why: (idle.length > 1 ? `${a.date} ~ ${z.date} ` : `${z.date} `)
          + `수집은 ${rows.toLocaleString()}행 되었는데 절삭 시간이 0입니다. `
          + '주말·휴무이거나, 설비가 섰거나, 공구 정보가 안 잡힌 날입니다.',
        value: 0, base: null, ratio: null,
      });
      idle = [];
    };

    for (let i = 0; i < D.length; i++) {
      const d = D[i];
      const perH = d.cut_h > 0 ? val(d) / d.cut_h : 0;

      /* 돌긴 돌았는데 절삭이 없는 날. 낱개로 올리지 않는다 — 43일 중 17일이
         주말·휴무라, 하루씩 올리면 경보 열일곱 건이 전부 «주말» 이 되고
         진짜 급증이 그 사이에 묻힌다. 연속 구간을 하나로 묶어 «며칠간» 으로
         보고하고, 단계도 «안내» 로 둔다. 안 돌린 것은 이상이 아니다. */
      if ((d.rows || 0) > 0 && !(d.cut_h > 0)) {
        idle.push(d);
        continue;
      }
      flushIdle();
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
    flushIdle();                                   // 마지막까지 안 돌았으면
    return out.reverse();                          // 최근 것을 위로
  }

  /* ── 색 ──────────────────────────────────────────────────────
     그림 색을 코드에 박아 두면 화면 색을 바꿀 때마다 여기가 남는다.
     mes.html 의 :root 변수를 읽어 쓰고, 없으면 기본값으로 떨어진다.
     그래서 «마모율 게이지와 그래프가 다른 파랑» 같은 일이 안 생긴다. */
  const FALLBACK = {
    '--accent': '#004EA1', '--chart-bar': '#6E9FD6', '--chart-area': '#E6EFFA',
    '--chart-grid': '#F1F4F7', '--chart-axis': '#94A3B8', '--chart-label': '#64748B',
    '--danger': '#DC2626', '--danger-soft': '#F3C7C7', '--warn': '#EC6E00',
    '--surface': '#FFFFFF',
  };
  let _pal = null;
  function pal() {
    if (_pal) return _pal;
    _pal = {};
    let cs = null;
    try {
      if (typeof getComputedStyle === 'function' && document.documentElement) {
        cs = getComputedStyle(document.documentElement);
      }
    } catch (e) { cs = null; }
    for (const k of Object.keys(FALLBACK)) {
      const v = cs ? String(cs.getPropertyValue(k) || '').trim() : '';
      _pal[k] = v || FALLBACK[k];
    }
    return _pal;
  }
  /* 화면 색이 바뀌면(테마 교체 등) 다시 읽는다 */
  function resetPal() { _pal = null; }

  /* ── 눈금 읽기 좋게 ──────────────────────────────────────────
     0.00042 같은 값을 축에 그대로 적으면 아무도 못 읽는다. 10의 거듭제곱을
     뽑아 «0.42» 로 적고 단위를 따로 밝힌다. 공학 표기(3의 배수)로 맞춘다. */
  const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴',
                5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const sup = n => String(n).split('').map(c => SUP[c] || c).join('');

  function scaleOf(max) {
    if (!(max > 0) || !isFinite(max)) return { mul: 1, unit: '' };
    const e = Math.floor(Math.log10(max));
    if (e >= 0) return { mul: 1, unit: '' };
    const k = Math.ceil(-e / 3) * 3;          // 3, 6, 9 …
    return { mul: Math.pow(10, k), unit: `10${sup(-k)}` };
  }

  /* 축 끝을 «보기 좋은 수» 로 올린다 — 0.42 대신 0.5 에서 끝나게 */
  function niceMax(v) {
    if (!(v > 0) || !isFinite(v)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v))), m = v / e;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e;
  }

  const empty = (W, H, msg) =>
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
      <text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${pal()['--chart-axis']}"
        font-size="13">${esc(msg)}</text></svg>`;


  /* ── 주차별 가동 상태 ─────────────────────────────────────────
     시간당 마모량 막대는 주마다 값이 367~391 로 거의 같아서, 막대 예닐곱
     개가 전부 같은 높이로 보였다. 값이 안 변하는 것을 막대로 그리면
     «다 통합돼 보이는» 그림이 된다.

     그래서 잘라 본다. 설비가 그 주에 무엇을 했는지 — 깎았나, 돌기만 했나,
     서 있었나 — 는 주마다 크게 다르고, 그게 마모량보다 먼저 알고 싶은 것이다.
     누적 막대 한 칸이 곧 그 주의 하루 구성이 된다.

     세 갈래로 묶는다. 여섯 갈래를 다 그리면 얇은 띠가 넷 생겨 안 읽힌다.
       절삭   — 실제로 깎은 시간 (여기서만 공구가 닳는다)
       공회전 — 돌고는 있는데 안 깎는 시간
       멈춤   — 정지·일시정지·비상정지·미연결 */
  const ST_GROUP = [
    ['절삭', ['가동중·절삭'], '--accent'],
    ['공회전', ['가동중·공회전'], null],          // 중간색은 아래에서 만든다
    ['멈춤', ['정지', '일시정지', '비상정지', '미연결'], null],
  ];

  function statesSVG(rows, opt) {
    opt = opt || {};
    const W = opt.width || 720, H = opt.height || 236;
    if (!rows.length) return empty(W, H, '표시할 자료가 없습니다');
    const C = pal();
    const FILL = [C['--accent'], '#9FB8D4', '#DFE5EC'];

    /* 주차마다 세 갈래 시간을 더한다 */
    const data = rows.map(r => {
      const g = [0, 0, 0];
      (r.states || []).forEach(st => {
        Object.keys(st || {}).forEach(k => {
          const i = ST_GROUP.findIndex(x => x[1].indexOf(k) >= 0);
          if (i >= 0) g[i] += st[k] || 0;
        });
      });
      return { label: r.label, g, tot: g[0] + g[1] + g[2] };
    });
    const maxT = Math.max(...data.map(d => d.tot), 1e-9);
    if (!(maxT > 1e-6)) return empty(W, H, '가동 기록이 없습니다');

    const P = { t: 34, r: 16, b: 48, l: 54 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const n = data.length;
    const top = niceMax(maxT);
    const bw = Math.min(46, iw / n * 0.58);
    const cx = i => P.l + iw * (i + 0.5) / n;
    const y = v => P.t + ih - ih * (v / top);

    const grid = [0, 0.5, 1].map(f => {
      const yy = y(top * f);
      return `<line x1="${P.l}" y1="${yy.toFixed(1)}" x2="${(P.l + iw).toFixed(1)}"
        y2="${yy.toFixed(1)}" stroke="${C['--chart-grid']}" stroke-width="1"/>
        <text x="${P.l - 9}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11"
          fill="${C['--chart-axis']}">${(top * f).toFixed(0)}</text>`;
    }).join('');

    const bars = data.map((d, i) => {
      let acc = 0;
      const seg = d.g.map((v, k) => {
        if (!(v > 0)) return '';
        const y0 = y(acc + v), h = Math.max(1, ih * (v / top));
        acc += v;
        return `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${y0.toFixed(1)}"
          width="${bw.toFixed(1)}" height="${h.toFixed(1)}"
          rx="${k === 2 ? 2 : 0}" fill="${FILL[k]}"
          ><title>${esc(d.label)} · ${ST_GROUP[k][0]} ${v.toFixed(1)}h
전체 ${d.tot.toFixed(1)}h 중 ${(100 * v / d.tot).toFixed(1)}%</title></rect>`;
      }).join('');
      /* 막대 위에는 «절삭 비율» — 이 그림에서 제일 알고 싶은 한 수다 */
      const pct = d.tot > 0 ? 100 * d.g[0] / d.tot : 0;
      const lab = d.tot > 0
        ? `<text x="${cx(i).toFixed(1)}" y="${(y(d.tot) - 8).toFixed(1)}"
            text-anchor="middle" font-size="11.5" font-weight="650"
            fill="${C['--accent']}">${pct.toFixed(0)}%</text>` : '';
      return seg + lab;
    }).join('');

    const labels = data.map((d, i) =>
      `<text x="${cx(i).toFixed(1)}" y="${H - 26}" text-anchor="middle" font-size="11"
        fill="${C['--chart-label']}">${esc(d.label)}</text>
       <text x="${cx(i).toFixed(1)}" y="${H - 11}" text-anchor="middle" font-size="10.5"
        fill="${C['--chart-axis']}">${d.tot.toFixed(0)}h</text>`).join('');

    /* 범례는 그림 위에. 색이 셋뿐이라 옆에 두면 자리만 먹는다 */
    let lx = P.l;
    const legend = ST_GROUP.map(([nm], k) => {
      const t = `<rect x="${lx}" y="${P.t - 22}" width="9" height="9" rx="2" fill="${FILL[k]}"/>
        <text x="${lx + 13}" y="${P.t - 14}" font-size="10.5"
          fill="${C['--chart-label']}">${nm}</text>`;
      lx += 13 + nm.length * 11 + 14;
      return t;
    }).join('');

    const yl = `<text x="${(P.l + iw).toFixed(1)}" y="${P.t - 14}" text-anchor="end"
      font-size="10.5" fill="${C['--chart-axis']}">시간 · 막대 위는 절삭 비율</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="주차별 가동 상태">
      ${grid}${legend}${yl}${bars}${labels}
    </svg>`;
  }

  /* ── 주차별 시간당 마모량 ─────────────────────────────────────
     예전에는 «막대 = 마모량, 선 = 절삭시간» 두 축을 한 그림에 겹쳐 놨다.
     두 축을 겹치면 눈금을 어떻게 잡느냐에 따라 선이 막대 위로도 아래로도
     가서, 교차점이 아무 뜻이 없다. 보고서에서 제일 먼저 지적받는 형식이다.

     그런데 애초에 알고 싶은 것은 «많이 돌려서인가, 빨리 닳아서인가» 였고,
     그건 시간당 마모량 하나가 이미 답한다 — 시간으로 나눠 놨으니
     «많이 돌렸다» 는 걷혀 있다. 그래서 축을 하나로 줄이고 그 값만 그린다.
     절삭시간은 비교 대상이 아니라 맥락이라 축 아래 글자로 내렸다.

     색은 하나만 쓴다 — 평상시는 회색, 최근 주만 파랑, 이상 있던 주만 빨강.
     전부 칠하면 어디를 봐야 할지가 사라진다. */
  function chartSVG(rows, opt) {
    opt = opt || {};
    const W = opt.width || 720, H = opt.height || 236;
    if (!rows.length) return empty(W, H, '표시할 자료가 없습니다');

    const C = pal();
    const P = { t: 30, r: 16, b: 48, l: 54 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const n = rows.length;

    /* 안 돌린 주를 평균에 넣으면 평균이 내려가 «이번 주가 높다» 가 부풀려진다 */
    const ran = rows.filter(r => r.cut_h > 0);
    if (!ran.length) return empty(W, H, '절삭한 주가 없습니다');
    const sc = scaleOf(Math.max(...ran.map(r => r.perH)));
    const top = niceMax(Math.max(...ran.map(r => r.perH)) * sc.mul);
    const avg = ran.reduce((a, r) => a + r.perH, 0) / ran.length * sc.mul;

    const bw = Math.min(46, iw / n * 0.58);
    const cx = i => P.l + iw * (i + 0.5) / n;
    const y = v => P.t + ih - ih * (v / top);

    /* 가로 눈금선만. 세로선·축선·테두리는 잉크만 먹고 읽는 데 도움이 안 된다 */
    const grid = [0, 0.5, 1].map(f => {
      const yy = y(top * f);
      return `<line x1="${P.l}" y1="${yy.toFixed(1)}" x2="${(P.l + iw).toFixed(1)}"
        y2="${yy.toFixed(1)}" stroke="${C['--chart-grid']}" stroke-width="1"/>
        <text x="${P.l - 9}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11"
          fill="${C['--chart-axis']}">${(top * f).toFixed(top < 10 ? 1 : 0)}</text>`;
    }).join('');

    /* 값이 367~391 로 거의 같으면 막대 높이로는 차이가 안 보인다.
       그래서 «앞 주 대비 몇 %» 를 값 아래에 같이 적는다 — 수준이 아니라
       변화를 보여 주면, 같은 자료에서도 읽을 것이 생긴다.
       바로 앞에 «안 돌린 주» 가 끼면 그 주를 건너뛰고 견준다. */
    const dlt = (i, r) => {
      if (!(r.cut_h > 0)) return '';
      let j = i - 1;
      while (j >= 0 && !(rows[j].cut_h > 0)) j--;
      if (j < 0 || !(rows[j].perH > 0)) return '';
      const p = (r.perH / rows[j].perH - 1) * 100;
      if (Math.abs(p) < 0.05) return '';
      const up = p > 0;
      return `<text x="${cx(i).toFixed(1)}" y="${(P.t + ih - ih * (r.perH * sc.mul / top) + 7).toFixed(1)}"
        text-anchor="middle" font-size="10.5"
        fill="${up ? C['--warn'] : C['--chart-axis']}"
        >${up ? '▲' : '▼'}${Math.abs(p).toFixed(1)}%</text>`;
    };

    const bars = rows.map((r, i) => {
      /* 안 돌린 주는 «0» 이 아니라 «없음» 이다. 0 짜리 막대에 «0.0» 을 적으면
         «아주 조금 닳았다» 로 읽히는데, 실제로는 잰 적이 없는 주다. */
      if (!(r.cut_h > 0)) {
        return `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${(P.t + ih - 3).toFixed(1)}"
          width="${bw.toFixed(1)}" height="3" rx="1.5" fill="${C['--chart-grid']}"
          ><title>${esc(r.label)}
절삭 없음 — 안 돌린 주입니다</title></rect>
          <text x="${cx(i).toFixed(1)}" y="${(P.t + ih - 11).toFixed(1)}"
            text-anchor="middle" font-size="11.5" fill="${C['--chart-axis']}">—</text>`;
      }
      const v = r.perH * sc.mul;
      const h = Math.max(2, ih * (v / top));
      const hot = opt.hot && opt.hot.has(r.week);
      const last = i === n - 1;
      const fill = hot ? C['--danger'] : (last ? C['--accent'] : '#C8D3DF');
      return `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${(P.t + ih - h).toFixed(1)}"
        width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}"
        ><title>${esc(r.label)}
시간당 마모 ${r.perH.toFixed(6)}
마모량 ${r.raw.toFixed(6)}
절삭 ${f2(r.cut_h)}h</title></rect>
        <text x="${cx(i).toFixed(1)}" y="${(P.t + ih - h - 8).toFixed(1)}"
          text-anchor="middle" font-size="11.5" font-weight="650"
          fill="${hot ? C['--danger'] : (last ? C['--accent'] : C['--chart-label'])}"
          >${v.toFixed(top < 10 ? 2 : 1)}</text>${dlt(i, r)}`;
    }).join('');

    /* 평균선 — 「이번 주가 평소보다 높은가」 를 눈으로 바로 답하게.
       값 설명은 선 옆이 아니라 그림 위에 둔다. 선 옆에 두면 막대와 겹친다. */
    const ay = y(avg);
    const avgLine = `<line x1="${P.l}" y1="${ay.toFixed(1)}" x2="${(P.l + iw).toFixed(1)}"
      y2="${ay.toFixed(1)}" stroke="${C['--chart-axis']}" stroke-width="1"
      stroke-dasharray="4 4" opacity=".65"/>
      <text x="${(P.l + iw).toFixed(1)}" y="${(P.t - 12).toFixed(1)}" text-anchor="end"
        font-size="10.5" fill="${C['--chart-axis']}">---- 평균 ${avg.toFixed(top < 10 ? 2 : 1)}</text>`;

    /* 축 아래 — 주차와 그 주의 절삭시간(맥락) */
    const labels = rows.map((r, i) =>
      `<text x="${cx(i).toFixed(1)}" y="${H - 26}" text-anchor="middle" font-size="11"
        fill="${C['--chart-label']}">${esc(r.label)}</text>
       <text x="${cx(i).toFixed(1)}" y="${H - 11}" text-anchor="middle" font-size="10.5"
        fill="${C['--chart-axis']}">${f2(r.cut_h)}h</text>`).join('');

    const unit = `<text x="${P.l - 9}" y="${P.t - 12}" text-anchor="end" font-size="10.5"
      fill="${C['--chart-axis']}">${sc.unit ? '단위 ' + sc.unit : ''}</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="주차별 시간당 마모량">
      ${grid}${unit}${avgLine}${bars}${labels}
    </svg>`;
  }

  /* ── 일자별 시간당 마모량 ─────────────────────────────────────
     면을 칠하지 않는다. 채워도 새로 알게 되는 것이 없고, 점(이상 징후)이
     묻힌다. 대신 판정 기준인 «중앙값» 을 점선으로 같이 그린다 — 점이 왜
     찍혔는지가 그림 안에서 설명된다. */
  function sparkSVG(days, marks, opt) {
    opt = opt || {};
    const W = opt.width || 720, H = opt.height || 236;
    const D = (days || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    if (D.length < 2) return empty(W, H, '일자가 부족합니다');

    const C = pal();
    const P = { t: 30, r: 16, b: 48, l: 54 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;

    /* 안 돌린 날은 «0» 이 아니라 «없음» 이다. 0 으로 찍어 이으면 선이 매주
       바닥까지 내려갔다 올라오는 톱니가 되어, 정작 추세가 안 보인다.
       43일 중 17일이 주말이라 절반 가까이가 그런 날이었다. */
    const per = D.map(d => (d.cut_h > 0 ? val(d) / d.cut_h : null));
    const got = per.filter(v => v != null && v > 0);
    if (!got.length) return empty(W, H, '절삭한 날이 없습니다');
    const sc = scaleOf(Math.max(...got));
    const top = niceMax(Math.max(...got) * sc.mul);
    const mid = median(got) * sc.mul;

    const x = i => P.l + iw * i / (D.length - 1);
    const y = v => P.t + ih - ih * (v / top);
    const M = new Map((marks || []).map(m => [m.date, m]));

    const grid = [0, 0.5, 1].map(f => {
      const yy = y(top * f);
      return `<line x1="${P.l}" y1="${yy.toFixed(1)}" x2="${(P.l + iw).toFixed(1)}"
        y2="${yy.toFixed(1)}" stroke="${C['--chart-grid']}" stroke-width="1"/>
        <text x="${P.l - 9}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11"
          fill="${C['--chart-axis']}">${(top * f).toFixed(top < 10 ? 1 : 0)}</text>`;
    }).join('');

    const midLine = mid > 0 ? `<line x1="${P.l}" y1="${y(mid).toFixed(1)}"
      x2="${(P.l + iw).toFixed(1)}" y2="${y(mid).toFixed(1)}"
      stroke="${C['--chart-axis']}" stroke-width="1" stroke-dasharray="4 4" opacity=".65"/>
      <text x="${(P.l + iw).toFixed(1)}" y="${(P.t - 12).toFixed(1)}" text-anchor="end"
        font-size="10.5" fill="${C['--chart-axis']}">---- 판정 기준(중앙값) ${
        mid.toFixed(top < 10 ? 2 : 1)}</text>` : '';

    /* 없는 날에서 선을 끊는다 — 이어진 구간마다 polyline 을 따로 그린다 */
    const segs = [];
    let cur = [];
    D.forEach((d, i) => {
      if (per[i] == null) { if (cur.length > 1) segs.push(cur); cur = []; return; }
      cur.push(`${x(i).toFixed(1)},${y(per[i] * sc.mul).toFixed(1)}`);
    });
    if (cur.length > 1) segs.push(cur);
    const line = segs.map(pts =>
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${C['--accent']}"
        stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
    /* 끊긴 자리가 «자료가 없다» 는 뜻임을 알 수 있게 바닥에 옅은 띠를 깐다 */
    const gaps = D.map((d, i) => per[i] == null
      ? `<rect x="${(x(i) - 2).toFixed(1)}" y="${(P.t + ih - 3).toFixed(1)}" width="4" height="3"
          rx="1" fill="${C['--chart-grid']}"><title>${esc(d.date)} · 절삭 없음</title></rect>` : '')
      .join('');

    /* 안 돌린 날(idle)은 점으로 안 찍는다 — 주말이 점으로 도배되면 진짜
       급증한 날이 그 사이에 묻힌다. 목록에는 구간으로 묶여 남아 있다. */
    const dots = D.map((d, i) => {
      const m = M.get(d.date);
      if (!m || m.kind === 'idle' || per[i] == null) return '';
      const col = m.level === 'danger' ? C['--danger']
        : m.level === 'warn' ? C['--warn'] : C['--accent'];
      return `<circle cx="${x(i).toFixed(1)}" cy="${y(per[i] * sc.mul).toFixed(1)}" r="5"
        fill="${col}" stroke="${C['--surface']}" stroke-width="2"><title>${esc(d.date)} · ${esc(m.title)}
${esc(m.why)}</title></circle>`;
    }).join('');

    /* 날짜 눈금 — 처음·끝만 적으면 가운데가 어디인지 모른다. 네댓 개로. */
    const step = Math.max(1, Math.round((D.length - 1) / 4));
    const ticks = D.map((d, i) =>
      (i % step === 0 || i === D.length - 1)
        ? `<text x="${x(i).toFixed(1)}" y="${H - 20}" text-anchor="middle" font-size="11"
            fill="${C['--chart-label']}">${esc(d.date.slice(5))}</text>` : '').join('');

    const unit = `<text x="${P.l - 9}" y="${P.t - 12}" text-anchor="end" font-size="10.5"
      fill="${C['--chart-axis']}">${sc.unit ? '단위 ' + sc.unit : ''}</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="일자별 시간당 마모량">
      ${grid}${unit}${midLine}${gaps}${line}${dots}${ticks}
    </svg>`;
  }

  /* ═══════════════════════════════════════════════════════════════
   * 화면 — 왼쪽 메뉴에 «종합» 을 붙이고 눌리면 여기서 그린다
   * ═══════════════════════════════════════════════════════════════ */
  /* 색·모서리는 mes.html 의 :root 를 따라간다. 그 변수가 없으면 괄호 안 기본값. */
  const CSS = `
  #mesdash .row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px}
  #mesdash .box{background:var(--surface,#fff);border:1px solid var(--line,#e2e8ee);
    border-radius:var(--r,10px);padding:16px 18px;
    box-shadow:var(--sh,0 1px 2px rgba(15,23,42,.04))}
  #mesdash .box.grow{flex:1 1 340px;min-width:0}
  /* 그래프 두 개를 한 줄에. 화면이 좁으면 알아서 위아래로 내려간다. */
  #mesdash .row.two > .box{display:flex;flex-direction:column}
  #mesdash .row.two > .box .hint{margin-top:auto}
  @media (max-width:860px){ #mesdash .row.two > .box{flex:1 1 100%} }
  #mesdash h4 .sub{font-weight:400;color:var(--faint,#94A3B8);margin-left:6px}
  #mesdash h4{font-size:12.5px;color:var(--ink,#0F172A);margin:0 0 12px;font-weight:650}
  #mesdash .hint{font-size:11.5px;color:var(--faint,#94A3B8);margin-top:10px;line-height:1.65}
  #mesdash .an{display:flex;gap:10px;align-items:flex-start;padding:9px 0;
    border-bottom:1px solid var(--line-2,#f0f3f6)}
  #mesdash .an:last-child{border-bottom:0}
  #mesdash .an .d{font-size:11.5px;color:var(--ink-2,#334155);font-weight:600;min-width:80px;
    font-variant-numeric:tabular-nums}
  #mesdash .an .t{font-size:12px;font-weight:600;min-width:70px}
  #mesdash .an .w{font-size:11.5px;color:var(--muted,#64748B);line-height:1.6;flex:1}
  #mesdash .an.danger .t{color:var(--danger,#DC2626)}
  #mesdash .an.warn .t{color:var(--warn,#D97706)}
  #mesdash .an.info .t{color:var(--accent,#1B365D)}
  #mesdash .segbtns{display:flex;gap:7px;flex-wrap:wrap}
  #mesdash .segbtns button, #basis .segbtns button{
    font:inherit;font-size:12px;padding:6px 13px;border:1px solid var(--line,#c3ced8);
    border-radius:999px;background:var(--surface,#fff);color:var(--ink-2,#41525f);
    cursor:pointer;transition:background .12s,border-color .12s}
  #mesdash .segbtns button:hover, #basis .segbtns button:hover{
    background:var(--accent-soft,#eef3fa);border-color:var(--accent-line,#9fb6cf)}
  #mesdash .segbtns button[data-on], #basis .segbtns button[data-on]{
    background:var(--accent,#1b365d);border-color:var(--accent,#1b365d);color:#fff;
    font-weight:650}
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
          <h4>주차별 가동 상태
            <span class="sub">막대 위 = 절삭 비율</span></h4>
          ${statesSVG(W, { width: 520, height: 236 })}
          <div class="hint">설비가 그 주에 <b>무엇을 했는지</b>입니다 —
            깎았나(절삭), 돌기만 했나(공회전), 서 있었나(멈춤).
            <b>공구는 절삭 시간에만 닳습니다.</b>
            공회전이 길면 전기는 쓰는데 일은 안 한 것입니다.</div>
        </div>
        <div class="box grow">
          <h4>주차별 시간당 마모량
            <span class="sub">파랑 = 최근 주 · 빨강 = 이상 있던 주</span></h4>
          ${chartSVG(W, { hot, width: 520, height: 236 })}
          <div class="hint"><b>시간으로 나눈 값</b>이라 «많이 돌려서» 는 이미 걷혔습니다.
            높은 주는 그냥 <b>빨리 닳은 주</b>입니다. 점선은 평균 —
            막대가 그 위로 올라간 주를 보시면 됩니다.
            축 아래 숫자는 그 주의 절삭시간입니다.</div>
        </div>
      </div>

      <!-- 일자별은 가로로 길어야 읽힌다 — 43일이 좁은 칸에 들어가면 톱니가 된다 -->
      <div class="row">
        <div class="box grow">
          <h4>일자별 시간당 마모량 <span class="sub">점 = 이상 징후</span></h4>
          ${sparkSVG(days, A, { width: 1060, height: 210 })}
          <div class="hint">점선이 <b>판정 기준(중앙값)</b>입니다 — 점이 왜 찍혔는지가
            그림 안에 같이 있습니다. 점에 마우스를 올리면 근거가 나옵니다.
            바닥의 옅은 점은 <b>안 돌린 날</b>이라 선을 끊어 둔 자리입니다.</div>
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

  /* 왼쪽 메뉴에 버튼 하나를 붙인다. 원래 있던 버튼들은 화면 코드가
     자기 핸들러를 달아 두었으므로, 우리 버튼만 우리가 맡는다. */
  function addTab() {
    const nav = document.querySelector('nav');
    if (!nav || $('mesdash-tab')) return;
    const first = nav.querySelector('button');
    const b = document.createElement('button');
    b.id = 'mesdash-tab';
    b.title = '종합';
    /* 메뉴가 왼쪽 세로 기둥이 되면서 칸 모양이 «그림표 + 글자» 로 정해졌다.
       우리 버튼만 글자뿐이면 그 줄만 안쪽으로 밀려 보인다 — 같은 모양으로
       만든다. 기둥이 좁아졌을 때 글자를 접는 것도 저쪽 규칙이 알아서 한다. */
    b.innerHTML =
      '<svg class="ic" viewBox="0 0 24 24">' +
      '<path d="M3 20h18M6 20V9M11 20V4M16 20v-7"/></svg><span>종합</span>';
    b.addEventListener('click', () => {
      nav.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      /* 딸린 목록은 «눌린 메뉴 바로 밑» 에 붙는다. 우리도 주차 요약을
         거기에 쓰므로, 그리기 전에 자리를 우리 버튼 밑으로 옮겨 달라고
         부른다 — 안 부르면 직전에 눌렀던 메뉴 밑에 우리 목록이 찍힌다. */
      if (typeof window.placeSide === 'function') window.placeSide();
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
    weeks, anomalies, chartSVG, sparkSVG, statesSVG, weekKey, median, RULES, pal, resetPal,
    draw, active: () => ACTIVE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MESDASH = api;
})(typeof self !== 'undefined' ? self : this);
