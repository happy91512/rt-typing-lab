import { parseHero84TravelReport } from "./travel.ts";
import { hero84TravelPositions } from "./travel-positions.ts";

const REPORT_ID = 9;
const REPORT_BYTES = 63;
const MODEL_UUID = 0x110000000005;
const MODEL_COMMAND = 0x82;
const TRAVEL_COMMAND = 0x98;
const POLL_MS = 100;
const CALIBRATION_POLL_MS = 20;
const TIMEOUT_MS = 600;
const NO_READING_TIMEOUT_MS = 8000;

interface HidDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly collections: readonly {
    inputReports: readonly { reportId: number }[];
    outputReports: readonly { reportId: number }[];
  }[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void>;
}

interface Hid extends EventTarget {
  requestDevice(options: { filters: { vendorId: number; productId: number }[] }): Promise<HidDevice[]>;
}

interface ReportEvent extends Event {
  readonly device: HidDevice;
  readonly reportId: number;
  readonly data: DataView;
}

function isReport(event: Event): event is ReportEvent {
  return "device" in event && "reportId" in event && typeof event.reportId === "number"
    && "data" in event && event.data instanceof DataView;
}

export interface TravelReading {
  position: number;
  rawTravel: number;
  pressed: boolean;
  receivedAt: number;
}

export interface TravelDevice {
  measure(
    code: string,
    onSample: (sample: TravelReading) => void,
    onError?: (error: Error) => void,
  ): Promise<() => Promise<void>>;
  requestCalibrationRate(enabled: boolean): void;
  close(): Promise<void>;
}

// The wired HERO driver uses a 63-byte payload with an additive complement checksum.
function makeRequest(command: number, operation: number, length: number, position = 0) {
  const packet = new Uint8Array(REPORT_BYTES);
  packet.set([command, operation, 0, 1, 0, length, position >> 8, position & 0xff]);
  const sum = packet.reduce((total, byte) => total + byte, REPORT_ID);
  packet[REPORT_BYTES - 1] = 0xff - (sum & 0xff);
  return packet;
}

function matchesReply(data: DataView, command: number) {
  return data.byteLength > 7 && data.getUint8(0) === command
    && data.getUint8(3) === 1 && data.getUint8(4) === 0;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

async function exchange(device: HidDevice, request: Uint8Array<ArrayBuffer>, command: number) {
  const controller = new AbortController();
  const reply = new Promise<DataView>((resolve) => {
    device.addEventListener("inputreport", (event) => {
      if (isReport(event) && event.device === device && event.reportId === REPORT_ID
        && matchesReply(event.data, command)) {
        resolve(event.data);
      }
    }, { signal: controller.signal });
  });
  try {
    const [data] = await withTimeout(Promise.all([reply, device.sendReport(REPORT_ID, request)]));
    return data;
  } finally {
    controller.abort();
  }
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("鍵盤回報逾時。")), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class Hero84TravelDevice implements TravelDevice {
  private session: { stop(): Promise<void>; fail(reason: unknown): void; repace(): void } | undefined;
  private closing: Promise<void> | undefined;
  private calibrationRate = false;
  private readonly events = new AbortController();
  private readonly device: HidDevice;

  constructor(hid: Hid, device: HidDevice) {
    this.device = device;
    hid.addEventListener("disconnect", (event) => {
      if (!("device" in event) || event.device !== device) return;
      if (this.session) {
        this.session.fail(new Error("鍵盤已中斷連線。"));
      } else {
        void this.close().catch(() => {});
      }
    }, { signal: this.events.signal });
  }

  requestCalibrationRate(enabled: boolean): void {
    const next = enabled && !!this.session && !this.closing;
    if (this.calibrationRate === next) return;
    this.calibrationRate = next;
    this.session?.repace();
  }

  async measure(code: string, onSample: (sample: TravelReading) => void, onError?: (error: Error) => void) {
    const position = hero84TravelPositions.get(code);
    if (position === undefined) throw new Error("這個鍵位尚未支援鍵程量測。");
    if (this.closing || !this.device.opened) throw new Error("鍵盤連線已關閉。");
    if (this.session) throw new Error("請先停止目前的鍵程量測。");

    const listeners = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReading = performance.now();
    let pendingQuery: Promise<void> | undefined;
    let waitingForReading = false;
    let repace = () => {};
    let stopping: Promise<void> | undefined;
    const fail = (reason: unknown) => {
      if (listeners.signal.aborted) return;
      void this.close().catch(() => {});
      onError?.(asError(reason));
    };
    this.device.addEventListener("inputreport", (event) => {
      if (!isReport(event) || event.device !== this.device) return;
      const samples = parseHero84TravelReport(event.reportId, event.data);
      const receivedAt = performance.now();
      for (const sample of samples ?? []) {
        if (sample.position !== position || listeners.signal.aborted) continue;
        lastReading = receivedAt;
        waitingForReading = false;
        try {
          onSample({ position, rawTravel: sample.travelRaw, pressed: sample.pressed, receivedAt });
        } catch (reason) {
          fail(reason);
        }
      }
    }, { signal: listeners.signal });

    const start = exchange(this.device, makeRequest(TRAVEL_COMMAND, 0, 0), TRAVEL_COMMAND);
    const stop = () => {
      if (stopping) return stopping;
      listeners.abort();
      this.calibrationRate = false;
      clearTimeout(timer);
      stopping = (async () => {
        try {
          await start.catch(() => {});
          await pendingQuery?.catch(() => {});
          if (this.device.opened) {
            await exchange(this.device, makeRequest(TRAVEL_COMMAND, 2, 0), TRAVEL_COMMAND);
          }
        } finally {
          this.session = undefined;
        }
      })();
      return stopping;
    };
    this.session = { stop, fail, repace: () => repace() };

    try {
      await start;
      if (listeners.signal.aborted) throw new Error("鍵程量測已停止。");
      lastReading = performance.now();
      const schedule = () => {
        timer = setTimeout(poll, this.calibrationRate ? CALIBRATION_POLL_MS : POLL_MS);
      };
      const poll = () => {
        timer = undefined;
        if (listeners.signal.aborted) return;
        if (performance.now() - lastReading > NO_READING_TIMEOUT_MS) {
          fail(new Error("未收到所選鍵位的鍵程回報。"));
          return;
        }
        if (this.calibrationRate && waitingForReading) {
          // A fast query that received no reading leaves room for a slow retry.
          this.calibrationRate = false;
          schedule();
          return;
        }
        waitingForReading = true;
        pendingQuery = withTimeout(this.device.sendReport(REPORT_ID, makeRequest(TRAVEL_COMMAND, 1, 2, position)));
        void pendingQuery.then(() => { if (!listeners.signal.aborted) schedule(); }, fail);
      };
      repace = () => {
        if (timer === undefined || listeners.signal.aborted) return;
        clearTimeout(timer);
        schedule();
      };
      poll();
      return async () => {
        try {
          await stop();
        } catch (reason) {
          await this.close().catch(() => {});
          throw reason;
        }
      };
    } catch (reason) {
      await this.close().catch(() => {});
      throw reason;
    }
  }

  close(): Promise<void> {
    this.closing ??= this.finishClose();
    return this.closing;
  }

  private async finishClose() {
    this.events.abort();
    try {
      await this.session?.stop();
    } finally {
      if (this.device.opened) await this.device.close();
    }
  }
}

export async function connectTravel(): Promise<TravelDevice> {
  if (!("hid" in navigator) || !isHid(navigator.hid)) throw new Error("此瀏覽器未提供 WebHID。");
  const hid = navigator.hid;
  const filter = { vendorId: 0x372e, productId: 0x103e };
  const candidates = await hid.requestDevice({ filters: [filter] });
  const device = candidates.find((candidate) =>
    candidate.vendorId === filter.vendorId && candidate.productId === filter.productId
    && candidate.collections.some((collection) => collection.inputReports.some(({ reportId }) => reportId === REPORT_ID))
    && candidate.collections.some((collection) => collection.outputReports.some(({ reportId }) => reportId === REPORT_ID)),
  );
  if (!device) throw new Error("未選取含有測試介面的鍵盤。");
  try {
    if (!device.opened) await device.open();
    const identity = await exchange(device, makeRequest(MODEL_COMMAND, 1, 6), MODEL_COMMAND);
    if (identity.byteLength < 13
      || identity.getUint16(6) * 0x100000000 + identity.getUint32(8) !== MODEL_UUID) {
      throw new Error("型號驗證失敗。鍵程量測目前只支援 HERO 84 HE ANSI。");
    }
    return new Hero84TravelDevice(hid, device);
  } catch (reason) {
    if (device.opened) await device.close().catch(() => {});
    throw reason;
  }
}

function isHid(value: unknown): value is Hid {
  return value instanceof EventTarget && "requestDevice" in value && typeof value.requestDevice === "function";
}
