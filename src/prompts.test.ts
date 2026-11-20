import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import {
  bopomofoLabels,
  englishCode,
  getBaselinePrompts,
  getPairPrompts,
  getValidationPrompts,
  keyboardRows,
  typeableCodes,
} from './prompts.ts';

test('the HERO84 HE layout shows 84 different keys in six rows', () => {
  deepEqual(keyboardRows.map(row => row.length), [16, 15, 15, 14, 14, 10]);
  const codes = keyboardRows.flat().map(({ code }) => code);
  equal(new Set(codes).size, 84);
  deepEqual(keyboardRows.map(row => row.at(-1)?.code), [
    'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowRight',
  ]);
  deepEqual(codes.slice(0, 16), [
    'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    'PrintScreen', 'Insert', 'Delete',
  ]);
  ok(codes.includes('Fn'));
  equal(new Set(typeableCodes).size, 48);
  ok(typeableCodes.every(code => codes.includes(code)));
});

test('US printable characters resolve to physical keys with or without Shift', () => {
  const expected = [
    ['aA', 'KeyA'], ['1!', 'Digit1'], ['0)', 'Digit0'], ['`~', 'Backquote'],
    ['-_', 'Minus'], ['=+', 'Equal'], ['[{', 'BracketLeft'], [']}', 'BracketRight'],
    ['\\|', 'Backslash'], [';:', 'Semicolon'], ['\'"', 'Quote'], [',<', 'Comma'],
    ['.>', 'Period'], ['/?', 'Slash'], [' ', 'Space'],
  ];
  for (const [characters, code] of expected) {
    for (const character of characters) equal(englishCode(character), code);
  }
  for (const character of ['ㄅ', 'K', '\n', 'AA', '']) equal(englishCode(character), undefined);
  const asciiCodes = Array.from({ length: 95 }, (_, index) =>
    englishCode(String.fromCharCode(index + 32)),
  );
  ok(asciiCodes.every(code => code !== undefined));
  deepEqual(new Set(asciiCodes), new Set(typeableCodes));
});

test('the standard Taiwan Bopomofo overlay includes each symbol and marked tone', () => {
  const labelRow = (legends: string) => [...legends].map(character => {
    const code = englishCode(character);
    return code && bopomofoLabels[code];
  }).join('');

  equal(labelRow('1234567890-'), 'ㄅㄉˇˋㄓˊ˙ㄚㄞㄢㄦ');
  equal(labelRow('qwertyuiop'), 'ㄆㄊㄍㄐㄔㄗㄧㄛㄟㄣ');
  equal(labelRow('asdfghjkl;'), 'ㄇㄋㄎㄑㄕㄘㄨㄜㄠㄤ');
  equal(labelRow('zxcvbnm,./'), 'ㄈㄌㄏㄒㄖㄙㄩㄝㄡㄥ');
  equal(Object.keys(bopomofoLabels).length, 41);
});

test('baseline, three comparison pairs, and holdouts use different prompt text', () => {
  const baseline = getBaselinePrompts();
  deepEqual(baseline.map(prompt => prompt.kind), ['english', 'english', 'chinese', 'chinese', 'drill']);
  deepEqual(new Set(baseline.find(prompt => prompt.kind === 'drill')?.codes), new Set(typeableCodes));
  const comparison = [0, 1, 2].flatMap(index => {
    const pair = getPairPrompts(index, ['KeyA', 'KeyS', 'KeyD']);
    deepEqual(pair, getPairPrompts(index, ['KeyA', 'KeyS', 'KeyD']));
    deepEqual(pair.map(prompt => prompt.kind), ['english', 'chinese', 'drill']);
    const validation = getValidationPrompts(index);
    deepEqual(validation.map(prompt => prompt.kind), ['english', 'chinese']);
    return [...pair, ...validation];
  });
  const prompts = [...baseline, ...comparison];
  equal(new Set(prompts.map(prompt => prompt.id)).size, prompts.length);
  equal(new Set(prompts.map(prompt => prompt.text)).size, prompts.length);
  for (const prompt of prompts) {
    if (prompt.kind === 'chinese') equal(prompt.codes, undefined);
    else deepEqual([...prompt.text].map(englishCode), prompt.codes);
  }
});

test('focused drills give each target three singles and eight intentional doubles', () => {
  const targets = ['KeyA', 'KeyS', 'Digit2'];
  const drill = getPairPrompts(1, [...targets, 'KeyA', 'NotAKey']).find(prompt => prompt.kind === 'drill');
  ok(drill);
  const codes = drill.codes;
  deepEqual(new Set(codes), new Set(targets));
  for (const target of targets) {
    const occurrences = codes.filter(code => code === target).length;
    const doubles = codes.filter((code, index) => code === target && codes[index + 1] === target).length;
    equal(occurrences, 19);
    equal(doubles, 8);
  }
  const fullDrill = getPairPrompts(0, [...targets, 'KeyQ', 'KeyW', 'KeyE']).find(prompt => prompt.kind === 'drill');
  equal(fullDrill?.codes.length, 114);
});

test('a one-key drill uses a neutral separator for isolated taps', () => {
  for (const [focus, separator] of [['KeyA', 'Space'], ['Space', 'KeyF']]) {
    const drill = getPairPrompts(2, [focus]).find(prompt => prompt.kind === 'drill');
    ok(drill?.codes);
    equal(drill.codes.filter(code => code === focus).length, 19);
    const runs = drill.codes.join(',').split(`,${separator},`);
    deepEqual(runs.map(run => run.split(',').length), [2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1]);
  }
});

test('v2 keeps both passages and single-key patterns distinct across a long comparison series', () => {
  const pairs = Array.from({ length: 100 }, (_, index) => getPairPrompts(index, ['KeyA'], 'v2'));
  for (const column of [0, 1, 2]) {
    equal(new Set(pairs.map(prompts => prompts[column].text)).size, 100);
  }
  deepEqual(pairs[70], getPairPrompts(70, ['KeyA'], 'v2'));
  for (const prompts of pairs) {
    const drill = prompts.find(prompt => prompt.kind === 'drill');
    ok(drill);
    equal(drill.codes.filter(code => code === 'KeyA').length, 19);
    equal(drill.codes.filter((code, index) => code === 'KeyA' && drill.codes[index + 1] === 'KeyA').length, 8);
  }
  const validation = Array.from({ length: 100 }, (_, index) => getValidationPrompts(index, 'v2'));
  for (const column of [0, 1]) {
    equal(new Set(validation.map(prompts => prompts[column].text)).size, 100);
    const pairTexts = new Set(pairs.map(prompts => prompts[column].text));
    ok(validation.every(prompts => !pairTexts.has(prompts[column].text)));
  }
});
