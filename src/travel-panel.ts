import { connectTravel } from './travel-device.ts';
import type { TravelDevice, TravelReading } from './travel-device.ts';

const monitored = ['KeyQ', 'KeyW', 'KeyA', 'KeyS', 'KeyZ', 'KeyX', 'Space'];
const historySize = 48;

export function mountTravel(host: HTMLElement): () => void {
  host.innerHTML = `<details class="travel-panel">
    <summary>即時行程（實驗）</summary>
    <p class="muted">先停下打字，再用有線 HERO84 HE 測一個鍵。行程顯示裝置原始讀值，候選 RT 仍需換值實測。</p>
    <label>測量鍵位<select name="travel-key">${monitored.map(code => `<option value="${code}">${code === 'Space' ? '空白鍵' : code.at(-1)}</option>`).join('')}</select></label>
    <div class="actions"><button data-connect>連線並量測</button><button data-disconnect disabled>結束量測</button></div>
    <p class="form-note" data-travel-message role="status"></p>
    <div class="trace" hidden>
      <canvas width="300" height="94" aria-hidden="true"></canvas>
      <p class="muted" data-reading>等待行程資料…</p>
    </div>
  </details>`;
  const details = host.querySelector<HTMLDetailsElement>('details')!;
  const key = host.querySelector<HTMLSelectElement>('select')!;
  const connect = host.querySelector<HTMLButtonElement>('[data-connect]')!;
  const disconnect = host.querySelector<HTMLButtonElement>('[data-disconnect]')!;
  const message = host.querySelector<HTMLElement>('[data-travel-message]')!;
  const trace = host.querySelector<HTMLElement>('.trace')!;
  const reading = host.querySelector<HTMLElement>('[data-reading]')!;
  const canvas = host.querySelector<HTMLCanvasElement>('canvas')!;
  const supported = 'hid' in navigator;
  const history: TravelReading[] = [];
  let device: TravelDevice | undefined;
  let request = 0;
  let busy = false;
  const lifecycle = new AbortController();

  function showState() {
    connect.disabled = busy || !!device || !supported;
    disconnect.disabled = !busy && !device;
    key.disabled = busy || !!device;
  }

  async function stop(text = '') {
    request++;
    const old = device;
    device = undefined;
    history.length = 0;
    trace.hidden = true;
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
