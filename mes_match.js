/* ═══════════════════════════════════════════════════════════════
 * 컬럼 매칭 — mes_match.py 의 자바스크립트 이식
 * ═══════════════════════════════════════════════════════════════
 * 이름이 다른 데이터셋을 표준 컬럼에 대응시킨다. 3단계로 판정하고
 * 어느 단계에서 나온 결과인지 근거와 함께 돌려준다. 자동 확정하지 않는다.
 *
 *   1단계  별칭 사전   제일PMC 데이터리스트 Rev06 대응표. 신뢰도 1.00
 *   2단계  이름 유사도  정규화 후 문자 유사도. 오탈자·표기 흔들림
 *   3단계  Claude      앞 둘이 못 잡은 것만. Edge Function 을 거친다
 *
 * 2단계는 파이썬 difflib.SequenceMatcher.ratio() 와 같은 값을 내야 한다.
 * 그래야 현장 서버와 웹이 같은 판정을 한다. 알고리즘을 그대로 옮겼다.
 */
(function (root) {
  'use strict';

  const STANDARD = {
    MECHNO: '기계번호', RunState: '가동상태 텍스트',
    MainPGM: '메인 프로그램 번호', RunPGM: '실행 프로그램 번호',
    ProgName: '실행 프로그램 이름', SEQ: '시퀀스(N번호)',
    ExecProgNo: '실행 중 프로그램 번호', ExecBlkNo: '실행 중 블록 번호',
    ToolNo: '현재 공구번호', ToolName: '공구명',
    CT: '사이클 타임(초)', RunTimeSec: '자동운전 누적(초)',
    CutTimeSec: '절삭 누적(초)', BootTimeSec: '전원ON 누적(초)',
    Update_time: '수집 시각', PRC_DATE: '처리일시',
    Feed: '실 이송속도 (mm/min)', SpindleRPM: '실 스핀들 회전수 (rpm)',
    SpindleLoad: '스핀들 부하율 (%)',
    FeedOverride: '이송 오버라이드 (%)', SpindleOverride: '스핀들 오버라이드 (%)',
    RapidOverride: '급속 오버라이드 (%)',
    X_AxisPos: 'X 위치(절대)', Y_AxisPos: 'Y 위치(절대)', Z_AxisPos: 'Z 위치(절대)',
    B_AxisPos: 'B축 위치', C_AxisPos: 'C축 위치', A_AxisPos: 'A축 위치',
    X_Abs: 'X 절대좌표', X_Rel: 'X 상대좌표', X_Mac: 'X 기계좌표', X_Dis: 'X 잔여 이동거리',
    Y_Abs: 'Y 절대좌표', Y_Rel: 'Y 상대좌표', Y_Mac: 'Y 기계좌표', Y_Dis: 'Y 잔여 이동거리',
    Z_Abs: 'Z 절대좌표', Z_Rel: 'Z 상대좌표', Z_Mac: 'Z 기계좌표', Z_Dis: 'Z 잔여 이동거리',
    WorkOffset: '워크오프셋 G54~G59', MotionGCode: '이송모드 G00/G01~03',
    AutoManual: '작업 모드 코드', OperationStatus: '1:STOP/2:HOLD/3:START',
    MovementDwell: '1:Motion/2:Dwell/3:Wait', Emergency: '0:정상/1:비상',
    Alarm: '알람 종류 코드', AlarmStatus: '알람 상태 플래그',
    DeviceStatus: '장치 상태', ModeName: '작업 모드 이름', AlarmMsg: '알람 정보 텍스트',
    X_Current: 'X 서보 부하율 (%)', Y_Current: 'Y 서보 부하율 (%)',
    Z_Current: 'Z 서보 부하율 (%)',
    PartCount: '총 생산 수량', PartCountSingle: '단일 처리 횟수',
    Cur_Max: '최대전류 raw (0.01A)', Cur_R: 'R상 전류 raw', Cur_S: 'S상 전류 raw',
    Cur_T: 'T상 전류 raw', Cur_R_A: 'R상 전류 (A)', Cur_S_A: 'S상 전류 (A)',
    Cur_T_A: 'T상 전류 (A)', UYeG_Temp: 'UYeG 온도 raw (0.01℃)', UYeG_Humi: 'UYeG 습도 (%)',
    Vib_X: 'X 진동속도 raw', Vib_Y: 'Y 진동속도 raw', Vib_Z: 'Z 진동속도 raw',
    Vib_X_mms: 'X 진동속도 (mm/s)', Vib_Y_mms: 'Y 진동속도 (mm/s)',
    Vib_Z_mms: 'Z 진동속도 (mm/s)',
    Vib_FreqX: 'X 진동 주파수 (Hz)', Vib_FreqY: 'Y 진동 주파수 (Hz)',
    Vib_FreqZ: 'Z 진동 주파수 (Hz)',
    Vib_AccX: 'X 가속도', Vib_AccY: 'Y 가속도', Vib_AccZ: 'Z 가속도',
    Vib_KurtX: 'X 진동 첨도', Vib_KurtY: 'Y 진동 첨도', Vib_KurtZ: 'Z 진동 첨도',
    Vib_Temp: '진동센서 온도 (℃)',
    Vib_DispX: 'X 변위', Vib_DispY: 'Y 변위', Vib_DispZ: 'Z 변위',
    Vib_AngX: 'X 각도', Vib_AngY: 'Y 각도', Vib_AngZ: 'Z 각도',
    Vib_AccAmpX: 'X 가속도 진폭', Vib_AccAmpY: 'Y 가속도 진폭', Vib_AccAmpZ: 'Z 가속도 진폭',
    Vib_VrmsX: 'X 진동 실효값', Vib_VrmsY: 'Y 진동 실효값', Vib_VrmsZ: 'Z 진동 실효값',
    Vib_DrmsX: 'X 변위 실효값', Vib_DrmsY: 'Y 변위 실효값', Vib_DrmsZ: 'Z 변위 실효값',
    Vib_ErrX: 'X 진동 오류코드', Vib_ErrY: 'Y 진동 오류코드', Vib_ErrZ: 'Z 진동 오류코드',
    VibModel: '진동센서 모델', VibDispMode: '진동 표시 모드',
    id: '행 일련번호', PRC_GB: '처리구분', Series: 'CNC 시리즈',
    CncType: 'CNC 종류', CncTypeCode: 'CNC 종류 코드', MaxAxis: '최대 축수',
    MaxToolGrp: '최대 공구그룹', Axis4Name: '4번째 축 이름',
    SysRet: '시스템 조회 반환', StatRet: '상태 조회 반환', SpLoadRet: '부하 조회 반환',
    ToolRet: '공구 조회 반환', SvRet: '서보 조회 반환',
    GcodeRet: 'G코드 조회 반환', ExecPtRet: '실행위치 조회 반환',
    FanucOk: 'FOCAS 연결 여부', VibOk: '진동 연결 여부', CurOk: '전류 연결 여부',
    FanucAgeMs: 'FOCAS 값 나이(ms)', VibAgeMs: '진동 값 나이(ms)', CurAgeMs: '전류 값 나이(ms)',
  };

  /* 제일PMC 데이터리스트 Rev06 '제일PMC대응' 시트.
     재활용 이름(ToolCounter*)이 실제로 무엇을 담는지는 이 표에만 적혀 있다. */
  const ALIAS = {
    ToolCounter1T: 'Cur_Max', ToolCounter2T: 'Cur_R', ToolCounter3T: 'Cur_S',
    ToolCounter4T: 'Cur_T', ToolCounter9T: 'UYeG_Temp', ToolCounter10T: 'UYeG_Humi',
    ToolCounter1N: 'ToolNo', ToolCounter2N: 'SpindleRPM', ToolCounter3N: 'Feed',
    ToolCounter4N: 'PartCount', ToolCounter5N: 'Vib_X', ToolCounter6N: 'Vib_Y',
    ToolCounter7N: 'Vib_Z',
    X_AsixPos: 'X_AxisPos', Y_AsixPos: 'Y_AxisPos', Z_AsixPos: 'Z_AxisPos',
    C_AsixPos: 'C_AxisPos', A_AsixPos: 'A_AxisPos',
    X_AsixPos_Abs: 'X_Abs', X_AsixPos_Rel: 'X_Rel', X_AsixPos_Mac: 'X_Mac',
    X_AsixPos_Dis: 'X_Dis', Y_AsixPos_Abs: 'Y_Abs', Y_AsixPos_Rel: 'Y_Rel',
    Y_AsixPos_Mac: 'Y_Mac', Y_AsixPos_Dis: 'Y_Dis', Z_AsixPos_Abs: 'Z_Abs',
    Z_AsixPos_Rel: 'Z_Rel', Z_AsixPos_Mac: 'Z_Mac', Z_AsixPos_Dis: 'Z_Dis',
    update: 'Update_time', updatetime: 'Update_time', timestamp: 'Update_time',
    수집시각: 'Update_time', 설비번호: 'MECHNO', 공구번호: 'ToolNo', 공구명: 'ToolName',
    이송속도: 'Feed', 스핀들속도: 'SpindleRPM', 생산량: 'PartCount', 가동상태: 'RunState',
    최대전류: 'Cur_Max', 온도: 'UYeG_Temp', 습도: 'UYeG_Humi',
  };

  const MAYBE = 0.55;
  const REQUIRED = ['Update_time', 'RunState', 'ToolNo', 'Cur_Max', 'FanucOk', 'VibOk', 'CurOk'];

  function norm(s) {
    return String(s).trim().toLowerCase()
      .replace(/asix/g, 'axis')                      // 원본 데이터리스트의 오타
      .replace(/[\s_\-.()[\]/]/g, '');
  }

  const NORM_STD = {}; for (const k of Object.keys(STANDARD)) NORM_STD[norm(k)] = k;
  const NORM_ALIAS = {}; for (const k of Object.keys(ALIAS)) NORM_ALIAS[norm(k)] = ALIAS[k];

  /* ── difflib.SequenceMatcher.ratio() ─────────────────────────
     파이썬과 같은 점수를 내야 한다. 가장 긴 일치 블록을 찾아 좌우로
     재귀하며 일치 글자 수를 세고, 2*일치 / 전체길이 로 나눈다.
     autojunk 는 b 가 200자 이상일 때만 작동하는데 컬럼명은 그보다 짧다. */
  function ratio(a, b) {
    const la = a.length, lb = b.length;
    if (la + lb === 0) return 1.0;

    const b2j = new Map();
    for (let j = 0; j < lb; j++) {
      const ch = b[j];
      let arr = b2j.get(ch);
      if (!arr) { arr = []; b2j.set(ch, arr); }
      arr.push(j);
    }

    function longest(alo, ahi, blo, bhi) {
      let besti = alo, bestj = blo, bestsize = 0;
      let j2len = new Map();
      for (let i = alo; i < ahi; i++) {
        const newj2len = new Map();
        const arr = b2j.get(a[i]);
        if (arr) {
          for (let x = 0; x < arr.length; x++) {
            const j = arr[x];
            if (j < blo) continue;
            if (j >= bhi) break;
            const k = (j2len.get(j - 1) || 0) + 1;
            newj2len.set(j, k);
            if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
          }
        }
        j2len = newj2len;
      }
      while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
        besti--; bestj--; bestsize++;
      }
      while (besti + bestsize < ahi && bestj + bestsize < bhi
        && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
      return [besti, bestj, bestsize];
    }

    let matches = 0;
    const queue = [[0, la, 0, lb]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = longest(alo, ahi, blo, bhi);
      if (k) {
        matches += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return 2.0 * matches / (la + lb);
  }

  /* ── 값의 성격 요약 — 판단 근거이자 사람이 보는 자료 ─────── */
  function profile(values) {
    const vals = (values || []).filter(v => v !== null && v !== undefined && v !== '').slice(0, 200);
    if (!vals.length) return { kind: 'empty', sample: [] };
    const nums = [], texts = [];
    for (const v of vals) {
      const f = (typeof v === 'number') ? v : parseFloat(v);
      if (isFinite(f) && String(v).trim() !== '' && !isNaN(f)) nums.push(f);
      else texts.push(String(v));
    }
    const r3 = x => Math.round(x * 1000) / 1000;
    if (nums.length >= vals.length * 0.8) {
      const uniq = Array.from(new Set(nums)).sort((x, y) => x - y);
      return {
        kind: 'number', n: nums.length,
        min: r3(Math.min.apply(null, nums)), max: r3(Math.max.apply(null, nums)),
        mean: r3(nums.reduce((s, x) => s + x, 0) / nums.length),
        distinct: uniq.length, sample: uniq.slice(0, 6).map(r3),
        zero_ratio: r3(nums.filter(x => x === 0).length / nums.length),
      };
    }
    const u = Array.from(new Set(texts));
    return { kind: 'text', n: texts.length, distinct: u.length, sample: u.slice(0, 6) };
  }

  function matchOne(src) {
    const n = norm(src);
    if (n in NORM_ALIAS) {
      const tgt = NORM_ALIAS[n];
      return { target: tgt, score: 1.0, how: '별칭 사전',
        why: `제일PMC 데이터리스트 대응표에 ${src} → ${tgt} 로 명시됨` };
    }
    if (n in NORM_STD) {
      return { target: NORM_STD[n], score: 1.0, how: '이름 일치', why: '표준 컬럼명과 동일' };
    }
    let best = null, score = 0.0;
    for (const ns of Object.keys(NORM_STD)) {
      const s = ratio(n, ns);
      if (s > score) { best = NORM_STD[ns]; score = s; }
    }
    const r3 = x => Math.round(x * 1000) / 1000;
    if (score >= MAYBE) {
      return { target: best, score: r3(score), how: '이름 유사도',
        why: `'${src}' 와 '${best}' 의 이름 유사도 ${Math.round(score * 100)}%` };
    }
    return { target: null, score: r3(score), how: '미확정',
      why: '사전에도 없고 이름도 닮지 않음 — 사람 확인 또는 Agent 판단 필요' };
  }

  /* ── 전체 매칭 ───────────────────────────────────────────────
     ask 는 (질문, 자료) → {answer} 를 돌려주는 함수. 없으면 1·2단계만 쓴다. */
  async function matchColumns(headers, samples, ask) {
    const rows = headers.map(h => Object.assign(
      { source: h, profile: profile((samples || {})[h]) }, matchOne(h)));

    let llmUsed = false;
    const unknown = rows.filter(r => r.target === null);
    if (unknown.length && typeof ask === 'function') {
      const used = new Set(rows.filter(r => r.target).map(r => r.target));
      const avail = {};
      for (const k of Object.keys(STANDARD)) if (!used.has(k)) avail[k] = STANDARD[k];
      const q = "아래 '미확정컬럼' 각각을 '표준컬럼' 중 하나에 대응시켜라. "
        + '값의 범위·형태를 근거로 판단하고, 대응할 것이 없으면 null 로 둬라. '
        + '반드시 JSON 배열만 출력하라. '
        + '형식: [{"source":"원본명","target":"표준컬럼명 또는 null","why":"근거 한 줄"}]';
      try {
        const ans = await ask(q, {
          표준컬럼: avail,
          미확정컬럼: unknown.map(r => ({ 이름: r.source, 값요약: r.profile })),
        });
        const txt = (ans && ans.answer) || '';
        const m = txt.match(/\[[\s\S]*\]/);
        if (m && !(ans && ans.fallback)) {
          for (const item of JSON.parse(m[0])) {
            for (const r of rows) {
              if (r.source === item.source && item.target && (item.target in STANDARD)) {
                r.target = item.target; r.score = 0.7; r.how = 'Agent 판단';
                r.why = String(item.why || '').slice(0, 120);
                llmUsed = true;
              }
            }
          }
        }
      } catch (e) {
        for (const r of unknown) r.why += ` (Agent 호출 실패: ${String(e.message || e).slice(0, 60)})`;
      }
    }

    /* 같은 표준 컬럼에 둘 이상이 붙으면 점수가 낮은 쪽을 뗀다 */
    const seen = {};
    for (const r of rows.slice().sort((a, b) => b.score - a.score)) {
      if (r.target && (r.target in seen)) {
        r.conflict = seen[r.target];
        r.why = `'${seen[r.target]}' 가 이미 ${r.target} 에 대응됨 — 하나만 선택해야 함`;
        r.target = null; r.how = '중복';
      } else if (r.target) seen[r.target] = r.source;
    }

    const cnt = how => rows.filter(r => r.how === how).length;
    return {
      rows: rows, mapped: Object.keys(seen).length, total: headers.length,
      by_dict: cnt('별칭 사전') + cnt('이름 일치'),
      by_sim: cnt('이름 유사도'), by_llm: cnt('Agent 판단'),
      unmatched: rows.filter(r => !r.target).length,
      llm_used: llmUsed,
      missing_required: REQUIRED.filter(k => !(k in seen)),
      standard: STANDARD,
      /* 집계기에 넘길 형태: {표준이름: 파일의 컬럼명} */
      columns: (() => { const c = {}; for (const t of Object.keys(seen)) c[t] = seen[t]; return c; })(),
    };
  }

  const api = { matchColumns, matchOne, profile, ratio, norm, STANDARD, ALIAS, REQUIRED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MESMATCH = api;
})(typeof self !== 'undefined' ? self : this);
