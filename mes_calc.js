/* ═══════════════════════════════════════════════════════════════
 * MES 계산 로직 — mes_core.py 의 자바스크립트 이식
 * ═══════════════════════════════════════════════════════════════
 * 브라우저가 Supabase 에서 집계본을 직접 받아 계산하도록 옮긴 것이다.
 * 서버를 거치지 않으므로 절전(콜드스타트)이 없고 호스팅이 무료다.
 *
 * mes_core.py 와 숫자가 하나라도 달라지면 안 된다. 반올림 자리수까지 맞췄고,
 * verify_calc.py 가 두 구현을 같은 집계본으로 돌려 자동 비교한다.
 *
 *   기준 수명 L일 · 주간 W시간 · 앵커 A 일 때
 *     하루 절삭시간  DAYH   = W / 7
 *     수명 절삭시간  LIFE_H = L × DAYH
 *     환산계수       k      = 100 × 관측절삭시간 / (LIFE_H × A의 원시마모)
 *     현재 마모율    wear_i = k × raw_i
 *     예상 수명      life_i = L × (A의 원시마모 / raw_i)
 *
 *   → 예상 수명은 기준일수 L 에 정비례하고 주간시간 W 와는 무관하다.
 *
 * 사용:
 *   <script src="mes_calc.js"></script>
 *   MES.load(집계본JSON);
 *   const b = new MES.Basis({seg:'fa', life:400, week:38, anchor:'mean'});
 *   MES.toolList(b);  MES.overview(b);  ...
 */
(function (root) {
  'use strict';

  const ALERTS = { '주의': 70.0, '교체 준비': 90.0, '교체': 100.0 };
  const ORDER_LEVEL = 70.0;

  const LIFE_OPTIONS = [300, 350, 380, 400, 420, 450, 500];
  const WEEK_OPTIONS = [27.4, 36.5, 38.0, 39.9, 40.0, 43.3];
  const WEEK_NOTE = {
    27.4: '비수기 실측 (08-24~26)',
    36.5: '7일 종합 실측',
    38.0: '팀 확정값',
    39.9: '중간발표 사용값',
    40.0: '1일 8h × 5일',
    43.3: '성수기 실측 (08-18~21)',
  };

  let DATA = {};

  /* 파이썬 round(v, nd) 와 결과가 같아야 한다. 두 가지를 다 맞춰야 한다.
       1) 반올림 판단은 값의 '정확한 이진 표현' 기준이어야 한다.
          9.475 는 실제로 9.47499999... 라 파이썬은 9.47 로 내린다.
          v*100 을 직접 계산하면 부동소수점 오차로 자릿수가 어긋난다.
       2) 정확히 .5 로 떨어지는 값(992.25 처럼 이진수로 딱 맞는 값)에서는
          파이썬이 '짝수로' 보낸다(은행가 반올림). toFixed 는 올림이라 갈린다.
     그래서 충분한 자리까지 펼쳐 보고, 남은 자리가 정확히 5000... 이면 짝수로 보낸다. */
  function round(v, nd) {
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return v;
    const neg = v < 0;
    const a = Math.abs(v);
    const ext = Math.min(nd + 25, 100);
    const s = a.toFixed(ext);                       // 정확한 십진 전개
    const dot = s.indexOf('.');
    const keep = s.slice(0, dot) + s.slice(dot + 1, dot + 1 + nd);   // 남길 자리
    const rest = s.slice(dot + 1 + nd);                              // 버릴 자리
    let n = parseInt(keep, 10);
    const tie = rest[0] === '5' && /^50*$/.test(rest);
    if (tie) {
      if (n % 2 !== 0) n += 1;                      // 정확한 .5 → 짝수로
    } else if (rest && rest[0] >= '5') {
      n += 1;
    }
    const out = n / Math.pow(10, nd);
    return neg ? -out : out;
  }

  function load(data) {
    DATA = data || {};
    if (!DATA.segments) throw new Error('집계본에 segments 가 없습니다 (예전 형식)');
    return DATA;
  }
  function raw() { return DATA; }

  function levelOf(w) {
    const names = Object.keys(ALERTS).sort((a, b) => ALERTS[b] - ALERTS[a]);
    for (const n of names) if (w >= ALERTS[n]) return n;
    return '정상';
  }

  /* ═══════════════════════════ 기준 적용 */
  class Basis {
    constructor(q) {
      q = q || {};
      const d = DATA.defaults || {};
      const segs = DATA.segments || {};
      this.segKey = q.seg || d.segment || 'fa';
      if (!(this.segKey in segs)) this.segKey = Object.keys(segs)[0] || 'fa';
      this.seg = segs[this.segKey] || {};

      const f = (v, dflt) => {
        const n = parseFloat(v);
        return isFinite(n) ? n : dflt;
      };
      this.lifeDays = f(q.life, f(d.life_days, 400));
      this.weekHours = f(q.week, f(d.week_hours, 38));
      this.anchor = String(q.anchor || d.anchor || 'set');

      this.dayHours = this.weekHours / 7;
      this.lifeCutHours = this.lifeDays * this.dayHours;
      this.totalH = this.seg.cut_h || 0;

      const tools = this.seg.tools || [];
      if (this.anchor === 'set') {
        this.anchorRaw = this.seg.raw_total || 0;
        this.anchorLabel = '세트 전체';
      } else if (this.anchor === 'mean') {
        const n = tools.length || 1;
        this.anchorRaw = (this.seg.raw_total || 0) / n;
        this.anchorLabel = `평균 공구 (${n}종 기준)`;
      } else {
        const tno = parseInt(this.anchor, 10);
        const t = tools.find(x => x.tool === tno);
        if (!t) {                      // 이 구간에 없는 공구를 고르면 세트로 되돌린다
          this.anchor = 'set';
          this.anchorRaw = this.seg.raw_total || 0;
          this.anchorLabel = '세트 전체';
        } else {
          this.anchorRaw = t.raw;
          this.anchorLabel = `T${t.tool} ${t.name}`;
        }
      }

      this.k = (this.anchorRaw > 0 && this.lifeCutHours > 0)
        ? 100.0 * this.totalH / (this.lifeCutHours * this.anchorRaw) : 0.0;
    }

    wear(r) { return this.k * r; }

    /* 평균 공구 대비 사용강도 배수. 앵커·기준일수와 무관하게 구간만으로 정해진다. */
    intensity(r) {
      const n = (this.seg.tools || []).length || 1;
      const mean = (this.seg.raw_total || 0) / n;
      if (mean <= 0) return null;
      return r / mean;
    }

    /* 예상 수명(일). 예측이 아니라 환산값이라 상세 화면에서만 근거와 함께 쓴다. */
    life(r) {
      if (r <= 0 || this.anchorRaw <= 0) return null;
      return this.lifeDays * this.anchorRaw / r;
    }

    info() {
      const segs = DATA.segments || {};
      return {
        segment: this.segKey,
        segment_label: this.seg.label || '',
        segment_period: this.seg.period || '',
        life_days: this.lifeDays,
        week_hours: this.weekHours,
        day_hours: round(this.dayHours, 4),
        life_cut_hours: round(this.lifeCutHours, 1),
        anchor: this.anchor,
        anchor_label: this.anchorLabel,
        observed_hours: round(this.totalH, 2),
        hour_wear: this.totalH
          ? round(this.k * (this.seg.raw_total || 0) / this.totalH, 5) : 0,
        set_wear: round(this.k * (this.seg.raw_total || 0), 4),
        life_options: LIFE_OPTIONS,
        week_options: WEEK_OPTIONS.map(w => ({ v: w, note: WEEK_NOTE[w] || '' })),
        anchor_options: [
          { v: 'mean', label: '평균 공구 = 기준일수', note: '많이 쓴 공구는 빨리, 적게 쓴 공구는 천천히 도달' },
          { v: 'set', label: '세트 전체 = 기준일수', note: '세트 단위 일괄 교체 정책 그대로' },
        ].concat((this.seg.tools || []).slice(0, 8).map(t => ({
          v: String(t.tool), label: `T${t.tool} ${t.name} = 기준일수`, note: `기여도 ${t.share}%`,
        }))),
        segments: Object.keys(segs).map(k => ({
          key: k, label: segs[k].label, period: segs[k].period,
          tools: segs[k].tools.length, hours: segs[k].cut_h,
        })),
        switch: DATA.switch || '',
        built: DATA.built || '',
        weights: DATA.weights || {},
        thresholds: DATA.thresholds || {},
      };
    }
  }

  /* ═══════════════════════════ 조회 응답 */
  function toolRow(b, t) {
    const iv = b.intensity(t.raw);
    return {
      tool: t.tool, name: t.name, cls: t.cls,
      wear: round(b.wear(t.raw), 4),
      intensity: iv ? round(iv, 2) : null,
      share: t.share, hours: t.hours, rows: t.rows,
    };
  }

  function toolList(b) { return (b.seg.tools || []).map(t => toolRow(b, t)); }

  function overview(b) {
    const s = b.seg;
    const tools = toolList(b);
    const danger = tools.filter(t => (t.intensity || 0) > 1.0);
    return {
      basis: b.info(),
      summary: {
        rows: s.rows, cut_hours: s.cut_h, tools: (s.tools || []).length,
        progs: (s.progs || []).length, days: (s.days || []).length, parts: s.parts,
        anchor_wear: round(b.wear(b.anchorRaw), 4),
        mean_wear: round(b.wear((s.raw_total || 0) / Math.max((s.tools || []).length, 1)), 4),
        sum_wear: round(b.wear(s.raw_total || 0), 4),
      },
      top5: tools.slice(0, 5),
      over: danger.length,
      days: (s.days || []).map(d => ({
        date: d.date, cut_h: d.cut_h, wear: round(b.wear(d.raw), 4),
        rows: d.rows, parts: d.parts, states: d.states,
      })),
      mains: (s.mains || []).map(m => ({
        main: m.main, hours: m.hours, wear: round(b.wear(m.raw), 4), progs: m.progs,
      })),
      events: (s.events || []).slice(0, 40).map(e => ({
        time: e.time, tool: e.tool, name: e.name, prog: e.prog,
        type: e.type, delta: round(b.wear(e.raw), 6),
      })),
    };
  }

  function toolDetail(b, tno) {
    const t = (b.seg.tools || []).find(x => x.tool === tno);
    if (!t) return null;
    const row = toolRow(b, t);
    const lf = b.life(t.raw);
    const progs = {};
    Object.keys(t.progs || {}).forEach(k => { progs[k] = round(b.wear(t.progs[k]), 5); });
    Object.assign(row, {
      machining: round(b.wear(t.f_m), 5),
      overload: round(b.wear(t.f_o), 5),
      shock: round(b.wear(t.f_s), 5),
      cond_change: round(b.wear(t.f_c), 5),
      progs: progs,
      life: lf ? round(lf, 1) : null,
      life_basis: lf ? `${b.lifeDays.toFixed(0)}일 × (${b.anchorLabel} 기준) ÷ 사용강도 ${row.intensity}배` : null,
    });
    const ev = (b.seg.events || []).filter(e => e.tool === tno).slice(0, 30).map(e => ({
      time: e.time, tool: e.tool, name: e.name, prog: e.prog,
      type: e.type, delta: round(b.wear(e.raw), 6),
    }));
    return { tool: row, level: levelOf(row.wear), events: ev };
  }

  function programs(b) {
    return {
      mains: (b.seg.mains || []).map(m => ({
        main: m.main, hours: m.hours, wear: round(b.wear(m.raw), 4), progs: m.progs,
      })),
      progs: (b.seg.progs || []).map(p => ({
        prog: p.prog, main: p.main, hours: p.hours, rows: p.rows,
        wear: round(b.wear(p.raw), 4),
      })),
    };
  }

  function programDetail(b, name) {
    const p = (b.seg.progs || []).find(x => x.prog === name);
    if (!p) return null;
    const names = {};
    (b.seg.tools || []).forEach(t => { names[t.tool] = t.name; });
    const tot = p.raw || 1;
    return {
      prog: {
        prog: p.prog, main: p.main, hours: p.hours, rows: p.rows,
        wear: round(b.wear(p.raw), 4),
      },
      tools: (p.tools || []).map(x => ({
        tool: x.tool, name: names[x.tool] || `T${x.tool}`,
        wear: round(b.wear(x.raw), 5),
        share: round(100 * x.raw / tot, 2),
      })),
    };
  }

  function sales(b) {
    const s = b.seg;
    const days = (s.days || []).map(d => ({
      date: d.date, cut_h: d.cut_h, parts: d.parts, wear: round(b.wear(d.raw), 4),
    }));
    const parts = days.reduce((a, d) => a + d.parts, 0);
    const wear = b.wear(s.raw_total || 0);
    const perPart = parts ? wear / parts : 0;
    const active = days.filter(d => d.cut_h > 0);
    const avg = active.length ? wear / active.length : 0;
    return {
      basis: b.info(), parts: parts, wear: round(wear, 4), per_part: perPart,
      per_1000: round(perPart * 1000, 4), days: days,
      mains: (s.mains || []).map(m => ({
        main: m.main, hours: m.hours, wear: round(b.wear(m.raw), 4),
        progs: m.progs.length, share: round(100 * m.raw / (s.raw_total || 1), 1),
      })),
      capacity: [1000, 5000, 10000, 20000].map(q => ({
        qty: q, wear: round(perPart * q, 3),
        days: avg ? round(perPart * q / avg, 1) : 0,
      })),
    };
  }

  /* 발주 우선순위는 예상 수명이 아니라 '지금 얼마나 닳았는가'로 정한다.
     교체 이력이 없어 잔여 일수를 말할 근거가 없다. */
  function orders(b, orderList) {
    const cand = (b.seg.tools || []).map(t => {
      const row = toolRow(b, t);
      return Object.assign({}, row, {
        level: levelOf(row.wear),
        recommend: row.wear >= ORDER_LEVEL,
      });
    });
    cand.sort((x, y) => (y.wear - x.wear) || ((y.intensity || 0) - (x.intensity || 0)));
    return {
      basis: b.info(), order_level: ORDER_LEVEL,
      candidates: cand, orders: orderList || [],
      recommend_count: cand.filter(c => c.recommend).length,
      over_count: cand.filter(c => (c.intensity || 0) > 1.0).length,
    };
  }

  /* ═══════════════════════════ 확장 조회 — 건전성 · 가동률 · 가공 */
  const GAP_REASON = {
    Vib_Kurt: ['파손 전조 감지', '진동 첨도 3채널이 전 구간 0 — 수집 경로 점검 필요',
      '과부하·충격 이벤트로 대체 관측 중'],
    Alarm: ['알람 이력 분석', '절삭 구간 내 Alarm·Emergency 가 전량 0',
      '비절삭 구간의 상태 전이만 이벤트로 기록'],
    SpindleLoad: ['주축 부하 추이', '비영률 41% — 절반 이상이 0이라 지표로 쓸 수 없음',
      '3상 전류(Cur_R/S/T)로 대체'],
    PartCount: ['생산량·개당 소모', 'PartCount 누적 카운터가 움직이지 않은 구간',
      '절삭시간 기준 소모율로 대체'],
    SEQ: ['시퀀스별 공정 분석', 'SEQ 가 500 한 값으로 고정',
      'WorkOffset(G54~G59)·MotionGCode 로 대체'],
    ExecBlkNo: ['블록 단위 추적', '전 구간 0 — 수집기 폴백 경로에서 값이 안 옴', null],
    Override: ['오버라이드 분석', 'SpindleOverride·RapidOverride 미수집 (확장 예정)',
      'FeedOverride 만 관측 — 99.96% 가 100% 고정'],
    ToolHistory: ['공구 교체 이력', '교체 이력이 수집되지 않음 — 현장 요청 중',
      '사용강도(평균 대비 배수)로 상대 비교'],
  };

  function gaps(keys) {
    return keys.filter(k => GAP_REASON[k]).map(k => ({
      key: k, feature: GAP_REASON[k][0], why: GAP_REASON[k][1], instead: GAP_REASON[k][2],
    }));
  }

  const HKEYS = ['imbalance', 'cur_r', 'cur_s', 'cur_t', 'servo_x', 'servo_y', 'servo_z',
    'freq_x', 'freq_y', 'freq_z', 'vib_temp', 'uyeg_temp', 'uyeg_humi', 'spindle_load'];

  function health(b) {
    const h = b.seg.health;
    if (!h) return { basis: b.info(), available: false, note: '확장 집계가 없습니다' };
    const stats = {};
    HKEYS.forEach(k => { stats[k] = h[k] || null; });
    return {
      basis: b.info(), available: true, stats: stats, days: h.days || [],
      gaps: gaps(['Vib_Kurt', 'SpindleLoad']),
    };
  }

  function oee(b) {
    const o = b.seg.oee;
    if (!o) return { basis: b.info(), available: false, note: '확장 집계가 없습니다' };
    const byDay = {};
    (o.states || []).forEach(r => {
      (byDay[r.day] = byDay[r.day] || {})[r.st] = r.h;
    });
    const win = {};
    (o.windows || []).forEach(w => { win[w.day] = w; });
    const days = Object.keys(byDay).sort().map(d => {
      const st = byDay[d];
      const cut = st['가동중·절삭'] || 0;
      const idle = st['가동중·공회전'] || 0;
      const w = win[d] || {};
      const span = w.span_h || 0;
      return {
        date: d, cut: round(cut, 2), idle: round(idle, 2), run: round(cut + idle, 2),
        span: span, start: w.start, end: w.end, states: st,
        cut_rate: span ? round(100 * cut / span, 1) : 0,
        run_rate: span ? round(100 * (cut + idle) / span, 1) : 0,
      };
    });
    const live = days.filter(d => d.cut > 0);
    const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
    const prod = o.production || {};
    return {
      basis: b.info(), available: true, days: days,
      summary: {
        operating_days: live.length,
        cut_h: round(sum(live, d => d.cut), 2),
        idle_h: round(sum(live, d => d.idle), 2),
        span_h: round(sum(live, d => d.span), 2),
        cut_rate: round(100 * sum(live, d => d.cut) / Math.max(sum(live, d => d.span), 0.001), 1),
        daily_cut: round(sum(live, d => d.cut) / Math.max(live.length, 1), 2),
      },
      production: prod,
      gaps: gaps((prod.counter_stuck ? ['PartCount'] : []).concat(['Override', 'SEQ'])),
    };
  }

  function machining(b) {
    const m = b.seg.machining;
    if (!m) return { basis: b.info(), available: false, note: '확장 집계가 없습니다' };
    const names = {};
    (b.seg.tools || []).forEach(t => { names[t.tool] = t.name; });
    const totOff = (m.offsets || []).reduce((a, x) => a + x.h, 0) || 1;
    const totGc = (m.gcode || []).reduce((a, x) => a + x.h, 0) || 1;
    return {
      basis: b.info(), available: true,
      offsets: (m.offsets || []).map(x => Object.assign({}, x, { share: round(100 * x.h / totOff, 1) })),
      gcode: (m.gcode || []).map(x => Object.assign({}, x, { share: round(100 * x.h / totGc, 1) })),
      feed_ovr: m.feed_ovr || [], pos: m.pos || {},
      offset_tool: (m.offset_tool || []).map(x =>
        Object.assign({}, x, { name: names[x.tool] || `T${x.tool}` })),
      gaps: gaps(['SEQ', 'ExecBlkNo', 'Override']),
    };
  }

  const MES = {
    load, raw, Basis, levelOf, round,
    toolRow, toolList, overview, toolDetail,
    programs, programDetail, sales, orders,
    health, oee, machining,
    ALERTS, ORDER_LEVEL, LIFE_OPTIONS, WEEK_OPTIONS, GAP_REASON,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MES;
  else root.MES = MES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
