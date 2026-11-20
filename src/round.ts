import { bopomofoLabels, typeableCodes } from './prompts.ts';
import type { Prompt } from './prompts.ts';
import { scoreKeys, scoreText } from './scoring.ts';
import type { Stroke } from './scoring.ts';
import type { Round } from './study.ts';

const kindNames = { english: '英文打字', chinese: '繁中打字', drill: '實體鍵短測' };
const printable = new Set(typeableCodes);

export function mountRound(host: HTMLElement, prompt: Prompt, onFinish: (round: Round) => void): AbortController {
  const scope = new AbortController();
  const { signal } = scope;
  const chinese = prompt.kind === 'chinese';
  const drill = prompt.kind === 'drill';
  const expected = Array.from(prompt.text);
  let strokes: Stroke[] = [];
  let started = 0;
  let lastInput = 0;
  let composing = false;
  let active = false;
  host.innerHTML = `
    <div class="round-head"><h3>${kindNames[prompt.kind]}</h3><span class="round-counter" data-count>0 / ${expected.length}</span></div>
    <p class="muted round-help">${chinese ? '使用平常的中文輸入法，可以選字與修正。' : drill ? '切到英文輸入，按提示的實體鍵。␣ 表示空白，重複出現的鍵要放開再按。' : '切到英文輸入，依序打完文本。打錯請繼續，或重打這一題。'}</p>
    <div data-prompt class="prompt${chinese ? ' prompt-zh' : ''}${drill ? ' prompt-drill' : ''}"></div>
    ${chinese ? `<label class="sr-only" for="typing">輸入繁中測試文字</label><textarea id="typing" maxlength="${expected.length + 24}" autocomplete="off" spellcheck="false" autocapitalize="off" rows="3" disabled></textarea>`
      : '<div id="typing" class="typing-target" tabindex="-1" role="region" aria-label="實體鍵輸入區">開始後在這裡輸入</div>'}
    <div class="actions">
      <button class="primary" type="button" data-start>開始這題</button>
      <button type="button" data-finish disabled>送出這題</button>
    </div>
    <p class="form-note" data-note role="status"></p>`;
  const input = host.querySelector<HTMLElement>('#typing')!;
  const reference = host.querySelector<HTMLElement>('[data-prompt]')!;
  const count = host.querySelector<HTMLElement>('[data-count]')!;
  const note = host.querySelector<HTMLElement>('[data-note]')!;
  const start = host.querySelector<HTMLButtonElement>('[data-start]')!;
  const finish = host.querySelector<HTMLButtonElement>('[data-finish]')!;
  if (chinese) reference.textContent = prompt.text;
  else {
    const text = document.createDocumentFragment();
    expected.forEach((character, index) => {
      const slot = document.createElement('span');
      slot.className = 'prompt-char';
      slot.textContent = drill && character === ' ' ? '␣' : character;
      if (drill) {
        const phonetic = bopomofoLabels[prompt.codes?.[index] ?? ''];
        if (phonetic) {
          const hint = document.createElement('small');
          hint.textContent = phonetic;
          slot.append(hint);
        }
      }
      text.append(slot);
    });
    reference.append(text);
  }

  function observeInput() {
    lastInput = performance.now();
    started ||= lastInput;
    const length = input instanceof HTMLTextAreaElement ? Array.from(input.value.normalize('NFC')).length : strokes.length;
    count.textContent = `${length} / ${expected.length}`;
    finish.disabled = !active || composing || length < Math.ceil(expected.length * 0.8);
    if (!chinese) {
      reference.querySelector('.next')?.classList.remove('next');
      reference.children[length]?.classList.add('next');
      input.textContent = strokes.map(stroke => drill && stroke.character === ' ' ? '␣' : stroke.character).join('') || '等待輸入…';
    }
  }

  function reset() {
    active = false;
    composing = false;
    started = 0;
    lastInput = 0;
    strokes = [];
    if (input instanceof HTMLTextAreaElement) {
      input.value = '';
      input.disabled = true;
    } else {
      input.textContent = '開始後在這裡輸入';
      input.tabIndex = -1;
    }
    reference.querySelector('.next')?.classList.remove('next');
    count.textContent = `0 / ${expected.length}`;
    finish.disabled = true;
    start.textContent = '開始這題';
  }

  function interrupt() {
    if (!active) return;
    reset();
    note.textContent = '測試已中斷，這次輸入未計分。可重新開始這題。';
  }

  start.addEventListener('click', () => {
    reset();
    active = true;
    note.textContent = '';
    start.textContent = '重打這題';
    if (input instanceof HTMLTextAreaElement) input.disabled = false;
    else {
      input.tabIndex = 0;
      input.textContent = '等待輸入…';
      reference.children[0]?.classList.add('next');
    }
    input.focus();
  }, { signal });

  function submit() {
    if (finish.disabled || !started) return;
    const elapsedMs = Math.max(1, lastInput - started);
    const text = input instanceof HTMLTextAreaElement ? input.value : strokes.map(stroke => stroke.character).join('');
    const keys = prompt.codes ? scoreKeys(prompt.codes, strokes).keys : {};
    const result = {
      promptId: prompt.id, kind: prompt.kind, elapsedMs,
      keys, text: scoreText(prompt.text, text, elapsedMs),
    };
    reset();
    scope.abort();
    onFinish(result);
  }

  finish.addEventListener('click', submit, { signal });
  input.addEventListener('keydown', event => {
    if (!active || chinese || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing || event.key === 'Process') {
      interrupt();
      note.textContent = '請切換到英文輸入，再重跑這一題。';
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    if (!printable.has(event.code) || event.key.length !== 1) return;
    event.preventDefault();
    if (event.repeat || strokes.length >= expected.length + 24) return;
    strokes.push({ code: event.code, character: event.key, time: event.timeStamp });
    observeInput();
  }, { signal });

  input.addEventListener('compositionstart', () => {
    if (!chinese) return;
    composing = true;
    finish.disabled = true;
    started ||= performance.now();
  }, { signal });
  input.addEventListener('compositionend', () => {
    if (!active || !chinese) return;
    composing = false;
    observeInput();
  }, { signal });
  input.addEventListener('input', () => { if (active && chinese) observeInput(); }, { signal });
  for (const name of ['paste', 'drop']) {
    input.addEventListener(name, event => {
      if (!active) return;
      event.preventDefault();
      note.textContent = '這一題需要手動輸入，貼上或拖放的文字未計入。';
    }, { signal });
  }
  window.addEventListener('blur', interrupt, { signal });
  host.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !host.contains(event.relatedTarget)) interrupt();
  }, { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) interrupt(); }, { signal });
  return scope;
}
