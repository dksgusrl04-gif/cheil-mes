/* ═══════════════════════════════════════════════════════════════
 * 규칙 기반 질의 — API 키 없이도 답하는 부분
 * ═══════════════════════════════════════════════════════════════
 * mes_agent.py 의 RuleProvider 와 같은 역할이다.
 * Edge Function 이 배포돼 있으면 Claude 가 답하고, 없으면 여기가 답한다.
 *
 * 정해진 형태만 답한다. 대신 그 범위 안에서는 집계본의 실제 값을 쓰므로
 * 틀린 숫자가 나오지 않는다. 모르면 모른다고 하고 무엇을 물어볼 수 있는지 알려준다.
 *
 * 답을 못 하면 null 을 돌려준다. 부르는 쪽이 그때 안내를 띄운다.
 */
(function (root) {
  'use strict';

  const f2 = v => (typeof v === 'number' ? v.toFixed(2) : String(v));
  const f3 = v => (typeof v === 'number' ? v.toFixed(3) : String(v));
  const has = (q, ...ws) => ws.some(w => q.indexOf(w) >= 0);

  /* '8월 20일' · '08-20' · '2026-08-20' 을 날짜로 바꾼다 */
  function findDate(q, days) {
    let m = q.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
    m = q.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
    if (m) {
      const mmdd = `${p2(m[1])}-${p2(m[2])}`;
      const hit = days.find(d => d.date.endsWith(mmdd));
      return hit ? hit.date : (days[0] ? days[0].date.slice(0, 4) + '-' + mmdd : null);
    }
    m = q.match(/(\d{1,2})[-./](\d{1,2})(?!\d)/);
    if (m) {
      const mmdd = `${p2(m[1])}-${p2(m[2])}`;
      const hit = days.find(d => d.date.endsWith(mmdd));
      if (hit) return hit.date;
    }
    return null;
  }
  const p2 = n => String(n).padStart(2, '0');

  /* 프로그램별 과부하 기여 — 공구의 과부하량을 그 공구가 돈 프로그램 비율로 나눈 추정값 */
  function overloadByProg(tools) {
    const acc = new Map();
    for (const t of tools) {
      const progs = t.progs || {};
      const tot = Object.values(progs).reduce((s, v) => s + v, 0);
      if (!(t.f_o > 0)) continue;
      if (tot <= 0) { acc.set('-', (acc.get('-') || 0) + t.f_o); continue; }
      for (const p of Object.keys(progs)) {
        acc.set(p, (acc.get(p) || 0) + t.f_o * (progs[p] / tot));
      }
    }
    return Array.from(acc.entries()).sort((a, b) => b[1] - a[1]);
  }

  /* ctx = { MES, basis, snapshot, tools, orders, alerts, log } */
  function answer(q, ctx) {
    q = String(q || '').trim();
    if (!q) return null;
    const b = ctx.basis, i = b.info();
    const seg = b.seg;
    const tools = ctx.tools || ctx.MES.toolList(b);
    const days = seg.days || [];
    const 기준 = `기준: ${i.segment_label} · ${i.life_days}일 · 주간 ${i.week_hours}h · 앵커 ${i.anchor_label}`;

    /* ── 특정 공구 (T33 · 33번 공구) */
    let m = q.match(/\bT\s*(\d{1,3})\b/i) || q.match(/(\d{1,3})\s*번\s*공구/);
    if (m) {
      const no = parseInt(m[1], 10);
      const t = tools.find(x => x.tool === no);
      if (!t) return { answer: `T${no} 은 ${i.segment_label} 구간 데이터에 없습니다. ` +
        `이 구간에서 돈 공구는 ${tools.length}종입니다.`, how: '규칙' };
      const rank = tools.findIndex(x => x.tool === no) + 1;
      const raw = (seg.tools || []).find(x => x.tool === no) || {};
      const parts = [
        `**T${t.tool} ${t.name}** (${t.cls === 'breakage' ? '파손형' : '마모형'})`,
        ``,
        `- 현재 마모율 **${f2(t.wear)}%**`,
        `- 사용강도 **${f2(t.intensity)}배** (평균 공구 대비)`,
        `- 세트 기여도 ${f2(t.share)}% · 전체 ${tools.length}종 중 **${rank}위**`,
        `- 절삭 ${f3(t.hours)}h · ${t.rows.toLocaleString()}행`,
      ];
      if (raw.f_o !== undefined) {
        const s = (raw.f_m || 0) + (raw.f_o || 0) + (raw.f_s || 0) + (raw.f_c || 0);
        if (s > 0) {
          parts.push(`- 인자 구성 — 실가공 ${f2(100 * raw.f_m / s)}% · ` +
            `과부하 ${f2(100 * raw.f_o / s)}% · 충격 ${f2(100 * raw.f_s / s)}% · ` +
            `조건급변 ${f2(100 * raw.f_c / s)}%`);
        }
      }
      if (t.wear >= 70) parts.push(``, `주의 — 마모율이 70%를 넘어 발주 대상입니다.`);
      parts.push(``, 기준);
      return { answer: parts.join('\n'), how: '규칙' };
    }

    /* ── 가장 많이 닳은 공구 */
    if (has(q, '많이 닳', '가장 닳', '제일 닳', '마모가 큰', '마모율 높', '위험한 공구',
      '교체', '닳은 공구', '심한 공구')) {
      const top = tools.slice(0, 5);
      const lines = top.map((t, n) =>
        `${n + 1}. **T${t.tool} ${t.name}** — 마모율 ${f2(t.wear)}% · 사용강도 ${f2(t.intensity)}배 · 기여도 ${f2(t.share)}%`);
      const over = tools.filter(t => t.wear >= 70);
      return { answer: [`마모율 상위 5종입니다.`, ``, ...lines, ``,
        over.length ? `70% 이상 ${over.length}종 — 발주 검토 대상입니다.`
          : `70% 이상인 공구는 없습니다.`,
        ``, 기준,
        `공구 교체 이력이 없어 잔여 일수는 산출하지 않습니다. 사용강도는 기준과 무관한 관측값입니다.`,
      ].join('\n'), how: '규칙' };
    }

    /* ── 특정 날짜 */
    const d = findDate(q, days);
    if (d && has(q, '가동', '절삭', '시간', '생산', '실적', '얼마', '알려')) {
      const row = days.find(x => x.date === d);
      if (!row) return { answer: `${d} 은 ${i.segment_label} 구간 데이터에 없습니다. ` +
        `이 구간은 ${days.length ? days[0].date + ' ~ ' + days[days.length - 1].date : '-'} 입니다.`,
      how: '규칙' };
      const st = Object.entries(row.states || {}).sort((a, c) => c[1] - a[1]);
      return { answer: [`**${d}**`, ``,
        `- 절삭 **${f3(row.cut_h)}h** · 수집 ${row.rows.toLocaleString()}행`,
        st.length ? `- 상태별 — ${st.map(([k, v]) => `${k} ${f3(v)}h`).join(' · ')}` : '',
        row.parts ? `- 생산 ${row.parts}개` : `- 생산량 — ${seg.parts_note || '집계 안 됨'}`,
        ``, 기준,
      ].filter(Boolean).join('\n'), how: '규칙' };
    }

    /* ── 경보 */
    if (has(q, '경보', '알림', '위험', '이상')) {
      const a = ctx.alerts || {};
      const auto = a.auto || [];
      if (!auto.length) return { answer: '현재 자동 경보가 없습니다.', how: '규칙' };
      const c = { danger: 0, warn: 0, info: 0 };
      auto.forEach(x => { c[x.level] = (c[x.level] || 0) + 1; });
      const top = auto.slice(0, 8).map(x =>
        `- [${x.level === 'danger' ? '위험' : x.level === 'warn' ? '주의' : '참고'}] ${x.title}` +
        (x.evidence ? ` — ${x.evidence}` : ''));
      return { answer: [`자동 경보 **${auto.length}건** (위험 ${c.danger} · 주의 ${c.warn} · 참고 ${c.info || 0})`,
        ``, ...top, auto.length > 8 ? `\n… 외 ${auto.length - 8}건` : '', ``, 기준,
      ].filter(Boolean).join('\n'), how: '규칙' };
    }

    /* ── 발주 이력 */
    if (has(q, '발주', '주문', '누가', '구매')) {
      const o = (ctx.orders && ctx.orders.orders) || [];
      if (!o.length) return { answer: '발주 이력이 아직 없습니다.', how: '규칙' };
      const lines = o.slice(0, 10).map(r =>
        `- ${r.at} · **T${r.tool} ${r.name}** × ${r.qty} · ${r.status} · 등록 ${r.by}`);
      const byUser = {};
      o.forEach(r => { byUser[r.by] = (byUser[r.by] || 0) + 1; });
      return { answer: [`발주 **${o.length}건**` +
        ` (${Object.entries(byUser).map(([k, v]) => `${k} ${v}건`).join(' · ')})`,
      ``, ...lines, o.length > 10 ? `\n… 외 ${o.length - 10}건` : ''].filter(Boolean).join('\n'),
      how: '규칙' };
    }

    /* ── 과부하 · 충격 */
    if (has(q, '과부하', '충격', '진동', '부하')) {
      const rawTools = seg.tools || [];
      if (has(q, '프로그램')) {
        const rows = overloadByProg(rawTools).slice(0, 8);
        if (!rows.length) return { answer: '과부하가 기록된 프로그램이 없습니다.', how: '규칙' };
        const tot = rows.reduce((s, r) => s + r[1], 0);
        return { answer: [`과부하 기여가 큰 프로그램입니다.`, ``,
          ...rows.map(([p, v], n) => `${n + 1}. **${p}** — 과부하 기여 ${f2(100 * v / tot)}%`),
          ``, `공구별 과부하량을 그 공구가 돈 프로그램 비율로 나눈 추정값입니다.`,
          `전류 ${i.thresholds ? '' : ''}${(ctx.snapshot.thresholds || {}).cur_thr} 초과 구간을 과부하로 봅니다.`,
        ].join('\n'), how: '규칙' };
      }
      const key = has(q, '충격', '진동') ? 'f_s' : 'f_o';
      const label = key === 'f_s' ? '충격' : '과부하';
      const rows = rawTools.filter(t => t[key] > 0).sort((a, c) => c[key] - a[key]).slice(0, 6);
      if (!rows.length) return { answer: `${label}이 기록된 공구가 없습니다.`, how: '규칙' };
      const tot = rawTools.reduce((s, t) => s + (t[key] || 0), 0);
      return { answer: [`${label} 기여가 큰 공구입니다.`, ``,
        ...rows.map((t, n) => `${n + 1}. **T${t.tool} ${t.name}** — ${label} 기여 ${f2(100 * t[key] / tot)}%`),
        ``, 기준].join('\n'), how: '규칙' };
    }

    /* ── 기준 · 앵커 설명 */
    if (has(q, '기준', '앵커', '400일', '수명', '어떻게 계산', '계산식', '근거')) {
      return { answer: [`**지금 적용된 기준**`, ``,
        `- 구간 ${i.segment_label} (${i.segment_period})`,
        `- 기준 수명 ${i.life_days}일 · 주간 가동 ${i.week_hours}h`,
        `- 앵커 ${i.anchor_label}`,
        `- 관측 절삭 ${f2(i.observed_hours)}h`,
        ``,
        `앵커로 잡은 대상이 ${i.life_days}일에 100%가 되도록 환산계수를 정하고, ` +
        `그 계수를 모든 공구에 똑같이 적용합니다. 그래서 마모율은 절대값이 아니라 ` +
        `이 기준 위에서의 상대값입니다.`,
        ``,
        `사용강도(평균 공구 대비 소모 배수)는 기준을 바꿔도 변하지 않습니다. ` +
        `기준에 이견이 있을 때는 이쪽을 보시면 됩니다.`,
        ``,
        `가중치 — ${Object.entries(ctx.snapshot.weights || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
      ].join('\n'), how: '규칙' };
    }

    /* ── 생산량 */
    if (has(q, '생산', '수량', '개수', '몇 개', '사이클')) {
      const oee = seg.oee || {};
      const p = oee.production || {};
      const out = [`**생산 집계** — ${i.segment_label}`, ``];
      if (p.counter_stuck || !p.produced) {
        out.push(`생산량을 알 수 없습니다. ${seg.parts_note || 'PartCount 카운터가 움직이지 않았습니다.'}`);
        out.push(``, `PartCount 는 누적 카운터라 증분을 봐야 하는데, 이 구간에서는 값이 변하지 않았습니다.`);
      } else {
        out.push(`- 생산 **${p.produced}개** (카운터 ${p.counter_min} → ${p.counter_max})`);
        if (p.cycle_min && p.cycle_min.median) {
          out.push(`- 실측 사이클타임 중앙값 **${p.cycle_min.median}분** (${p.cycle_min.n}회 관측)`);
        }
      }
      return { answer: out.join('\n'), how: '규칙' };
    }

    /* ── 가동률 */
    if (has(q, '가동률', 'oee', 'OEE', '조업', '전체 가동')) {
      const tot = days.reduce((s, x) => s + (x.cut_h || 0), 0);
      const st = {};
      days.forEach(x => { for (const [k, v] of Object.entries(x.states || {})) st[k] = (st[k] || 0) + v; });
      const all = Object.values(st).reduce((s, v) => s + v, 0);
      return { answer: [`**가동 집계** — ${i.segment_label} · ${days.length}일`, ``,
        `- 절삭 합계 **${f2(tot)}h**`,
        ...Object.entries(st).sort((a, c) => c[1] - a[1]).map(([k, v]) =>
          `- ${k} ${f2(v)}h (${f2(100 * v / (all || 1))}%)`),
      ].join('\n'), how: '규칙' };
    }

    /* ── 빈 항목 · 데이터 품질 */
    if (has(q, '비어', '빈 ', '없는', '수집 안', '품질', '왜 없')) {
      const qa = ctx.snapshot.quality;
      const zero = qa && qa.columns ? qa.columns.filter(c => c.nonzero === 0) : [];
      return { answer: [`**수집되지 않는 항목**`, ``,
        zero.length
          ? `절삭 구간에서 값이 한 번도 들어오지 않은 컬럼이 **${zero.length}개** 입니다.\n` +
            zero.slice(0, 12).map(c => `- ${c.col}`).join('\n') +
            (zero.length > 12 ? `\n… 외 ${zero.length - 12}개` : '')
          : `집계본에 품질 스캔 결과가 없습니다.`,
        ``,
        `이 중 아픈 것은 두 가지입니다.`,
        `- **Vib_Kurt** (진동 첨도) — 공구 파손 조기 감지에 쓰는 값인데 3주 내내 0입니다. ` +
        `이게 있으면 TAP·소경 드릴의 파손을 미리 잡을 수 있습니다.`,
        `- **SpindleLoad** (주축 부하율) — 전류 대신 부하로 절삭을 판정할 수 있어 정확도가 올라갑니다.`,
        ``,
        `그동안은 전류(Cur_Max)와 진동 속도(Vib_*_mms)로 대신 보고 있습니다.`,
      ].join('\n'), how: '규칙' };
    }

    return null;      // 못 알아들었다
  }

  const CAN = [
    '제일 많이 닳은 공구는?',
    'T33 상태는?',
    '8월 20일 가동시간 알려줘',
    '현재 경보 요약해줘',
    '누가 발주했나?',
    '과부하가 많은 프로그램은?',
    '기준이 어떻게 되나?',
    '생산량은?',
    '데이터가 비어 있는 항목은?',
  ];

  const api = { answer, CAN, findDate, overloadByProg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MESASK = api;
})(typeof self !== 'undefined' ? self : this);
