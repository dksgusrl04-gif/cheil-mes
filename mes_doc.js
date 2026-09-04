/* ═══════════════════════════════════════════════════════════════
 * 서류 출력 — mes_report.py 의 자바스크립트 이식
 * ═══════════════════════════════════════════════════════════════
 * 양식(templates/*.html)을 읽어 자료를 끼워 넣는다. 양식은 앞머리에
 * 자기가 어떤 자료를 필요로 하는지 적어 두고, 엔진이 그걸 보고 준비한다.
 *
 *   <!--meta
 *   key: order            양식 식별자
 *   title: 공구 발주서     화면에 뜨는 이름
 *   data: order           필요한 자료 묶음 (order/wear/oee/health/mfg/alert)
 *   role: manager         볼 수 있는 권한
 *   -->
 *
 * 문법은 넷뿐이다.
 *   {{이름}}              값 넣기
 *   {{이름|f2}}           소수 2자리로
 *   {{#if 이름}}…{{else}}…{{/if}}
 *   {{#each 목록}}…{{/each}}   안에서 {{@no}} 는 1부터의 순번
 *
 * 블록이 겹칠 수 있으므로(발주표 안의 조건문) 정규식으로 자르면 안 된다.
 * 여는 태그와 닫는 태그의 깊이를 세어 짝을 찾는다.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ── 앞머리 읽기 ─────────────────────────────────────────── */
  function meta(src) {
    const m = src.match(/<!--\s*meta([\s\S]*?)-->/);
    const out = { key: '', title: '', data: '', role: '', note: '' };
    if (!m) return out;
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }
  const body = src => src.replace(/<!--\s*meta[\s\S]*?-->\s*/, '');

  /* ── 값 꺼내기 — a.b.c 형태도 따라간다 ───────────────────── */
  function look(ctx, path) {
    if (path === '.') return ctx;
    let v = ctx;
    for (const p of path.split('.')) {
      if (v === null || v === undefined) return undefined;
      v = v[p];
    }
    return v;
  }

  function fmt(v, spec) {
    if (v === null || v === undefined) return '';
    if (!spec) return String(v);
    const m = /^f(\d)$/.exec(spec);
    if (m && typeof v === 'number') return v.toFixed(+m[1]);
    if (spec === 'n' && typeof v === 'number') return v.toLocaleString();
    return String(v);
  }

  /* ── 짝이 되는 {{/if}} · {{/each}} 찾기 ─────────────────────
     같은 종류의 여는 태그가 몇 개 열렸는지 세면서 지나간다. */
  function findClose(src, from, kind) {
    const re = new RegExp('\\{\\{(#' + kind + '\\s[^}]*|/' + kind + ')\\}\\}', 'g');
    re.lastIndex = from;
    let depth = 1, m;
    while ((m = re.exec(src)) !== null) {
      if (m[1][0] === '#') depth++;
      else if (--depth === 0) return { start: m.index, end: re.lastIndex };
    }
    return null;
  }

  /* {{else}} 는 같은 깊이에 있는 것만 인정한다 */
  function splitElse(inner) {
    const re = /\{\{(#if\s[^}]*|\/if|else)\}\}/g;
    let depth = 0, m;
    while ((m = re.exec(inner)) !== null) {
      const t = m[1];
      if (t[0] === '#') depth++;
      else if (t === '/if') depth--;
      else if (t === 'else' && depth === 0) {
        return [inner.slice(0, m.index), inner.slice(re.lastIndex)];
      }
    }
    return [inner, ''];
  }

  const truthy = v => !(v === undefined || v === null || v === false || v === '' ||
    v === 0 || (Array.isArray(v) && v.length === 0));

  function render(src, ctx) {
    let out = '', i = 0;
    const open = /\{\{(#if|#each)\s+([^\s}|]+)\}\}/g;

    while (i < src.length) {
      open.lastIndex = i;
      const m = open.exec(src);
      if (!m) { out += subst(src.slice(i), ctx); break; }

      out += subst(src.slice(i, m.index), ctx);
      const kind = m[1] === '#if' ? 'if' : 'each';
      const close = findClose(src, open.lastIndex, kind);
      if (!close) { out += subst(src.slice(m.index), ctx); break; }

      const inner = src.slice(open.lastIndex, close.start);
      const val = look(ctx, m[2]);

      if (kind === 'if') {
        const [yes, no] = splitElse(inner);
        out += render(truthy(val) ? yes : no, ctx);
      } else {
        const list = Array.isArray(val) ? val : [];
        list.forEach((item, n) => {
          const sub = (item && typeof item === 'object')
            ? Object.assign({}, ctx, item, { '@no': n + 1, '@i': n })
            : Object.assign({}, ctx, { '.': item, '@no': n + 1, '@i': n });
          out += render(inner, sub);
        });
      }
      i = close.end;
    }
    return out;
  }

  /* 양식의 이름은 한글이 많다({{발주번호}}). \w 는 영문만 잡으므로
     유니코드 글자류(\p{L})를 써야 한다. */
  const VAR = /\{\{\s*([@\p{L}\p{N}_.-]+)\s*(?:\|\s*(\w+)\s*)?\}\}/gu;
  function subst(s, ctx) {
    return s.replace(VAR, (all, path, spec) => {
      const v = (path[0] === '@') ? ctx[path] : look(ctx, path);
      return v === undefined ? '' : esc(fmt(v, spec));
    });
  }

  /* ── 자료 묶음 ───────────────────────────────────────────────
     양식이 data: 로 요구한 것만 만든다. 화면 계산(mes_calc.js)을 그대로 쓴다. */
  function bundle(kind, o) {
    const b = o.basis, info = b.info();
    const common = {
      회사: '제일PMC', 설비: 'JPS-1070',
      발행시각: new Date().toISOString().slice(0, 16).replace('T', ' '),
      발행자: o.user ? `${o.user.name} (${o.user.role === 'manager' ? '관리자' : '작업자'})` : '-',
      담당: o.user ? o.user.name : '-',
      구간: info.segment_label, 구간기간: info.segment_period,
      기준일수: info.life_days, 주간시간: info.week_hours,
      앵커: info.anchor_label, 관측시간: info.observed_hours,
      집계시각: info.built,
    };
    const tools = o.MES.toolList(b);
    const byTool = new Map(tools.map(t => [t.tool, t]));

    if (kind === 'order') {
      const orders = o.orders || [];
      const items = orders.map(r => {
        const t = byTool.get(r.tool) || {};
        return Object.assign({}, r, {
          규격: r.name || t.name || ('T' + r.tool),
          부류: t.cls === 'breakage' ? '파손형' : '마모형',
          마모율: t.wear === undefined ? 0 : t.wear,
          사용강도: t.intensity === undefined ? 0 : t.intensity,
        });
      });
      return Object.assign({}, common, {
        items: items,
        발주번호: o.batch || (orders[0] && orders[0].batch) || '-',
        발주일: (orders[0] && String(orders[0].at || '').slice(0, 10)) || common.발행시각.slice(0, 10),
        건수: items.length,
        총수량: items.reduce((s, x) => s + (+x.qty || 0), 0),
      });
    }
    if (kind === 'wear') {
      const ov = o.MES.overview(b);
      return Object.assign({}, common, {
        tools: tools, top5: ov.top5, days: ov.days,
        공구수: tools.length, 절삭시간: info.observed_hours,
        주의: tools.filter(t => t.wear >= 70).length,
        최대마모: tools.length ? tools[0].wear : 0,
        최대공구: tools.length ? `T${tools[0].tool} ${tools[0].name}` : '-',
      });
    }
    if (kind === 'oee') {
      const d = o.MES.oee ? o.MES.oee(b) : {};
      return Object.assign({}, common, d, { days: (b.seg.days || []) });
    }
    if (kind === 'health') {
      const d = o.MES.health ? o.MES.health(b) : {};
      return Object.assign({}, common, d);
    }
    if (kind === 'mfg') {
      const d = o.MES.machining ? o.MES.machining(b) : {};
      return Object.assign({}, common, d);
    }
    if (kind === 'alert') {
      return Object.assign({}, common, o.alerts || {});
    }
    return common;
  }

  function build(src, o) {
    const mt = meta(src);
    const ctx = bundle(mt.data, o);
    return { meta: mt, html: render(body(src), ctx) };
  }

  const api = { meta, body, render, subst, build, bundle, findClose, splitElse, look, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MESDOC = api;
})(typeof self !== 'undefined' ? self : this);
