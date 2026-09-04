/* ═══════════════════════════════════════════════════════════════
 * 집계 엔진 — mes_rebuild.py 의 자바스크립트 이식
 * ═══════════════════════════════════════════════════════════════
 * 브라우저가 CSV 를 직접 읽어 집계본을 만든다. 현장 PC 의 파이썬 없이
 * 웹에서 '데이터 추가 → 재집계' 를 끝낸다.
 *
 * 수백 MB 를 다루므로 전체를 메모리에 올리지 않는다.
 *   File.slice() 로 잘라 읽고 → TextDecoder(stream) 로 이어 붙이고
 *   → 한 줄씩 처리하고 버린다. 남는 것은 집계 결과뿐이다.
 *
 * 파이썬과 수치가 달라지면 안 되는 곳이 세 군데다.
 *   1) 행별 초 배분   같은 초를 공유하는 행끼리 간격을 나눠 갖는다
 *   2) 합계 누적      100만 행을 그냥 더하면 오차가 쌓인다. 카한 합을 쓴다
 *   3) 분위수        numpy.percentile 의 선형보간과 같아야 한다
 *
 * 사용:
 *   const snap = await MESAGG.run(file, { onProgress: p => ... });
 */
(function (root) {
  'use strict';

  /* ── 상수 — mes_rebuild.py 와 동일해야 한다 ───────────────── */
  const UNIT = {
    machining: 0.0000656580, overload: 0.0058825832,
    shock: 0.0020956450, cond_change: 0.0000044341,
  };
  const CUR_MED = 989.0, CUR_THR = 2246.0, VIB_THR = 8.44;
  const F_TH = 500.0, R_TH = 100.0, REF = 500.0;
  const VIB_AGE_MAX = 250;
  const SWITCH_MS = Date.parse('2026-08-24T16:00:00');   // 부품 모델 전환 시각

  const SEG_META = {
    fa: { label: 'FA 밸브', period: '2026-08-06 ~ 08-24 16:00' },
    rear: { label: '3.5톤 RearCover', period: '2026-08-24 16:00 ~ 08-27' },
    all: { label: '전체 (구간 혼합)', period: '2026-08-06 ~ 08-27' },
  };

  /* ── 카한 합 — 100만 번 더해도 오차가 안 쌓인다 ───────────── */
  function Kahan() { this.s = 0; this.c = 0; }
  Kahan.prototype.add = function (v) {
    if (!(v === v)) return;                    // NaN 은 버린다
    const y = v - this.c, t = this.s + y;
    this.c = (t - this.s) - y;
    this.s = t;
  };
  Kahan.prototype.val = function () { return this.s; };

  /* ── 분위수 — 값 빈도를 세서 numpy.percentile 과 같게 낸다 ──
     100만 개를 다 들고 있으면 메모리가 터진다. 값을 반올림해 빈도만 세면
     서로 다른 값이 보통 수만 개라 충분히 작다.

     자리수가 중요하다. 전류·서보처럼 원본이 소수 3자리인 값은 3자리로 세도
     원본 그대로지만, 불평형률처럼 나눗셈으로 만든 값은 자리가 무한하다.
     3자리로 뭉개면 분위수 보간이 파이썬과 0.001 어긋난다. 그래서 6자리로
     세고, 서로 다른 값이 너무 많아지면 그때 3자리로 낮춘다(메모리 보호). */
  const CAP = 1500000;
  function Dist(name) {
    this.name = name; this.n = 0; this.sum = new Kahan();
    this.max = -Infinity; this.map = new Map(); this.nd = 6; this.coarse = false;
  }
  Dist.prototype._coarsen = function () {
    const m = new Map();
    for (const [k, c] of this.map) {
      const k3 = pyround(k, 3);
      m.set(k3, (m.get(k3) || 0) + c);
    }
    this.map = m; this.nd = 3; this.coarse = true; this._keys = null;
  };
  /* 여기서는 빠른 반올림을 쓴다. 통 나누기용이라 1e-6 자리에서 한 칸 밀려도
     출력(소수 3자리)에는 영향이 없다. 파이썬과 자리를 맞춰야 하는 곳은
     최종 출력뿐이고 거기서는 pyround 를 쓴다. */
  Dist.prototype.add = function (v) {
    if (!(v > -Infinity && v < Infinity)) return;      // NaN·무한대 제외
    this.n++; this.sum.add(v);
    if (v > this.max) this.max = v;
    const s = this.nd === 6 ? 1e6 : 1e3;
    const k = Math.round(v * s) / s;
    const m = this.map, c = m.get(k);
    if (c === undefined) {
      m.set(k, 1);
      if (m.size > CAP && !this.coarse) this._coarsen();
    } else m.set(k, c + 1);
  };
  Dist.prototype.sorted = function () {
    if (!this._keys) this._keys = Array.from(this.map.keys()).sort((a, b) => a - b);
    return this._keys;
  };
  /* 정렬했을 때 k 번째(0부터) 값 */
  Dist.prototype.at = function (k) {
    const keys = this.sorted();
    let acc = 0;
    for (let i = 0; i < keys.length; i++) {
      acc += this.map.get(keys[i]);
      if (k < acc) return keys[i];
    }
    return keys[keys.length - 1];
  };
  /* numpy.percentile 기본값(linear) 과 같은 방식 */
  Dist.prototype.pct = function (p) {
    if (this.n === 0) return null;
    const idx = (this.n - 1) * p / 100;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    const a = this.at(lo);
    if (lo === hi) return a;
    return a + (this.at(hi) - a) * (idx - lo);
  };
  Dist.prototype.stat = function () {
    if (this.n === 0) return null;
    return {
      n: this.n, mean: r3(this.sum.val() / this.n),
      p50: r3(this.pct(50)), p95: r3(this.pct(95)),
      max: r3(this.max), name: this.name,
    };
  };

  /* 파이썬 round(v, nd) 와 결과가 같아야 한다. Math.round(v*1000)/1000 은 두 군데서 갈린다.
       · 9.4745 는 실제로 9.47449999... 라 파이썬은 내리는데 v*1000 은 올린다
       · 정확히 .5 로 떨어지면 파이썬은 짝수로 보낸다 (은행가 반올림)
     충분한 자리까지 십진으로 펼쳐 보고 판단한다. mes_calc.js 와 같은 함수다. */
  function pyround(v, nd) {
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return v;
    const neg = v < 0;
    const a = Math.abs(v);
    const s = a.toFixed(Math.min(nd + 25, 100));
    const dot = s.indexOf('.');
    const keep = s.slice(0, dot) + s.slice(dot + 1, dot + 1 + nd);
    const rest = s.slice(dot + 1 + nd);
    let n = parseInt(keep, 10);
    if (rest[0] === '5' && /^50*$/.test(rest)) { if (n % 2 !== 0) n += 1; }
    else if (rest && rest[0] >= '5') n += 1;
    const out = n / Math.pow(10, nd);
    return neg ? -out : out;
  }
  const r3 = v => (v === null || v === undefined || !isFinite(v)) ? null : pyround(v, 3);

  /* ── CSV 한 줄 쪼개기 — 따옴표 있는 줄만 느린 길로 보낸다 ── */
  function splitLine(s) {
    if (s.indexOf('"') < 0) return s.split(',');
    const out = []; let cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /* ── 파일을 줄 단위로 흘려보낸다 ─────────────────────────── */
  async function streamLines(file, onHeader, onLine, onProgress) {
    const CHUNK = 8 << 20;                       // 8MB 씩
    const dec = new TextDecoder('utf-8');
    let rest = '', off = 0, header = null, n = 0, lastTick = 0;

    while (off < file.size) {
      const buf = await file.slice(off, off + CHUNK).arrayBuffer();
      off += CHUNK;
      const text = rest + dec.decode(buf, { stream: off < file.size });
      const lines = text.split('\n');
      rest = lines.pop();                        // 마지막 조각은 다음 덩어리와 이어붙인다

      for (let i = 0; i < lines.length; i++) {
        let ln = lines[i];
        if (ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);   // \r 제거
        if (!ln) continue;
        if (header === null) { header = splitLine(ln); onHeader(header); continue; }
        onLine(ln); n++;
      }
      if (onProgress && Date.now() - lastTick > 120) {
        lastTick = Date.now();
        onProgress({ bytes: Math.min(off, file.size), total: file.size, rows: n });
        await new Promise(r => setTimeout(r, 0));   // 화면이 멈추지 않게 양보한다
      }
    }
    if (rest) {
      let ln = rest.charCodeAt(rest.length - 1) === 13 ? rest.slice(0, -1) : rest;
      if (ln) { if (header === null) onHeader(splitLine(ln)); else { onLine(ln); n++; } }
    }
    if (onProgress) onProgress({ bytes: file.size, total: file.size, rows: n, done: true });
    return n;
  }

  /* ── 구간별 누적기 ───────────────────────────────────────── */
  function newSeg() {
    return {
      rows: 0, cutSec: new Kahan(),
      T: new Map(),        // 공구별
      PR: new Map(),       // 프로그램별
      MN: new Map(),       // 메인 프로그램별
      DY: new Map(),       // 날짜별
      EV: [],              // 과부하·충격 이벤트
      H: null,             // 건전성 (지연 생성)
      HD: new Map(),       // 날짜별 건전성 중앙값용
      OFF: new Map(), GC: new Map(), FO: new Map(), OT: new Map(),
      POS: null,
      pcMin: Infinity, pcMax: -Infinity, pcPrev: null, pcPrevTs: null,
      incs: [], gaps: [], pcDay: new Map(),
    };
  }
  const bump = (m, k, mk) => { let v = m.get(k); if (!v) { v = mk(); m.set(k, v); } return v; };

  function healthBox() {
    return {
      imbalance: new Dist('3상 전류 불평형률 (%)'),
      cur_r: new Dist('R상 전류 raw'), cur_s: new Dist('S상 전류 raw'),
      cur_t: new Dist('T상 전류 raw'),
      servo_x: new Dist('X 서보 부하율 (%)'), servo_y: new Dist('Y 서보 부하율 (%)'),
      servo_z: new Dist('Z 서보 부하율 (%)'),
      freq_x: new Dist('X 진동 주파수 (Hz)'), freq_y: new Dist('Y 진동 주파수 (Hz)'),
      freq_z: new Dist('Z 진동 주파수 (Hz)'),
      vib_temp: new Dist('진동센서 온도 (℃)'), uyeg_temp: new Dist('UYeG 온도 (℃)'),
      uyeg_humi: new Dist('UYeG 습도 (%)'), spindle_load: new Dist('주축 부하율 (%)'),
    };
  }
  function posBox() {
    return {
      x: new Dist('X 기계좌표'), y: new Dist('Y 기계좌표'),
      z: new Dist('Z 기계좌표'), b: new Dist('B축 위치'),
    };
  }

  /* ── 공구 분류 — TAP 과 6mm 미만 드릴은 파손형 ───────────── */
  const TAP = /TAP/i, DR = /([\d.]+)\s*D\/?R/i;
  function toolClass(n) {
    if (!n) return 'wear';
    if (TAP.test(n)) return 'breakage';
    const m = DR.exec(n);
    if (m) { const d = parseFloat(m[1]); if (isFinite(d)) return d < 6.0 ? 'breakage' : 'wear'; }
    return 'wear';
  }

  /* ═══════════════════════════ 본체 ═══════════════════════════ */
  async function run(file, opt) {
    opt = opt || {};
    const skip = new Set(opt.skipDays || []);
    const map = opt.columns || null;         // {표준이름: 파일의 컬럼명}
    const segs = { fa: newSeg(), rear: newSeg() };

    let H = null, idx = {};
    const want = [
      'Update_time', 'RunState', 'ToolNo', 'ToolName', 'SpindleRPM', 'Feed', 'Cur_Max',
      'Vib_X_mms', 'Vib_Y_mms', 'Vib_Z_mms', 'VibAgeMs', 'FanucOk', 'VibOk', 'CurOk',
      'MainPGM', 'ProgName', 'PartCount', 'Cur_R', 'Cur_S', 'Cur_T',
      'X_Current', 'Y_Current', 'Z_Current', 'Vib_FreqX', 'Vib_FreqY', 'Vib_FreqZ',
      'UYeG_Temp', 'UYeG_Humi', 'Vib_Temp', 'WorkOffset', 'MotionGCode',
      'FeedOverride', 'SpindleLoad', 'X_Mac', 'Y_Mac', 'Z_Mac', 'B_AxisPos', 'BootTimeSec',
    ];
    const missing = [];

    function onHeader(cols) {
      H = cols.map(c => c.trim());
      const pos = {};
      H.forEach((c, i) => { pos[c] = i; });
      for (const w of want) {
        const actual = (map && map[w]) || w;
        idx[w] = (actual in pos) ? pos[actual] : -1;
        if (idx[w] < 0) missing.push(w);
      }
      if (idx['Update_time'] < 0) throw new Error('Update_time 컬럼을 찾지 못했습니다');
      if (idx['RunState'] < 0) throw new Error('RunState 컬럼을 찾지 못했습니다');
      if (idx['ToolNo'] < 0) throw new Error('ToolNo 컬럼을 찾지 못했습니다');
    }

    /* 같은 초를 공유하는 행을 모았다가, 다음 초가 오면 한꺼번에 처리한다.
       한 행이 갖는 시간 = (다음 초까지의 간격) ÷ (그 초를 나눠 쓰는 행 수) */
    let pend = [], pool = [], pendSec = null, prevTool = null, prevFeed = 0, prevRpm = 0;
    let bootMin = Infinity, bootMax = -Infinity, total = 0, backwards = 0;

    function flush(nextSec) {
      if (!pend.length) return;
      const gap = (nextSec === null) ? 0 : Math.min(Math.max(nextSec - pendSec, 0), 1.0);
      const per = gap / pend.length;
      for (let i = 0; i < pend.length; i++) emit(pend[i], per);
      pend.length = 0; pendSec = null;
    }

    function emit(row, sec) {
      const S = segs[row.seg];
      S.rows++;

      const day = row.day;
      const D = bump(S.DY, day, () => ({
        sec: new Kahan(), cutsec: new Kahan(), raw: new Kahan(), rows: 0, states: new Map(),
      }));
      D.rows++; D.sec.add(sec);
      const stAcc = D.states;
      stAcc.set(row.st, (stAcc.get(row.st) || 0) + sec);

      /* 생산 카운터 — 누적값이라 '증분' 만 센다 */
      if (row.pc > 0) {
        if (row.pc < S.pcMin) S.pcMin = row.pc;
        const pd = bump(S.pcDay, day, () => ({ lo: Infinity, hi: -Infinity }));
        if (row.pc < pd.lo) pd.lo = row.pc;
        if (row.pc > pd.hi) pd.hi = row.pc;
      }
      if (row.pc > S.pcMax) S.pcMax = row.pc;
      if (S.pcPrev !== null && row.pc > S.pcPrev && S.pcPrev > 0 && row.pc > 0) {
        S.incs.push({ time: row.iso, day: day, frm: S.pcPrev, to: row.pc });
        if (S.pcPrevTs !== null) {
          const mins = (row.ms - S.pcIncTs) / 60000;
          if (S.pcIncTs && mins > 0 && mins < 1440) S.gaps.push(Math.round(mins * 10) / 10);
        }
        S.pcIncTs = row.ms;
      }
      S.pcPrev = row.pc; S.pcPrevTs = row.ms;

      /* ── 온습도·센서온도는 절삭 여부와 무관하게 전 구간에서 본다 */
      if (!S.H) S.H = healthBox();
      S.H.vib_temp.add(row.vibTemp);
      S.H.uyeg_temp.add(row.uyegTemp / 100);
      S.H.uyeg_humi.add(row.uyegHumi);

      if (!row.gate) return;                      // 여기부터는 절삭 + 품질통과 행만

      D.cutsec.add(sec);
      S.cutSec.add(sec);

      /* 인자별 마모 증분 */
      const d_m = Math.max(row.cur / CUR_MED, 0.2) * sec * UNIT.machining;
      const d_o = (row.cur > CUR_THR ? (row.cur - CUR_THR) / CUR_THR : 0) * sec * UNIT.overload;
      const d_s = ((row.vib > VIB_THR && row.fresh) ? (row.vib - VIB_THR) / VIB_THR : 0)
        * sec * UNIT.shock;
      const d_c = ((row.dF > F_TH ? row.dF / REF : 0) + (row.dR > R_TH ? row.dR / REF : 0))
        * UNIT.cond_change;
      const raw = d_m + d_o + d_s + d_c;
      D.raw.add(raw);

      const t = bump(S.T, row.tool, () => ({
        name: '', sec: new Kahan(), rows: 0, raw: new Kahan(),
        m: new Kahan(), o: new Kahan(), s: new Kahan(), c: new Kahan(),
        progs: new Map(), days: new Map(),
      }));
      if (!t.name && row.name) t.name = row.name;
      t.rows++; t.sec.add(sec); t.raw.add(raw);
      t.m.add(d_m); t.o.add(d_o); t.s.add(d_s); t.c.add(d_c);
      t.progs.set(row.prog, (t.progs.get(row.prog) || 0) + raw);

      /* 공구 × 날짜. 조회 시작일을 고르면 이 값으로 다시 더해 마모율을 낸다.
         이게 없으면 '이 날짜 이후로 얼마나 닳았나' 를 답할 수 없다.
         구간당 공구 수 × 일수라 크기는 얼마 안 된다. */
      let td = t.days.get(day);
      if (!td) { td = { raw: new Kahan(), sec: new Kahan(), rows: 0 }; t.days.set(day, td); }
      td.raw.add(raw); td.sec.add(sec); td.rows++;

      const p = bump(S.PR, row.prog, () => ({
        main: '', sec: new Kahan(), rows: 0, raw: new Kahan(), tools: new Map(),
      }));
      p.main = row.main; p.rows++; p.sec.add(sec); p.raw.add(raw);
      p.tools.set(row.tool, (p.tools.get(row.tool) || 0) + raw);

      const mn = bump(S.MN, row.main, () => ({ sec: new Kahan(), raw: new Kahan(), progs: new Set() }));
      mn.sec.add(sec); mn.raw.add(raw); mn.progs.add(row.prog);

      /* 건전성 — 절삭 구간만 */
      const h = S.H;
      h.imbalance.add(row.imb); h.cur_r.add(row.R); h.cur_s.add(row.S); h.cur_t.add(row.Tc);
      h.servo_x.add(row.sx); h.servo_y.add(row.sy); h.servo_z.add(row.sz);
      h.freq_x.add(row.fx); h.freq_y.add(row.fy); h.freq_z.add(row.fz);
      h.spindle_load.add(row.spl);

      const hd = bump(S.HD, day, () => ({
        imb: new Dist(), sx: new Dist(), sy: new Dist(), sz: new Dist(),
        fx: new Dist(), temp: new Dist(), humi: new Dist(),
      }));
      hd.imb.add(row.imb); hd.sx.add(row.sx); hd.sy.add(row.sy); hd.sz.add(row.sz);
      hd.fx.add(row.fx); hd.temp.add(row.vibTemp); hd.humi.add(row.uyegHumi);

      /* 가공 분석 */
      S.OFF.set(row.wo, (S.OFF.get(row.wo) || 0) + sec);
      S.GC.set(row.gc, (S.GC.get(row.gc) || 0) + sec);
      S.FO.set(row.fo, (S.FO.get(row.fo) || 0) + sec);
      const otk = row.wo + ' ' + row.tool;
      S.OT.set(otk, (S.OT.get(otk) || 0) + sec);
      if (!S.POS) S.POS = posBox();
      S.POS.x.add(row.xm); S.POS.y.add(row.ym); S.POS.z.add(row.zm); S.POS.b.add(row.bax);

      if ((d_o > 0 || d_s > 0) && S.EV.length < 1500) {
        const tags = [];
        if (d_o > 0) tags.push('과부하 전류 ' + row.cur.toFixed(0));
        if (d_s > 0) tags.push('충격 진동 ' + row.vib.toFixed(1) + 'mm/s');
        S.EV.push({
          time: row.iso, tool: row.tool, name: row.name, prog: row.prog,
          raw: raw, type: tags.join(' · '),
        });
      }
    }

    const F = (a, i) => { if (i < 0) return 0; const v = +a[i]; return v === v ? v : 0; };

    function onLine(ln) {
      const a = splitLine(ln);
      const tRaw = a[idx['Update_time']];
      if (!tRaw) return;
      const ms = Date.parse(tRaw.length === 19 ? tRaw.replace(' ', 'T') : tRaw);
      if (!(ms === ms)) return;
      const day = tRaw.slice(0, 10);
      if (skip.has(day)) return;
      total++;

      const st = a[idx['RunState']] || '';
      const tool = F(a, idx['ToolNo']) | 0;
      const gate = st.indexOf('절삭') >= 0
        && F(a, idx['FanucOk']) === 1 && F(a, idx['VibOk']) === 1 && F(a, idx['CurOk']) === 1
        && tool > 0;

      const feed = F(a, idx['Feed']), rpm = F(a, idx['SpindleRPM']);
      const same = (prevTool !== null && tool === prevTool);
      const dF = same ? Math.abs(feed - prevFeed) : 0;
      const dR = same ? Math.abs(rpm - prevRpm) : 0;
      prevTool = tool; prevFeed = feed; prevRpm = rpm;

      const vx = F(a, idx['Vib_X_mms']), vy = F(a, idx['Vib_Y_mms']), vz = F(a, idx['Vib_Z_mms']);
      const age = F(a, idx['VibAgeMs']);
      const R = F(a, idx['Cur_R']), Sc = F(a, idx['Cur_S']), Tc = F(a, idx['Cur_T']);
      const pmean = (R + Sc + Tc) / 3;
      const imb = pmean > 50
        ? (Math.max(R, Sc, Tc) - Math.min(R, Sc, Tc)) / Math.max(pmean, 1) * 100 : NaN;

      const boot = F(a, idx['BootTimeSec']);
      if (boot < bootMin) bootMin = boot;
      if (boot > bootMax) bootMax = boot;

      let prog = idx['ProgName'] >= 0 ? (a[idx['ProgName']] || '') : '';
      if (!prog) prog = '-';

      /* 한 초에 모이는 행은 많아야 예닐곱이다. 그만큼만 만들어 두고 돌려 쓴다.
         100만 번 객체를 새로 만들면 가비지 수집이 따라오지 못한다.

         순서가 중요하다. 자리를 먼저 잡고 나중에 flush 하면, 앞 초가 비워지면서
         이미 pend 에 들어간 객체를 덮어쓴다. 반드시 flush 를 끝내고 자리를 잡는다. */
      /* 이 방식은 시각이 오름차순이라는 것을 전제로 한다. 한 초에 모인 행을
         모았다가 다음 초가 오면 간격을 나눠 갖기 때문이다.
         거꾸로 가는 행이 있으면 그 행의 시간 배분이 틀어진다. 조용히 틀린 숫자를
         내는 것이 가장 나쁘므로 세어 두었다가 결과에 붙여 알린다. */
      const s = (ms / 1000) | 0;
      if (pendSec !== null && s < pendSec) backwards++;
      if (pendSec === null) pendSec = s;
      else if (s !== pendSec) { flush(s); pendSec = s; }

      const row = pool[pend.length] || (pool[pend.length] = {});
      row.seg = ms < SWITCH_MS ? 'fa' : 'rear'; row.day = day; row.iso = tRaw; row.ms = ms;
      row.st = st; row.tool = tool; row.gate = gate;
      row.name = idx['ToolName'] >= 0 ? (a[idx['ToolName']] || '') : '';
      row.prog = prog; row.main = String(F(a, idx['MainPGM']) | 0);
      row.cur = F(a, idx['Cur_Max']);
      row.vib = vx > vy ? (vx > vz ? vx : vz) : (vy > vz ? vy : vz);
      row.fresh = age >= 0 && age <= VIB_AGE_MAX; row.dF = dF; row.dR = dR;
      row.pc = F(a, idx['PartCount']);
      row.R = R; row.S = Sc; row.Tc = Tc; row.imb = imb;
      row.sx = F(a, idx['X_Current']); row.sy = F(a, idx['Y_Current']); row.sz = F(a, idx['Z_Current']);
      row.fx = F(a, idx['Vib_FreqX']); row.fy = F(a, idx['Vib_FreqY']); row.fz = F(a, idx['Vib_FreqZ']);
      row.vibTemp = F(a, idx['Vib_Temp']); row.uyegTemp = F(a, idx['UYeG_Temp']);
      row.uyegHumi = F(a, idx['UYeG_Humi']); row.spl = F(a, idx['SpindleLoad']);
      row.wo = idx['WorkOffset'] >= 0 ? String(a[idx['WorkOffset']] || '') : '';
      row.gc = idx['MotionGCode'] >= 0 ? String(a[idx['MotionGCode']] || '') : '';
      row.fo = F(a, idx['FeedOverride']) | 0;
      row.xm = F(a, idx['X_Mac']); row.ym = F(a, idx['Y_Mac']); row.zm = F(a, idx['Z_Mac']);
      row.bax = F(a, idx['B_AxisPos']);
      pend.push(row);
    }

    await streamLines(file, onHeader, onLine, opt.onProgress);
    flush(null);                                  // 마지막 초는 간격 0

    return finish(segs, { rows: total, missing, bootMin, bootMax, backwards, name: file.name });
  }

  /* ═══════════════════════════ 결과 조립 ═══════════════════════ */
  function build(S) {
    const tools = [];
    for (const [tno, t] of S.T) {
      const progs = {};
      Array.from(t.progs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .forEach(([k, v]) => { progs[k] = v; });
      /* 날짜순으로. 조회 시작일 이후만 더하면 그 기간 마모량이 나온다. */
      const byDay = Array.from(t.days.keys()).sort().map(d => {
        const v = t.days.get(d);
        return { date: d, raw: v.raw.val(), hours: r3(v.sec.val() / 3600), rows: v.rows };
      });
      tools.push({
        tool: tno, name: t.name || ('T' + tno), cls: toolClass(t.name),
        raw: t.raw.val(), hours: r3(t.sec.val() / 3600), rows: t.rows,
        f_m: t.m.val(), f_o: t.o.val(), f_s: t.s.val(), f_c: t.c.val(),
        progs: progs, byday: byDay,
      });
    }
    tools.sort((a, b) => b.raw - a.raw);
    const tot = tools.reduce((s, t) => s + t.raw, 0) || 1;
    tools.forEach(t => { t.share = r3(100 * t.raw / tot); });

    const progs = [];
    for (const [k, v] of S.PR) {
      progs.push({
        prog: k, main: v.main, hours: r3(v.sec.val() / 3600), rows: v.rows, raw: v.raw.val(),
        tools: Array.from(v.tools.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)
          .map(([x, y]) => ({ tool: x, raw: y })),
      });
    }
    progs.sort((a, b) => b.raw - a.raw);

    const mains = [];
    for (const [k, v] of S.MN) {
      if (k === '-' || k === '0') continue;
      mains.push({ main: k, hours: r3(v.sec.val() / 3600), raw: v.raw.val(), progs: Array.from(v.progs).sort() });
    }
    mains.sort((a, b) => b.raw - a.raw);

    const days = Array.from(S.DY.keys()).sort().map(k => {
      const v = S.DY.get(k), states = {};
      for (const [x, y] of v.states) if (y > 0) states[x] = r3(y / 3600);
      const pd = S.pcDay.get(k);
      return {
        date: k, cut_h: r3(v.cutsec.val() / 3600), raw: v.raw.val(), rows: v.rows,
        parts: pd && isFinite(pd.hi) ? Math.max(pd.hi - (isFinite(pd.lo) ? pd.lo : pd.hi), 0) : 0,
        states: states,
      };
    });

    const events = S.EV.slice().sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0)).slice(0, 600);

    /* 건전성 */
    const health = {};
    if (S.H) for (const k of Object.keys(S.H)) health[k] = S.H[k].stat();
    health.days = Array.from(S.HD.keys()).sort().map(d => {
      const h = S.HD.get(d), o = { day: d };
      for (const k of ['imb', 'sx', 'sy', 'sz', 'fx', 'temp', 'humi']) {
        const v = h[k].pct(50);
        o[k] = v === null ? null : pyround(v, 2);
      }
      return o;
    });

    /* 가동률 */
    const stateRows = [];
    for (const d of Array.from(S.DY.keys()).sort()) {
      const v = S.DY.get(d);
      for (const [st, sec] of v.states) stateRows.push({ day: d, st: st, h: r3(sec / 3600) });
    }
    const counterStuck = S.incs.length === 0;
    const gaps = S.gaps.slice().sort((a, b) => a - b);
    const median = gaps.length
      ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2]
        : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2) : null;
    const produced = (isFinite(S.pcMin) && isFinite(S.pcMax)) ? (S.pcMax - S.pcMin) : 0;
    const oee = {
      states: stateRows,
      production: {
        counter_min: isFinite(S.pcMin) ? S.pcMin : 0,
        counter_max: isFinite(S.pcMax) ? S.pcMax : 0,
        produced: counterStuck ? 0 : produced,
        events: S.incs.slice(0, 200), n_events: S.incs.length,
        cycle_min: {
          n: gaps.length, median: median === null ? null : pyround(median, 1),
          min: gaps.length ? gaps[0] : null, max: gaps.length ? gaps[gaps.length - 1] : null,
        },
        counter_stuck: counterStuck,
        days: Array.from(S.pcDay.keys()).sort().map(d => {
          const v = S.pcDay.get(d);
          return {
            day: d, lo: isFinite(v.lo) ? v.lo : 0, hi: isFinite(v.hi) ? v.hi : 0,
            inc: isFinite(v.hi) && isFinite(v.lo) ? v.hi - v.lo : 0,
          };
        }),
      },
    };

    const srt = m => Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
    const machining = {
      offsets: srt(S.OFF).map(([k, v]) => ({ name: k, h: r3(v / 3600) })),
      gcode: srt(S.GC).map(([k, v]) => ({ name: k, h: r3(v / 3600) })),
      feed_ovr: srt(S.FO).slice(0, 6).map(([k, v]) => ({ val: k, h: r3(v / 3600) })),
      offset_tool: srt(S.OT).slice(0, 40).map(([k, v]) => {
        const p = k.split(' ');
        return { offset: p[0], tool: +p[1], h: r3(v / 3600) };
      }),
      pos: S.POS ? { x: S.POS.x.stat(), y: S.POS.y.stat(), z: S.POS.z.stat(), b: S.POS.b.stat() } : null,
    };

    return {
      rows: S.rows, cut_h: r3(S.cutSec.val() / 3600), raw_total: tot,
      tools: tools, progs: progs, mains: mains, days: days, events: events,
      parts: oee.production.produced,
      parts_note: counterStuck ? 'PartCount 카운터가 움직이지 않아 생산량을 알 수 없음' : '',
      health: health, oee: oee, machining: machining,
    };
  }

  function finish(segs, meta) {
    const out = {};
    for (const k of ['fa', 'rear']) {
      if (segs[k].rows === 0) continue;
      out[k] = build(segs[k]);
      Object.assign(out[k], SEG_META[k]);
    }
    const keys = Object.keys(out);
    if (keys.length === 0) throw new Error('집계할 행이 없습니다. 날짜·컬럼을 확인하세요.');

    return {
      built: new Date().toISOString().slice(0, 19).replace('T', ' '),
      note: '마모량은 원시 단위. 기준 수명·주간 가동시간·앵커는 조회 시점에 적용한다.',
      switch: '2026-08-24 16:00 부품 모델 전환 (FA 밸브 → 3.5톤 RearCover)',
      thresholds: { cur_med: CUR_MED, cur_thr: CUR_THR, vib_thr: VIB_THR },
      weights: { 실가공: 50, 과부하: 27, 충격: 8, 조건급변: 5, 알람: 10 },
      defaults: { life_days: 400, week_hours: 38.0, anchor: 'mean', segment: keys[0] },
      segments: out,
      source: {
        file: meta.name, rows: meta.rows, missing: meta.missing,
        backwards: meta.backwards || 0,
        warn: meta.backwards
          ? `시각이 거꾸로 가는 행이 ${meta.backwards.toLocaleString()}개 있습니다. `
            + '수집 파일이 시간순이 아니면 절삭시간 배분이 부정확해집니다.'
          : '',
      },
    };
  }

  /* ── 기존 집계본과 합치기 ────────────────────────────────────
     새 CSV 는 보통 '다음 주차' 다. 같은 구간이면 더하고, 없으면 새로 넣는다.
     원시 마모는 단순 합산이 맞다 — 캘리브레이션 전 값이라 그렇다. */
  function mergeSeg(A, B) {
    const T = new Map();
    for (const src of [A.tools, B.tools]) {
      for (const t of src) {
        const e = T.get(t.tool);
        if (!e) {
          T.set(t.tool, Object.assign({}, t, {
            progs: Object.assign({}, t.progs),
            byday: (t.byday || []).map(d => Object.assign({}, d)),
          }));
          continue;
        }
        e.raw += t.raw; e.hours = r3(e.hours + t.hours); e.rows += t.rows;
        e.f_m += t.f_m; e.f_o += t.f_o; e.f_s += t.f_s; e.f_c += t.f_c;
        if (!e.name && t.name) { e.name = t.name; e.cls = t.cls; }
        for (const k of Object.keys(t.progs || {})) e.progs[k] = (e.progs[k] || 0) + t.progs[k];

        /* 같은 날짜가 양쪽에 있으면 더한다 (같은 주차를 두 번 올린 경우) */
        const dm = new Map((e.byday || []).map(d => [d.date, d]));
        for (const d of (t.byday || [])) {
          const x = dm.get(d.date);
          if (x) { x.raw += d.raw; x.hours = r3(x.hours + d.hours); x.rows += d.rows; }
          else dm.set(d.date, Object.assign({}, d));
        }
        e.byday = Array.from(dm.values()).sort((x, y) => (x.date < y.date ? -1 : 1));
      }
    }
    const tools = Array.from(T.values()).sort((a, b) => b.raw - a.raw);
    const tot = tools.reduce((s, t) => s + t.raw, 0) || 1;
    tools.forEach(t => { t.share = r3(100 * t.raw / tot); });

    const dayMap = new Map();
    for (const d of A.days.concat(B.days)) {
      const e = dayMap.get(d.date);
      if (!e) { dayMap.set(d.date, Object.assign({}, d, { states: Object.assign({}, d.states) })); continue; }
      e.cut_h = r3(e.cut_h + d.cut_h); e.raw += d.raw; e.rows += d.rows;
      e.parts += d.parts;
      for (const k of Object.keys(d.states || {})) e.states[k] = r3((e.states[k] || 0) + d.states[k]);
    }

    return Object.assign({}, B, {
      rows: A.rows + B.rows, cut_h: r3(A.cut_h + B.cut_h), raw_total: tot,
      tools: tools,
      days: Array.from(dayMap.values()).sort((x, y) => (x.date < y.date ? -1 : 1)),
      events: B.events.concat(A.events)
        .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0)).slice(0, 600),
      parts: A.parts + B.parts,
      period: (A.period && B.period && A.period !== B.period) ? (A.period + ' + ' + B.period) : B.period,
    });
  }

  const hasByday = seg => (seg && seg.tools || []).some(t => Array.isArray(t.byday) && t.byday.length);

  /* 옛 집계본과 새 집계본을 합친다.

     주의 — 옛 것에 날짜별 자료(byday)가 없으면 합치면 안 된다.
     합계는 옛 자료까지 더해지는데 날짜별은 새 것만 있어서, 날짜로 자를 때
     숫자가 안 맞는다. 그런 구간은 합치지 않고 새 것으로 바꾼다.
     조용히 틀린 값을 내는 것보다 낫고, 무슨 일이 있었는지 notes 로 알린다. */
  function merge(oldSnap, newSnap) {
    if (!oldSnap || !oldSnap.segments) return newSnap;
    const out = Object.assign({}, newSnap);
    out.segments = Object.assign({}, oldSnap.segments);
    const notes = [];

    for (const k of Object.keys(newSnap.segments)) {
      const prev = out.segments[k];
      if (!prev) { out.segments[k] = newSnap.segments[k]; continue; }
      if (!hasByday(prev) && hasByday(newSnap.segments[k])) {
        out.segments[k] = newSnap.segments[k];
        notes.push(`${prev.label || k} — 예전 집계본에 날짜별 자료가 없어 합치지 못하고 `
          + '이번 파일로 새로 만들었습니다.');
        continue;
      }
      out.segments[k] = mergeSeg(prev, newSnap.segments[k]);
    }

    out.defaults = oldSnap.defaults || newSnap.defaults;
    if (oldSnap.quality) out.quality = oldSnap.quality;
    if (notes.length) out.merge_notes = notes;
    return out;
  }

  const api = { run, merge, UNIT, Dist, Kahan, toolClass, splitLine, streamLines, _build: build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MESAGG = api;
})(typeof self !== 'undefined' ? self : this);
