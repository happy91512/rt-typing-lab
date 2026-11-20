import assert from "node:assert/strict";
import test from "node:test";
import { parseHero84TravelReport } from "./travel.ts";

function report(...bytes: number[]): DataView {
  return new DataView(Uint8Array.of(...bytes).buffer);
}

test("decodes two physical positions and ignores report padding", () => {
  const fixture = report(
    0xff,
    0x98, 0x01, 0, 1, 0, 12,
    0x01, 0x02, 0x01, 0x45, 0x81, 0x23,
    0x02, 0x01, 0, 0, 0x7f, 0xff,
    0xaa, 0xff,
  );
  const data = new DataView(fixture.buffer, 1, fixture.byteLength - 2);
  assert.deepEqual(parseHero84TravelReport(9, data), [
    { position: 258, travelRaw: 325, adcRaw: 291, pressed: true },
    { position: 513, travelRaw: 0, adcRaw: 32767, pressed: false },
  ]);
});

test("rejects unrelated reports and malformed record lengths", () => {
  assert.equal(parseHero84TravelReport(8, report(0x98, 1, 0, 1, 0, 0)), null);
  assert.equal(parseHero84TravelReport(9, report(0x98, 2, 0, 1, 0, 0)), null);
  assert.equal(parseHero84TravelReport(9, report(0x98, 1)), null);
  assert.equal(parseHero84TravelReport(9, report(0x98, 1, 0, 1, 0, 2, 0, 0)), null);
  assert.equal(parseHero84TravelReport(9, report(0x98, 1, 0, 1, 0, 6)), null);
  assert.deepEqual(parseHero84TravelReport(9, report(0x98, 1, 0, 1, 0, 0)), []);
});
