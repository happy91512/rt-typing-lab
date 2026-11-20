import { connectTravel } from './travel-device.ts';
import type { TravelDevice, TravelReading } from './travel-device.ts';
import { summarizeCadence, summarizeTravel } from './travel-quality.ts';
import type { DigitalEdge } from './travel-quality.ts';
import { keyboardRows } from './prompts.ts';
import { hero84TravelPositions } from './travel-positions.ts';
import { mountTravelExercise } from './travel-exercise.ts';
import type { Config } from './study.ts';

const historySize = 48;
const probeDurationMs = 4000;
const representative = ['KeyQ', 'Space', 'KeyA'];
const labels = new Map(keyboardRows.flat().map(key => [key.code, key.label]));

function option(code: string) {
  const item = document.createElement('option');
  item.value = code;
  item.textContent = code === 'Space' ? '空白鍵' : labels.get(code) ?? code;
  return item;
}

export function mountTravel(host: HTMLElement, priorities: readonly string[], config: Config,
  onCandidate: (code: string, distance: number) => boolean): () => void {
  host.innerHTML = `<details class="travel-panel">
    <summary>即時行程（實驗）</summary>
    <p class="muted">用有線 HERO84 HE 測一個鍵，可查看原始行程或做短題試算。候選 RT 仍需換值實測。</p>
    <label>測量鍵位<select name="travel-key"></select></label>
    <div class="actions"><button data-connect>連線並量測</button><button data-disconnect disabled>結束量測</button></div>
    <p class="form-note" data-travel-message role="status"></p>
    <div class="trace" hidden>
      <div class="calibration-pad" tabindex="0" aria-label="行程校準按鍵區">在這裡按選定鍵</div>
      <canvas width="300" height="94" aria-hidden="true"></canvas>
      <p class="muted" data-reading>等待行程資料…</p>
      <p class="muted" data-quality></p>
      <p class="muted" data-quality-status role="status"></p>
      <button type="button" data-cadence-test>測試取樣速度（4 秒）</button>
      <p class="muted" data-cadence-result role="status"></p>
      <div data-travel-exercise></div>
    </div>
  </details>`;
  const details = host.querySelector<HTMLDetailsElement>('details')!;
  const key = host.querySelector<HTMLSelectElement>('select')!;
  const prioritized = Array.from(new Set(priorities.length ? priorities : representative))
    .filter(code => hero84TravelPositions.has(code));
  const first = document.createElement('optgroup');
  first.label = priorities.length ? '優先補測' : '代表鍵';
  first.append(...prioritized.map(option));
  const rest = document.createElement('optgroup');
  rest.label = '其他鍵位';
  rest.append(...Array.from(hero84TravelPositions.keys()).filter(code => !prioritized.includes(code)).map(option));
  key.replaceChildren(first, rest);
  const connect = host.querySelector<HTMLButtonElement>('[data-connect]')!;
  const disconnect = host.querySelector<HTMLButtonElement>('[data-disconnect]')!;
  const message = host.querySelector<HTMLElement>('[data-travel-message]')!;
  const trace = host.querySelector<HTMLElement>('.trace')!;
  const reading = host.querySelector<HTMLElement>('[data-reading]')!;
  const canvas = host.querySelector<HTMLCanvasElement>('canvas')!;
  const pad = host.querySelector<HTMLElement>('.calibration-pad')!;
  const evaluation = host.querySelector<HTMLElement>('[data-quality]')!;
  const qualityStatus = host.querySelector<HTMLElement>('[data-quality-status]')!;
  const testCadence = host.querySelector<HTMLButtonElement>('[data-cadence-test]')!;
  const cadenceResult = host.querySelector<HTMLElement>('[data-cadence-result]')!;
  const supported = 'hid' in navigator;
  const history: TravelReading[] = [];
  const calibration: TravelReading[] = [];
  const edges: DigitalEdge[] = [];
  let device: TravelDevice | undefined;
  let request = 0;
  let busy = false;
  let keyPressed = false;
  let fastExercise = false;
  let probe: { samples: TravelReading[]; edges: DigitalEdge[]; timer: ReturnType<typeof setTimeout> } | undefined;
  const lifecycle = new AbortController();
  const exerciseHost = host.querySelector<HTMLElement>('[data-travel-exercise]')!;
  const exercise = mountTravelExercise(exerciseHost, pad, () => key.value, config, onCandidate,
    enabled => { fastExercise = enabled; updateSampling(); }, lifecycle.signal);

  function updateSampling() {
    device?.requestCalibrationRate(fastExercise || !!probe);
    testCadence.disabled = !device || !!probe || fastExercise;
    exerciseHost.inert = !!probe;
  }

  function showState() {
    connect.disabled = busy || !!device || !supported;
    disconnect.disabled = !busy && !device;
    key.disabled = busy || !!device;
  }

  async function stop(text = '') {
    request++;
    const old = device;
    device = undefined;
    if (probe) clearTimeout(probe.timer);
    probe = undefined;
    history.length = 0;
    calibration.length = 0;
    edges.length = 0;
    keyPressed = false;
    exercise.reset();
    trace.hidden = true;
    reading.textContent = '等待行程資料…';
    evaluation.textContent = '';
    qualityStatus.textContent = '';
    cadenceResult.textContent = '';
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    const cleanupId = request;
    busy = !!old;
    message.textContent = text;
    showState();
    try {
      await old?.close();
    } catch {
      if (cleanupId === request && host.isConnected) message.textContent = '裝置已離開量測流程。若行程測試仍開著，可重新插拔鍵盤。';
    } finally {
      if (cleanupId === request) {
        busy = false;
        showState();
      }
    }
  }

  function showReading(sample: TravelReading) {
    history.push(sample);
    if (history.length > historySize) history.shift();
    if (calibration.length < 4096 && edges.length < 80) calibration.push(sample);
    if (probe && probe.samples.length < 256) probe.samples.push(sample);
    exercise.sample(sample);
    const first = history[0];
    const mean = history.length > 1 ? (sample.receivedAt - first.receivedAt) / (history.length - 1) : 0;
    reading.textContent = `讀值 ${sample.rawTravel}，${sample.pressed ? '按下' : '放開'}${mean ? `，約 ${Math.round(mean)} ms／筆` : ''}`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#204c96';
    ctx.beginPath();
    const max = Math.max(...history.map(item => item.rawTravel), 1);
    history.forEach((point, i) => {
      const x = 4 + i / (historySize - 1) * (canvas.width - 8);
      const y = canvas.height - 5 - point.rawTravel / max * (canvas.height - 10);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    if (edges.length) showQuality();
  }

  testCadence.addEventListener('click', () => {
    if (!device || probe || fastExercise) return;
    probe = { samples: [], edges: [], timer: setTimeout(finishProbe, probeDurationMs) };
    updateSampling();
    cadenceResult.textContent = '測試中，請連續按下並放開選定鍵。';
    pad.focus();
  }, { signal: lifecycle.signal });

  function finishProbe() {
    if (!probe) return;
    const { samples, edges } = probe;
    probe = undefined;
    updateSampling();
    const cadence = summarizeCadence(samples);
    if (cadence.medianIntervalMs === null) {
      cadenceResult.textContent = '取樣不足，請再測一次。';
      return;
    }
    const { matchedEdges } = summarizeTravel(samples, edges);
    cadenceResult.textContent = `中位間隔 ${cadence.medianIntervalMs.toFixed(1)} ms／筆，最長間隔 ${cadence.maxIntervalMs?.toFixed(1)} ms。收到 ${cadence.samples} 筆，對齊 ${matchedEdges}／${edges.length} 個事件。`;
  }

  function showQuality() {
    const result = summarizeTravel(calibration, edges);
    const median = result.medianIntervalMs;
    evaluation.textContent = `事件對齊 ${result.matchedEdges} / ${result.edges}${median === null ? '' : `，中位間隔 ${median.toFixed(1)} ms`}`;
    const text = {
      collecting: '請先慢按、快按，再連按。累積五次完整的按下與放開後評估。',
      insufficient: '這次行程不足以分析快速觸發。請以打字 A / B 結果為準。',
      aligned: '這段行程與鍵盤事件能對齊。RT 值仍以換值實測確認。',
    }[result.quality];
    if (qualityStatus.textContent !== text) qualityStatus.textContent = text;
  }

  for (const eventType of ['keydown', 'keyup'] as const) {
    pad.addEventListener(eventType, event => {
      if (!device || event.code !== key.value || event.repeat) return;
      event.preventDefault();
      const pressed = eventType === 'keydown';
      if (pressed === keyPressed) return;
      keyPressed = pressed;
      const edge = { pressed, receivedAt: performance.now() };
      exercise.edge(edge);
      if (probe && probe.edges.length < 80) probe.edges.push(edge);
      if (edges.length < 80) {
        edges.push(edge);
        showQuality();
      }
    }, { signal: lifecycle.signal });
  }

  connect.addEventListener('click', async () => {
    if (!supported || busy || device) return;
    const id = ++request;
    busy = true;
    showState();
    message.textContent = '請在瀏覽器清單選擇 HERO84 HE。';
    try {
      const connected = await connectTravel();
      if (id !== request) {
        await connected.close();
        return;
      }
      device = connected;
      await connected.measure(key.value, showReading, error => { if (id === request) void stop(error.message); });
      if (id !== request) return;
      message.textContent = '量測中。試著慢按、快按，再快速連按兩下。';
      trace.hidden = false;
      updateSampling();
      showQuality();
      pad.focus();
    } catch (error) {
      if (id === request) await stop(error instanceof Error ? error.message : '無法啟動行程量測。');
    } finally {
      if (id === request) {
        busy = false;
        showState();
      }
    }
  }, { signal: lifecycle.signal });
  disconnect.addEventListener('click', () => { void stop('已結束量測。'); }, { signal: lifecycle.signal });
  details.addEventListener('toggle', () => { if (!details.open && (busy || device)) void stop(); }, { signal: lifecycle.signal });
  window.addEventListener('pagehide', () => { void stop(); }, { signal: lifecycle.signal });
  if (!supported) message.textContent = '此瀏覽器沒有 WebHID，仍可做完整的打字比較。';
  showState();
  return () => {
    lifecycle.abort();
    void stop();
  };
}
