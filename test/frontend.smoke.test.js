'use strict';

/*
 * 前端冒烟测试：用最小 DOM/fetch stub 在 Node 中加载 public/app.js，
 * 模拟 打开页面 -> 实时分析 -> 生成修复方案 -> 一次应用 -> 再次实时分析，
 * 校验：按钮显隐、预览中的前后位置/不可避免遮蔽数、应用后的规则顺序与本地保存。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { analyze } = require('../lib/analyzer');

// ---------- 最小 DOM stub ----------
function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    hidden: false,
    disabled: false,
    _text: '',
    _html: '',
    className: '',
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) {
        if (force === undefined) force = !this._set.has(c);
        force ? this._set.add(c) : this._set.delete(c);
      },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    attrs: {},
    listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.children.push(c)); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    dispatch(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(sel) {
      const all = [];
      const walk = (n) => (n.children || []).forEach((c) => { all.push(c); walk(c); });
      walk(this);
      if (sel === '.status-cell') return all.find((c) => c.className === 'status-cell');
      return all.find((c) => c.className === sel.slice(1));
    },
    querySelectorAll() {
      const all = [];
      const walk = (n) => (n.children || []).forEach((c) => { all.push(c); walk(c); });
      walk(this);
      return all;
    },
    focus() {}, select() {}, click() { this.dispatch('click'); },
    get textContent() {
      if (this.children.length) {
        return this.children
          .map((c) => (typeof c === 'string' ? c : c.textContent))
          .join('');
      }
      if (this._html) return this._html.replace(/<[^>]*>/g, ''); // innerHTML 的文本部分
      return this._text;
    },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
  };
  return el;
}

const ids = [
  'rules-list', 'conflicts', 'summary', 'toast', 'fix-plan', 'btn-fix',
  'btn-add', 'btn-reset', 'btn-export', 'btn-import', 'file-import',
  'samples-input', 'samples-summary', 'samples-result',
  'diff-summary', 'diff-status', 'diff-result',
  'baseline-view', 'baseline-list',
  'btn-baseline-import', 'btn-baseline-snapshot', 'btn-baseline-clear',
  'file-baseline',
  'contracts-list', 'contracts-summary', 'btn-contract-add',
];
const els = {};
for (const id of ids) els[id] = makeEl('div');

const storage = {};
const sandbox = {
  console,
  setTimeout, clearTimeout,
  document: {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeEl(tag),
    querySelectorAll: () => [],
    activeElement: null,
  },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
  navigator: {},
  fetch: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () =>
        analyze(body.rules, {
          samples: body.samples,
          baselineRules: body.baselineRules,
          contracts: body.contracts,
        }),
    };
  },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Blob: function () {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInContext(code, sandbox);

// app.js 启动时会 scheduleAnalyze(true) -> 异步 fetch
(async () => {
  await new Promise((r) => setTimeout(r, 30));

  // 0) 请求回归预演：默认样例随首次分析即时计算首条命中
  const samplesText0 = els['samples-result'].textContent;
  assert.ok(
    samplesText0.includes('#1 GET /api/*'),
    '默认顺序下 GET /api/users/123 应首条命中 #1 /api/*'
  );
  assert.ok(
    samplesText0.includes('#8 POST /api/users'),
    'POST /api/users 应命中第 8 条规则'
  );
  assert.ok(samplesText0.includes('无匹配规则'), '无匹配样例应被标注');

  // 0b) 编辑样例 -> 防抖重算 + 本地保存；非法样例逐条标注
  els['samples-input'].value = 'GET /api/users/123\nBADMETHOD /x\nGET /x/:bad';
  els['samples-input'].dispatch('input');
  await new Promise((r) => setTimeout(r, 250)); // 防抖 150ms
  const samplesText = els['samples-result'].textContent;
  assert.ok(samplesText.includes('#1 GET /api/*'), '样例编辑后应自动重算命中');
  assert.ok(samplesText.includes('无效样例'), '非法方法/非具体路径应标为无效样例');
  assert.strictEqual(
    storage['route-conflict-lab.samples.v1'],
    'GET /api/users/123\nBADMETHOD /x\nGET /x/:bad',
    '样例文本应持久化到 localStorage'
  );

  // 1) 默认示例存在 4 条遮蔽 -> 修复按钮可见
  assert.strictEqual(els['btn-fix'].hidden, false, '存在遮蔽时应显示“生成修复方案”按钮');

  // 2) 打开修复方案预览
  els['btn-fix'].dispatch('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(els['fix-plan'].hidden, false, '预览面板应显示');
  const previewText = els['fix-plan'].textContent;
  assert.ok(previewText.includes('调整前遮蔽'), '应展示调整前位置指标');
  assert.ok(previewText.includes('调整后遮蔽'), '应展示调整后位置指标');
  assert.ok(previewText.includes('仍不可避免的遮蔽'), '应展示不可避免遮蔽数量');
  assert.ok(previewText.includes('4'), '默认示例应显示 4 条调整前遮蔽');
  // 默认示例全部可修复
  assert.ok(previewText.includes('一次应用（移动 4 条）'), '应显示一次应用按钮及移动数');
  assert.ok(!/仍将存在的/.test(previewText), '全可修复时不应有残留遮蔽区块');
  // 请求行为回归预演对比：同一批样例 × 建议顺序
  assert.ok(previewText.includes('请求行为回归预演'), '预览应包含样例对比区块');
  assert.ok(previewText.includes('命中改变'), '应标出命中规则改变的样例');
  assert.ok(previewText.includes('#1 GET /api/users/:id'), '应展示建议顺序下的新命中规则');
  // 路由行为契约纳入同一约束图：建议顺序下 3 条契约全部成立（修复 2 条）
  assert.ok(previewText.includes('路由行为契约修复前后'), '预览应包含契约修复前后区块');
  assert.ok(/修复 2/.test(previewText), '应显示 2 条契约被修复');
  assert.ok(/调整后成立 3/.test(previewText), '建议顺序下 3 条契约应全部成立');
  assert.ok(previewText.includes('目标规则移至 #1'), '应预览 hit 契约目标规则的新位置');

  // 3) 一次应用
  const applyBtn = els['fix-plan']
    .querySelectorAll()
    .find((c) => c.tagName === 'button' && String(c.textContent).includes('一次应用'));
  assert.ok(applyBtn, '应找到“一次应用”按钮');
  applyBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));

  // 应用后规则顺序：:id -> /users/* -> /api/* ...
  const saved = JSON.parse(storage['route-conflict-lab.rules.v1']);
  assert.strictEqual(saved[0].path, '/api/users/:id');
  assert.strictEqual(saved[1].path, '/api/users/*');
  assert.strictEqual(saved[2].path, '/api/*');
  assert.strictEqual(saved[3].path, '/assets/css/*');
  assert.strictEqual(saved[4].path, '/assets/*');
  assert.strictEqual(els['fix-plan'].hidden, true, '应用后应收起预览');
  assert.strictEqual(els['btn-fix'].hidden, true, '无遮蔽时修复按钮应隐藏');

  // 3a) 契约的期望规则随重排按“原规则目标”自动重映射：
  // 原 #3(/api/users/:id) 移到 #1、原 #5(/assets/css/*) 移到 #4
  const remappedContracts = JSON.parse(storage['route-conflict-lab.contracts.v1']);
  const hitId = remappedContracts.find((c) => c.path === '/api/users/:id' && c.expect === 'hit');
  const hitCss = remappedContracts.find((c) => c.path === '/assets/css/*' && c.expect === 'hit');
  assert.strictEqual(hitId.ruleIndex, 0, '#3 目标应重映射到第 1 位（0-based 0）');
  assert.strictEqual(hitCss.ruleIndex, 3, '#5 目标应重映射到第 4 位（0-based 3）');
  // 重算后三条契约全部成立
  await new Promise((r) => setTimeout(r, 30));
  const contractTextAfter = els['contracts-list'].textContent;
  assert.strictEqual((contractTextAfter.match(/契约成立/g) || []).length, 3, '应用后 3 条契约均应成立');
  assert.ok(!contractTextAfter.includes('契约被违反'), '应用后不应再有契约被违反');

  // 3b) 应用修复后样例自动重算：/api/users/:id 提升为第 1 位并被首条命中
  const samplesAfter = els['samples-result'].textContent;
  assert.ok(
    samplesAfter.includes('#1 GET /api/users/:id'),
    '应用修复后应命中提升后的 :id 规则'
  );

  // 3c) 路由行为契约面板（此时规则仍为应用后的 8 条）：全空间验证 + 反例 + 新增/校验 + 清空
  const contractRows = els['contracts-list']
    .querySelectorAll()
    .filter((c) => String(c.tagName).toUpperCase() === 'LI' && c.dataset && c.dataset.index !== undefined);
  assert.strictEqual(contractRows.length, 3, '应渲染 3 条默认契约');
  const contractText = els['contracts-list'].textContent;
  assert.ok(contractText.includes('契约成立'), '应用后无匹配契约（POST /api/users/:id）仍成立');
  // 应用后三条契约全部成立（步骤 3a 已断言），这里再核一次计数
  assert.strictEqual((contractText.match(/契约成立/g) || []).length, 3, '应用后应 3 条契约全部成立');

  // 点击其中一条 hit 契约的目标芯片可定位（无反例时改为直接校验期望下拉选项数量）
  els['btn-contract-add'].dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  let rowsNow = els['contracts-list']
    .querySelectorAll()
    .filter((c) => String(c.tagName).toUpperCase() === 'LI' && c.dataset && c.dataset.index !== undefined);
  assert.strictEqual(rowsNow.length, 4, '应新增一条契约');
  const newRow = rowsNow[3];
  const newPath = newRow.querySelector('.contract-path');
  const newExpect = newRow.querySelector('.contract-expect');
  const expectOpts = newExpect.children.filter((c) => String(c.tagName).toUpperCase() === 'OPTION');
  assert.strictEqual(expectOpts.length, 9, '期望选项应为 none + 当前 8 条规则');
  assert.ok(expectOpts[1].textContent.includes('#1'), '规则选项应带 1-based 序号');

  // 编辑新契约为非法路径模式 -> 逐条提示“无效契约”且不参与验证
  newPath.value = 'bad-path';
  newPath.dispatch('input');
  await new Promise((r) => setTimeout(r, 250)); // 防抖 150ms
  rowsNow = els['contracts-list']
    .querySelectorAll()
    .filter((c) => String(c.tagName).toUpperCase() === 'LI' && c.dataset && c.dataset.index !== undefined);
  const invalidRowText = rowsNow[3].textContent;
  assert.ok(invalidRowText.includes('无效契约'), '非法路径契约应标注为无效且不参与验证');
  assert.ok(invalidRowText.includes('路径必须以 / 开头'), '应逐条给出语法错误原因');
  assert.ok(
    els['contracts-summary'].textContent.includes('无效'),
    '摘要应统计无效契约数'
  );

  // 清空全部契约（删除 4 行），使后续步骤 4 在“无 contracts 请求”语义下评估（验证向后兼容）
  for (let k = 0; k < 4; k++) {
    const cur = els['contracts-list']
      .querySelectorAll()
      .filter((c) => String(c.tagName).toUpperCase() === 'LI' && c.dataset && c.dataset.index !== undefined);
    if (cur.length === 0) break;
    const del = cur[cur.length - 1].children[cur[cur.length - 1].children.length - 1];
    del.dispatch('click');
    await new Promise((r) => setTimeout(r, 10));
  }
  rowsNow = els['contracts-list']
    .querySelectorAll()
    .filter((c) => String(c.tagName).toUpperCase() === 'LI' && c.dataset && c.dataset.index !== undefined);
  assert.strictEqual(rowsNow.length, 0, '应已清空全部契约');
  const savedContracts = JSON.parse(storage['route-conflict-lab.contracts.v1']);
  assert.ok(Array.isArray(savedContracts) && savedContracts.length === 0, '清空后契约应持久化为空数组');

  // 4) 不可消除场景：导入含等价重复规则的规则集，预览必须如实标注残留遮蔽
  sandbox.FileReader = class {
    readAsText() {
      this.result = JSON.stringify({
        format: 'route-conflict-lab/v1',
        rules: [
          { method: 'GET', path: '/*' },
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/b' },
        ],
      });
      this.onload();
    }
  };
  els['file-import'].dispatch('change', { target: { files: [{}], value: '' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(els['btn-fix'].hidden, false, '含遮蔽时应显示修复按钮');
  // 导入后样例按新规则集自动重算
  const samplesImported = els['samples-result'].textContent;
  assert.ok(
    samplesImported.includes('#1 GET /*'),
    '导入新规则集后样例应自动重算（/* 首条命中）'
  );
  els['btn-fix'].dispatch('click');
  await new Promise((r) => setTimeout(r, 10));
  const text2 = els['fix-plan'].textContent;
  // 原始：/* 遮蔽 3 条（/a、/a、/b）+ 两条 /a 互相遮蔽 = 4；可修复 3，残留 1
  assert.ok(text2.includes('不可通过排序消除的等价规则'), '应出现不可消除等价组区块');
  assert.ok(/应用后仍将存在的 1 条遮蔽/.test(text2), '应如实列出 1 条残留遮蔽');
  assert.ok(text2.includes('移动 4 条'), '等价组前移 + /* 后移，共 4 条位置变化');
  // 建议顺序：等价的 /a、/a 在前，随后 /b，最宽泛的 /* 最后
  const fpExpect = analyze([
    { method: 'GET', path: '/*' },
    { method: 'GET', path: '/a' },
    { method: 'GET', path: '/a' },
    { method: 'GET', path: '/b' },
  ]).fixPlan;
  assert.deepStrictEqual(
    fpExpect.order.map((i) => ['/*', '/a', '/a', '/b'][i]),
    ['/a', '/a', '/b', '/*']
  );
  // 应用一次：顺序变为 /a /a /b /*（/* 移到最后），遮蔽 4 -> 1
  const applyBtn2 = els['fix-plan']
    .querySelectorAll()
    .find((c) => c.tagName === 'button' && String(c.textContent).includes('一次应用'));
  applyBtn2.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  const saved2 = JSON.parse(storage['route-conflict-lab.rules.v1']);
  assert.strictEqual(saved2[3].path, '/*', '最宽泛的 /* 应移至末尾');
  assert.strictEqual(els['btn-fix'].hidden, false, '仍有 1 条不可避免遮蔽，按钮应保持可见');

  // 5) 版本差异审计：未设基线时的空态 -> 快照当前为基线 -> 两版本行为一致
  assert.ok(
    els['diff-status'].textContent.includes('尚未设置基线'),
    '未设基线时应展示引导提示'
  );
  assert.strictEqual(els['btn-baseline-clear'].hidden, true, '无基线时清除按钮应隐藏');
  els['btn-baseline-snapshot'].dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    els['diff-result'].textContent.includes('完全一致'),
    '快照后两版本首条命中行为应完全一致'
  );
  assert.strictEqual(els['baseline-list'].children.length, 4, '基线只读列表应渲染 4 条规则');
  assert.strictEqual(els['baseline-view'].hidden, false, '设置基线后应可展开查看基线表');
  assert.strictEqual(els['btn-baseline-clear'].hidden, false, '设置基线后清除按钮应可见');
  assert.ok(
    storage['route-conflict-lab.baseline.v1'],
    '基线应保存到 localStorage'
  );

  // 6) 编辑规则 -> 差异自动重算：/a 改为 /c 后，/c 的请求空间从基线 /* 迁移到当前 /c
  const firstRow = els['rules-list'].children[0];
  const pathInput = firstRow.querySelector('.path-input');
  pathInput.value = '/c';
  pathInput.dispatch('input');
  await new Promise((r) => setTimeout(r, 250)); // 防抖 150ms
  const diffText = els['diff-result'].textContent;
  assert.ok(diffText.includes('命中迁移（1）'), '应归组展示 1 类命中迁移');
  assert.ok(diffText.includes('新增覆盖（0）'), '不应出现新增覆盖');
  assert.ok(diffText.includes('丢失覆盖（0）'), '不应出现丢失覆盖');
  assert.ok(diffText.includes('基线 #4 GET /*'), '迁移应归组到基线 /* 规则');
  assert.ok(diffText.includes('当前 #1 GET /c'), '迁移目标应为当前 /c 规则');
  assert.ok(diffText.includes('GET /c'), '应给出最短见证 GET /c');
  assert.ok(
    els['diff-summary'].textContent.includes('命中迁移'),
    '摘要应包含命中迁移计数'
  );

  // 7) 点击见证请求 -> 回填请求预演并自动重算
  const chip = els['diff-result']
    .querySelectorAll()
    .find((c) => c.className === 'witness-chip' && c.textContent === 'GET /c');
  assert.ok(chip, '应找到 GET /c 见证芯片');
  chip.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    els['samples-input'].value.split('\n').includes('GET /c'),
    '见证请求应回填到请求预演输入框'
  );
  assert.ok(
    storage['route-conflict-lab.samples.v1'].split('\n').includes('GET /c'),
    '回填后的样例文本应持久化'
  );
  assert.ok(
    els['samples-result'].textContent.includes('#1 GET /c'),
    '回填后预演应立即按当前规则重算命中'
  );

  // 9) 清除基线 -> 恢复空态，本地存储同步移除（契约已在步骤 3c 清空）
  els['btn-baseline-clear'].dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    els['diff-status'].textContent.includes('尚未设置基线'),
    '清除基线后应恢复引导提示'
  );
  assert.strictEqual(
    'route-conflict-lab.baseline.v1' in storage,
    false,
    '清除基线后 localStorage 中不应保留基线'
  );

  console.log('前端冒烟测试全部通过 ✓');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
