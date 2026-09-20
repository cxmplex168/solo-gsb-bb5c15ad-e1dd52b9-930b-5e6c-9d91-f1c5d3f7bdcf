'use strict';

/* 路由冲突实验室 —— 原生前端
 * 规则编辑后（含拖动排序）防抖调用 POST /api/analyze 实时重算。
 */

const STORAGE_KEY = 'route-conflict-lab.rules.v1';
const SAMPLES_STORAGE_KEY = 'route-conflict-lab.samples.v1';
const BASELINE_STORAGE_KEY = 'route-conflict-lab.baseline.v1';
const CONTRACTS_STORAGE_KEY = 'route-conflict-lab.contracts.v1';

const DEFAULT_RULES = [
  { method: 'GET', path: '/api/*' },
  { method: 'GET', path: '/api/users/*' },
  { method: 'GET', path: '/api/users/:id' },
  { method: 'GET', path: '/assets/*' },
  { method: 'GET', path: '/assets/css/*' },
  { method: 'GET', path: '/a/*/c' },
  { method: 'GET', path: '/*/b/c' },
  { method: 'POST', path: '/api/users' },
];

/* 默认请求样例：覆盖命中、无匹配与 ALL/通配符语义，便于首次打开即看到预演效果 */
const DEFAULT_SAMPLES = [
  'GET /api/users/123',
  'GET /assets/css/site.css',
  'POST /api/users',
  'GET /nowhere/deep',
].join('\n');

// 默认路由行为契约（与 DEFAULT_RULES 对应，首次打开即可看到 成立 / 违反 两种状态）：
// 前两条要求 /api/users/:id 与 /api/users/通配空间由对应规则首条命中，
// 但第 1 条规则 GET /api 通配遮蔽了它们，契约被违反；
// 第三条要求 POST 的 /api/users/:id 空间无匹配（默认规则中无 POST /api 通配），契约成立。
const DEFAULT_CONTRACTS = [
  { method: 'GET', path: '/api/users/:id', expect: 'hit', ruleIndex: 2 },
  { method: 'GET', path: '/api/users/*', expect: 'hit', ruleIndex: 1 },
  { method: 'POST', path: '/api/users/:id', expect: 'none' },
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'];
const CONTRACT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const listEl = document.getElementById('rules-list');
const conflictsEl = document.getElementById('conflicts');
const summaryEl = document.getElementById('summary');
const toastEl = document.getElementById('toast');
const fixEl = document.getElementById('fix-plan');
const fixBtnEl = document.getElementById('btn-fix');
const samplesInput = document.getElementById('samples-input');
const samplesSummaryEl = document.getElementById('samples-summary');
const samplesResultEl = document.getElementById('samples-result');
const diffSummaryEl = document.getElementById('diff-summary');
const diffStatusEl = document.getElementById('diff-status');
const diffResultEl = document.getElementById('diff-result');
const baselineViewEl = document.getElementById('baseline-view');
const baselineListEl = document.getElementById('baseline-list');
const baselineClearBtn = document.getElementById('btn-baseline-clear');
const contractsListEl = document.getElementById('contracts-list');
const contractsSummaryEl = document.getElementById('contracts-summary');
const contractAddBtn = document.getElementById('btn-contract-add');

let rules = loadRules();
let baselineRules = loadBaseline();
let contracts = loadContracts();
let dragIndex = null;
let lastAnalysis = null;
let debounceTimer = null;
let fixOpen = false;

function loadRules() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((r) => r && typeof r.path === 'string')) {
        return parsed.map((r) => ({
          method: typeof r.method === 'string' ? r.method : 'GET',
          path: r.path,
        }));
      }
    }
  } catch (_e) {
    /* 存储损坏时回退到默认示例 */
  }
  return DEFAULT_RULES.map((r) => ({ ...r }));
}

function saveRules() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
}

/* ---------------- 基线路由表（版本差异审计，仅保存在浏览器） ---------------- */

function loadBaseline() {
  try {
    const raw = localStorage.getItem(BASELINE_STORAGE_KEY);
    if (raw === null) return null; // 从未设置过基线
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((r) => r && typeof r.path === 'string')) {
      return parsed.map((r) => ({
        method: typeof r.method === 'string' ? r.method : 'GET',
        path: r.path,
      }));
    }
  } catch (_e) {
    /* 存储损坏时视为未设置基线 */
  }
  return null;
}

function saveBaseline() {
  try {
    if (baselineRules === null) {
      localStorage.removeItem(BASELINE_STORAGE_KEY);
    } else {
      localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(baselineRules));
    }
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
}

/* ---------------- 路由行为契约（全空间验证） ---------------- */

function normalizeContract(c) {
  if (!c || typeof c !== 'object') return null;
  const method = typeof c.method === 'string' ? c.method.trim().toUpperCase() : '';
  if (!CONTRACT_METHODS.includes(method)) return null;
  if (typeof c.path !== 'string' || c.path.trim() === '') return null;
  if (c.expect === 'none') {
    return { method, path: c.path, expect: 'none' };
  }
  if (c.expect === 'hit' && Number.isInteger(c.ruleIndex) && c.ruleIndex >= 0) {
    return { method, path: c.path, expect: 'hit', ruleIndex: c.ruleIndex };
  }
  return null;
}

/** 契约仅保存在浏览器本地；首次使用（从未保存过）时给出默认契约 */
function loadContracts() {
  try {
    const raw = localStorage.getItem(CONTRACTS_STORAGE_KEY);
    if (!raw) return DEFAULT_CONTRACTS.map((c) => ({ ...c }));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeContract).filter(Boolean);
  } catch (_e) {
    return [];
  }
}

function saveContracts() {
  try {
    localStorage.setItem(CONTRACTS_STORAGE_KEY, JSON.stringify(contracts));
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
}

/* ---------------- 请求样例（回归预演输入） ---------------- */
function loadSamplesText() {
  try {
    const v = localStorage.getItem(SAMPLES_STORAGE_KEY);
    // 首次使用（从未保存过）时给出默认样例；用户清空后保持为空
    return typeof v === 'string' ? v : DEFAULT_SAMPLES;
  } catch (_e) {
    return DEFAULT_SAMPLES;
  }
}

function saveSamplesText() {
  try {
    localStorage.setItem(SAMPLES_STORAGE_KEY, samplesInput.value);
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
}

/** 当前输入框中的样例行（含空白行，由后端跳过并保留行号） */
function currentSampleLines() {
  return String(samplesInput.value || '').split('\n');
}

function showToast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

/* ---------------- 规则列表渲染 ---------------- */

function renderRules() {
  listEl.innerHTML = '';
  rules.forEach((rule, i) => {
    const li = document.createElement('li');
    li.className = 'rule-row';
    li.dataset.index = String(i);
    li.draggable = true;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⣿';
    grip.title = '拖动以调整优先级';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;

    const method = document.createElement('select');
    method.className = 'rule-method';
    method.setAttribute('aria-label', `规则 ${i + 1} 的请求方法`);
    for (const m of METHODS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if ((rule.method || 'GET').toUpperCase() === m) opt.selected = true;
      method.appendChild(opt);
    }
    method.addEventListener('change', () => {
      rules[i].method = method.value;
      saveRules();
      scheduleAnalyze();
    });

    const pathWrap = document.createElement('span');
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'path-input';
    pathInput.value = rule.path;
    pathInput.placeholder = '/users/:id';
    pathInput.setAttribute('aria-label', `规则 ${i + 1} 的路径模式`);
    pathInput.spellcheck = false;
    pathInput.addEventListener('input', () => {
      rules[i].path = pathInput.value;
      saveRules();
      scheduleAnalyze();
    });
    pathWrap.appendChild(pathInput);

    const status = document.createElement('span');
    status.className = 'status-cell';

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.type = 'button';
    del.textContent = '✕';
    del.title = '删除该规则';
    del.addEventListener('click', () => {
      rules.splice(i, 1);
      saveRules();
      closeFix();
      renderRules();
      scheduleAnalyze(true);
    });

    li.append(grip, idx, method, pathWrap, status, del);
    attachDragHandlers(li);
    listEl.appendChild(li);
  });
  paintAnalysis();
}

/* ---------------- 拖拽排序（HTML5 DnD） ---------------- */

function attachDragHandlers(li) {
  li.addEventListener('dragstart', (e) => {
    dragIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', String(dragIndex));
    } catch (_e) {
      /* 某些浏览器要求 setData，失败可忽略 */
    }
  });

  li.addEventListener('dragend', () => {
    dragIndex = null;
    document.querySelectorAll('.rule-row').forEach((el) => {
      el.classList.remove('dragging', 'drop-above', 'drop-below');
    });
  });

  li.addEventListener('dragover', (e) => {
    if (dragIndex === null || dragIndex === Number(li.dataset.index)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    li.classList.toggle('drop-above', above);
    li.classList.toggle('drop-below', !above);
  });

  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-above', 'drop-below');
  });

  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const targetIndex = Number(li.dataset.index);
    if (dragIndex === null || dragIndex === targetIndex) return;
    const rect = li.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;

    const [moved] = rules.splice(dragIndex, 1);
    let insertAt = targetIndex;
    if (dragIndex < targetIndex) insertAt = targetIndex - 1;
    if (!above) insertAt += 1;
    rules.splice(insertAt, 0, moved);

    saveRules();
    closeFix();
    renderRules();
    scheduleAnalyze(true);
  });
}

/* ---------------- 分析 ---------------- */

function scheduleAnalyze(immediate = false) {
  clearTimeout(debounceTimer);
  if (immediate) {
    analyze();
    return;
  }
  debounceTimer = setTimeout(analyze, 150);
}

async function analyze() {
  try {
    const payload = {
      rules,
      samples: currentSampleLines(),
      contracts,
    };
    if (baselineRules !== null) payload.baselineRules = baselineRules;
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lastAnalysis = await resp.json();
    paintAnalysis();
  } catch (err) {
    closeFix();
    summaryEl.innerHTML = '';
    conflictsEl.innerHTML =
      `<div class="empty-state">分析失败：${escapeHTML(err.message)}</div>`;
    samplesSummaryEl.innerHTML = '';
    samplesResultEl.innerHTML = '';
    diffSummaryEl.innerHTML = '';
    diffResultEl.innerHTML = '';
    paintContracts(null);
  }
}

function paintAnalysis() {
  if (!lastAnalysis) return;
  const { rules: results, conflicts, summary } = lastAnalysis;

  // 行高亮 + 状态徽标
  listEl.querySelectorAll('.rule-row').forEach((row) => {
    const i = Number(row.dataset.index);
    const r = results[i];
    if (!r) return;
    row.classList.toggle('row-invalid', !r.valid);
    row.classList.toggle('row-shadow', r.shadows.length > 0);
    row.classList.toggle(
      'row-partial',
      r.overlaps.length > 0 && r.shadows.length === 0
    );

    const status = row.querySelector('.status-cell');
    status.innerHTML = '';
    if (!r.valid) {
      const badge = badgeEl('invalid', '语法错误');
      status.appendChild(badge);
      const err = document.createElement('span');
      err.className = 'row-error';
      err.textContent = r.errors.join('；');
      status.appendChild(err);
    } else if (r.shadows.length > 0) {
      status.appendChild(badgeEl('shadow', `遮蔽 ${r.shadows.length} 条`));
      if (r.overlaps.length > 0) {
        status.appendChild(badgeEl('partial', `重叠 ${r.overlaps.length} 条`));
      }
    } else if (r.overlaps.length > 0) {
      status.appendChild(badgeEl('partial', `重叠 ${r.overlaps.length} 条`));
    } else {
      status.appendChild(badgeEl('ok', '无冲突'));
    }
  });

  // 摘要
  summaryEl.innerHTML = '';
  const pill = (cls, text, n) => {
    const el = document.createElement('span');
    el.className = `pill ${cls}`;
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = n;
    el.append(num, ` ${text}`);
    return el;
  };
  summaryEl.appendChild(pill('pill-shadow', '完全遮蔽', summary.shadow));
  summaryEl.appendChild(pill('pill-partial', '部分重叠', summary.partial));
  if (summary.total === 0) {
    summaryEl.appendChild(pill('pill-ok', '无冲突', ''));
  }

  // “生成修复方案”仅在存在遮蔽时可用；规则内容变化则收起可能过期的预览
  // （签名只覆盖规则集：仅编辑样例时预览保持打开并用新对比结果重绘）
  const fp = lastAnalysis.fixPlan;
  if (fixOpen && fp && lastAnalysis.signature !== currentSignature()) {
    closeFix();
  }
  if (fp && fp.needed) {
    fixBtnEl.hidden = false;
  } else {
    fixBtnEl.hidden = true;
    closeFix();
  }
  if (fixOpen && fp) renderFixPlan(fp);

  // 请求行为回归预演：按当前优先级逐条展示首条命中
  renderSamples(lastAnalysis.samples);

  // 版本差异审计：基线 × 当前的全空间对比结果
  renderDiff(lastAnalysis.diff);

  // 路由行为契约：全空间验证结果
  paintContracts(lastAnalysis.contracts);

  // 冲突卡片
  conflictsEl.innerHTML = '';
  if (conflicts.length === 0) {
    conflictsEl.innerHTML =
      '<div class="empty-state"><span class="big">✅</span>未发现冲突。<br/>不同方法的规则互不影响；尝试调整顺序或加入 <code>/*</code> 通配符。</div>';
    return;
  }
  for (const c of conflicts) {
    conflictsEl.appendChild(renderConflictCard(c));
  }
}

function badgeEl(kind, text) {
  const b = document.createElement('span');
  b.className = `badge badge-${kind}`;
  b.textContent = text;
  return b;
}

function renderConflictCard(c) {
  const card = document.createElement('div');
  card.className = `conflict-card c-${c.type}`;

  const top = document.createElement('div');
  top.className = 'conflict-top';
  const type = document.createElement('span');
  type.className = 'conflict-type';
  type.textContent = c.type === 'shadow' ? '⛔ 完全遮蔽' : '⚠️ 部分重叠';
  const desc = document.createElement('span');
  desc.className = 'conflict-desc';
  desc.textContent =
    c.type === 'shadow'
      ? `#${c.higher.index + 1} 命中后，#${c.lower.index + 1} 永远不会被执行`
      : `#${c.higher.index + 1} 与 #${c.lower.index + 1} 在部分路径上同时命中`;
  top.append(type, desc);

  const pair = document.createElement('div');
  pair.className = 'route-pair';
  pair.appendChild(routeLine('高优先级', c.higher));
  pair.appendChild(routeLine('低优先级', c.lower));

  const ex = document.createElement('div');
  ex.className = 'example-box';
  const exLabel = document.createElement('span');
  exLabel.className = 'ex-label';
  exLabel.textContent = '最短同时命中';
  const exValue = document.createElement('span');
  exValue.className = 'ex-value';
  exValue.textContent = c.example;
  exValue.title = '点击复制';
  exValue.addEventListener('click', () => {
    navigator.clipboard
      ?.writeText(c.example)
      .then(() => showToast(`已复制：${c.example}`, 'ok'))
      .catch(() => showToast('复制失败，请手动选择', 'error'));
  });
  ex.append(exLabel, exValue);

  card.append(top, pair, ex);
  return card;
}

function routeLine(tag, endpoint) {
  const wrap = document.createElement('span');
  wrap.className = 'rp';
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = tag;
  const method = document.createElement('span');
  method.className = 'm';
  method.textContent = endpoint.method;
  const p = document.createElement('span');
  p.textContent = endpoint.path;
  p.title = `规则 #${endpoint.index + 1}`;
  wrap.append(t, method, p);
  return wrap;
}

/* ---------------- 请求行为回归预演（首条命中） ---------------- */

function renderSamples(data) {
  samplesSummaryEl.innerHTML = '';
  samplesResultEl.innerHTML = '';
  if (!data || data.total === 0) {
    samplesResultEl.innerHTML =
      '<div class="samples-empty">输入样例后，将按当前优先级逐条计算首条命中规则；空白行会被忽略。</div>';
    return;
  }

  const invalid = data.total - data.validCount;
  const parts = [
    `共 ${data.total} 条`,
    `命中 ${data.validCount - data.unmatched}`,
    `无匹配 ${data.unmatched}`,
  ];
  if (invalid > 0) parts.push(`无效 ${invalid}`);
  samplesSummaryEl.textContent = parts.join(' · ');

  for (const s of data.results) {
    samplesResultEl.appendChild(renderSampleRow(s));
  }
}

function renderSampleRow(s) {
  const state = !s.valid ? 'invalid' : s.hit ? 'hit' : 'unmatched';
  const row = document.createElement('div');
  row.className = `sample-row s-${state}`;

  const line = document.createElement('span');
  line.className = 'sample-line';
  line.textContent = `L${s.line}`;
  line.title = `输入第 ${s.line} 行`;

  const input = document.createElement('span');
  input.className = 'sample-input';
  input.textContent = s.input;

  const verdict = document.createElement('span');
  verdict.className = 'sample-verdict';
  if (!s.valid) {
    verdict.appendChild(badgeEl('invalid', '无效样例'));
    const err = document.createElement('span');
    err.className = 'sample-err';
    err.textContent = s.errors.join('；');
    verdict.appendChild(err);
  } else if (s.hit) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sample-hit';
    chip.textContent = `#${s.hit.index + 1} ${s.hit.method} ${s.hit.path}`;
    chip.title = '点击定位到该规则';
    chip.addEventListener('click', () => locateRule(s.hit.index));
    verdict.appendChild(chip);
  } else {
    verdict.appendChild(badgeEl('partial', '无匹配规则'));
  }

  row.append(line, input, verdict);
  return row;
}

/** 滚动定位并短暂高亮指定规则行（预演结果与修复预览共用） */
function locateRule(index) {
  const row = listEl.children[index];
  if (!row) return;
  if (typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  row.classList.add('row-locate');
  setTimeout(() => row.classList.remove('row-locate'), 1600);
}

/* ---------------- 路由行为契约面板（全空间验证） ---------------- */

function expectValue(contract) {
  return contract.expect === 'none' ? 'none' : `hit:${contract.ruleIndex}`;
}

/** 期望下拉框的选项签名：规则数量或任一规则方法/路径变化时需要重建选项 */
function ruleOptionsSignature() {
  return JSON.stringify(rules.map((r) => [
    (r.method || 'GET').toUpperCase(),
    r.path,
  ]));
}

/** 重建「期望」下拉框选项（规则增删/编辑后同步）；重建时尽量保留当前选择 */
function syncExpectOptions(select) {
  const sig = ruleOptionsSignature();
  if (select.dataset.sig === sig) return;
  // 用户正在操作下拉框时不打断（下次分析返回后再同步）
  if (typeof document.activeElement !== 'undefined' && document.activeElement === select) {
    return;
  }
  const prev = select.value || '';
  select.innerHTML = '';
  const none = document.createElement('option');
  none.value = 'none';
  none.textContent = '应无匹配 (none)';
  select.appendChild(none);
  rules.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = `hit:${i}`;
    opt.textContent = `应由 #${i + 1} 首条命中（${(r.method || 'GET').toUpperCase()} ${r.path}）`;
    select.appendChild(opt);
  });
  // 规则被删除导致期望序号越界时，补一个占位选项（契约随即被判无效并逐条提示）
  if (prev.startsWith('hit:')) {
    const idx = Number(prev.slice(4));
    if (!Number.isInteger(idx) || idx >= rules.length) {
      const stale = document.createElement('option');
      stale.value = prev;
      stale.textContent = `应由 #${idx + 1} 首条命中（该规则不存在）`;
      select.appendChild(stale);
    }
  }
  select.value = prev;
  select.dataset.sig = sig;
}

/** 从期望下拉框值回写契约模型 */
function applyExpectValue(contract, value) {
  if (value === 'none') {
    contract.expect = 'none';
    delete contract.ruleIndex;
  } else if (value.startsWith('hit:')) {
    contract.expect = 'hit';
    contract.ruleIndex = Number(value.slice(4));
  }
}

/** 结构性渲染契约行（新增/删除契约时调用）；验证结果由 paintContracts 填充 */
function renderContracts() {
  contractsListEl.innerHTML = '';
  if (contracts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'contracts-empty';
    empty.textContent =
      '尚无契约。点击「＋ 新增契约」：指定具体方法与路径模式，要求该空间一律由某条规则首条命中、或一律无匹配。' +
      '系统会在契约覆盖的整个请求空间上验证当前优先级（自动机全空间枚举，非抽样），并随规则编辑自动重算。';
    contractsListEl.appendChild(empty);
    paintContracts(lastAnalysis ? lastAnalysis.contracts : null);
    return;
  }
  contracts.forEach((contract, i) => {
    const li = document.createElement('li');
    li.className = 'contract-row';
    li.dataset.index = String(i);

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;

    const method = document.createElement('select');
    method.className = 'contract-method';
    method.setAttribute('aria-label', `契约 ${i + 1} 的请求方法`);
    for (const m of CONTRACT_METHODS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if ((contract.method || 'GET').toUpperCase() === m) opt.selected = true;
      method.appendChild(opt);
    }
    method.addEventListener('change', () => {
      contracts[i].method = method.value;
      saveContracts();
      scheduleAnalyze();
    });

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'contract-path';
    pathInput.value = contract.path;
    pathInput.placeholder = '/api/users/:id';
    pathInput.setAttribute('aria-label', `契约 ${i + 1} 的路径模式`);
    pathInput.spellcheck = false;
    pathInput.addEventListener('input', () => {
      contracts[i].path = pathInput.value;
      saveContracts();
      scheduleAnalyze();
    });

    const expect = document.createElement('select');
    expect.className = 'contract-expect';
    expect.setAttribute('aria-label', `契约 ${i + 1} 的期望`);
    expect.addEventListener('change', () => {
      applyExpectValue(contracts[i], expect.value);
      saveContracts();
      scheduleAnalyze(true);
    });

    const status = document.createElement('span');
    status.className = 'contract-status';

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.type = 'button';
    del.textContent = '✕';
    del.title = '删除该契约';
    del.addEventListener('click', () => {
      contracts.splice(i, 1);
      saveContracts();
      renderContracts();
      scheduleAnalyze(true);
    });

    li.append(idx, method, pathInput, expect, status, del);
    contractsListEl.appendChild(li);
  });
  paintContracts(lastAnalysis ? lastAnalysis.contracts : null);
}

function contractPill(cls, text, n) {
  const el = document.createElement('span');
  el.className = `pill ${cls}`;
  const num = document.createElement('span');
  num.className = 'n';
  num.textContent = n;
  el.append(num, ` ${text}`);
  return el;
}

/** 填充契约行的验证结果与汇总（每次分析返回后调用） */
function paintContracts(data) {
  contractsSummaryEl.innerHTML = '';

  // 真实 DOM 按选择器过滤；冒烟测试的最小 stub 不解析选择器，用标签 + dataset 兜底
  const rows = Array.from(contractsListEl.querySelectorAll('.contract-row')).filter(
    (el) => String(el.tagName).toUpperCase() === 'LI' && el.dataset && el.dataset.index !== undefined
  );
  rows.forEach((row) => {
    const i = Number(row.dataset.index);
    const select = row.querySelector('.contract-expect');
    syncExpectOptions(select);
    // 规则删改后模型中的期望序号仍存在、但下拉框选项可能已重建，确保选中态一致
    const wanted = expectValue(contracts[i]);
    if (select.value !== wanted) select.value = wanted;

    const status = row.querySelector('.contract-status');
    status.innerHTML = '';
    row.classList.remove('ct-fail', 'ct-invalid', 'ct-truncated');

    const r = data && Array.isArray(data.results) ? data.results[i] : null;
    if (!r) {
      const wait = document.createElement('span');
      wait.className = 'ct-chip';
      wait.textContent = '等待验证…';
      status.appendChild(wait);
      return;
    }

    if (!r.valid || r.status === 'invalid') {
      row.classList.add('ct-invalid');
      status.appendChild(badgeEl('invalid', '无效契约 · 不参与验证'));
      for (const msg of r.errors) {
        const err = document.createElement('span');
        err.className = 'ct-error';
        err.textContent = msg;
        status.appendChild(err);
      }
      return;
    }

    if (r.status === 'pass') {
      status.appendChild(badgeEl('ok', '✔ 契约成立'));
      return;
    }

    if (r.status === 'truncated') {
      row.classList.add('ct-truncated');
      status.appendChild(badgeEl('partial', '⚠ 状态空间超限，未能完成全空间验证'));
      return;
    }

    // fail：反例 + 实际命中
    row.classList.add('ct-fail');
    const ce = r.counterexample;
    status.appendChild(badgeEl('invalid', '✘ 契约被违反'));
    if (ce) {
      const box = document.createElement('span');
      box.className = 'ct-counter';

      const line1 = document.createElement('span');
      line1.className = 'ct-counter-line';
      const lab = document.createElement('span');
      lab.className = 'ct-counter-label';
      lab.textContent = '最短反例';
      const ex = document.createElement('button');
      ex.type = 'button';
      ex.className = 'ct-counterex';
      ex.textContent = ce.text;
      ex.title = '点击回填到请求预演';
      ex.addEventListener('click', () => backfillWitness(ce.text));
      line1.append(lab, ex);

      const line2 = document.createElement('span');
      line2.className = 'ct-counter-line';
      const lab2 = document.createElement('span');
      lab2.className = 'ct-counter-label';
      lab2.textContent = '实际首条命中';
      const actual = document.createElement('span');
      actual.className = 'ct-actual';
      if (ce.actualHit) {
        const hitBtn = document.createElement('button');
        hitBtn.type = 'button';
        hitBtn.textContent = `#${ce.actualHit.index + 1} ${ce.actualHit.method} ${ce.actualHit.path}`;
        hitBtn.title = '点击定位到该规则';
        hitBtn.addEventListener('click', () => locateRule(ce.actualHit.index));
        actual.appendChild(hitBtn);
      } else {
        actual.textContent = '（无匹配）';
      }
      line2.append(lab2, actual);

      box.append(line1, line2);
      status.appendChild(box);
    }
  });

  if (!data || data.total === 0) return;
  contractsSummaryEl.appendChild(contractPill('pill-contract-pass', '成立', data.pass));
  contractsSummaryEl.appendChild(contractPill('pill-contract-fail', '违反', data.fail));
  if (data.truncated > 0) {
    contractsSummaryEl.appendChild(contractPill('pill-contract-trunc', '未完成', data.truncated));
  }
  if (data.invalid > 0) {
    contractsSummaryEl.appendChild(contractPill('pill-contract-invalid', '无效', data.invalid));
  }
}

contractAddBtn.addEventListener('click', () => {
  contracts.push({ method: 'GET', path: '/', expect: 'none' });
  saveContracts();
  renderContracts();
  scheduleAnalyze(true);
  const inputs = contractsListEl.querySelectorAll('.contract-path');
  const last = inputs[inputs.length - 1];
  if (last) {
    last.focus();
    last.select();
  }
});

/* ---------------- 版本差异审计（基线 × 当前，首条命中语义） ---------------- */

function diffPill(cls, text, n) {
  const el = document.createElement('span');
  el.className = `pill ${cls}`;
  const num = document.createElement('span');
  num.className = 'n';
  num.textContent = n;
  el.append(num, ` ${text}`);
  return el;
}

/** 规则引用芯片：baseline 侧只读展示，current 侧可点击定位到规则行 */
function diffRuleChip(side, ref) {
  const clickable = side === 'current';
  const chip = document.createElement(clickable ? 'button' : 'span');
  chip.className = `diff-rule-chip side-${side}`;
  const tag = side === 'baseline' ? '基线' : '当前';
  chip.textContent = `${tag} #${ref.index + 1} ${ref.method} ${ref.path}`;
  if (clickable) {
    chip.type = 'button';
    chip.title = '点击定位到该规则';
    chip.addEventListener('click', () => locateRule(ref.index));
  }
  return chip;
}

/** 最短见证请求芯片：点击回填到请求预演输入框 */
function witnessChip(witness) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'witness-chip';
  chip.textContent = witness.text;
  chip.title = '最短见证请求（点击回填到请求预演）';
  chip.addEventListener('click', () => backfillWitness(witness.text));
  return chip;
}

/** 把见证请求追加到请求预演输入框（去重），并立即重算 */
function backfillWitness(text) {
  const lines = currentSampleLines();
  if (lines.some((l) => l.trim() === text)) {
    showToast(`预演中已存在：${text}`);
  } else {
    const trimmed = String(samplesInput.value || '').replace(/\s+$/, '');
    samplesInput.value = trimmed ? `${trimmed}\n${text}` : text;
    saveSamplesText();
    showToast(`已回填请求预演：${text}`, 'ok');
  }
  scheduleAnalyze(true);
  if (typeof samplesInput.scrollIntoView === 'function') {
    samplesInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderDiff(diff) {
  baselineClearBtn.hidden = baselineRules === null;
  diffSummaryEl.innerHTML = '';
  diffStatusEl.innerHTML = '';
  diffResultEl.innerHTML = '';
  baselineListEl.innerHTML = '';

  if (baselineRules === null) {
    baselineViewEl.hidden = true;
    diffStatusEl.innerHTML =
      '<div class="diff-empty">尚未设置基线路由表。点击「导入基线 JSON」或「快照当前为基线」后，' +
      '系统会按<strong>首条命中语义</strong>在自动机上比较两个版本的全部请求空间，' +
      '找出命中规则发生变化或仅一侧可命中的请求，并为每类变化给出确定性的最短见证请求。' +
      '基线仅保存在浏览器本地。</div>';
    return;
  }

  // 基线只读列表（语法错误的行标注，与 diff.baseline.invalid 对齐）
  baselineViewEl.hidden = false;
  const invalidMap = new Map();
  if (diff && diff.baseline) {
    for (const inv of diff.baseline.invalid) invalidMap.set(inv.index, inv.errors);
  }
  baselineRules.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'baseline-row' + (invalidMap.has(i) ? ' baseline-invalid' : '');
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = (r.method || 'GET').toUpperCase();
    const p = document.createElement('span');
    p.className = 'p';
    p.textContent = r.path;
    li.append(idx, m, p);
    if (invalidMap.has(i)) {
      const err = document.createElement('span');
      err.className = 'baseline-err';
      err.textContent = invalidMap.get(i).join('；');
      li.appendChild(err);
    }
    baselineListEl.appendChild(li);
  });

  if (!diff) return; // 分析结果尚未返回

  const statusLine = document.createElement('div');
  statusLine.className = 'diff-status-line';
  statusLine.textContent =
    `基线 ${diff.baseline.total} 条规则（${diff.baseline.validCount} 条有效）· ` +
    `与当前 ${lastAnalysis.total} 条规则按首条命中语义对比全部请求空间`;
  diffStatusEl.appendChild(statusLine);
  if (diff.baseline.invalid.length > 0) {
    const warn = document.createElement('div');
    warn.className = 'diff-warn';
    warn.textContent =
      `⚠️ 基线中 ${diff.baseline.invalid.length} 条规则语法错误，已在对比中忽略（见上方基线列表）。`;
    diffStatusEl.appendChild(warn);
  }
  if (diff.truncated) {
    const warn = document.createElement('div');
    warn.className = 'diff-warn';
    warn.textContent = '⚠️ 请求空间状态数超过安全上限，结果已截断，可能未列出全部差异类。';
    diffStatusEl.appendChild(warn);
  }

  diffSummaryEl.appendChild(diffPill('pill-added', '新增覆盖', diff.summary.added));
  diffSummaryEl.appendChild(diffPill('pill-lost', '丢失覆盖', diff.summary.lost));
  diffSummaryEl.appendChild(diffPill('pill-migrated', '命中迁移', diff.summary.migrated));
  if (diff.summary.total === 0 && !diff.truncated) {
    diffSummaryEl.appendChild(diffPill('pill-ok', '两版本行为一致', ''));
  }

  if (diff.summary.total === 0) {
    diffResultEl.innerHTML = diff.identical
      ? '<div class="empty-state"><span class="big">✅</span>两个版本的首条命中行为完全一致。<br/>' +
        '任意方法与路径的请求，两版本命中的规则（按方法+路径判定）均相同。</div>'
      : '<div class="empty-state"><span class="big">⚠️</span>已遍历的请求空间内未发现差异，' +
        '但状态数超过安全上限被截断，无法保证两版本完全一致。</div>';
    return;
  }

  diffResultEl.appendChild(
    renderDiffKindSection(
      'added',
      '新增覆盖',
      '当前版本可命中、基线无匹配的请求空间（按当前规则归组）',
      diff.classes
    )
  );
  diffResultEl.appendChild(
    renderDiffKindSection(
      'lost',
      '丢失覆盖',
      '基线可命中、当前版本无匹配的请求空间（按基线规则归组）',
      diff.classes
    )
  );
  diffResultEl.appendChild(
    renderDiffKindSection(
      'migrated',
      '命中迁移',
      '两侧均可命中、但命中规则不同的请求空间（按基线规则 → 当前规则归组）',
      diff.classes
    )
  );
}

function renderDiffKindSection(kind, title, desc, classes) {
  const list = classes.filter((c) => c.kind === kind);
  const sec = document.createElement('section');
  sec.className = `diff-kind dk-${kind}`;

  const head = document.createElement('div');
  head.className = 'diff-kind-head';
  const t = document.createElement('span');
  t.className = 'diff-kind-title';
  t.textContent = `${title}（${list.length}）`;
  const d = document.createElement('span');
  d.className = 'diff-kind-desc';
  d.textContent = desc;
  head.append(t, d);
  sec.appendChild(head);

  if (list.length === 0) {
    const none = document.createElement('div');
    none.className = 'diff-none';
    none.textContent = '无';
    sec.appendChild(none);
    return sec;
  }

  // 归组：新增覆盖按当前规则；丢失覆盖 / 命中迁移按基线规则
  const groups = new Map();
  for (const c of list) {
    const anchor = kind === 'added' ? c.current : c.baseline;
    if (!groups.has(anchor.index)) groups.set(anchor.index, { anchor, items: [] });
    groups.get(anchor.index).items.push(c);
  }
  for (const g of groups.values()) {
    sec.appendChild(renderDiffGroup(kind, g.anchor, g.items));
  }
  return sec;
}

function renderDiffGroup(kind, anchor, items) {
  const card = document.createElement('div');
  card.className = 'diff-group';

  const head = document.createElement('div');
  head.className = 'diff-group-head';
  head.appendChild(diffRuleChip(kind === 'added' ? 'current' : 'baseline', anchor));
  const note = document.createElement('span');
  note.className = 'diff-group-note';
  note.textContent =
    kind === 'added'
      ? '基线中无匹配'
      : kind === 'lost'
        ? '当前版本无匹配'
        : '以下请求空间的命中迁移自该基线规则';
  head.appendChild(note);
  card.appendChild(head);

  for (const c of items) {
    const row = document.createElement('div');
    row.className = 'diff-row';
    if (kind === 'migrated') {
      const arrow = document.createElement('span');
      arrow.className = 'diff-arrow';
      arrow.textContent = '→';
      row.append(arrow, diffRuleChip('current', c.current));
    }
    const lab = document.createElement('span');
    lab.className = 'witness-label';
    lab.textContent = '最短见证';
    row.append(lab, witnessChip(c.witness));
    card.appendChild(row);
  }
  return card;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ---------------- 修复方案（确定性重排） ---------------- */

function closeFix() {
  fixOpen = false;
  fixEl.hidden = true;
  fixEl.innerHTML = '';
}

/** 当前规则集的内容签名，与 /api/analyze 返回的 signature 对齐 */
function currentSignature() {
  return JSON.stringify(
    rules.map((r) => [
      typeof r.method === 'string' ? r.method.trim().toUpperCase() : '',
      typeof r.path === 'string' ? r.path : '',
    ])
  );
}

fixBtnEl.addEventListener('click', () => {
  fixOpen = !fixOpen;
  if (fixOpen && lastAnalysis && lastAnalysis.fixPlan) {
    renderFixPlan(lastAnalysis.fixPlan);
  } else {
    closeFix();
  }
});

function renderFixPlan(fp) {
  fixEl.hidden = false;
  fixEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'fix-head';
  const title = document.createElement('span');
  title.className = 'fix-title';
  title.textContent = '🛠 修复方案（按语言等价关系分组 + 约束图拓扑排序）';
  head.appendChild(title);

  // 汇总：调整前后遮蔽数量 + 仍不可避免的遮蔽数量
  const stats = document.createElement('div');
  stats.className = 'fix-stats';
  stats.appendChild(fixStat('stat-before', '调整前遮蔽', fp.shadowBefore));
  stats.appendChild(fixStat('stat-after', '调整后遮蔽', fp.shadowAfter));
  stats.appendChild(
    fixStat('stat-unavoid', '仍不可避免的遮蔽', fp.unavoidableShadow)
  );
  stats.appendChild(fixStat('stat-move', '需移动规则', fp.moves.length));

  const verdict = document.createElement('div');
  verdict.className = `fix-verdict ${fp.shadowAfter === 0 ? 'fv-ok' : 'fv-warn'}`;
  if (fp.shadowBefore === 0) {
    verdict.textContent = '当前没有需要修复的遮蔽。';
  } else if (fp.shadowAfter === 0) {
    verdict.textContent =
      `✅ 该顺序可消除全部 ${fp.shadowBefore} 条遮蔽（被消除的遮蔽会转为部分重叠，仍在下方冲突卡片中标注）。`;
  } else if (fp.fixedCount > 0) {
    verdict.textContent =
      `⚠️ 重排可消除 ${fp.fixedCount} 条遮蔽，但仍有 ${fp.unavoidableShadow} 条遮蔽不可避免` +
      `（互相覆盖的等价规则无法通过排序消除）；调整后遮蔽 ${fp.shadowBefore} → ${fp.shadowAfter}。`;
  } else {
    verdict.textContent =
      `⛔ ${fp.unavoidableShadow} 条遮蔽均来自互相覆盖的等价规则，无法通过排序消除——只能合并、删除或改写路径。`;
  }

  // 建议顺序：展示每条规则调整前 #from → 调整后 #to
  const orderBox = document.createElement('div');
  orderBox.className = 'fix-order';
  const orderLabel = document.createElement('div');
  orderLabel.className = 'fix-section-label';
  orderLabel.textContent = '建议顺序（新位置 → 规则，括号内为调整前位置）';
  orderBox.appendChild(orderLabel);

  fp.order.forEach((origIdx, pos) => {
    const r = rules[origIdx];
    if (!r) return;
    const row = document.createElement('div');
    row.className = 'fix-order-row';
    const newNo = document.createElement('span');
    newNo.className = 'fix-new-no';
    newNo.textContent = pos + 1;
    const arrow = document.createElement('span');
    arrow.className = `fix-move ${origIdx === pos ? 'no-move' : ''}`;
    arrow.textContent = origIdx === pos ? '＝' : `#${origIdx + 1} →`;
    arrow.title =
      origIdx === pos ? '位置不变' : `调整前位于第 ${origIdx + 1} 位`;
    const m = document.createElement('span');
    m.className = 'fix-m';
    m.textContent = r.method;
    const p = document.createElement('span');
    p.className = 'fix-p';
    p.textContent = r.path;
    row.append(newNo, arrow, m, p);
    orderBox.appendChild(row);
  });

  // 不可消除的等价组：明确标注，不伪装成已修复
  const groupsBox = document.createElement('div');
  if (fp.equivalenceGroups.some((g) => g.unavoidableShadow > 0)) {
    groupsBox.className = 'fix-groups';
    const glabel = document.createElement('div');
    glabel.className = 'fix-section-label label-danger';
    glabel.textContent = '不可通过排序消除的等价规则（互相覆盖）';
    groupsBox.appendChild(glabel);
    for (const g of fp.equivalenceGroups) {
      if (g.unavoidableShadow === 0) continue;
      const card = document.createElement('div');
      card.className = 'equiv-card';
      const members = document.createElement('div');
      members.className = 'equiv-members';
      g.members.forEach((m2) => {
        const chip = document.createElement('span');
        chip.className = 'equiv-chip';
        chip.textContent = `${m2.method} ${m2.path}`;
        members.appendChild(chip);
      });
      const note = document.createElement('div');
      note.className = 'equiv-note';
      note.textContent =
        `这 ${g.size} 条规则的路径语言互相覆盖、方法兼容，任何顺序下都有 ${g.unavoidableShadow} 对遮蔽。`;
      card.append(members, note);
      groupsBox.appendChild(card);
    }
  }

  // 调整后仍存在的遮蔽（预览）
  const remainBox = document.createElement('div');
  const remainShadows = (fp.residualConflicts || []).filter(
    (c) => c.type === 'shadow'
  );
  if (remainShadows.length > 0) {
    remainBox.className = 'fix-remain';
    const rlabel = document.createElement('div');
    rlabel.className = 'fix-section-label label-danger';
    rlabel.textContent = `应用后仍将存在的 ${remainShadows.length} 条遮蔽`;
    remainBox.appendChild(rlabel);
    for (const c of remainShadows) {
      const line = document.createElement('div');
      line.className = 'remain-line';
      line.textContent =
        `#${c.newPositionA} ${c.higher.method} ${c.higher.path} ⛔ 遮蔽 ` +
        `#${c.newPositionB} ${c.lower.method} ${c.lower.path}（示例 ${c.example}）`;
      remainBox.appendChild(line);
    }
  }

  // 请求行为回归预演：同一批样例 × 建议顺序，逐条对比命中变化
  const replayBox = document.createElement('div');
  if (fp.sampleReplay && fp.sampleReplay.results.length > 0) {
    const rp = fp.sampleReplay;
    replayBox.className = 'fix-samples';
    const label = document.createElement('div');
    label.className = 'fix-section-label';
    label.textContent = '请求行为回归预演（同一批样例 × 建议顺序）';
    replayBox.appendChild(label);

    const sum = document.createElement('div');
    sum.className = 'fix-samples-summary';
    sum.textContent =
      `共 ${rp.total} 条有效样例 · 命中改变 ${rp.changed} · ` +
      `原本无匹配 ${rp.unmatchedBefore} · 调整后无匹配 ${rp.unmatchedAfter}`;
    replayBox.appendChild(sum);

    for (const r of rp.results) {
      replayBox.appendChild(renderReplayRow(r));
    }
  }

  // 操作按钮：预览后一次应用 / 取消
  const actions = document.createElement('div');
  actions.className = 'fix-actions';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-primary';
  applyBtn.textContent = fp.moves.length > 0
    ? `一次应用（移动 ${fp.moves.length} 条）`
    : '顺序无需调整';
  applyBtn.disabled = fp.moves.length === 0;
  applyBtn.addEventListener('click', () => applyFix(fp));
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '收起预览';
  cancelBtn.addEventListener('click', () => closeFix());
  actions.append(applyBtn, cancelBtn);

  fixEl.append(head, stats, verdict, orderBox, replayBox, groupsBox, remainBox, actions);
}

/** 修复预览中的单条样例对比行：当前命中 → 建议顺序命中 */
function renderReplayRow(r) {
  const row = document.createElement('div');
  row.className =
    'fs-row' +
    (r.changed ? ' fs-changed' : '') +
    (r.unmatchedBefore || r.unmatchedAfter ? ' fs-unmatched' : '');

  const badge = document.createElement('span');
  if (r.changed) {
    badge.className = 'fs-badge fb-changed';
    badge.textContent = '命中改变';
  } else if (r.unmatchedBefore && r.unmatchedAfter) {
    badge.className = 'fs-badge fb-unmatched';
    badge.textContent = '始终无匹配';
  } else if (r.unmatchedBefore) {
    badge.className = 'fs-badge fb-unmatched';
    badge.textContent = '原本无匹配';
  } else if (r.unmatchedAfter) {
    badge.className = 'fs-badge fb-unmatched';
    badge.textContent = '调整后无匹配';
  } else {
    badge.className = 'fs-badge fb-same';
    badge.textContent = '不变';
  }

  const input = document.createElement('span');
  input.className = 'fs-input';
  input.textContent = r.input;

  const before = document.createElement('span');
  before.className = 'fs-hit';
  if (r.before) {
    before.textContent = `#${r.before.index + 1} ${r.before.method} ${r.before.path}`;
    before.classList.add('fs-hit-link');
    before.title = '点击定位到该规则';
    before.addEventListener('click', () => locateRule(r.before.index));
  } else {
    before.textContent = '（无匹配）';
  }

  const arrow = document.createElement('span');
  arrow.className = 'fs-arrow';
  arrow.textContent = '→';

  const after = document.createElement('span');
  after.className = 'fs-hit';
  if (r.after) {
    after.textContent = `#${r.afterPosition} ${r.after.method} ${r.after.path}`;
    after.classList.add('fs-hit-link');
    after.title = `调整后位于第 ${r.afterPosition} 位（点击定位当前规则）`;
    after.addEventListener('click', () => locateRule(r.after.index));
  } else {
    after.textContent = '（无匹配）';
  }

  row.append(badge, input, before, arrow, after);
  return row;
}

function fixStat(cls, label, n) {
  const el = document.createElement('span');
  el.className = `fix-stat ${cls}`;
  const num = document.createElement('span');
  num.className = 'fix-stat-n';
  num.textContent = n;
  const lab = document.createElement('span');
  lab.className = 'fix-stat-label';
  lab.textContent = label;
  el.append(num, lab);
  return el;
}

function applyFix(fp) {
  // 防御：规则内容若已变化（编辑/增删/导入），order 索引不再可信，要求重新生成
  if (
    !lastAnalysis ||
    !fp ||
    !Array.isArray(fp.order) ||
    lastAnalysis.total !== rules.length ||
    lastAnalysis.signature !== currentSignature()
  ) {
    showToast('规则已变化，请重新生成修复方案', 'error');
    closeFix();
    scheduleAnalyze(true);
    return;
  }
  const next = fp.order.map((origIdx) => rules[origIdx]).filter(Boolean);
  if (next.length !== rules.length) {
    showToast('规则已变化，请重新生成修复方案', 'error');
    closeFix();
    scheduleAnalyze(true);
    return;
  }
  rules = next;
  saveRules();
  closeFix();
  renderRules();
  scheduleAnalyze(true);
  showToast(
    fp.shadowAfter === 0
      ? '已应用修复方案：遮蔽全部消除'
      : `已应用修复方案：仍有 ${fp.shadowAfter} 条不可避免的遮蔽`,
    fp.shadowAfter === 0 ? 'ok' : 'error'
  );
}

/* ---------------- 导入 / 导出 / 新增 / 重置 ---------------- */

document.getElementById('btn-add').addEventListener('click', () => {
  rules.push({ method: 'GET', path: '/new/route/:id' });
  saveRules();
  closeFix();
  renderRules();
  scheduleAnalyze(true);
  const inputs = listEl.querySelectorAll('.path-input');
  const last = inputs[inputs.length - 1];
  last.focus();
  last.select();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  rules = DEFAULT_RULES.map((r) => ({ ...r }));
  saveRules();
  closeFix();
  renderRules();
  scheduleAnalyze(true);
  showToast('已恢复默认示例', 'ok');
});

document.getElementById('btn-export').addEventListener('click', () => {
  const payload = {
    format: 'route-conflict-lab/v1',
    exportedAt: new Date().toISOString(),
    rules,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'route-rules.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${rules.length} 条规则`, 'ok');
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('file-import').click();
});

document.getElementById('file-import').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      // 兼容裸数组与 { rules: [...] } 两种格式
      const incoming = Array.isArray(data) ? data : data.rules;
      if (!Array.isArray(incoming)) {
        throw new Error('JSON 中未找到 rules 数组');
      }
      const cleaned = incoming
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          method: typeof r.method === 'string' ? r.method : 'GET',
          path: String(r.path ?? ''),
        }));
      if (cleaned.length === 0) throw new Error('规则列表为空');
      rules = cleaned;
      saveRules();
      closeFix();
      renderRules();
      scheduleAnalyze(true);
      showToast(`已导入 ${cleaned.length} 条规则`, 'ok');
    } catch (err) {
      showToast(`导入失败：${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

/* ---------------- 基线导入 / 快照 / 清除 ---------------- */

document.getElementById('btn-baseline-import').addEventListener('click', () => {
  document.getElementById('file-baseline').click();
});

document.getElementById('file-baseline').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      // 与规则导入相同的格式：裸数组或 { rules: [...] }
      const incoming = Array.isArray(data) ? data : data.rules;
      if (!Array.isArray(incoming)) {
        throw new Error('JSON 中未找到 rules 数组');
      }
      const cleaned = incoming
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          method: typeof r.method === 'string' ? r.method : 'GET',
          path: String(r.path ?? ''),
        }));
      if (cleaned.length === 0) throw new Error('规则列表为空');
      baselineRules = cleaned;
      saveBaseline();
      scheduleAnalyze(true);
      showToast(`已导入基线：${cleaned.length} 条规则`, 'ok');
    } catch (err) {
      showToast(`基线导入失败：${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

document.getElementById('btn-baseline-snapshot').addEventListener('click', () => {
  baselineRules = rules.map((r) => ({ method: r.method, path: r.path }));
  saveBaseline();
  scheduleAnalyze(true);
  showToast(`已快照当前 ${rules.length} 条规则为基线`, 'ok');
});

baselineClearBtn.addEventListener('click', () => {
  baselineRules = null;
  saveBaseline();
  scheduleAnalyze(true);
  showToast('已清除基线', 'ok');
});

/* ---------------- 启动 ---------------- */
samplesInput.value = loadSamplesText();
samplesInput.addEventListener('input', () => {
  saveSamplesText();
  scheduleAnalyze();
});
saveContracts(); // 首次打开时把默认契约（或已加载契约）落实到 localStorage
renderRules();
renderContracts();
renderDiff(null); // 首帧即展示基线状态（差异结果随首次分析返回后重绘）
scheduleAnalyze(true);
