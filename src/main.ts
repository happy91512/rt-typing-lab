import './style.css';
import { bopomofoLabels, getBaselinePrompts, keyboardRows, typeableCodes } from './prompts.ts';
import { mountRound } from './round.ts';
import { mountTravel } from './travel-panel.ts';
import {
  baselineKeyCounts, cancelSupplement, comparisonPrompt, completePairs, configSchema, countRtErrors, defaultConfig, finishSupplement,
  lowSampleKeys, mergedRecommendations, minimumBaselineSamples, mm, newStudy, onGrid, passesTextGuard,
  pendingSupplement, proposeTargets, recordTravelTarget, refinementForKey, restoreStudy, settingFor, startSupplement,
  storageKey, summarizeText, trialResults, validationPrompt,
} from './study.ts';
import type { Condition, Config, Recommendation, Round, Setting, Study, Target } from './study.ts';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing application root');
const app = root;
const labels = new Map(keyboardRows.flat().map(key => [key.code, key.label]));
const printable = new Set(typeableCodes);
const driver = 'https://hub.aulacn.com/keyboard/triggerSet';
const repository = 'https://github.com/happy91512/rt-typing-lab';
const fieldLabels = { linked: '連動按下與抬起', press: '按下靈敏度', release: '抬起靈敏度' };
const statusLabels = { recommended: '實測推薦', keep: '維持原設定', pending: '待驗證', insufficient: '待補測' };
const steps = { setup: '目前設定', baseline: '基準測試', comparison: '換值比較', results: '逐鍵結果' };
type View = keyof typeof steps;

let storageNote = '';
let study = loadStudy();
let view: View = !study ? 'setup' : study.baseline.length < 5 || pendingSupplement(study) ? 'baseline'
  : study.trials.at(-1)?.rounds.length === 18 ? 'results' : 'comparison';
let draft = study?.config ?? defaultConfig;
let overrides = { ...draft.overrides };
let selection: Target[] | null = null;
let selectedKey = 'KeyF';
let confirmedBlock = '';
let validating = !!study?.validation.length && study.validation.length < 4;
let roundScope: AbortController | undefined;
let closeTravel: (() => void) | undefined;

function loadStudy() {
  try {
    const raw = localStorage.getItem(storageKey);
    const restored = raw ? restoreStudy(raw) : null;
    if (raw && !restored) storageNote = '這份本機紀錄無法讀取。開始新測試後會用新紀錄取代。';
    return restored;
  } catch {
    storageNote = '瀏覽器禁止本機儲存。此分頁仍可測試，關閉後進度會消失。';
    return null;
  }
}

function save() {
  try {
    if (study) localStorage.setItem(storageKey, JSON.stringify(study));
    else localStorage.removeItem(storageKey);
  } catch {
    storageNote = '本機進度未能儲存。請保留此分頁，或先下載結果。';
  }
}

function html(value: string | number): string {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? '');
}

function keyLabel(code: string) {
  return code === 'Space' ? '空白' : labels.get(code) ?? code;
}

function settingLabel(value: Setting) {
  return value.enabled ? `${mm(value.distance)} mm` : '關閉';
}

function useView(next: View) {
  view = next === 'comparison' && study && pendingSupplement(study) ? 'baseline' : next;
  render();
  app.querySelector<HTMLElement>('main h1')?.focus();
}

function keyboard(interactive: boolean, results: Record<string, Recommendation | undefined> = {}): string {
  return `<div class="keyboard-scroll" tabindex="0" aria-label="HERO84 HE 鍵盤圖，可水平捲動"><div class="keyboard">
    ${keyboardRows.map(row => `<div class="key-row">${row.map(key => {
      const result = results[key.code];
      const status = result?.status ?? (printable.has(key.code) ? 'untested' : 'outside');
      const attrs = `class="key ${status}" style="--units:${key.width ?? 1}"`;
      const contents = `<span>${html(key.label)}</span>${bopomofoLabels[key.code] ? `<small>${html(bopomofoLabels[key.code])}</small>` : ''}`;
      if (!interactive || !printable.has(key.code)) return `<span ${attrs}>${contents}</span>`;
      return `<button type="button" ${attrs} data-key="${key.code}" tabindex="${selectedKey === key.code ? '0' : '-1'}" aria-pressed="${selectedKey === key.code}"
        aria-label="${html(keyLabel(key.code))}${result ? ` ${statusLabels[result.status]}` : ''}">${contents}</button>`;
    }).join('')}</div>`).join('')}
  </div></div>`;
}

const headers = {
  setup: ['找到適合你的逐鍵 RT', '先記下官方驅動的目前值，再用中英文和短按鍵測試比較。'],
  baseline: ['建立打字基準', '請保留原本的鍵盤設定，完成英文、繁中與實體鍵短測。'],
  comparison: ['比較兩組 RT 設定', '每一對用相同題目測原設定與候選設定。請在官方驅動套用後，再回這裡開始。'],
  results: ['逐鍵 RT 建議', '展開個別鍵位，查看它的樣本、錯誤和建議依據。'],
};

function render() {
  roundScope?.abort();
  closeTravel?.();
  closeTravel = undefined;
  const canVisit = (name: View) => name === 'setup' || (name === 'baseline' && study)
    || (name === 'comparison' && study?.baseline.length === 5 && !pendingSupplement(study))
    || (name === 'results' && study?.baseline.length);
  app.innerHTML = `
    <header class="topbar">
      <div class="wrap topbar-inner">
        <a class="brand" href="./" aria-label="RT Typing Lab 首頁"><span class="brand-mark" aria-hidden="true">RT</span> Typing Lab</a>
        <a class="top-link" href="${repository}" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
      </div>
    </header>
    <main class="wrap" id="main">
      <section class="page-head">
        <div><p class="model-label">AULA HERO84 HE</p><h1 tabindex="-1">${headers[view][0]}</h1><p>${headers[view][1]}</p></div>
        <span class="local-pill"><i aria-hidden="true"></i> 本機分析</span>
      </section>
      <nav class="steps" aria-label="測試步驟">${(Object.keys(steps) as View[]).map((name, index) =>
        `<button type="button" data-view="${name}" ${canVisit(name) ? '' : 'disabled'} ${name === view ? 'aria-current="step"' : ''}><span>${index + 1}</span>${steps[name]}</button>`
      ).join('')}</nav>
      ${storageNote ? `<p class="storage-note" role="status">${html(storageNote)}</p>` : ''}
      <section id="stage" aria-label="${steps[view]}"></section>
    </main>
    <footer class="wrap footer"><span>打字內容在此瀏覽器中分析。</span><a href="${driver}" target="_blank" rel="noopener noreferrer">AULA 官方驅動 ↗</a></footer>
    <dialog id="clear-dialog"><h2>清除測試資料？</h2><p>這會清除本機設定、回合與結果。</p>
      <form method="dialog" class="actions"><button value="cancel" autofocus>取消</button><button class="danger" value="clear">清除本機資料</button></form>
    </dialog>`;
  const stage = app.querySelector<HTMLElement>('#stage')!;
  switch (view) {
    case 'setup': renderSetup(stage); break;
    case 'baseline': renderBaseline(stage); break;
    case 'comparison': renderComparison(stage); break;
    case 'results': renderResults(stage); break;
  }
  app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button =>
    button.addEventListener('click', () => {
      const next = button.dataset.view;
      if (next === 'setup' || next === 'baseline' || next === 'comparison' || next === 'results') useView(next);
    }));
}

function numberInput(name: string, label: string, value: number) {
  return `<label>${label}<span class="input-unit"><input name="${name}" type="number" step="0.01" min="0.01" max="100" inputmode="decimal" value="${mm(value)}" required><span>mm</span></span></label>`;
}

function slotOptions(active: string) {
  return ['1', '2', '3'].map(slot => `<option value="${slot}" ${active === slot ? 'selected' : ''}>板載設定 ${slot}</option>`).join('');
}

function renderSetup(stage: HTMLElement) {
  if (study) {
    stage.innerHTML = `<div class="split"><section class="panel"><h2>本次測試的設定</h2>
      <dl class="summary-list"><div><dt>RT 欄位</dt><dd>${fieldLabels[study.config.field]}</dd></div>
      <div><dt>全鍵預設</dt><dd>${settingLabel(study.config.standard)}</dd></div>
      <div><dt>個別例外</dt><dd>${Object.keys(study.config.overrides).length} 鍵</dd></div></dl>
      <p class="muted">要改用其他鍵盤設定，請先下載目前結果，再清除本機資料開始新一輪。</p>
      <div class="actions"><button class="primary" data-continue>回到測試</button><button data-clear>清除本機資料</button></div></section>
      <section class="panel keyboard-panel"><h2>實體鍵位</h2>${keyboard(false)}</section></div>`;
    stage.querySelector('[data-continue]')?.addEventListener('click', () => useView(study!.baseline.length < 5 ? 'baseline' : 'comparison'));
    stage.querySelector('[data-clear]')?.addEventListener('click', clearDialog);
    return;
  }
  stage.innerHTML = `<div class="split"><form class="panel" id="setup-form" autocomplete="off">
    <h2>填入官方驅動的設定</h2>
    <div class="form-stack">
      <label>本次比較的 RT 欄位<select name="field">
        ${Object.entries(fieldLabels).map(([value, label]) => `<option value="${value}" ${draft.field === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select></label>
      <label class="checkbox"><input name="enabled" type="checkbox" ${draft.standard.enabled ? 'checked' : ''}> 目前已開啟 RT</label>
      ${numberInput('distance', '目前 RT（關閉時填開啟後的起始值）', draft.standard.distance)}
      <details class="advanced"><summary>驅動範圍與板載設定</summary>
        <div class="form-grid three">${numberInput('min', '最小值', draft.bounds.min)}${numberInput('max', '最大值', draft.bounds.max)}${numberInput('step', '刻度', draft.bounds.step)}</div>
        <div class="form-grid"><label>原設定槽位<select name="slotA">${slotOptions(draft.slotA)}</select></label>
        <label>候選設定槽位<select name="slotB"><option value="same">在原槽位手動換值</option>${slotOptions(draft.slotB)}</select></label></div>
        <p class="muted">請先確認另一個槽位可用，且能保留獨立的 RT 設定。</p>
      </details>
    </div>
    <p class="form-note" id="config-error" role="status"></p>
    <button class="primary" type="submit">開始基準測試</button>
  </form>
  <section class="panel keyboard-panel" aria-labelledby="layout-title">
    <h2 id="layout-title">實體鍵位</h2><p class="muted">如果有單獨改過的鍵，在這裡加上例外。一般鍵沿用全鍵預設。</p>
    ${keyboard(true)}
    <div id="override-editor"></div>
  </section></div>`;
  const form = stage.querySelector<HTMLFormElement>('#setup-form')!;
  const slotB = form.elements.namedItem('slotB');
  if (slotB instanceof HTMLSelectElement) slotB.value = draft.slotB;
  bindKeys(stage, () => updateOverride(stage));
  updateOverride(stage);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const config = configSchema.safeParse({
      field: data.get('field'), standard: { enabled: data.has('enabled'), distance: fromForm(data, 'distance') },
      bounds: { min: fromForm(data, 'min'), max: fromForm(data, 'max'), step: fromForm(data, 'step') },
      overrides, slotA: data.get('slotA'), slotB: data.get('slotB'),
    });
    if (!config.success) {
      stage.querySelector('#config-error')!.textContent = '請確認數值符合驅動的範圍與刻度，且 A、B 沒有選到同一個槽位。';
      return;
    }
    draft = config.data;
    study = newStudy(config.data);
    save();
    useView('baseline');
  });
}

function fromForm(form: FormData, name: string) {
  return Math.round(Number(form.get(name)) * 100);
}

function bindKeys(stage: HTMLElement, update: () => void) {
  const keys = Array.from(stage.querySelectorAll<HTMLButtonElement>('[data-key]'));
  for (const [index, key] of keys.entries()) {
    key.addEventListener('click', () => {
      selectedKey = key.dataset.key ?? selectedKey;
      for (const button of keys) {
        button.setAttribute('aria-pressed', String(button === key));
        button.tabIndex = button === key ? 0 : -1;
      }
      update();
    });
    key.addEventListener('keydown', event => {
      const next = new Map([
        ['ArrowRight', keys[index + 1]], ['ArrowLeft', keys[index - 1]],
        ['ArrowDown', keys[index + 11]], ['ArrowUp', keys[index - 11]],
        ['Home', keys[0]], ['End', keys.at(-1)],
      ]);
      if (!next.has(event.key)) return;
      event.preventDefault();
      const destination = next.get(event.key);
      destination?.focus();
      destination?.click();
    });
  }
}

function updateOverride(stage: HTMLElement) {
  const host = stage.querySelector<HTMLElement>('#override-editor')!;
  const fromMain = stage.querySelector<HTMLInputElement>('input[name="distance"]');
  const enabled = stage.querySelector<HTMLInputElement>('input[name="enabled"]');
  const override = overrides[selectedKey];
  const value = override ?? { distance: Math.round(Number(fromMain?.value) * 100), enabled: enabled?.checked ?? false };
  host.innerHTML = `<form class="inline-editor" id="override-form"><h3>${html(keyLabel(selectedKey))} 的個別設定</h3>
    <div class="form-grid"><label class="checkbox"><input name="enabled" type="checkbox" ${value.enabled ? 'checked' : ''}> 目前已開啟 RT</label>${numberInput('distance', 'RT 值', value.distance || draft.standard.distance)}</div>
    <div class="actions"><button type="submit">儲存例外</button>${override ? '<button type="button" data-remove>使用全鍵預設</button>' : ''}</div>
    <p class="muted" role="status">${override ? `已儲存 ${settingLabel(value)}` : '目前沿用全鍵預設'}</p></form>`;
  const form = host.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    overrides[selectedKey] = { enabled: data.has('enabled'), distance: fromForm(data, 'distance') };
    updateOverride(stage);
    host.querySelector<HTMLElement>('[type=submit]')?.focus();
  });
  host.querySelector('[data-remove]')?.addEventListener('click', () => {
    delete overrides[selectedKey];
    updateOverride(stage);
    host.querySelector<HTMLElement>('[type=submit]')?.focus();
  });
}

function renderBaseline(stage: HTMLElement) {
  if (!study) return;
  const { baseline } = study;
  const prompts = getBaselinePrompts();
  const missing = lowSampleKeys(baselineKeyCounts(study));
  const supplement = pendingSupplement(study);
  const token = `supplement-${study.supplements.length}`;
  const awaitingOriginal = !!supplement && confirmedBlock !== token;
  const current = !awaitingOriginal ? supplement?.prompt ?? prompts[baseline.length] : undefined;
  const canSupplement = !validating && (study.trials.at(-1)?.rounds.length ?? 18) === 18;
  const altered = supplement ? new Set(study.trials.flatMap(trial => trial.targets.map(target => target.code))) : null;
  stage.innerHTML = `<div class="split test-layout">
    <section class="panel">
      <div class="section-head"><h2>${supplement ? '低樣本鍵補測' : '基準回合'}</h2><span>${baseline.length} / ${prompts.length}</span></div>
      <progress aria-label="已完成的基準題數" value="${baseline.length}" max="${prompts.length}"></progress>
      ${supplement ? `<p class="muted">這次補測 ${supplement.targets.map(code => html(keyLabel(code))).join('、')}。</p>` : ''}
      <div id="round">${current ? '' : awaitingOriginal ? `<p>請切回板載設定 ${study.config.slotA} 並確認是 A 原設定，再開始補測。</p>
        <div class="actions"><button class="primary" data-confirm-original>已回到 A 原設定</button></div>`
        : `<p>已有 ${typeableCodes.length - missing.length}／${typeableCodes.length} 鍵達到基準樣本門檻。可補測低頻鍵，或直接比較候選值。</p>
          <div class="actions"><button class="primary" data-next>挑選比較鍵</button>
          ${canSupplement && missing.length ? '<button data-supplement>補測低樣本鍵</button>' : ''}
          <button data-results>查看逐鍵結果</button></div>`}</div>
      ${supplement ? '<div class="actions"><button class="text-button" data-cancel-supplement>取消本次補測</button></div>' : ''}
    </section>
    <aside class="panel detail-panel"><h2>目前設定</h2><dl class="summary-list">
      <div><dt>RT 欄位</dt><dd>${fieldLabels[study.config.field]}</dd></div>
      <div><dt>全鍵預設</dt><dd>${settingLabel(study.config.standard)}</dd></div>
      <div><dt>原設定槽位</dt><dd>${study.config.slotA}</dd></div></dl>
      ${altered?.size ? `<details class="advanced"><summary>核對先前調整過的鍵</summary>${settingsTable(study.config, [], 'A', altered)}</details>` : ''}
      <div id="travel-mount"></div>
    </aside></div>`;
  if (current) roundScope = mountRound(stage.querySelector<HTMLElement>('#round')!, current, result => {
    if (supplement) {
      if (!finishSupplement(study!, result)) return;
      confirmedBlock = '';
      selection = null;
      view = 'results';
    } else study!.baseline.push(result);
    completeRound();
  });
  const travel = stage.querySelector<HTMLElement>('#travel-mount');
  if (travel) {
    const priorities = Object.entries(baselineKeyCounts(study))
      .map(([code, counts]) => ({ code, errors: countRtErrors(counts) }))
      .filter(item => item.errors > 0)
      .sort((a, b) => b.errors - a.errors)
      .slice(0, 6)
      .map(item => item.code);
    closeTravel = mountTravel(travel, priorities, study.config, (code, distance) => {
      if (!study || !recordTravelTarget(study, code, distance)) return false;
      selection = null;
      save();
      return true;
    });
  }
  stage.querySelector('[data-start]')?.addEventListener('click', () => {
    const details = stage.querySelector<HTMLDetailsElement>('.travel-panel');
    if (details) details.open = false;
  });
  stage.querySelector('[data-next]')?.addEventListener('click', () => useView('comparison'));
  stage.querySelector('[data-results]')?.addEventListener('click', () => useView('results'));
  stage.querySelector('[data-supplement]')?.addEventListener('click', () => beginSupplement());
  stage.querySelector('[data-confirm-original]')?.addEventListener('click', () => {
    confirmedBlock = token;
    render();
    app.querySelector<HTMLElement>('[data-start]')?.focus();
  });
  stage.querySelector('[data-cancel-supplement]')?.addEventListener('click', () => {
    if (!study || !cancelSupplement(study)) return;
    confirmedBlock = '';
    completeRound();
  });
}

function beginSupplement(code?: string) {
  if (!study || validating || !startSupplement(study, code)) return;
  confirmedBlock = '';
  save();
  useView('baseline');
}

function completeRound() {
  save();
  render();
  (app.querySelector<HTMLElement>('[data-start], [data-confirm], [data-next]')
    ?? app.querySelector<HTMLElement>('main h1'))?.focus();
}

function renderComparison(stage: HTMLElement) {
  if (!study) return;
  const index = study.trials.length - 1;
  const trial = study.trials[index];
  const current = trial ? comparisonPrompt(trial, index) : null;
  if (current) {
    mountComparisonRound(stage, current, trial.targets, `trial-${index}`, result => {
      trial.rounds.push(result);
      if (trial.rounds.length === 18) view = 'results';
      completeRound();
    });
    return;
  }
  selection ??= proposeTargets(study);
  const counts = baselineKeyCounts(study);
  stage.innerHTML = `<div class="split">
    <section class="panel"><div class="section-head"><h2>候選設定</h2><span>${selection.length} / 6 鍵</span></div>
      <p class="muted">先選少量鍵。其他鍵和本次未測的 RT 欄位保持原設定。</p>
      <form id="add-target" class="form-stack" autocomplete="off">
        <label>選擇鍵位<select name="keyCode">${typeableCodes.map(code => `<option value="${code}" ${selectedKey === code ? 'selected' : ''}>${html(keyLabel(code))}</option>`).join('')}</select></label>
        <div data-distance>${numberInput('distance', '候選值', suggestedManual(study.config, selectedKey))}</div>
        <button type="submit">新增或更新候選鍵</button><p class="form-note" role="status"></p>
      </form>
    </section>
    <section class="panel"><h2>A / B 設定清單</h2>
      ${selection.length ? `<div class="table-scroll"><table><thead><tr><th>鍵</th><th>A 原設定</th><th>B 候選值</th><th>基準樣本</th><th><span class="sr-only">動作</span></th></tr></thead><tbody>
        ${selection.map(target => `<tr><th scope="row">${html(keyLabel(target.code))}</th><td>${settingLabel(settingFor(study!.config, target.code))}</td><td>${mm(target.distance)} mm</td><td>${counts[target.code]?.opportunities ?? 0}</td><td><button class="text-button" data-remove-target="${target.code}" aria-label="移除 ${html(keyLabel(target.code))}">移除</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">選一個想測的鍵，或從逐鍵結果找出常出錯的鍵。</p>'}
      <div class="actions"><button class="primary" data-begin ${selection.length ? '' : 'disabled'}>開始三對比較</button><button data-results>查看逐鍵結果</button></div>
    </section></div>`;
  const form = stage.querySelector<HTMLFormElement>('#add-target')!;
  const choice = form.elements.namedItem('keyCode');
  if (choice instanceof HTMLSelectElement) choice.addEventListener('change', () => {
    selectedKey = choice.value;
    form.querySelector('[data-distance]')!.innerHTML = numberInput('distance', '候選值', suggestedManual(study!.config, selectedKey));
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const raw = new FormData(form);
    const code = String(raw.get('keyCode'));
    const value = fromForm(raw, 'distance');
    const original = settingFor(study!.config, code);
    const note = form.querySelector('.form-note')!;
    if (!onGrid(value, study!.config.bounds) || (original.enabled && value === original.distance)) {
      note.textContent = '候選值須符合驅動刻度，且不能等於生效中的原值。';
      return;
    }
    const remaining = selection!.filter(target => target.code !== code);
    if (remaining.length >= 6) {
      note.textContent = '每次可比較六個鍵。移除一個候選鍵後再試。';
      return;
    }
    selection = [...remaining, { code, distance: value, source: original.enabled ? 'manual' : 'enable' }];
    render();
    app.querySelector<HTMLElement>('#add-target select')?.focus();
  });
  stage.querySelectorAll<HTMLButtonElement>('[data-remove-target]').forEach(button =>
    button.addEventListener('click', () => {
      selection = selection!.filter(target => target.code !== button.dataset.removeTarget);
      render();
      app.querySelector<HTMLElement>('#add-target select')?.focus();
    }));
  stage.querySelector('[data-begin]')?.addEventListener('click', () => {
    study!.trials.push({ targets: selection!, rounds: [], promptSet: 'v2' });
    study!.validation = [];
    validating = false;
    selection = null;
    confirmedBlock = '';
    save();
    useView('comparison');
  });
  stage.querySelector('[data-results]')?.addEventListener('click', () => useView('results'));
}

function suggestedManual(config: Config, code: string) {
  const target = selection?.find(item => item.code === code);
  if (target) return target.distance;
  const original = settingFor(config, code);
  if (!original.enabled) return original.distance;
  const { step } = config.bounds;
  const delta = step * Math.max(1, Math.round(5 / step));
  return [original.distance + delta, original.distance - delta, original.distance + step, original.distance - step]
    .find(value => onGrid(value, config.bounds)) ?? original.distance;
}

function mountComparisonRound(
  stage: HTMLElement,
  current: NonNullable<ReturnType<typeof validationPrompt>> & { pair?: number },
  targets: Target[],
  run: string,
  onFinish: (round: Round) => void,
) {
  const { config } = study!;
  const setting = current.condition;
  const token = `${run}-${current.block}`;
  const slot = setting === 'A' || config.slotB === 'same' ? config.slotA : config.slotB;
  const confirmed = confirmedBlock === token;
  const heading = current.pair === undefined ? '整組複測' : `第 ${current.pair + 1} 對 / 3`;
  const previousKeys = new Set(study!.trials.flatMap(trial => trial.targets.map(target => target.code)));
  const separateSlot = config.slotB !== 'same' && setting === 'B';
  if (separateSlot) for (const code of Object.keys(config.overrides)) previousKeys.add(code);
  stage.innerHTML = `<div class="split test-layout"><section class="panel">
    <div class="section-head"><h2>${heading}</h2><span class="condition condition-${setting}">${setting} 組</span></div>
    <div id="round">${confirmed ? '' : `<h3>套用 ${setting} 組設定</h3>
      <p>在官方驅動切到板載設定 ${slot}，依右側清單確認各鍵。操作完成後再回來開始這組。</p>
      <div class="actions"><button class="primary" data-confirm>已套用 ${setting} 組</button><a class="button-link" href="${driver}" target="_blank" rel="noopener noreferrer">開啟官方驅動 ↗</a></div>`}</div>
    </section><aside class="panel detail-panel"><h2>${setting} 組設定清單</h2>
      <p class="muted">板載設定 ${slot} ／ ${fieldLabels[config.field]}</p>
      ${separateSlot ? `<p class="muted">先以 A 槽為基準建立 B 槽。未列出的鍵沿用全鍵預設 ${settingLabel(config.standard)}。</p>` : ''}
      ${settingsTable(config, targets, setting, previousKeys)}
      <p class="muted">確認首次觸發、死區、軸體與本次未測的欄位相同。清單會提醒你還原先前試過的鍵。</p>
    </aside></div>`;
  if (confirmed) roundScope = mountRound(stage.querySelector<HTMLElement>('#round')!, current.prompt, onFinish);
  stage.querySelector('[data-confirm]')?.addEventListener('click', () => {
    confirmedBlock = token;
    render();
    app.querySelector<HTMLElement>('[data-start]')?.focus();
  });
}

function settingsTable(config: Config, targets: readonly Target[], condition: Condition, previouslyTested: Iterable<string> = []) {
  const settings = new Map(targets.map(target => [target.code,
    condition === 'A' ? settingFor(config, target.code) : { enabled: true, distance: target.distance }]));
  for (const code of previouslyTested) if (!settings.has(code)) settings.set(code, settingFor(config, code));
  return `<div class="table-scroll"><table><thead><tr><th scope="col">鍵</th><th scope="col">RT 設定</th></tr></thead><tbody>${Array.from(settings, ([code, setting]) =>
    `<tr><th scope="row">${html(keyLabel(code))}</th><td>${setting.enabled ? `開啟，${settingLabel(setting)}` : '關閉'}</td></tr>`
  ).join('')}</tbody></table></div>`;
}

function clearDialog() {
  const dialog = app.querySelector<HTMLDialogElement>('#clear-dialog')!;
  dialog.returnValue = '';
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'clear') return;
    study = null;
    draft = defaultConfig;
    overrides = {};
    selection = null;
    confirmedBlock = '';
    validating = false;
    save();
    useView('setup');
  }, { once: true });
  dialog.showModal();
}

function rate(result: Recommendation | undefined, condition: 'a' | 'b') {
  const count = result?.[condition];
  return count?.opportunities ? `${countRtErrors(count, result?.target?.source)} / ${count.opportunities}` : '—';
}

function resultStatus(result: Recommendation | undefined, opportunities: number) {
  return result ? statusLabels[result.status] : opportunities >= minimumBaselineSamples ? '維持原設定' : '待補測';
}

function renderResults(stage: HTMLElement) {
  if (!study) return;
  const results = mergedRecommendations(study);
  const wins = Object.values(results).flatMap(result => result.status === 'recommended' && result.target ? [result.target] : []);
  const holdout = validationPrompt(study);
  if (validating && holdout && wins.length) {
    mountComparisonRound(stage, holdout, wins, 'holdout', result => {
      study!.validation.push(result);
      if (study!.validation.length === 4) validating = false;
      completeRound();
    });
    return;
  }
  const { config, baseline, validation } = study;
  const counts = baselineKeyCounts(study);
  const missing = lowSampleKeys(counts);
  const supplement = pendingSupplement(study);
  const comparisonInProgress = (study.trials.at(-1)?.rounds.length ?? 18) < 18;
  const latestTrial = study.trials.at(-1);
  const completed = latestTrial ? completePairs(latestTrial) : [];
  const english = summarizeText(baseline, 'english');
  const chinese = summarizeText(baseline, 'chinese');
  const validated = validation.length === 4;
  const validationOK = validated && passesTextGuard(validation.slice(0, 2), validation.slice(2));
  const tested = new Set(study.trials.flatMap(trial => trial.targets.map(target => target.code)));
  stage.innerHTML = `<div class="result-hero">
    <div><strong>${wins.length}</strong><span>鍵有實測推薦</span></div>
    <div><strong>${english.characters ? english.speed.toFixed(0) : '—'}</strong><span>英文 WPM（基準）</span></div>
    <div><strong>${chinese.characters ? chinese.speed.toFixed(0) : '—'}</strong><span>繁中正確字／分鐘（基準）</span></div>
  </div>
  <section class="panel keyboard-panel result-panel"><div class="section-head"><h2>鍵盤圖</h2><span>${fieldLabels[config.field]}</span></div>
    ${keyboard(true, results)}
    <div class="legend"><span class="legend-win">實測推薦</span><span class="legend-pending">待驗證</span><span>其他狀態請參考逐鍵表</span></div><div id="key-detail"></div>
  </section>
  ${completed.length ? textComparison(completed) : ''}
  <section class="panel result-panel"><div class="section-head"><h2>逐鍵設定表</h2><button data-export>下載 CSV</button></div>
    <p class="muted">A／B 欄顯示可歸因的 RT 錯誤數與按鍵機會。連打漏字樣本可在鍵位詳情查看。</p>
    <p class="muted" data-baseline-coverage>已達基準樣本門檻 ${typeableCodes.length - missing.length}／${typeableCodes.length} 鍵。</p>
    ${validated ? `<p role="status">${validationOK ? '整組已通過新文本複測。' : '整組需複測。合併後的表現未通過中英文門檻。'}</p>` : ''}
    <div class="table-scroll result-table" tabindex="0" aria-label="逐鍵設定表，可捲動"><table>
      <thead><tr><th>鍵</th><th>原設定</th><th>建議</th><th>基準樣本</th><th>A 錯誤 / 樣本</th><th>B 錯誤 / 樣本</th><th>狀態</th></tr></thead>
      <tbody>${keyboardRows.flat().map(({ code }) => {
        const result = results[code];
        const n = counts[code]?.opportunities ?? 0;
        const outside = !printable.has(code);
        const suggested = result?.target && (result.status === 'recommended' || result.status === 'pending') ? `${mm(result.target.distance)} mm` : '—';
        return `<tr><th scope="row">${html(keyLabel(code))}</th><td>${outside ? '—' : settingLabel(settingFor(config, code))}</td><td>${suggested}</td><td>${outside ? '—' : n}</td><td>${rate(result, 'a')}</td><td>${rate(result, 'b')}</td><td><span class="result-status ${result?.status ?? ''}">${outside ? '首版未測' : resultStatus(result, n)}</span></td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <div class="actions"><button class="primary" data-continue>${supplement ? '繼續低樣本鍵補測' : study.baseline.length < 5 ? '繼續基準測試' : comparisonInProgress ? '繼續目前比較' : '測試另一組鍵'}</button>
      ${study.baseline.length === 5 && missing.length && !supplement && !comparisonInProgress ? '<button data-supplement>補測低樣本鍵</button>' : ''}
      ${wins.length && !validated && !comparisonInProgress && !supplement ? '<button data-validate>用新文本複測整組</button>' : ''}<button class="text-button" data-clear>清除本機資料</button></div>
    ${tested.size ? `<details class="advanced restore-list"><summary>還原測試前的設定</summary>
      <p class="muted">回到官方驅動的板載設定 ${config.slotA}，依下表核對 ${fieldLabels[config.field]}。若使用不同槽位且原槽未改動，切回原槽即可。</p>
      ${settingsTable(config, [], 'A', tested)}
    </details>` : ''}
  </section>`;
  bindKeys(stage, () => showKeyDetail(stage, results, counts));
  showKeyDetail(stage, results, counts);
  stage.querySelector('[data-export]')?.addEventListener('click', () => exportCsv(study!, results));
  stage.querySelector('[data-continue]')?.addEventListener('click', () => useView(study!.baseline.length < 5 || supplement ? 'baseline' : 'comparison'));
  stage.querySelector('[data-supplement]')?.addEventListener('click', () => beginSupplement());
  stage.querySelector('[data-validate]')?.addEventListener('click', () => {
    validating = true;
    confirmedBlock = '';
    render();
    app.querySelector<HTMLElement>('[data-confirm]')?.focus();
  });
  stage.querySelector('[data-clear]')?.addEventListener('click', clearDialog);
}

function textComparison(completed: ReturnType<typeof completePairs>) {
  const baseline = completed.flatMap(pair => pair.A);
  const candidate = completed.flatMap(pair => pair.B);
  const rows = (['english', 'chinese'] as const).map(language => {
    const a = summarizeText(baseline, language);
    const b = summarizeText(candidate, language);
    const unit = language === 'english' ? 'WPM' : '字／分';
    const speed = (value: number) => `${value.toFixed(1)} ${unit}`;
    const errors = (value: number) => `${(value * 100).toFixed(1)}%`;
    return `<tr><th scope="row">${language === 'english' ? '英文' : '繁中'}</th>
      <td>${speed(a.speed)}</td><td>${speed(b.speed)}</td>
      <td>${errors(a.rate)}</td><td>${errors(b.rate)}</td></tr>`;
  }).join('');
  return `<section class="panel result-panel"><div class="section-head"><h2>最近一次比較的文字表現</h2><span>${completed.length} / 3 對</span></div>
    <div class="table-scroll"><table><thead><tr><th>語言</th><th>A 速度</th><th>B 速度</th><th>A 錯字率</th><th>B 錯字率</th></tr></thead>
      <tbody>${rows}</tbody></table></div></section>`;
}

function showKeyDetail(stage: HTMLElement, results: Record<string, Recommendation>, counts: ReturnType<typeof baselineKeyCounts>) {
  if (!study) return;
  const stat = counts[selectedKey];
  const result = results[selectedKey];
  const tested = study.trials.flatMap(trial => trial.targets.some(target => target.code === selectedKey)
    ? [trialResults(trial)[selectedKey]] : []);
  const pending = pendingSupplement(study);
  const next = pending ? null : refinementForKey(study, selectedKey);
  const canSupplement = study.baseline.length === 5 && !pending
    && (study.trials.at(-1)?.rounds.length ?? 18) === 18
    && (stat?.opportunities ?? 0) < minimumBaselineSamples;
  const host = stage.querySelector<HTMLElement>('#key-detail')!;
  host.innerHTML = `<div class="key-detail" aria-live="polite">
    <div><h3>${html(keyLabel(selectedKey))}</h3><span>${result?.reason ?? '已依基準回合整理按鍵表現'}</span></div>
    <dl><div><dt>按鍵機會</dt><dd>${stat?.opportunities ?? 0}</dd></div><div><dt>同鍵多打</dt><dd>${stat?.extra ?? 0}</dd></div>
    <div><dt>連打漏字</dt><dd>${stat?.repeatMiss ?? 0} / ${stat?.repeatOpportunities ?? 0}</dd></div>
    <div><dt>漏打總數</dt><dd>${stat?.missed ?? 0}</dd></div></dl>
  </div>
  ${tested.length ? `<details class="advanced restore-list">
    <summary>${html(keyLabel(selectedKey))} 的比較紀錄（${tested.length}）</summary>
    <div class="table-scroll"><table><thead><tr><th scope="col">B 候選值</th><th scope="col">A 錯誤 / 樣本</th><th scope="col">B 錯誤 / 樣本</th><th scope="col">結果</th></tr></thead><tbody>
    ${tested.map(entry => `<tr><th scope="row">${entry.target ? mm(entry.target.distance) : '—'} mm</th>
      <td>${rate(entry, 'a')}</td><td>${rate(entry, 'b')}</td><td>${statusLabels[entry.status]}</td></tr>`).join('')}
    </tbody></table></div></details>` : ''}
  ${next ? `<div class="actions"><button data-refine>比較 ${html(keyLabel(selectedKey))} 的相鄰值 ${mm(next.distance)} mm</button></div>
    <p class="muted">這個相鄰值仍待驗證，目前的實測推薦繼續有效。</p>` : ''}
  ${canSupplement ? `<div class="actions"><button data-supplement-key>補測 ${html(keyLabel(selectedKey))} 的基準樣本</button></div>` : ''}`;
  host.querySelector('[data-supplement-key]')?.addEventListener('click', () => beginSupplement(selectedKey));
  host.querySelector('[data-refine]')?.addEventListener('click', () => {
    if (!next) return;
    selection = [next, ...(selection ?? []).filter(target => target.code !== next.code)].slice(0, 6);
    useView('comparison');
  });
}

function exportCsv(study: Study, results: Record<string, Recommendation>) {
  const baseline = baselineKeyCounts(study);
  const fields = [['實體鍵', '欄位', '原設定', '候選或推薦值 mm', '狀態', '基準樣本', 'A 錯誤', 'A 樣本', 'B 錯誤', 'B 樣本', '依據']];
  for (const code of typeableCodes) {
    const result = results[code];
    fields.push([code, fieldLabels[study.config.field], settingLabel(settingFor(study.config, code)),
      result?.target ? mm(result.target.distance) : '', resultStatus(result, baseline[code]?.opportunities ?? 0),
      String(baseline[code]?.opportunities ?? 0), result?.a.opportunities ? String(countRtErrors(result.a, result.target?.source)) : '', String(result?.a.opportunities ?? ''),
      result?.b.opportunities ? String(countRtErrors(result.b, result.target?.source)) : '', String(result?.b.opportunities ?? ''), result?.reason ?? '']);
  }
  const csv = fields.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=UTF-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'rt-typing-lab-results.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

render();
