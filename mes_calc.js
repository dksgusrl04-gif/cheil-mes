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
 *     환산계수       k      = 100 × 구간전체_절삭시간 / (LIFE_H × A의 원시마모)
 *     현재 마모율    wear_i = k × raw_i
 *     예상 수명      life_i = L × (A의 원시마모 / raw_i)
 *
 *   → 예상 수명은 기준일수 L 에 정비례하고 주간시간 W 와는 무관하다.
 *
 *   ── k 는 '구간 전체' 로 한 번 정하고 얼린다 ──────────────────────
 *   k 의 재료(절삭시간·앵커 원시마모)는 모두 fullSeg 에서 온다. 화면에서
 *   날짜를 좁혀도, 구간을 바꿔도 k 는 그대로다. 바뀌는 것은 raw_i 뿐이다.
 *
 *   그래서 이렇게 된다.
 *     · 그 공구를 안 쓴 날에는 마모율이 안 움직인다
 *     · 날짜별 마모율을 전부 더하면 정확히 전체 기간 마모율이 된다
 *     · 「전체」를 눌러도 값이 튀지 않는다
 *
 *   예전에는 보고 있는 화면으로 k 를 매번 다시 잡았다. 그래서 남의 공구가
 *   돌기만 해도 내 공구 마모율이 올라갔다. 마모계가 그러면 안 된다.
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
  const WEEK_OPTIONS = [26.14, 27.4, 36.5, 38.0, 39.9, 40.0, 43.3];
  const WEEK_NOTE = {
    /* 주간 가동시간은 «100% 가 몇 절삭시간인가» 를 정한다. 실측보다 크게 잡으면
       400일을 굴려도 100% 에 못 닿는다 — 38h 로는 68.78% 에서 멈춘다. */
    26.14: '4주 실측 (08-06~09-03) · 400일에 100%',
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

  function load(data, reps) {
    DATA = data || {};
    if (!DATA.segments) throw new Error('집계본에 segments 가 없습니다 (예전 형식)');
    delete DATA._segs0;                       // 다시 불러오면 교체 반영도 처음부터
    setReplacements(reps !== undefined ? reps : DATA.replacements);
    return DATA;
  }
  function raw() { return DATA; }

  /* ═══════════════════════════ 공구 교체 ═══════════════════════════
     공구를 갈면 그 순간부터 «다른 공구» 다. 그 전에 쌓인 마모는 지금 물려
     있는 공구의 것이 아니다. 그래서 교체일 이후의 자료만 남겨 처음부터 다시
     센다. 이게 없으면 한 번 교체되는 순간부터 화면의 모든 숫자가 거짓이 된다.

     날짜 규칙 — 교체일을 «포함» 한다. 그날 아침에 갈았다고 보고 그날치를 새
     공구에 붙인다. 실제로 오후에 갈았다면 새 공구가 조금 더 닳은 것으로
     나오는데, 그 방향이 안전하다. 경보는 늦게 뜨는 것보다 일찍 뜨는 게 낫다.

     같은 공구를 여러 번 갈았으면 «가장 마지막» 교체일만 쓴다.

     자(k)는 건드리지 않는다. 자는 mes_calib.json 에 얼려 둔 값이고, 교체는
     «어디서부터 세는가» 의 문제지 «얼마나 닳는가» 의 문제가 아니다. */

  const YMD = /^\d{4}-\d{2}-\d{2}$/;

  /* 이력 목록 → { 공구번호: 마지막 교체일 }. 형식이 어긋난 줄은 조용히 버린다. */
  function cutMap(list) {
    const m = Object.create(null);
    (list || []).forEach(r => {
      const t = parseInt(r && r.tool, 10);
      const at = String((r && r.at) || '').slice(0, 10);
      if (!isFinite(t) || !YMD.test(at)) return;
      if (!m[t] || at > m[t]) m[t] = at;
    });
    return m;
  }

  /* 교체일 이전을 잘라 낸 구간을 새로 만든다. 원본은 건드리지 않는다. */
  function cutSeg(seg, cuts) {
    const tools0 = seg.tools || [];
    if (!tools0.some(t => cuts[t.tool])) return seg;

    const dropDay = Object.create(null);      // 날짜 → 이 날 버린 마모량
    const ratioOf = Object.create(null);      // 공구 → 남은 비율
    const cutList = [];
    const tools = [];

    for (const t of tools0) {
      const R = cuts[t.tool];
      if (!R) { tools.push(t); continue; }
      const bdAll = t.byday || [];
      if (!bdAll.length) {
        /* 날짜별 자료가 없는 예전 집계본은 자를 수가 없다. 자른 척하지 않고
           «못 잘랐다» 고 남긴다. 화면이 그 사실을 보여 준다. */
        tools.push(Object.assign({}, t, {
          replaced_at: R,
          replace_note: '이 집계본에는 날짜별 자료가 없어 교체일 이후만 셀 수 없습니다',
        }));
        cutList.push({ tool: t.tool, name: t.name, at: R, applied: false });
        continue;
      }
      const bd = [], keepRaw = { r: 0, h: 0, n: 0 };
      for (const x of bdAll) {
        if (x.date >= R) {
          bd.push(x);
          keepRaw.r += x.raw; keepRaw.h += x.hours; keepRaw.n += x.rows;
        } else {
          dropDay[x.date] = (dropDay[x.date] || 0) + x.raw;
        }
      }
      const ratio = (t.raw > 0) ? keepRaw.r / t.raw : 0;
      ratioOf[t.tool] = ratio;
      const progs = {};
      Object.keys(t.progs || {}).forEach(k => { progs[k] = t.progs[k] * ratio; });
      tools.push(Object.assign({}, t, {
        raw: keepRaw.r, hours: round(keepRaw.h, 3), rows: keepRaw.n, byday: bd, progs: progs,
        /* 인자별(f_m/f_o/f_s/f_c)과 프로그램별은 날짜로 안 쪼개 뒀다.
           남은 비율로 나눈 어림값이다 — sliceSeg 가 쓰는 방식과 같다. */
        f_m: t.f_m * ratio, f_o: t.f_o * ratio,
        f_s: t.f_s * ratio, f_c: t.f_c * ratio,
        replaced_at: R, before_raw: t.raw,
      }));
      cutList.push({
        tool: t.tool, name: t.name, at: R, applied: true,
        dropped_raw: t.raw - keepRaw.r, kept_raw: keepRaw.r,
      });
    }

    tools.sort((a, b) => b.raw - a.raw);
    const tot = tools.reduce((s, t) => s + t.raw, 0);
    tools.forEach(t => { t.share = tot > 0 ? round(100 * t.raw / tot, 3) : 0; });

    /* 날짜별에서도 같은 양을 뺀다. 이걸 빼지 않으면
       «날짜별 마모율의 합 = 공구별 마모율의 합» 이 깨진다. */
    const days = (seg.days || []).map(d => {
      const c = dropDay[d.date] || 0;
      return c ? Object.assign({}, d, { raw: Math.max(d.raw - c, 0) }) : d;
    });

    /* 프로그램별은 날짜로 안 쪼개 뒀다. 공구별 남은 비율로 깎는다 (어림값). */
    const progs0 = seg.progs || [];
    const mdrop = Object.create(null);
    const progs = progs0.map(p => {
      const ts = p.tools || [];
      if (!ts.some(x => ratioOf[x.tool] !== undefined)) return p;
      let dropped = 0;
      const nt = ts.map(x => {
        const r = ratioOf[x.tool];
        if (r === undefined) return x;
        dropped += x.raw * (1 - r);
        return Object.assign({}, x, { raw: x.raw * r });
      });
      nt.sort((a, b) => b.raw - a.raw);
      mdrop[p.main] = (mdrop[p.main] || 0) + dropped;
      return Object.assign({}, p, { raw: Math.max(p.raw - dropped, 0), tools: nt });
    });
    const mains = (seg.mains || []).map(m => (mdrop[m.main]
      ? Object.assign({}, m, { raw: Math.max(m.raw - mdrop[m.main], 0) }) : m));

    /* 교체 전에 난 이벤트는 지금 공구의 것이 아니다. */
    const events = (seg.events || []).filter(e => {
      const R = cuts[e.tool];
      return !R || String(e.time || '').slice(0, 10) >= R;
    });

    /* 절삭시간(cut_h)·행수는 «설비가 실제로 돈 시간» 이다. 공구를 갈았다고
       설비가 덜 돈 게 아니므로 그대로 둔다. 그래서 교체 뒤에는
       시간당 마모율(hour_wear)이 낮게 나온다 — 분모에 교체 전 가공시간이
       남아 있기 때문이다. info().replaced 로 그 사실을 화면에 알린다. */
    return Object.assign({}, seg, {
      tools: tools, days: days, progs: progs, mains: mains, events: events,
      raw_total: tot, _cut: cutList,
    });
  }

  /* 이력을 갈아 끼운다. 원본 구간은 _segs0 에 남겨 두므로 몇 번을 불러도
     두 번 깎이지 않는다. */
  function setReplacements(list) {
    const reps = (list || []).filter(r => r && YMD.test(String(r.at || '').slice(0, 10)))
      .map(r => Object.assign({}, r, {
        tool: parseInt(r.tool, 10), at: String(r.at).slice(0, 10),
      }))
      .filter(r => isFinite(r.tool))
      .sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : a.tool - b.tool));
    DATA.replacements = reps;
    if (!DATA.segments) return reps;
    if (!DATA._segs0) DATA._segs0 = DATA.segments;
    const base = DATA._segs0;
    const cuts = cutMap(reps);
    const out = {};
    Object.keys(base).forEach(k => {
      out[k] = Object.keys(cuts).length ? cutSeg(base[k], cuts) : base[k];
    });
    DATA.segments = out;
    return reps;
  }

  function replacements() { return DATA.replacements || []; }

  function levelOf(w) {
    const names = Object.keys(ALERTS).sort((a, b) => ALERTS[b] - ALERTS[a]);
    for (const n of names) if (w >= ALERTS[n]) return n;
    return '정상';
  }

  /* ═══════════════════════════ 조회 시작일 ═══════════════════════
     고른 날짜부터의 자료만 남긴 구간을 새로 만든다.

     공구별 마모량은 집계본의 byday(공구 × 날짜)를 다시 더해서 낸다.
     그래서 마모율이 '그 기간 동안 닳은 양' 으로 바뀐다 — 전체 누적이 아니다.

     byday 가 없는 예전 집계본이면 자를 수 없다. 그때는 원래 구간을 그대로
     돌려주고 sliced=false 로 알린다. 화면이 그 사실을 표시한다. */
  function sliceSeg(seg, from, to) {
    const days = seg.days || [];
    if ((!from && !to) || !days.length) return seg;
    const lo = from || days[0].date;
    const hi = to || days[days.length - 1].date;
    if (lo <= days[0].date && hi >= days[days.length - 1].date) return seg;   // 전체와 같다
    const hasByday = (seg.tools || []).some(t => Array.isArray(t.byday) && t.byday.length);
    if (!hasByday) return Object.assign({}, seg, { _noByday: true });

    const keep = d => d >= lo && d <= hi;
    const D = days.filter(x => keep(x.date));
    if (!D.length) {
      // 마지막 날보다 뒤를 고르면 빈 결과가 된다 — 빈 채로 정직하게 보여준다
      return Object.assign({}, seg, {
        days: [], tools: [], events: [], rows: 0, cut_h: 0, raw_total: 0, parts: 0,
        _from: lo, _to: hi, _sliced: true, _empty: true,
      });
    }

    const tools = [];
    for (const t of (seg.tools || [])) {
      const bd = (t.byday || []).filter(x => keep(x.date));
      if (!bd.length) continue;                         // 이 기간에 안 쓴 공구는 뺀다
      const raw = bd.reduce((s, x) => s + x.raw, 0);
      if (!(raw > 0)) continue;
      tools.push(Object.assign({}, t, {
        raw: raw,
        hours: round(bd.reduce((s, x) => s + x.hours, 0), 3),
        rows: bd.reduce((s, x) => s + x.rows, 0),
        byday: bd,
        /* 인자별(f_m/f_o/f_s/f_c)은 날짜로 안 쪼개 뒀다. 기간 비율로 나눈 어림값이라
           표시할 때 '어림' 이라고 알려야 한다. */
        f_m: t.f_m * (raw / (t.raw || 1)), f_o: t.f_o * (raw / (t.raw || 1)),
        f_s: t.f_s * (raw / (t.raw || 1)), f_c: t.f_c * (raw / (t.raw || 1)),
      }));
    }
    tools.sort((a, b) => b.raw - a.raw);
    const tot = tools.reduce((s, t) => s + t.raw, 0) || 1;
    tools.forEach(t => { t.share = round(100 * t.raw / tot, 3); });

    const cutH = round(D.reduce((s, x) => s + (x.cut_h || 0), 0), 3);
    const out = Object.assign({}, seg, {
      days: D, tools: tools, rows: D.reduce((s, x) => s + (x.rows || 0), 0),
      cut_h: cutH, raw_total: tot,
      parts: D.reduce((s, x) => s + (x.parts || 0), 0),
      events: (seg.events || []).filter(e => keep(String(e.time).slice(0, 10))),
      period: (D.length === 1) ? D[0].date : `${D[0].date} ~ ${D[D.length - 1].date}`,
      _from: lo, _to: hi, _sliced: true,
    });

    if (seg.oee) {
      out.oee = Object.assign({}, seg.oee, {
        states: (seg.oee.states || []).filter(s => keep(s.day)),
      });
      if (seg.oee.production) {
        const pd = (seg.oee.production.days || []).filter(x => keep(x.day));
        out.oee.production = Object.assign({}, seg.oee.production, {
          days: pd,
          events: (seg.oee.production.events || []).filter(e => keep(e.day)),
          produced: pd.reduce((s, x) => s + (x.inc || 0), 0),
        });
      }
    }
    return out;
  }

  /* ═══════════════════════════ 기준 적용 */
  class Basis {
    constructor(q) {
      q = q || {};
      const d = DATA.defaults || {};
      const segs = DATA.segments || {};
      /* 아무것도 안 고르면 «전체» 부터 본다. 부품 모델이 둘로 갈린 뒤로는
         한쪽만 보면 설비의 절반만 보는 셈이고, 자도 전체로 맞춰져 있다. */
      const pick = () => ('all' in segs) ? 'all' : (Object.keys(segs)[0] || 'fa');
      this.segKey = q.seg || d.segment || pick();
      if (!(this.segKey in segs)) this.segKey = pick();
      this.fullSeg = segs[this.segKey] || {};

      /* 조회 시작일 — 'YYYY-MM-DD'. 비어 있으면 구간 전체다. */
      const ymd = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
      this.from = ymd(q.from);
      this.to = ymd(q.to);
      this.seg = (this.from || this.to)
        ? sliceSeg(this.fullSeg, this.from, this.to) : this.fullSeg;

      const f = (v, dflt) => {
        const n = parseFloat(v);
        return isFinite(n) ? n : dflt;
      };
      this.lifeDays = f(q.life, f(d.life_days, 400));
      this.weekHours = f(q.week, f(d.week_hours, 38));
      this.anchor = String(q.anchor || d.anchor || 'set');

      this.dayHours = this.weekHours / 7;
      this.lifeCutHours = this.lifeDays * this.dayHours;
      this.totalH = this.seg.cut_h || 0;          // 이 화면이 보고 있는 기간의 절삭시간

      /* ── 환산계수 k 는 '구간 전체' 로 한 번 정하고 얼린다 ────────────
         예전에는 보고 있는 화면(this.seg)으로 k 를 다시 계산했다. 그래서
         날짜를 고르거나 구간을 바꾸면 남의 공구 사정 때문에 내 공구 마모율이
         움직였다. 8/20 에 T33 을 안 썼는데도 그날 다른 공구가 돌면
         raw_total 과 절삭시간이 늘어 T33 값이 올라갔다. 그건 마모계가 아니다.

         이제 k 는 fullSeg 로만 정해진다. 마모율 = k × 그 공구 자기 raw 다.
           · 안 쓴 날엔 안 움직인다
           · 날짜별 마모율을 더하면 정확히 전체와 같다 (raw 가 가산이므로)
           · 「전체」를 눌러도 튀지 않는다
         기준(평균 공구가 L일에 100%)은 그대로다 — 잡는 시점만 고정했다. */
      this.baseSeg = this.fullSeg;
      this.baseH = this.baseSeg.cut_h || 0;
      const baseTools = this.baseSeg.tools || [];
      const baseTotal = this.baseSeg.raw_total || 0;
      this.baseN = baseTools.length || 1;
      this.baseMean = baseTotal / this.baseN;

      /* ── 보정본이 있으면 그것이 자다 ─────────────────────────────
         집계본에 calib 가 있으면 자는 «그때 한 번 정해진 것» 이다. 구간을
         바꿔도, 날짜를 좁혀도, 새 주차를 더해도 이 자는 안 바뀐다.
         그래서 어떤 공구든 자기 가공이 없으면 값이 움직이지 않는다.
         기준일수·주간시간을 화면에서 바꾸면 그만큼만 비례해 바뀐다. */
      this.calib = DATA.calib || null;
      const C = this.calib;
      /* 보정값을 쓰라고 했는데 집계본에 없다 — 조용히 다른 기준으로 넘어가면
         «왜 숫자가 이러지» 가 된다. 넘어가되 그 사실을 화면에 남긴다. */
      this.calibMissing = (this.anchor === 'calib'
        && !(C && C.anchor_raw > 0 && C.cut_h > 0));
      /* 앵커가 «공구» 인 경우 그 번호. 보정값을 쓸 때도 그 뒤에는 공구가 있다.
         화면이 «그 공구가 지금 얼마나 닳았나» 를 물을 수 있어야 한다. */
      this.anchorTool = null;
      if (this.anchor === 'calib' && C && C.anchor_raw > 0 && C.cut_h > 0) {
        this.anchorRaw = C.anchor_raw;
        this.baseH = C.cut_h;
        this.anchorTool = C.tool;
        this.anchorLabel = `T${C.tool} 보정 (${C.period || C.made_at || '기준'})`;
      } else if (this.anchor === 'set') {
        this.anchorRaw = baseTotal;
        this.anchorLabel = '세트 전체';
      } else if (this.anchor === 'mean') {
        this.anchorRaw = this.baseMean;
        this.anchorLabel = `평균 공구 (${this.baseN}종 기준)`;
      } else {
        const tno = parseInt(this.anchor, 10);
        const t = baseTools.find(x => x.tool === tno);
        if (!t) {                      // 이 구간에 없는 공구를 고르면 세트로 되돌린다
          this.anchor = 'set';
          this.anchorRaw = baseTotal;
          this.anchorLabel = '세트 전체';
        } else {
          this.anchorRaw = t.raw;
          this.anchorTool = t.tool;
          this.anchorLabel = `T${t.tool} ${t.name}`;
        }
      }

      /* 구간 전체의 절삭시간으로 잡는다. 조회 기간을 좁혀도 자가 안 바뀐다. */
      this.k = (this.anchorRaw > 0 && this.lifeCutHours > 0)
        ? 100.0 * this.baseH / (this.lifeCutHours * this.anchorRaw) : 0.0;

      /* 예상 수명·사용강도는 '그 공구의 전 기간 누적' 으로 봐야 뜻이 통한다.
         하루치 raw 로 수명을 내면 수천 일이 나온다. */
      this.fullRawMap = Object.create(null);
      baseTools.forEach(t => { this.fullRawMap[t.tool] = t.raw; });

      /* ── 「기준일수 예상」 ─────────────────────────────────────
         마모율은 «기록된 것» 만 담는다. 그 원칙은 안 건드린다.
         대신 «이 기간이 그대로 반복되면 기준일수에 몇 %가 되나» 를 옆에
         따로 계산해 둔다. 기록과 예측을 한 칸에 섞지 않기 위해서다.

         배수 = 기준일수 ÷ 관측한 달력일수
           관측 달력일수는 첫날부터 마지막날까지, 양쪽 다 포함해서 센다.
           (08-06 ~ 09-03 이면 29일. 28일로 세면 예측이 3.6% 부풀려진다)

         이 배수는 주간 가동시간과 무관하다. 주간시간은 «100% 가 몇 시간인가»
         를 정할 뿐, 이 기간에 실제로 얼마나 깎았는지를 바꾸지 않는다.

         언제나 구간 전체(fullSeg)로 잡는다. 화면에서 날짜를 좁혀도
         «앞으로 어떻게 될까» 의 근거는 전 기간이라야 한다. */
      const fd = this.fullSeg.days || [];
      this.spanDays = fd.length
        ? Math.round((Date.parse(fd[fd.length - 1].date) - Date.parse(fd[0].date))
          / 86400000) + 1 : 0;
      this.horizonDays = this.lifeDays;
      this.horizonMul = (this.spanDays > 0) ? this.horizonDays / this.spanDays : 0;
    }

    /* 기준 공구가 지금 보고 있는 구간에서 실제로 돌았는가.
       앵커가 멈추면 「기준 대비 진행」이 굳는다 — 그 사실을 숨기지 않는다. */
    anchorSeen() {
      if (this.anchorTool === null) return true;      // 세트·평균 기준은 해당 없음
      const t = (this.seg.tools || []).find(x => x.tool === this.anchorTool);
      return !!(t && t.raw > 0);
    }

    /* 기준 공구의 «지금» 마모량. 안 돌았으면 얼린 보정값으로 물러선다. */
    anchorNowRaw() {
      if (this.anchorTool === null) return this.anchorRaw;
      const t = (this.seg.tools || []).find(x => x.tool === this.anchorTool);
      return (t && t.raw > 0) ? t.raw : this.anchorRaw;
    }

    /* 그 공구가 기준일수 시점에 몇 %일 것인가 — 전 기간 누적 × 배수.
       예측이지 기록이 아니다. 화면은 반드시 그렇게 표시해야 한다. */
    project(tno, dflt) {
      if (!(this.horizonMul > 0)) return null;
      return this.k * this.fullRaw(tno, dflt) * this.horizonMul;
    }

    wear(r) { return this.k * r; }

    /* 평균 공구 대비 사용강도 배수. 분모는 구간 전체의 평균 공구로 고정한다.
       그래야 마모율 = (기준 대비 진행) × 사용강도 가 조회 기간과 무관하게 성립한다. */
    intensity(r) {
      if (this.baseMean <= 0) return null;
      return r / this.baseMean;
    }

    /* 그 공구의 전 기간 누적 raw. 날짜를 좁혀 봐도 수명·강도는 이걸 쓴다. */
    fullRaw(tno, dflt) {
      const v = this.fullRawMap[tno];
      return (typeof v === 'number' && v > 0) ? v : dflt;
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

        /* 조회 시작일 관련 */
        from: this.from,
        to: this.to,
        one_day: !!(this.from && this.to && this.from === this.to),
        sliced: !!this.seg._sliced,
        empty: !!this.seg._empty,
        /* 날짜를 고르기 전에도 알 수 있어야 한다. 골라 보고 나서야 '안 된다' 고
           하면 사용자는 무엇이 잘못됐는지 모른다. */
        no_byday: !(this.fullSeg.tools || [])
          .some(t => Array.isArray(t.byday) && t.byday.length),
        date_range: (() => {
          const d = this.fullSeg.days || [];
          return d.length ? { min: d[0].date, max: d[d.length - 1].date, count: d.length }
            : { min: '', max: '', count: 0 };
        })(),
        from_note: !(this.fullSeg.tools || [])
          .some(t => Array.isArray(t.byday) && t.byday.length)
          ? '이 집계본에는 날짜별 자료가 없어 기간을 자를 수 없습니다.'
          : (this.seg._sliced
            ? (this.from && this.to && this.from === this.to
              ? `마모율은 ${this.from} 하루 동안 닳은 양입니다. 하루씩 더하면 전체와 같습니다.`
              : '마모율은 선택한 기간에 쌓인 양입니다. 기간을 더하면 전체와 같습니다.')
            : ''),
        /* 환산계수를 잡은 기준. 조회 기간을 좁혀도 이 값은 안 바뀐다. */
        base_hours: round(this.baseH, 2),
        base_tools: this.baseN,
        life_days: this.lifeDays,
        week_hours: this.weekHours,
        day_hours: round(this.dayHours, 4),
        life_cut_hours: round(this.lifeCutHours, 1),
        anchor: this.anchor,
        anchor_label: this.anchorLabel,
        /* 자를 언제 무엇으로 만들었는지 — 화면이 밝힐 수 있어야 한다 */
        calib_missing: this.calibMissing,
        calib_note: this.calibMissing
          ? '이 집계본에는 고정된 자(보정값)가 없습니다 — 예전 집계본입니다. '
            + '지금은 «세트 전체» 기준으로 보고 있어 숫자가 다릅니다. '
            + 'python mes_rebuild.py 로 다시 집계해 올리세요.'
          : '',
        calib: this.calib ? {
          tool: this.calib.tool, period: this.calib.period || '',
          cut_h: this.calib.cut_h, days: this.calib.days || 0,
          made_at: this.calib.made_at || '',
          fixed: this.anchor === 'calib',
        } : null,
        observed_hours: round(this.totalH, 2),
        hour_wear: this.totalH
          ? round(this.k * (this.seg.raw_total || 0) / this.totalH, 5) : 0,
        set_wear: round(this.k * (this.seg.raw_total || 0), 4),
        life_options: LIFE_OPTIONS,
        week_options: WEEK_OPTIONS.map(w => ({ v: w, note: WEEK_NOTE[w] || '' })),
        anchor_options: (this.calib ? [{
          v: 'calib',
          label: `T${this.calib.tool} 보정값 (고정)`,
          note: `${this.calib.period || this.calib.made_at} 자료로 한 번 맞춘 자 — 새 주차를 더해도 안 바뀝니다`,
        }] : []).concat([
          { v: 'mean', label: '평균 공구 = 기준일수', note: '많이 쓴 공구는 빨리, 적게 쓴 공구는 천천히 도달' },
          { v: 'set', label: '세트 전체 = 기준일수', note: '세트 단위 일괄 교체 정책 그대로' },
        ]).concat((this.seg.tools || []).slice(0, 8).map(t => ({
          /* 자릿수를 고정한다. 그냥 두면 5 와 5.0 처럼 파이썬과 갈린다. */
          v: String(t.tool), label: `T${t.tool} ${t.name} = 기준일수`,
          note: `기여도 ${Number(t.share).toFixed(2)}%`,
        }))),
        segments: Object.keys(segs).map(k => ({
          key: k, label: segs[k].label, period: segs[k].period,
          tools: segs[k].tools.length, hours: segs[k].cut_h,
        })),
        /* 「기준일수 예상」의 근거 — 화면이 그대로 밝힐 수 있어야 한다.
           예측이라는 사실과, 무엇을 전제했는지를 숫자와 함께 들고 다닌다. */
        horizon: {
          days: this.horizonDays,
          span_days: this.spanDays,
          multiple: round(this.horizonMul, 4),
          label: `${this.horizonDays.toFixed(0)}일 예상`,
          note: this.spanDays > 0
            /* 자릿수를 고정한다. round() 로 두면 20 과 20.0 처럼 파이썬과
               표기가 갈려 대조 시험이 문자열에서 걸린다. */
            ? `관측 ${this.spanDays}일치가 그대로 반복된다는 전제로 `
              + `${this.horizonMul.toFixed(2)}배 한 값입니다. 예측이며, 마모율에는 섞지 않습니다.`
            : '관측 기간을 알 수 없어 예상을 낼 수 없습니다.',
        },
        /* 교체 반영 — 이 구간에서 어떤 공구를 언제부터 다시 세고 있는가.
           applied=false 면 «날짜별 자료가 없어 못 잘랐다» 는 뜻이다. */
        replaced: (this.fullSeg._cut || []).slice(),
        replaced_count: (this.fullSeg._cut || []).filter(x => x.applied).length,
        replaced_note: (this.fullSeg._cut || []).some(x => x.applied)
          ? '교체한 공구는 교체일부터 다시 셉니다. 절삭시간은 설비 기준이라 그대로여서, '
            + '시간당 마모율은 교체 전 가공시간이 분모에 남아 낮게 나옵니다.'
          : '',
        switch: DATA.switch || '',
        built: DATA.built || '',
        weights: DATA.weights || {},
        /* 부류별 인자 가중치. 파손형은 다른 한 벌을 쓴다 — 화면이 그 사실을
           밝힐 수 있어야 «왜 TAP 만 값이 다르지» 가 안 생긴다. */
        units: DATA.units || null,
        /* 조건 정규화 추세의 근거 — 화면이 «무엇을 잰 값인지» 밝힐 수 있어야 한다 */
        trend_basis: (DATA.tool_trend ? {
          made_at: DATA.tool_trend.made_at || '', span_days: DATA.tool_trend.span_days || 0,
          weeks: DATA.tool_trend.weeks || 0, min_rows: DATA.tool_trend.min_rows || 0,
          basis: DATA.tool_trend.basis || '', note: DATA.tool_trend.note || '',
          count: Object.keys((DATA.tool_trend.tools) || {}).length,
        } : null),
        thresholds: DATA.thresholds || {},
      };
    }
  }

  /* ═══════════════════════════ 공구 종류 ═══════════════════════════
     이름에서 종류를 뽑는다. 「6.8 D/R 드릴」과 「8.5 D/R 드릴」은 지름만 다른
     같은 종류다. 종류로 묶어 보면 «드릴이 세트 마모의 절반» 같은 게 한눈에
     보이고, 발주도 종류 단위로 하는 편이 현장 실무에 가깝다.

     판정은 이름의 «약호» 로 한다. 앞의 치수(6.8 · 23.0x24.0)와 뒤의 괄호
     (D/R(L) · E/M(F))는 같은 종류 안의 변형이므로 무시한다.

     순서가 중요하다 — 위에서부터 먼저 걸리는 것을 쓴다. PORT 를 TAP 보다
     앞에 둔 이유는 「PF1/4 PORT」가 TAP 이 아니기 때문이다.
     (이름에 PF1/4 가 들어가도 PORT 는 구멍 가공이지 나사 내기가 아니다)

     mes_core.py 의 TOOL_KINDS 와 한 글자도 달라선 안 된다. */
  const TOOL_KINDS = [
    ['PORT', /\bPORT\b/i, '포트'],
    ['TAP', /\bTAP\b/i, '탭'],
    ['DR', /\d\s*D\s*\/?\s*R\b/i, '드릴 (D/R)'],
    ['UR', /\d\s*U\s*\/?\s*R\b/i, '리머 (U/R)'],
    ['EM', /\bE\s*\/?\s*M\b/i, '엔드밀 (E/M)'],
    ['FC', /\bF\s*\/?\s*C\b/i, '페이스커터 (F/C)'],
    ['TC', /\bT\s*\/?\s*C\b/i, 'T/C'],
    ['CR', /\bC\s*\/?\s*R\b/i, '챔퍼 (C/R)'],
    ['BT', /\bB\s*\/?\s*T\b/i, '보링 (B/T)'],
  ];
  const KIND_ETC = ['ETC', null, '기타'];

  function toolKind(name) {
    const n = String(name || '');
    if (n) {
      for (const [key, re, label] of TOOL_KINDS) {
        if (re.test(n)) return { key: key, label: label };
      }
    }
    return { key: KIND_ETC[0], label: KIND_ETC[2] };
  }

  /* 종류별로 묶어 합계를 낸다. 각 종류 안에서는 마모율 순으로 세운다.
     종류별 마모율의 합 = 전체 공구 마모율의 합 이어야 한다 (그냥 더한 것이므로). */
  function toolKinds(b) {
    const rows = toolList(b);
    const g = new Map();
    for (const t of rows) {
      const k = toolKind(t.name);
      let e = g.get(k.key);
      if (!e) {
        e = { key: k.key, label: k.label, tools: [], wear: 0, wear_h: 0,
          hours: 0, rows: 0, share: 0, breakage: 0, order: TOOL_KINDS.length };
        const i = TOOL_KINDS.findIndex(x => x[0] === k.key);
        e.order = (i < 0) ? TOOL_KINDS.length : i;
        g.set(k.key, e);
      }
      e.tools.push(t);
      e.wear += t.wear;
      e.wear_h += (t.wear_h || 0);
      e.hours += (t.hours || 0);
      e.rows += (t.rows || 0);
      e.share += (t.share || 0);
      if (t.cls === 'breakage') e.breakage += 1;
    }
    const out = Array.from(g.values());
    out.forEach(e => {
      e.tools.sort((x, y) => y.wear - x.wear);
      e.count = e.tools.length;
      e.top = e.tools[0] || null;
      /* 종류 안에서 가장 많이 닳은 공구가 그 종류의 «대표 위험» 이다.
         합계만 보면 종수가 많은 종류가 무조건 위로 오므로 최대값도 같이 낸다. */
      e.max_wear = e.top ? e.top.wear : 0;
      e.wear = round(e.wear, 4);
      e.wear_h = round(e.wear_h, 4);
      e.hours = round(e.hours, 3);
      e.share = round(e.share, 3);
      e.avg_wear = round(e.count ? e.wear / e.count : 0, 4);
    });
    /* 마모율이 큰 종류부터. 같으면 정해 둔 순서대로 — 화면이 매번 안 흔들리게. */
    out.sort((a, c) => (c.wear - a.wear) || (a.order - c.order));
    return {
      basis: b.info(), kinds: out,
      total_wear: round(out.reduce((s, e) => s + e.wear, 0), 4),
      total_tools: out.reduce((s, e) => s + e.count, 0),
      note: '공구 이름의 약호로 묶었습니다. 치수(6.8 · 23.0x24.0)와 '
        + '괄호 표기(D/R(L) · E/M(F))는 같은 종류의 변형으로 봅니다.',
    };
  }

  /* ═══════════════════════════ 프로그램 이름 ═══════════════════════
     O0702 같은 NC 번호는 기계가 붙인 것이라 사람이 못 읽는다. 현장이 붙인
     한국어 이름을 옆에 달아 준다.

     이름은 집계본에 안 넣는다. 집계본은 CSV 에서 다시 만들어지는 것이고,
     이름은 사람이 적는 것이라 재집계할 때마다 날아가면 안 된다.
     Supabase 에 따로 두고 여기서 갖다 붙인다 (mes_supa.js 가 실어 준다). */
  function progNames() { return DATA.prog_names || {}; }

  /* 「O0702 · 리어커버 황삭」. 이름이 없으면 번호만. */
  function progLabel(prog) {
    const n = (DATA.prog_names || {})[String(prog)];
    return n ? `${prog} · ${n}` : String(prog);
  }

  /* ═══════════════════════════ 조회 응답 */
  /* 파손형은 «닳아서» 가 아니라 «부러져서» 죽는다. 그래서 같은 숫자라도
     부르는 이름이 달라야 한다 — 마모형은 «마모율», 파손형은 «파손 위험도».
     값을 바꾸는 게 아니라 무엇을 뜻하는지를 바로잡는 것이다.
     70% 가 마모형에는 «수명의 70% 를 썼다» 지만, 파손형에는 «그만큼의
     과부하·충격을 누적해 왔다» 이지 «70% 부러졌다» 가 아니다. */
  function wearLabel(cls) { return cls === 'breakage' ? '파손 위험도' : '마모율'; }

  function toolRow(b, t) {
    const iv = b.intensity(t.raw);
    /* 예상은 «기록» 옆에 따로 선다. wear 는 손대지 않는다. */
    const pj = b.project(t.tool, t.raw);
    /* 조건 정규화 추세 — 가중치 없이 관측한 값. 계산에는 안 들어가고
       값 옆에 따로 선다 (mes_supa.js 가 Supabase 에서 실어 준다). */
    const tr = ((DATA.tool_trend || {}).tools || {})[String(t.tool)] || null;
    return {
      tool: t.tool, name: t.name, cls: t.cls,
      wear: round(b.wear(t.raw), 4),
      wear_label: wearLabel(t.cls),
      trend: tr ? {
        pct_per_week: tr.pct_per_week, cum_pct: tr.cum_pct, rows: tr.rows,
      } : null,
      wear_h: (pj === null) ? null : round(pj, 4),
      intensity: iv ? round(iv, 2) : null,
      share: t.share, hours: t.hours, rows: t.rows,
      /* 교체한 공구면 «언제부터 센 값인지» 를 값과 함께 들고 다닌다.
         숫자만 보고 «왜 갑자기 낮아졌지» 하지 않도록. */
      replaced_at: t.replaced_at || null,
      replace_note: t.replace_note || '',
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
        /* 기준 공구가 «지금» 얼마나 닳았나.
           예전에는 얼린 보정값(b.anchorRaw)을 그대로 썼다. 그건 «보정하던
           시점의 값» 이라 주차를 아무리 더해도 안 움직인다. 화면의
           「기준 대비 진행」이 영원히 같은 숫자로 굳어 있게 된다.
           기준 공구의 지금 마모량으로 낸다. 그 공구가 이 구간에 안 나오면
           (안 돌았으면) 얼린 값으로 물러서고, anchor_live 로 알린다. */
        anchor_wear: round(b.wear(b.anchorNowRaw()), 4),
        anchor_live: b.anchorSeen(),
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
    /* 수명·수명근거는 '그 공구의 전 기간 누적' 으로 낸다. 하루만 골라 보고 있을 때
       그날 raw 로 수명을 내면 수천 일이 나와 뜻이 없다. */
    const fr = b.fullRaw(tno, t.raw);
    const lf = b.life(fr);
    const fi = b.intensity(fr);
    const progs = {};
    Object.keys(t.progs || {}).forEach(k => { progs[k] = round(b.wear(t.progs[k]), 5); });
    Object.assign(row, {
      machining: round(b.wear(t.f_m), 5),
      overload: round(b.wear(t.f_o), 5),
      shock: round(b.wear(t.f_s), 5),
      cond_change: round(b.wear(t.f_c), 5),
      progs: progs,
      life: lf ? round(lf, 1) : null,
      life_basis: lf ? `${b.lifeDays.toFixed(0)}일 × (${b.anchorLabel} 기준) ÷ 사용강도 `
        + `${fi ? round(fi, 2) : '-'}배 (전 기간 누적 기준)`
        /* 교체 직후에는 쌓인 양이 적어 수명이 실제보다 길게 나온다.
           숫자를 손대지 않고 그 사실만 옆에 적는다. */
        + (t.replaced_at
          ? ` — ${t.replaced_at} 교체 후 자료만 반영. 쌓인 기간이 짧아 길게 나옵니다`
          : '') : null,
    });
    const ev = (b.seg.events || []).filter(e => e.tool === tno).slice(0, 30).map(e => ({
      time: e.time, tool: e.tool, name: e.name, prog: e.prog,
      type: e.type, delta: round(b.wear(e.raw), 6),
    }));
    return { tool: row, level: levelOf(row.wear), events: ev };
  }

  function programs(b) {
    /* 현장이 붙인 한국어 이름을 같이 실어 준다. 없으면 빈 문자열이고,
       화면은 그때 번호만 보여 준다 — 「(이름 없음)」 같은 자리채움은 안 쓴다. */
    const PN = DATA.prog_names || {};
    return {
      mains: (b.seg.mains || []).map(m => ({
        main: m.main, hours: m.hours, wear: round(b.wear(m.raw), 4), progs: m.progs,
        name: PN[String(m.main)] || PN['O' + m.main] || '',
      })),
      progs: (b.seg.progs || []).map(p => ({
        prog: p.prog, main: p.main, hours: p.hours, rows: p.rows,
        wear: round(b.wear(p.raw), 4),
        name: PN[String(p.prog)] || '',
        main_name: PN[String(p.main)] || PN['O' + p.main] || '',
      })),
      names: PN,
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
    setReplacements, replacements, cutMap, cutSeg,
    toolRow, toolList, overview, toolDetail,
    toolKind, toolKinds, TOOL_KINDS, progNames, progLabel,
    programs, programDetail, sales, orders,
    health, oee, machining,
    ALERTS, ORDER_LEVEL, LIFE_OPTIONS, WEEK_OPTIONS, GAP_REASON,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MES;
  else root.MES = MES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
