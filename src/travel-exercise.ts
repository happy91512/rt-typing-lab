import { mm, settingFor } from './study.ts';
import type { Config } from './study.ts';
import type { TravelReading } from './travel-device.ts';
import { summarizeTravel } from './travel-quality.ts';
import type { DigitalEdge } from './travel-quality.ts';
import { assessTravel } from './travel-replay.ts';
import type { ReplaySettings, TravelAttempt } from './travel-replay.ts';

const goals = [1, 2, 1, 2, 1, 2] as const;
const prompts = ['慢按一下後完全放開', '快速按兩下，最後完全放開', '快按一下後完全放開',
  '正常速度按兩下，最後完全放開', '正常速度按一下後完全放開', '快速按兩下，最後完全放開'];

export function mountTravelExercise(
  host: HTMLElement,
  pad: HTMLElement,
  code: () => string,
  config: Config,
  onCandidate: (code: string, distance: number) => boolean,
  requestCalibrationRate: (enabled: boolean) => void,
  signal: AbortSignal,
) {
  host.innerHTML = `<details class="advanced">
    <summary>用行程試算 RT 候選值</summary>
    <form class="form-stack" autocomplete="off">
      <p class="muted">照官方驅動填入目前值，接著做六個短動作。行程需能重現原設定下的按鍵結果，試算值才會出現。</p>
      <div class="form-grid">
        ${input('actuation', '首次觸發點', '1.00')}
        ${input('full', '軸體總行程', '3.40')}
        ${input('top', '頂部死區', '0.26')}
        ${input('bottom', '底部死區', '0.25')}
        ${config.field === 'linked' ? '' : input('other', config.field === 'press' ? '目前抬起 RT' : '目前按下 RT', '0.15')}
      </div>
      <button type="submit">準備試算短題</button>
    </form>
    <p data-exercise-note role="status"></p>
    <p class="muted" data-exercise-cadence></p>
    <div class="actions">
      <button type="button" data-exercise-start hidden>開始這題</button>
      <button type="button" data-exercise-finish hidden>完成這題</button>
      <button type="button" data-exercise-candidate hidden>加入 A/B 候選</button>
    </div>
  </details>`;
  const form = host.querySelector<HTMLFormElement>('form')!;
  const details = host.querySelector<HTMLDetailsElement>('details')!;
  const note = host.querySelector<HTMLElement>('[data-exercise-note]')!;
  const cadence = host.querySelector<HTMLElement>('[data-exercise-cadence]')!;
  const start = host.querySelector<HTMLButtonElement>('[data-exercise-start]')!;
  const finish = host.querySelector<HTMLButtonElement>('[data-exercise-finish]')!;
  const add = host.querySelector<HTMLButtonElement>('[data-exercise-candidate]')!;
  let latest: TravelReading | undefined;
  let active: TravelAttempt | undefined;
  let settings: ReplaySettings | undefined;
  let attempts: TravelAttempt[] = [];
  let candidate: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function stopAttempt() {
    clearTimeout(timeout);
    active = undefined;
    requestCalibrationRate(false);
  }

  function reset() {
    latest = undefined;
    stopAttempt();
    settings = undefined;
    attempts = [];
    candidate = undefined;
    start.hidden = finish.hidden = add.hidden = true;
    note.textContent = '';
    cadence.textContent = '';
  }

  function showPrompt() {
    note.textContent = `第 ${attempts.length + 1} 題／${goals.length}　${prompts[attempts.length]}。`;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const original = settingFor(config, code());
    if (!original.enabled) {
      note.textContent = '請用已開啟 RT 的基準做行程試算。目前可先用 A/B 比較開啟和關閉。';
      return;
    }
    const data = new FormData(form);
    const value = (name: string) => Math.round(Number(data.get(name)) * 100);
    const { field } = config;
    const other = field === 'linked' ? original.distance : value('other');
    const actuation = value('actuation'), top = value('top'), bottom = value('bottom'), full = value('full');
    if (top >= actuation || actuation > full - bottom || other <= 0) {
      note.textContent = '請核對首次觸發點、總行程、死區與另一欄 RT。';
      return;
    }
    settings = { actuation, top, bottom, full, field, bounds: config.bounds,
      press: field === 'release' ? other : original.distance,
      release: field === 'press' ? other : original.distance,
    };
    stopAttempt();
    attempts = [];
    candidate = undefined;
    cadence.textContent = '';
    start.hidden = false;
    finish.hidden = add.hidden = true;
    showPrompt();
  }, { signal });

  start.addEventListener('click', () => {
    if (!latest || latest.pressed) {
      note.textContent = '請先完全放開選定鍵，等畫面收到放開的行程讀值再開始。';
      return;
    }
    active = { expected: goals[attempts.length], samples: [latest], edges: [] };
    requestCalibrationRate(true);
    timeout = setTimeout(() => {
      stopAttempt();
      finish.hidden = true;
      start.hidden = false;
      note.textContent = '這題已逾時。請完全放開按鍵，再重新開始這題。';
    }, 10_000);
    start.hidden = true;
    finish.hidden = false;
    showPrompt();
    pad.focus();
  }, { signal });

  finish.addEventListener('click', () => {
    if (!settings || !active) return;
    if (!latest || latest.pressed || latest.receivedAt <= (active.edges.at(-1)?.receivedAt ?? 0)) {
      note.textContent = '請完全放開選定鍵，等下一筆行程回報，再完成這題。';
      return;
    }
    const quality = summarizeTravel(active.samples, active.edges);
    cadence.textContent = quality.medianIntervalMs === null
      ? '上一題沒有足夠的行程資料可計算取樣間隔。'
      : `上一題中位間隔 ${quality.medianIntervalMs.toFixed(1)} ms，對齊 ${quality.matchedEdges}／${quality.edges} 個事件。`;
    attempts.push(active);
    stopAttempt();
    finish.hidden = true;
    if (attempts.length < goals.length) {
      start.hidden = false;
      showPrompt();
      start.focus();
      return;
    }
    const result = assessTravel(attempts, settings);
    attempts = [];
    if (result.status === 'candidate') {
      candidate = result.distance;
      note.textContent = `待驗證 ${mm(candidate)} mm。同一段行程的試算錯誤由 ${result.originalErrors} 次降至 ${result.candidateErrors} 次。`;
      add.hidden = false;
      add.focus();
      return;
    }
    note.textContent = {
      insufficient: '行程回報太慢、缺漏或樣本不足，這次沒有產生候選值。可繼續用打字 A/B。',
      mismatch: '試算無法重現原設定的觸發。請核對欄位與刻度，或用打字 A/B 繼續。',
      'no-improvement': '這段行程沒有顯示相鄰設定會改善表現。可保留原值或做打字 A/B。',
    }[result.status];
    form.querySelector<HTMLElement>('button')?.focus();
  }, { signal });

  details.addEventListener('toggle', () => {
    if (details.open || !active) return;
    stopAttempt();
    finish.hidden = true;
    start.hidden = false;
    showPrompt();
  }, { signal });

  add.addEventListener('click', () => {
    if (candidate === undefined) return;
    note.textContent = onCandidate(code(), candidate)
      ? `已將 ${mm(candidate)} mm 加入待驗證的 A/B 候選。`
      : '此值已在比較紀錄中，或不符合目前的設定範圍。';
    add.hidden = true;
    form.querySelector<HTMLElement>('button')?.focus();
  }, { signal });

  return {
    reset,
    sample(reading: TravelReading) {
      latest = reading;
      if (active && active.samples.length < 1200) active.samples.push(reading);
    },
    edge(edge: DigitalEdge) {
      if (active && active.edges.length < 40) active.edges.push(edge);
    },
  };
}

function input(name: string, label: string, example: string) {
  return `<label>${label}<span class="input-unit"><input name="${name}" type="number" min="0" max="100" step="0.01" inputmode="decimal" placeholder="${example}" required><span>mm</span></span></label>`;
}
