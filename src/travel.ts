const TRAVEL_REPORT_ID = 9;
const TRAVEL_HEADER = 0x9801;
const LENGTH_OFFSET = 5;
const RECORDS_OFFSET = 6;
const RECORD_SIZE = 6;
const PRESSED_BIT = 0x8000;
const ADC_MASK = 0x7fff;

export interface Hero84TravelSample {
  readonly position: number;
  readonly travelRaw: number;
  readonly adcRaw: number;
  readonly pressed: boolean;
}

// Candidate packet format from the HERO model-specific web driver (app-CPb3bToC.js).
export function parseHero84TravelReport(
  reportId: number,
  data: DataView,
): readonly Hero84TravelSample[] | null {
  if (
    reportId !== TRAVEL_REPORT_ID ||
    data.byteLength < RECORDS_OFFSET ||
    data.getUint16(0) !== TRAVEL_HEADER
  ) {
    return null;
  }

  const recordBytes = data.getUint8(LENGTH_OFFSET);
  const reportEnd = RECORDS_OFFSET + recordBytes;
  if (recordBytes % RECORD_SIZE !== 0 || reportEnd > data.byteLength) {
    return null;
  }

  const samples: Hero84TravelSample[] = [];
  for (let offset = RECORDS_OFFSET; offset < reportEnd; offset += RECORD_SIZE) {
    const adcAndStatus = data.getUint16(offset + 4);
    samples.push({
      position: data.getUint16(offset),
      travelRaw: data.getUint16(offset + 2),
      adcRaw: adcAndStatus & ADC_MASK,
      pressed: (adcAndStatus & PRESSED_BIT) !== 0,
    });
  }
  return samples;
}
