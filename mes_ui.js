/* ═══════════════════════════════════════════════════════════════
 * 화면 보강 — 알림 탭의 요약 카드를 눌러 걸러 보기
 * ═══════════════════════════════════════════════════════════════
 * 상단 «위험 / 주의 / 안 읽은 알림» 카드를 누르면 그 종류만 남기고
 * 나머지를 감춘다. 다시 누르면 전체로 돌아온다.
 *
 * mes.html 을 고치지 않는다. 화면이 다시 그려지는 것을 지켜보다가
 * 알림 탭이 뜨면 그때 손잡이만 달아 준다. 화면 코드가 바뀌어도
 * 클래스 이름(.al .danger .warn .unread)만 그대로면 계속 동작한다.
 */
(function () {
  'use strict';

  const KIND = [
    { key: 'danger', label: '위험', match: '위험' },
    { key: 'warn', label: '주의', match: '주의' },
    { key: 'unread', label: '안 읽은 알림', match: '안 읽' },
  ];

  let FILTER = null;      // null 이면 전체

  const $main = () => document.getElementById('main');

  /* 눌러도 되는 것처럼 보여야 사람이 누른다.
     화면 코드를 고치지 않으므로 필요한 모양만 여기서 얹는다. */
  const CSS = `
  #main .cards > [data-mes-wired]{
    cursor:pointer; user-select:none; position:relative;
    transition:box-shadow .12s ease, transform .12s ease, background .12s ease;
  }
  #main .cards > [data-mes-wired]:hover{
    box-shadow:0 3px 10px rgba(27,54,93,.16); transform:translateY(-1px);
  }
  #main .cards > [data-mes-wired]:active{ transform:translateY(0); }
  #main .cards > [data-mes-on]{
    outline:2px solid #1b365d; outline-offset:-2px; background:#eef3fa;
  }
  #main .cards > [data-mes-wired]::after{
    content:'클릭'; position:absolute; top:8px; right:10px;
    font-size:10px; color:#94a3b0; letter-spacing:.5px;
  }
  #main .cards > [data-mes-on]::after{ content:'해제'; color:#1b365d; font-weight:600; }
  `;
  function addStyle() {
    if (document.getElementById('mes-ui-style')) return;
    const s = document.createElement('style');
    s.id = 'mes-ui-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* 이 카드가 어떤 종류인가 — 카드에 적힌 글자로 알아낸다 */
  function kindOf(card) {
    const txt = (card.textContent || '').replace(/\s+/g, ' ');
    for (const k of KIND) if (txt.indexOf(k.match) >= 0) return k;
    return null;
  }

  function isAlertView(main) {
    // 알림 탭인지 — 요약 카드와 알림 항목이 같이 있어야 한다
    return main && main.querySelector('.cards') && main.querySelector('.al, .panel h4');
  }

  function apply() {
    const main = $main();
    if (!main) return;

    /* 1) 항목 걸러내기 */
    main.querySelectorAll('.panel').forEach(panel => {
      const items = panel.querySelectorAll('.al');
      if (!items.length) return;
      let shown = 0;
      items.forEach(el => {
        const ok = !FILTER || (FILTER === 'unread'
          ? el.classList.contains('unread') : el.classList.contains(FILTER));
        el.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });

      /* 다 걸러졌으면 빈 채로 두지 않고 이유를 적어 준다 */
      let empty = panel.querySelector('.mes-empty');
      if (shown === 0) {
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'muted mes-empty';
          empty.style.cssText = 'padding:10px 2px;font-size:12.5px';
          panel.appendChild(empty);
        }
        const k = KIND.find(x => x.key === FILTER);
        empty.textContent = `${k ? k.label : ''}에 해당하는 항목이 없습니다`;
        empty.style.display = '';
      } else if (empty) empty.style.display = 'none';

      /* 제목의 숫자를 걸러진 개수로 바꾼다 */
      const h = panel.querySelector('h4');
      if (h) {
        if (!h.dataset.mesBase) h.dataset.mesBase = h.textContent.trim();
        const base = h.dataset.mesBase.replace(/\s*\(\d+\)\s*$/, '');
        h.textContent = FILTER
          ? `${base} (${shown} / ${items.length})` : h.dataset.mesBase;
      }
    });

    /* 2) 카드에 눌린 표시 */
    main.querySelectorAll('.cards > *').forEach(card => {
      const k = kindOf(card);
      if (!k) return;
      const on = FILTER === k.key;
      if (on) card.setAttribute('data-mes-on', '1');
      else card.removeAttribute('data-mes-on');
      card.style.cursor = 'pointer';
      card.title = on ? '다시 누르면 전체를 봅니다' : `${k.label}만 보기`;
    });

    /* 3) 걸러 보는 중이라는 표시 */
    let bar = main.querySelector('.mes-filterbar');
    if (FILTER) {
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'mes-filterbar';
        bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin:-4px 0 12px;' +
          'padding:7px 11px;background:#eef3fa;border:1px solid #c9d9ee;border-radius:6px;' +
          'font-size:12.5px;color:#1b365d';
        const cards = main.querySelector('.cards');
        if (cards && cards.parentNode) cards.parentNode.insertBefore(bar, cards.nextSibling);
      }
      const k = KIND.find(x => x.key === FILTER);
      bar.innerHTML = `<b>${k ? k.label : ''}</b> 만 보는 중` +
        `<button type="button" class="mes-clear" style="margin-left:auto;background:#fff;` +
        `border:1px solid #c9d9ee;color:#1b365d;border-radius:5px;padding:4px 12px;` +
        `font-size:12px;cursor:pointer">전체 보기</button>`;
      bar.querySelector('.mes-clear').onclick = () => { FILTER = null; apply(); };
      bar.style.display = '';
    } else if (bar) bar.style.display = 'none';
  }

  function wire() {
    /* 화면이 다시 그려졌다는 것은 조회가 끝났다는 뜻이다.
       그때 BASIS 가 새로 채워지므로 달력의 범위·안내도 같이 맞춘다. */
    if (document.getElementById('mes-from')) updateDateBox();

    const main = $main();
    if (!isAlertView(main)) { FILTER = null; return; }

    let any = false;
    main.querySelectorAll('.cards > *').forEach(card => {
      const k = kindOf(card);
      if (!k) return;
      any = true;
      if (card.dataset.mesWired) return;      // 두 번 달지 않는다
      card.dataset.mesWired = '1';

      /* 마우스뿐 아니라 키보드로도 눌리게 한다 */
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      const toggle = () => {
        FILTER = (FILTER === k.key) ? null : k.key;   // 같은 걸 또 누르면 해제
        apply();
      };
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
    if (any) { addStyle(); apply(); }
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
   * «최근 7일» 같은 버튼은 구간으로 본다.
   *
   * 화면은 qs() 로 조회 조건을 만들어 /api/* 에 붙인다. 그 함수가
   * seg·life·week·anchor 넷만 담으므로, 감싸서 from·to 를 더 넣는다.
   * mes.html 은 여전히 안 고친다.
   */
  let FROM = '', TO = '';

  const DATE_CSS = `
  #basis .mes-date{ display:flex; align-items:center; gap:6px; }
  #basis .mes-date input[type=date]{
    font:inherit; font-size:12px; padding:3px 6px; border:1px solid #c3ced8;
    border-radius:5px; background:#fff; color:#1f2a33; cursor:pointer;
  }
  #basis .mes-date button{
    font:inherit; font-size:11.5px; padding:3px 9px; border:1px solid #c3ced8;
    border-radius:5px; background:#fff; color:#41525f; cursor:pointer;
  }
  #basis .mes-date button:hover{ background:#eef3fa; border-color:#9fb6cf; }
  #basis .mes-date button[data-on]{ background:#1b365d; border-color:#1b365d; color:#fff; }
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
      '<button type="button" data-days="7">최근 7일</button>' +
      '<button type="button" data-days="3">최근 3일</button>';

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

  window.MES_UI = {
    filter: k => { FILTER = k; apply(); }, current: () => FILTER,
    from: () => FROM, to: () => TO, setFrom: applyFrom, setRange: applyRange,
  };
})();
