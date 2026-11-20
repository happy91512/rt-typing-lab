import { comparisonText, holdoutText } from './prompt-variety.ts';

export type TestKind = 'english' | 'chinese' | 'drill';
export type PromptSet = 'v1' | 'v2';

export type Prompt =
  | { id: string; kind: 'chinese'; text: string; codes?: undefined }
  | { id: string; kind: 'english'; text: string; codes: string[] }
  | { id: string; kind: 'drill'; text: string; codes: string[] };

export type LayoutKey = { code: string; label: string; width?: number };

const key = (code: string, label: string, width?: number): LayoutKey =>
  width === undefined ? { code, label } : { code, label, width };

const numberRow = [...'1234567890'].map(digit => key(`Digit${digit}`, digit));
const letterKeys = (letters: string) =>
  [...letters].map(letter => key(`Key${letter}`, letter));

const printingRows = [
  [key('Backquote', '`'), ...numberRow, key('Minus', '-'), key('Equal', '=')],
  [...letterKeys('QWERTYUIOP'), key('BracketLeft', '['), key('BracketRight', ']'), key('Backslash', '\\', 1.5)],
  [...letterKeys('ASDFGHJKL'), key('Semicolon', ';'), key('Quote', "'")],
  [...letterKeys('ZXCVBNM'), key('Comma', ','), key('Period', '.'), key('Slash', '/')],
  [key('Space', 'Space', 6.25)],
];

export const keyboardRows: LayoutKey[][] = [
  [
    key('Escape', 'Esc'),
    ...Array.from({ length: 12 }, (_, index) => key(`F${index + 1}`, `F${index + 1}`)),
    key('PrintScreen', 'PrtSc'), key('Insert', 'Ins'), key('Delete', 'Del'),
  ],
  [...printingRows[0], key('Backspace', '⌫', 2), key('Home', 'Home')],
  [key('Tab', 'Tab', 1.5), ...printingRows[1], key('End', 'End')],
  [key('CapsLock', 'Caps', 1.75), ...printingRows[2], key('Enter', 'Enter', 2.25), key('PageUp', 'PgUp')],
  [key('ShiftLeft', 'Shift', 2.25), ...printingRows[3], key('ShiftRight', 'Shift', 1.75), key('ArrowUp', '↑'), key('PageDown', 'PgDn')],
  [
    key('ControlLeft', 'Ctrl', 1.25), key('MetaLeft', 'Win', 1.25), key('AltLeft', 'Alt', 1.25),
    ...printingRows[4], key('AltRight', 'Alt'), key('Fn', 'Fn'), key('ControlRight', 'Ctrl'),
    key('ArrowLeft', '←'), key('ArrowDown', '↓'), key('ArrowRight', '→'),
  ],
];

const printingKeys = printingRows.flat();
export const typeableCodes = printingKeys.map(({ code }) => code);

const physicalLegends = new Map(
  printingKeys.map(({ code, label }) => [code, code === 'Space' ? ' ' : label.toLowerCase()]),
);

const codesByCharacter = new Map(
  [...physicalLegends].map(([code, legend]) => [legend, code]),
);

const shiftedCharacters = '~!@#$%^&*()_+{}|:"<>?';
const unshiftedCharacters = '`1234567890-=[]\\;\',./';
for (const [index, character] of [...shiftedCharacters].entries()) {
  const code = codesByCharacter.get(unshiftedCharacters[index]);
  if (code) codesByCharacter.set(character, code);
}

export const englishCode = (character: string): string | undefined =>
  codesByCharacter.get(character.replace(/^[A-Z]$/, letter => letter.toLowerCase()));

const bopomofoRows = [
  ['1qaz', 'ㄅㄆㄇㄈ'],
  ['2wsx', 'ㄉㄊㄋㄌ'],
  ['edcrfv', 'ㄍㄎㄏㄐㄑㄒ'],
  ['5tgb', 'ㄓㄔㄕㄖ'],
  ['yhn', 'ㄗㄘㄙ'],
  ['ujm', 'ㄧㄨㄩ'],
  ['8ik,', 'ㄚㄛㄜㄝ'],
  ['9ol.', 'ㄞㄟㄠㄡ'],
  ['0p;/-', 'ㄢㄣㄤㄥㄦ'],
  ['3674', 'ˇˊ˙ˋ'],
];

export const bopomofoLabels: Record<string, string> = Object.fromEntries(
  bopomofoRows.flatMap(([legends, labels]) =>
    [...legends].flatMap((legend, index) => {
      const code = englishCode(legend);
      return code ? [[code, labels[index]]] : [];
    }),
  ),
);

const baselineEnglish = [
  'Before the shop opened, Iris swept the steps and set small plants by the door. A delivery rider stopped to ask for water.',
  'We took the slow train to the coast. The sky cleared near the last stop, and a narrow road led us to the waves.',
];

const baselineChinese = [
  '下班後我繞到市場買菜，順手挑了幾顆橘子。回家的路上，路燈一盞接一盞亮起來。',
  '爸媽把舊照片排在桌上。姐姐認出陽台上的盆栽，才想起那年我們一起種過薄荷。',
];

const pairEnglish = [
  'Mina pushed the book cart slowly past the front desk.',
  'Ben closed the window and set the kettle on the stove.',
  'Leo bought four pears and took them home in a paper bag.',
  'Nora found a dry seat near the gate and ate her lunch.',
  'The dog heard a soft tap at the door and looked up.',
  'June found the key in her pocket and stepped inside.',
];

const pairChinese = [
  '我把修好的雨傘放在門邊，提醒自己明天帶上。',
  '公車晚了幾分鐘，站牌下的人都站進遮雨棚。',
  '弟弟用紙箱做了一座房子，貓立刻鑽進去睡覺。',
  '河邊的步道剛整修好，有人在長椅上吃早餐。',
  '我切了半根胡蘿蔔，準備用昨天的白飯做炒飯。',
  '郵差把包裹放在管理室，裡面是朋友寄來的食譜。',
];

const singleTapRounds = [[0, 4, 8], [1, 5, 9], [2, 6, 10], [0, 5, 10], [1, 4, 8], [2, 5, 9]];
const variedTapRounds = Array.from({ length: 9 }, (_, first) =>
  Array.from({ length: 9 - first }, (_, offset) => first + offset + 1).flatMap(second =>
    Array.from({ length: 10 - second }, (_, offset) => [first, second, second + offset + 1]),
  ),
).flat();

const validationEnglish = [
  'Rob took the wrong path and reached the pond instead of the shop. He checked the map, turned at the stone wall, and got there just as the owner put out the sign.',
  'After practice, Kim found a blue scarf under the bench. She put it beside the lost gloves so its owner could see it from the door the next morning.',
  'We moved the table closer to the window so the lamp could reach the outlet. There was room for one more chair, and we brought it in from the porch.',
];

const validationChinese = [
  '午休時我去樓下寄信，碰巧遇到隔壁的同事。她替我扶著玻璃門，我把信投進郵筒後，一起回辦公室。',
  '雨停以後，空地上還積著幾灘水。兩個孩子拿樹枝在水裡畫線，等到路面開始乾了，才收好書包回家。',
  '我們約好在車站旁的書店見面。哥哥早到了十分鐘，已經翻完一本薄薄的漫畫，正要把書放回原來的位置。',
];

function englishPrompt(id: string, text: string): Prompt {
  const codes = [...text].map(character => {
    const code = englishCode(character);
    if (!code) throw new Error(`Unsupported English prompt character: ${character}`);
    return code;
  });
  return { id, kind: 'english', text, codes };
}

function chinesePrompt(id: string, text: string): Prompt {
  return { id, kind: 'chinese', text };
}

function drillPrompt(id: string, codes: string[]): Prompt {
  const text = codes.map(code => physicalLegends.get(code)).join('');
  return { id, kind: 'drill', text, codes };
}

export function getBaselinePrompts(): Prompt[] {
  return [
    ...baselineEnglish.map((text, index) => englishPrompt(`v1-baseline-en-${index}`, text)),
    ...baselineChinese.map((text, index) => chinesePrompt(`v1-baseline-zh-${index}`, text)),
    drillPrompt('v1-baseline-drill', [...typeableCodes, ...typeableCodes.flatMap(code => [code, code])]),
  ];
}

export function getPairPrompts(pairIndex: number, targetCodes: readonly string[], set: PromptSet = 'v1'): Prompt[] {
  const index = pairIndex % pairEnglish.length;
  const [english, chinese] = set === 'v2' ? comparisonText(pairIndex) : [pairEnglish[index], pairChinese[index]];
  const id = set === 'v2' ? `v2-pair-${pairIndex}` : `pair-${pairIndex}`;
  return [
    englishPrompt(`${id}-en`, english),
    chinesePrompt(`${id}-zh`, chinese),
    focusedDrill(`${id}-drill`, pairIndex, targetCodes, set),
  ];
}

export function getSupplementPrompt(index: number, targetCodes: readonly string[]): Prompt {
  return focusedDrill(`v2-supplement-${index}`, index + 110, targetCodes, 'v2');
}

function focusedDrill(id: string, pairIndex: number, targetCodes: readonly string[], set: PromptSet): Prompt {
  const singles = set === 'v2' ? variedTapRounds[(pairIndex * 37) % variedTapRounds.length]
    : singleTapRounds[pairIndex % singleTapRounds.length];
  const focus = [...new Set(targetCodes)].filter(code => physicalLegends.has(code));
  const offset = focus.length ? pairIndex % focus.length : 0;
  const rotated = [...focus.slice(offset), ...focus.slice(0, offset)];
  const roundCount = 11;
  const codes = Array.from({ length: roundCount }, (_, round) => {
    const isSingle = singles.includes(round);
    return rotated.flatMap(code => {
      const presses = isSingle ? [code] : [code, code];
      if (rotated.length === 1 && round < roundCount - 1) {
        presses.push(code === 'Space' ? 'KeyF' : 'Space');
      }
      return presses;
    });
  }).flat();

  return drillPrompt(id, codes);
}

export function getValidationPrompts(pairIndex: number, set: PromptSet = 'v1'): Prompt[] {
  const index = pairIndex % validationEnglish.length;
  const [english, chinese] = set === 'v2' ? holdoutText(pairIndex) : [validationEnglish[index], validationChinese[index]];
  const id = set === 'v2' ? `v2-validation-${pairIndex}` : `validation-${pairIndex}`;
  return [
    englishPrompt(`${id}-en`, english),
    chinesePrompt(`${id}-zh`, chinese),
  ];
}
