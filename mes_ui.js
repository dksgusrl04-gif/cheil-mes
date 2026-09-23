/* ═══════════════════════════════════════════════════════════════
 * 화면 보강 — 조회 기간(달력) · 되돌리기
 * ═══════════════════════════════════════════════════════════════
 * mes.html 을 고치지 않고 얹는 것들만 여기 둔다.
 *
 * 예전에는 «알림 카드를 눌러 걸러 보기» 도 여기 있었다. 그런데 화면
 * 쪽(mes.html)이 ALERT_SEL 로 같은 일을 하게 되면서, 카드를 한 번 누르면
 * 두 벌이 동시에 걸러 버렸다 — 이쪽은 항목을 감추고, 저쪽은 다시 그리고.
 * 그 상태에서 「전체 보기」 를 눌러도 이쪽 거르개만 풀려 화면은 그대로였다.
 * 거르개는 한 벌이어야 한다. 그래서 이 층을 통째로 걷어냈다.
 */
(function () {
  'use strict';

  const $main = () => document.getElementById('main');

  /* 눌러도 되는 것처럼 보여야 사람이 누른다.
     화면 코드를 고치지 않으므로 필요한 모양만 여기서 얹는다. */
  function wire() {
    /* 화면이 다시 그려졌다는 것은 조회가 끝났다는 뜻이다.
       그때 BASIS 가 새로 채워지므로 달력의 범위·안내도 같이 맞춘다. */
    if (document.getElementById('mes-from')) updateDateBox();
    ensureUndo();
  }

  /* ── 되돌리기 버튼 ───────────────────────────────────────────
     집계본은 한 칸짜리라 잘못 올리면 이전 것이 사라진다. 덮어쓰기 직전에
     한 세대를 따로 남겨 두므로, 그걸 되살릴 길을 «데이터 추가» 탭에 둔다. */
  function ensureUndo() {
    const main = $main();
    if (!main || document.getElementById('mes-undo')) return;
    // 데이터 추가 탭인지 — 재집계 버튼이 있는 화면
    const anchor = main.querySelector('#rbbtn');
    if (!anchor) return;

    const box = document.createElement('div');
    box.id = 'mes-undo';
    box.style.cssText = 'display:inline-flex;align-items:center;gap:9px;margin-left:10px';
    box.innerHTML = '<button type="button" class="act sec" id="mes-undo-btn">직전 집계본으로 되돌리기</button>'
      + '<span id="mes-undo-msg" style="font-size:11.5px;color:#8c9ba5"></span>';
    anchor.parentNode.insertBefore(box, anchor.nextSibling);

    const msg = box.querySelector('#mes-undo-msg');
    box.querySelector('#mes-undo-btn').addEventListener('click', async () => {
      if (!window.confirm('지금 집계본을 버리고 직전 것으로 되돌립니다.\n계속할까요?')) return;
      msg.textContent = '되돌리는 중…';
      try {
        const r = await fetch('/api/rebuild/undo', { method: 'POST' });
        const j = await r.json();
        if (!r.ok) { msg.textContent = (j.error || '실패') + (j.hint ? ' — ' + j.hint : ''); return; }
        msg.textContent = `되돌렸습니다 — ${j.segments || ''} (집계 ${j.built || '-'})`;
        if (typeof window.reload === 'function') window.reload();
      } catch (e) { msg.textContent = '실패 — ' + e.message; }
    });
  }

  /* 화면이 다시 그려질 때마다 손잡이를 다시 단다.
     탭을 옮기거나 알림을 읽으면 innerHTML 이 통째로 바뀌기 때문이다. */
  function start() {
    const main = $main();
    if (!main) { setTimeout(start, 200); return; }
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(wire, 30);           // 연속 변경은 한 번만 처리
    }).observe(main, { childList: true, subtree: true });
    wire();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else start();

  /* ═══════════════════════════════════════════════════════════════
   * 조회 기간 — 기준 막대에 달력을 붙인다
   * ═══════════════════════════════════════════════════════════════
   * 달력에서 날짜 하나를 고르면 그 날 하루의 자료만 본다.
   * «최근 7일» 버튼은 구간으로 본다.
   *
   * 화면은 qs() 로 조회 조건을 만들어 /api/* 에 붙인다. 그 함수가
   * seg·life·week·anchor 넷만 담으므로, 감싸서 from·to 를 더 넣는다.
   * mes.html 은 여전히 안 고친다.
   */
  let FROM = '', TO = '';

  const DATE_CSS = `
  #basis .mes-date{ display:flex; align-items:center; gap:6px; }
  /* 테두리 색은 mes.html 의 --line-in 을 따라간다. 여기에 색을 박아 두면
     화면 톤을 바꿨을 때 이 두 칸만 옛 색으로 남는다. */
  #basis .mes-date input[type=date]{
    font:inherit; font-size:12.5px; padding:6px 9px;
    border:1px solid var(--line-in, #AFBCCB);
    border-radius:6px; background:#fff; color:#1f2a33; cursor:pointer;
    box-shadow:0 1px 1px rgba(15,23,42,.04);
    transition:border-color .12s, box-shadow .12s;
  }
  #basis .mes-date button{
    font:inherit; font-size:12px; padding:6px 11px;
    border:1px solid var(--line-in, #AFBCCB);
    border-radius:6px; background:#fff; color:var(--ink-2, #334155); cursor:pointer;
    box-shadow:0 1px 1px rgba(15,23,42,.04);
    transition:border-color .12s, background .12s, box-shadow .12s;
  }
  #basis .mes-date input[type=date]:hover,
  #basis .mes-date button:hover{
    background:var(--accent-soft, #EDF3FC); border-color:var(--line-in-2, #7E93AB);
    box-shadow:0 1px 3px rgba(15,23,42,.09);
  }
  #basis .mes-date button[data-on]{
    background:var(--accent, #004EA1); border-color:var(--accent, #004EA1);
    color:#fff; font-weight:650;
  }
  /* 못 누르는 단추는 못 누른다는 게 보여야 한다 — 색이 같으면 눌러 보고 나서야 안다 */
  #basis .mes-date button:disabled{
    background:#F3F5F8; border-color:#DDE2E9; color:#A3AEBC;
    cursor:not-allowed; box-shadow:none;
  }
  #mes-from-note{
    font-size:11.5px; color:#8a6d1f; background:#fff8e6; border:1px solid #f0dfae;
    border-radius:5px; padding:4px 9px; margin-left:4px;
  }`;

  function addDateStyle() {
    if (document.getElementById('mes-date-style')) return;
    const s = document.createElement('style');
    s.id = 'mes-date-style';
    s.textContent = DATE_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* 화면의 qs() 를 감싸 조회 기간을 얹는다 */
  let hooked = false;
  function hookQs() {
    if (hooked || typeof window.qs !== 'function') return;
    const orig = window.qs;
    window.qs = function () {
      let s = orig.apply(this, arguments);
      if (FROM) s += (s ? '&' : '') + 'from=' + encodeURIComponent(FROM);
      if (TO) s += (s ? '&' : '') + 'to=' + encodeURIComponent(TO);
      return s;
    };
    hooked = true;
  }

  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`;
  function minus(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() - days);
    return ymd(d);
  }

  /* 기간을 정한다. 달력으로 하루를 고르면 from 과 to 가 같은 날이 된다 —
     그 날 하루만 보고 싶다는 뜻이다. 빠른 버튼은 '최근 N일' 구간을 만든다. */
  function applyRange(from, to) {
    FROM = from || '';
    TO = to || '';
    const inp = document.getElementById('mes-from');
    if (inp) inp.value = FROM;
    syncQuick();
    if (typeof window.reload === 'function') window.reload();
  }
  const applyFrom = v => applyRange(v, v);      // 달력 = 하루

  function syncQuick() {
    const box = document.querySelector('#basis .mes-date');
    if (!box) return;
    const R = (window.BASIS && window.BASIS.date_range) || {};
    const off = !R.max || (window.BASIS && window.BASIS.no_byday);
    box.querySelectorAll('button[data-days]').forEach(b => {
      const all = b.dataset.days === 'all';
      /* 날짜 범위를 모르거나 자를 수 없는 집계본이면 '전체' 말고는 눌러도 소용없다.
         눌리는 것처럼 보였다가 아무 일도 안 일어나는 게 제일 나쁘므로 아예 막는다. */
      b.disabled = off && !all;
      b.style.opacity = b.disabled ? '.45' : '';
      b.style.cursor = b.disabled ? 'not-allowed' : 'pointer';
      if (b.disabled) { b.removeAttribute('data-on'); return; }
      const want = all ? '' : minus(R.max, parseInt(b.dataset.days, 10) - 1);
      const on = all ? (!FROM && !TO) : (want === FROM && TO === R.max);
      if (on) b.setAttribute('data-on', '1');
      else b.removeAttribute('data-on');
    });
  }

  /* 기준 막대에 달력 한 칸을 만든다 (한 번만) */
  function ensureDateBox() {
    const basis = document.getElementById('basis');
    if (!basis || document.getElementById('mes-from')) { updateDateBox(); return; }
    addDateStyle();

    const wrap = document.createElement('div');
    wrap.className = 'bset mes-date';
    wrap.innerHTML = '<span>조회 날짜</span>' +
      '<input type="date" id="mes-from" title="고른 날 하루의 자료만 봅니다">' +
      '<button type="button" data-days="all">전체</button>' +
      '<button type="button" data-days="7">최근 7일</button>';

    const note = document.getElementById('bnote');
    if (note && note.parentNode === basis) basis.insertBefore(wrap, note);
    else basis.appendChild(wrap);

    wrap.querySelector('#mes-from').addEventListener('change', e => applyFrom(e.target.value));
    wrap.querySelectorAll('button[data-days]').forEach(b => {
      b.addEventListener('click', () => {
        const R = (window.BASIS && window.BASIS.date_range) || {};
        if (b.dataset.days === 'all') return applyRange('', '');
        if (!R.max) return;
        applyRange(minus(R.max, parseInt(b.dataset.days, 10) - 1), R.max);
      });
    });
    updateDateBox();
  }

  /* 고를 수 있는 범위와 안내 문구를 최신으로.

     주의 — 입력칸의 값은 FROM 이 주인이다. BASIS 에서 되받아 덮어쓰면 안 된다.
     BASIS 는 대시보드를 그릴 때만 새로 채워지므로, 다른 탭에서는 옛 값(빈 문자열)이
     남아 있다. 그걸로 덮어쓰면 사용자가 고른 날짜가 저 혼자 지워진다. */
  function updateDateBox() {
    const inp = document.getElementById('mes-from');
    const B = window.BASIS;
    if (!inp || !B) return;
    const R = B.date_range || {};
    if (R.min) inp.min = R.min;
    if (R.max) inp.max = R.max;          // 마지막 날 뒤는 못 고르게 — 빈 결과 방지

    /* 날짜로 자를 수 없는 집계본이면 고르게 두면 안 된다.
       골라도 값이 안 바뀌는데 이유를 모르는 게 가장 답답하다. */
    const blocked = !!B.no_byday;
    if (blocked && (FROM || TO)) { FROM = ''; TO = ''; inp.value = ''; }
    inp.disabled = blocked;
    inp.style.opacity = blocked ? '.45' : '';
    inp.style.cursor = blocked ? 'not-allowed' : 'pointer';

    let note = document.getElementById('mes-from-note');
    const msg = blocked
      ? '이 집계본에는 날짜별 자료가 없어 날짜로 볼 수 없습니다. '
        + '«데이터 추가» 탭에서 CSV 를 올려 다시 집계하면 켜집니다.'
      : (B.empty
        ? '고른 날짜에는 자료가 없습니다. 달력에서 다른 날을 골라 보세요.'
        : (B.sliced ? B.from_note : ''));
    if (msg) {
      if (!note) {
        note = document.createElement('div');
        note.id = 'mes-from-note';
        const basis = document.getElementById('basis');
        const box = document.querySelector('#basis .mes-date');
        if (basis && box) basis.insertBefore(note, box.nextSibling);
      }
      note.textContent = msg;
      note.style.display = '';
      inp.title = msg;
    } else if (note) note.style.display = 'none';
    syncQuick();
  }

  /* 화면 뼈대가 준비될 때까지 몇 번 기다린다. 영영 안 되면 그만둔다 —
     못 붙였다고 계속 돌면 배터리만 먹는다. */
  let tries = 0;
  function startDate() {
    hookQs();
    ensureDateBox();
    if (hooked && document.getElementById('mes-from')) return;
    if (++tries > 60) return;                  // 약 15초
    setTimeout(startDate, 250);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDate);
  } else startDate();

  /* 화면이 다시 그려질 때마다 안내 문구를 맞춘다 */
  if (typeof setInterval === 'function') {
    setInterval(() => { if (document.getElementById('mes-from')) updateDateBox(); }, 700);
  }

  /* 알림 거르개(filter/current)는 뺐다 — 화면 쪽 ALERT_SEL 이 그 일을 한다.
     여기 남겨 두면 «거르는 곳이 두 군데» 라는 오해가 다시 생긴다. */
  window.MES_UI = {
    from: () => FROM, to: () => TO, setFrom: applyFrom, setRange: applyRange,
  };
})();
