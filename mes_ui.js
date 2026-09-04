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
      card.style.outline = on ? '2px solid #1b365d' : '';
      card.style.outlineOffset = on ? '-2px' : '';
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
    const main = $main();
    if (!isAlertView(main)) { FILTER = null; return; }

    let any = false;
    main.querySelectorAll('.cards > *').forEach(card => {
      const k = kindOf(card);
      if (!k) return;
      any = true;
      if (card.dataset.mesWired) return;      // 두 번 달지 않는다
      card.dataset.mesWired = '1';
      card.addEventListener('click', () => {
        FILTER = (FILTER === k.key) ? null : k.key;   // 같은 걸 또 누르면 해제
        apply();
      });
    });
    if (any) apply();
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

  window.MES_UI = { filter: k => { FILTER = k; apply(); }, current: () => FILTER };
})();
