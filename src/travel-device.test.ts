import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { connectTravel } from "./travel-device.ts";

class FixtureDevice extends EventTarget {
  opened = false;
  readonly vendorId = 0x372e;
  readonly productId = 0x103e;
  readonly collections = [{ inputReports: [{ reportId: 9 }], outputReports: [{ reportId: 9 }] }];
  readonly sent: number[][] = [];
  private readonly model: number[];

  constructor(model = [0x11, 0, 0, 0, 0, 5]) {
    super();
    this.model = model;
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; }

  async sendReport(reportId: number, bytes: Uint8Array) {
    assert.equal(reportId, 9);
    assert.equal(bytes.length, 63);
    assert.equal(bytes.reduce((sum, byte) => sum + byte, reportId) & 255, 255);
    this.sent.push(Array.from(bytes.subarray(0, 8)));
    const [command, operation] = bytes;
    if (command === 0x82) this.emitReport([0x82, 1, 0, 1, 0, 6, ...this.model, 0]);
    else if (operation === 1) {
      this.emitReport([0x98, 1, 0, 1, 0, 12, 0, 29, 0, 7, 0x80, 0, 0, 70, 1, 3, 0x80, 0]);
    } else {
      this.emitReport([0x98, operation, 0, 1, 0, 0, 0, 0]);
    }
  }

  private emitReport(bytes: number[]) {
    this.dispatchEvent(Object.assign(new Event("inputreport"), {
      device: this,
      reportId: 9,
      data: new DataView(Uint8Array.from(bytes).buffer),
    }));
  }
}

class FixtureHid extends EventTarget {
  readonly device: FixtureDevice;
  constructor(device: FixtureDevice) {
    super();
    this.device = device;
  }
  async requestDevice(options: unknown) {
    assert.deepEqual(options, { filters: [{ vendorId: 0x372e, productId: 0x103e }] });
    return [this.device];
  }
}

function installFixture(t: TestContext, device: FixtureDevice) {
  const hid = new FixtureHid(device);
  Object.defineProperty(navigator, "hid", { value: hid, configurable: true });
  t.after(() => { Reflect.deleteProperty(navigator, "hid"); });
  return hid;
}

test("checks model before querying only the selected position and exits measurement on stop", async (t) => {
  const device = new FixtureDevice();
  installFixture(t, device);
  const travel = await connectTravel();
  await assert.rejects(travel.measure("KeyP", () => {}), /尚未支援/);
  const received: { position: number; rawTravel: number; pressed: boolean }[] = [];
  const stop = await travel.measure("Space", ({ position, rawTravel, pressed, receivedAt }) => {
    assert.ok(Number.isFinite(receivedAt));
    received.push({ position, rawTravel, pressed });
  });
  assert.deepEqual(received, [{ position: 70, rawTravel: 259, pressed: true }]);
  await stop();
  await travel.close();
  assert.deepEqual(device.sent, [
    [0x82, 1, 0, 1, 0, 6, 0, 0],
    [0x98, 0, 0, 1, 0, 0, 0, 0],
    [0x98, 1, 0, 1, 0, 2, 0, 70],
    [0x98, 2, 0, 1, 0, 0, 0, 0],
  ]);
  assert.equal(device.opened, false);
});

test("closes a device with a different UUID without starting travel measurement", async (t) => {
  const device = new FixtureDevice([0x11, 0, 0, 0, 0, 6]);
  installFixture(t, device);
  await assert.rejects(connectTravel(), /型號驗證失敗/);
  assert.deepEqual(device.sent, [[0x82, 1, 0, 1, 0, 6, 0, 0]]);
  assert.equal(device.opened, false);
});

test("reports disconnection and stops polling an unplugged device", async (t) => {
  const device = new FixtureDevice();
  const hid = installFixture(t, device);
  const travel = await connectTravel();
  const errors: Error[] = [];
  const stop = await travel.measure("KeyQ", () => {}, (error) => errors.push(error));
  device.opened = false;
  hid.dispatchEvent(Object.assign(new Event("disconnect"), { device }));
  await travel.close();
  await stop();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /中斷/);
  await assert.rejects(travel.measure("KeyQ", () => {}), /已關閉/);
  assert.deepEqual(device.sent.map(([command, operation]) => [command, operation]), [
    [0x82, 1], [0x98, 0], [0x98, 1],
  ]);
});
