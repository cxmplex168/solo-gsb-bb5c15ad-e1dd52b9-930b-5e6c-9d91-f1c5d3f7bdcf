'use strict';

const assert = require('assert');
const { analyze, covers, buildDFA, parsePath, shortestIntersectionWord } = require('../lib/analyzer');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function dfa(path) {
  const { tokens } = parsePath(path);
  return buildDFA(tokens);
}
function coversP(a, b) {
  return covers(dfa(a), dfa(b));
}
function shortest(a, b) {
  return shortestIntersectionWord(dfa(a), dfa(b));
}

// ---------- 覆盖关系 ----------
check('* 覆盖一切', () => {
  assert.strictEqual(coversP('/*', '/a/b/c'), true);
  assert.strictEqual(coversP('/*', '/'), true);
});
check('具体路径不被 * 反向覆盖之外：/a 不覆盖 /*', () => {
  assert.strictEqual(coversP('/a', '/*'), false);
});
check('/users/:id 覆盖 /users/123 这类单段', () => {
  assert.strictEqual(coversP('/users/:id', '/users/123'), true);
  assert.strictEqual(coversP('/users/:id', '/users/123/posts'), false);
});
check('/users/* 覆盖 /users/:id 及其子路径', () => {
  assert.strictEqual(coversP('/users/*', '/users/:id'), true);
  assert.strictEqual(coversP('/users/*', '/users/:id/posts'), true);
  assert.strictEqual(coversP('/users/*', '/users'), true);
  assert.strictEqual(coversP('/users/*', '/orders/1'), false);
});
check('相同模式互相覆盖', () => {
  assert.strictEqual(coversP('/a/:x', '/a/:y'), true);
});
check('/ 根路径只覆盖自己', () => {
  assert.strictEqual(coversP('/', '/'), true);
  assert.strictEqual(coversP('/', '/a'), false);
  assert.strictEqual(coversP('/*', '/'), true);
});
check('字面量分流不覆盖', () => {
  assert.strictEqual(coversP('/a/x', '/b/x'), false);
});
check('/api/* 与 /api/:v/health：参数需非空，不覆盖无段情形但覆盖有段', () => {
  assert.strictEqual(coversP('/api/*', '/api/:v/health'), true);
  assert.strictEqual(coversP('/api/:v/health', '/api/*'), false);
});
check('双通配 /a/*/b/* 覆盖情形', () => {
  assert.strictEqual(coversP('/a/*/b/*', '/a/x/b/y/z'), true);
  assert.strictEqual(coversP('/a/*/b/*', '/a/b'), true); // 两个 * 均匹配零段
  assert.strictEqual(coversP('/a/*/b/*', '/a/x/c'), false);
});

// ---------- 最短交集路径 ----------
check('交集最短：/users/:id 与 /users/* -> /users/a', () => {
  assert.strictEqual(shortest('/users/:id', '/users/*'), '/users/a');
});
check('交集最短：/a/* 与 /*/b -> /a/b（单段同时满足）', () => {
  assert.strictEqual(shortest('/a/*', '/*/b'), '/a/b');
});
check('交集最短：根 / 与 /* -> /', () => {
  assert.strictEqual(shortest('/', '/*'), '/');
});
check('无交集返回 null：/a 与 /b', () => {
  assert.strictEqual(shortest('/a', '/b'), null);
});
check('无交集返回 null：/a/x 与 /a/:p/y（段数不同）', () => {
  assert.strictEqual(shortest('/a/x', '/a/:p/y'), null);
});
check('字典序并列取最小：/x/:p 与 /x/* 可取任意字面量时取 a', () => {
  assert.strictEqual(shortest('/x/:p', '/x/*'), '/x/a');
});
check('字面量优先于自由值成为最短路径一部分', () => {
  // /z/:p vs /z/*：两条都在 /z/<段> 命中，自由值 a < z
  assert.strictEqual(shortest('/z/:p', '/z/*'), '/z/a');
});
check('/a/* 与 /:p/b 最短交集为 /a/b', () => {
  assert.strictEqual(shortest('/a/*', '/:p/b'), '/a/b');
});

// ---------- analyze 集成 ----------
function ids(conflicts, kind) {
  return conflicts.filter((c) => c.type === kind).map((c) => [c.higher.id, c.lower.id]);
}

check('analyze: 完全遮蔽检测 + 示例', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/users/*' },
    { id: 'b', method: 'GET', path: '/users/:id' },
  ]);
  assert.strictEqual(res.summary.shadow, 1);
  assert.strictEqual(res.summary.partial, 0);
  assert.deepStrictEqual(ids(res.conflicts, 'shadow'), [['a', 'b']]);
  assert.strictEqual(res.conflicts[0].example, 'GET /users/a');
});

check('analyze: 部分重叠检测', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/a/*' },
    { id: 'b', method: 'GET', path: '/*/b' },
  ]);
  assert.strictEqual(res.summary.shadow, 0);
  assert.strictEqual(res.summary.partial, 1);
  assert.strictEqual(res.conflicts[0].example, 'GET /a/b');
});

check('analyze: 不同方法互不冲突', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/users/*' },
    { id: 'b', method: 'POST', path: '/users/*' },
  ]);
  assert.strictEqual(res.summary.total, 0);
});

check('analyze: ALL 与任意具体方法冲突', () => {
  const res = analyze([
    { id: 'a', method: 'ALL', path: '/users/:id' },
    { id: 'b', method: 'DELETE', path: '/users/:id' },
  ]);
  assert.strictEqual(res.summary.shadow, 1);
  assert.strictEqual(res.conflicts[0].method, 'DELETE');
});

check('analyze: 静态规则被通配规则遮蔽，示例为静态字面量', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/*' },
    { id: 'b', method: 'GET', path: '/health' },
  ]);
  assert.strictEqual(res.summary.shadow, 1);
  assert.strictEqual(res.conflicts[0].example, 'GET /health');
});

check('analyze: 无效规则被跳过并给出错误', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: 'users/missing-slash' },
    { id: 'b', method: 'GET', path: '/ok' },
  ]);
  assert.strictEqual(res.rules[0].valid, false);
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.summary.total, 0);
});

check('analyze: 优先级由数组顺序决定，交换后遮蔽方向相反', () => {
  const r1 = analyze([
    { id: 'a', method: 'GET', path: '/users/*' },
    { id: 'b', method: 'GET', path: '/users/:id' },
  ]);
  const r2 = analyze([
    { id: 'b', method: 'GET', path: '/users/:id' },
    { id: 'a', method: 'GET', path: '/users/*' },
  ]);
  // 互换优先级后：:id 不遮蔽 *，仅在 /users/:id 单段处重叠
  assert.strictEqual(r1.conflicts[0].type, 'shadow');
  assert.strictEqual(r2.conflicts[0].type, 'partial');
  assert.strictEqual(r2.conflicts[0].example, 'GET /users/a');
});

check('analyze: 默认实验室示例集结果稳定', () => {
  const res = analyze([
    { method: 'GET', path: '/api/*' },
    { method: 'GET', path: '/api/users/*' },
    { method: 'GET', path: '/api/users/:id' },
    { method: 'GET', path: '/assets/*' },
    { method: 'GET', path: '/assets/css/*' },
    { method: 'GET', path: '/a/*/c' },
    { method: 'GET', path: '/*/b/c' },
    { method: 'POST', path: '/api/users' },
  ]);
  // 遮蔽：0->1、0->2、1->2、3->4
  assert.strictEqual(res.summary.shadow, 4);
  // 部分重叠：5(/a/*/c) 与 6(/*/b/c) 等
  const overlap56 = res.conflicts.find(
    (c) => c.type === 'partial' && c.higher.index === 5 && c.lower.index === 6
  );
  assert.ok(overlap56, '应检出 /a/*/c 与 /*/b/c 的部分重叠');
  assert.strictEqual(overlap56.example, 'GET /a/b/c');
});

// ---------- 修复方案（重排） ----------
function isPermutation(order, n) {
  return (
    Array.isArray(order) &&
    order.length === n &&
    order.slice().sort((a, b) => a - b).every((v, i) => v === i)
  );
}

check('fixPlan: 严格覆盖的遮蔽全部可经重排消除，结果无遮蔽', () => {
  const rules = [
    { id: 'a', method: 'GET', path: '/users/*' },
    { id: 'b', method: 'GET', path: '/users/:id' },
  ];
  const f = analyze(rules).fixPlan;
  assert.strictEqual(f.needed, true);
  assert.strictEqual(f.feasible, true);
  assert.strictEqual(f.shadowBefore, 1);
  assert.strictEqual(f.shadowAfter, 0);
  assert.strictEqual(f.unavoidableShadow, 0);
  assert.strictEqual(f.fixedCount, 1);
  // 更具体的 b 必须排在严格覆盖它的 a 之前
  assert.deepStrictEqual(f.order, [1, 0]);
  assert.ok(isPermutation(f.order, rules.length));
  // 位置调整：b 2->1，a 1->2
  assert.deepStrictEqual(f.moves.map((m) => [m.rule.id, m.from, m.to]), [
    ['b', 2, 1],
    ['a', 1, 2],
  ]);
  // 约束图边：narrower=b -> wider=a
  assert.strictEqual(f.constraints.length, 1);
  assert.strictEqual(f.constraints[0].narrower.id, 'b');
  assert.strictEqual(f.constraints[0].wider.id, 'a');
});

check('fixPlan: 默认示例集中 4 条严格覆盖遮蔽全部可修复，转换为重叠', () => {
  const res = analyze([
    { method: 'GET', path: '/api/*' },
    { method: 'GET', path: '/api/users/*' },
    { method: 'GET', path: '/api/users/:id' },
    { method: 'GET', path: '/assets/*' },
    { method: 'GET', path: '/assets/css/*' },
    { method: 'GET', path: '/a/*/c' },
    { method: 'GET', path: '/*/b/c' },
    { method: 'POST', path: '/api/users' },
  ]);
  const f = res.fixPlan;
  assert.strictEqual(f.shadowAfter, 0);
  assert.strictEqual(f.unavoidableShadow, 0);
  assert.ok(isPermutation(f.order, 8));
  // 顺序约束：:id 在 /users/* 在 /api/* 之前；/assets/css/* 在 /assets/* 之前
  const pos = (i) => f.order.indexOf(i);
  assert.ok(pos(2) < pos(1) && pos(1) < pos(0));
  assert.ok(pos(4) < pos(3));
  // 部分重叠数：原 5 + 转为重叠的 4 = 9，遮蔽 0
  assert.strictEqual(f.partialAfter, 9);
});

check('fixPlan: 路径语言等价的重复规则标为不可消除，不伪装为已修复', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/dup/:x' },
    { id: 'b', method: 'GET', path: '/dup/:y' },
  ]);
  const f = res.fixPlan;
  assert.strictEqual(f.shadowBefore, 1);
  assert.strictEqual(f.shadowAfter, 1); // 排序后依旧遮蔽
  assert.strictEqual(f.fixedCount, 0);
  assert.strictEqual(f.unavoidableShadow, 1);
  assert.strictEqual(f.equivalenceGroups.length, 1);
  assert.strictEqual(f.equivalenceGroups[0].resolvableByOrder, false);
  assert.strictEqual(f.equivalenceGroups[0].unavoidableShadow, 1);
  assert.strictEqual(f.unavoidablePairs.length, 1);
  assert.deepStrictEqual(
    f.unavoidablePairs[0].a.id < f.unavoidablePairs[0].b.id ? ['a', 'b'] : ['b', 'a'],
    ['a', 'b']
  );
  // 无约束边：等价关系不产生排序约束
  assert.strictEqual(f.constraints.length, 0);
});

check('fixPlan: GET/ALL 同路径也属不可消除等价组，且具体规则仍约束通配规则', () => {
  const res = analyze([
    { id: 'c', method: 'GET', path: '/*' },
    { id: 'a', method: 'GET', path: '/x' },
    { id: 'b', method: 'ALL', path: '/x' },
  ]);
  const f = res.fixPlan;
  // 原始顺序：c 遮蔽 a、c 遮蔽 b；a、b 路径等价且方法兼容 -> 1 条不可消除
  assert.strictEqual(f.shadowBefore, 3);
  assert.strictEqual(f.unavoidableShadow, 1);
  assert.strictEqual(f.shadowAfter, 1);
  assert.strictEqual(f.fixedCount, 2);
  assert.strictEqual(f.equivalenceGroups.length, 1);
  assert.strictEqual(f.equivalenceGroups[0].resolvableByOrder, false);
  const pos = (i) => f.order.indexOf(i);
  // 等价组（a=1、b=2）必须在更宽泛的 c=0 之前
  assert.ok(pos(1) < pos(0) && pos(2) < pos(0));
});

check('fixPlan: 部分重叠不产生约束边，也不宣称被修复', () => {
  const f = analyze([
    { method: 'GET', path: '/a/*' },
    { method: 'GET', path: '/*/b' },
  ]).fixPlan;
  assert.strictEqual(f.needed, false); // 没有遮蔽
  assert.strictEqual(f.shadowBefore, 0);
  assert.strictEqual(f.shadowAfter, 0);
  assert.strictEqual(f.fixedCount, 0);
  assert.strictEqual(f.constraints.length, 0);
  assert.deepStrictEqual(f.order, [0, 1]);
});

check('fixPlan: 确定性——相同输入多次计算顺序完全一致', () => {
  const rules = [
    { method: 'GET', path: '/*' },
    { method: 'GET', path: '/api/*' },
    { method: 'GET', path: '/api/users/*' },
    { method: 'GET', path: '/api/users/:id' },
    { method: 'GET', path: '/assets/*' },
    { method: 'GET', path: '/assets/css/*' },
  ];
  const o1 = analyze(rules).fixPlan.order;
  const o2 = analyze(rules).fixPlan.order;
  assert.deepStrictEqual(o1, o2);
  // 更具体者在前
  assert.deepStrictEqual(o1, [3, 2, 1, 5, 4, 0]);
});

check('fixPlan: 无效规则不参与分组与约束，且应用后仍为无效规则', () => {
  const rules = [
    { method: 'GET', path: 'bad' },
    { method: 'GET', path: '/*' },
    { method: 'GET', path: '/x' },
  ];
  const f = analyze(rules).fixPlan;
  assert.ok(isPermutation(f.order, 3));
  assert.strictEqual(f.order[0], 0); // 无效规则保持原位
  assert.ok(f.order.indexOf(2) < f.order.indexOf(1)); // /x 位于 /* 之前
  assert.strictEqual(f.shadowAfter, 0);
});

check('fixPlan: 无冲突/空集时给出稳定空方案', () => {
  const f1 = analyze([
    { method: 'GET', path: '/a' },
    { method: 'POST', path: '/b' },
  ]).fixPlan;
  assert.strictEqual(f1.needed, false);
  assert.deepStrictEqual(f1.order, [0, 1]);
  assert.strictEqual(f1.moves.length, 0);
  const f2 = analyze([]).fixPlan;
  assert.deepStrictEqual(f2.order, []);
  assert.strictEqual(f2.shadowAfter, 0);
});

// ---------- 请求行为回归预演（samples） ----------
check('samples: 按当前优先级计算首条命中，支持 ALL 规则与通配符语义', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/api/*' },
      { method: 'GET', path: '/api/users/:id' },
      { method: 'ALL', path: '/assets/*' },
      { method: 'GET', path: '/' },
    ],
    { samples: ['GET /api/users/123', 'DELETE /assets/css/a.css', 'GET /assets', 'GET /'] }
  );
  const [s1, s2, s3, s4] = res.samples.results;
  assert.strictEqual(s1.hit.index, 0); // /api/* 优先于更具体的 :id
  assert.strictEqual(s2.hit.index, 2); // ALL 规则命中 DELETE
  assert.strictEqual(s3.hit.index, 2); // * 匹配零个段
  assert.strictEqual(s4.hit.index, 3); // 根路径精确命中
  assert.strictEqual(res.samples.total, 4);
  assert.strictEqual(res.samples.validCount, 4);
  assert.strictEqual(res.samples.unmatched, 0);
});

check('samples: 无匹配时 hit 为 null 并计入 unmatched；方法不兼容即无匹配', () => {
  const res = analyze(
    [{ method: 'GET', path: '/only-get' }],
    { samples: ['POST /only-get', 'GET /other'] }
  );
  assert.strictEqual(res.samples.results[0].hit, null);
  assert.strictEqual(res.samples.results[1].hit, null);
  assert.strictEqual(res.samples.unmatched, 2);
  assert.strictEqual(res.samples.validCount, 2);
});

check('samples: 校验具体方法与具体路径，错误逐条可读', () => {
  const res = analyze(
    [{ method: 'GET', path: '/x/*' }],
    { samples: ['GET /x/:id', 'GET /x/*', 'ALL /x', 'GET', 'FOO /x', 'GET /a b'] }
  );
  const r = res.samples.results;
  assert.strictEqual(r[0].valid, false); // 参数段不是具体路径
  assert.strictEqual(r[1].valid, false); // 通配符不是具体路径
  assert.strictEqual(r[2].valid, false); // ALL 不是具体方法
  assert.strictEqual(r[3].valid, false); // 缺少路径
  assert.strictEqual(r[4].valid, false); // 非法方法
  assert.strictEqual(r[5].valid, false); // 路径含空白
  assert.strictEqual(res.samples.validCount, 0);
  assert.ok(r[0].errors.join('').includes('具体路径'));
  assert.ok(r[1].errors.join('').includes('通配符'));
  assert.ok(r[2].errors.join('').includes('具体方法'));
  assert.ok(r.every((s) => s.hit === null));
});

check('samples: 空白行被跳过，结果保留输入行号与顺序', () => {
  const res = analyze(
    [{ method: 'GET', path: '/a' }],
    { samples: ['', 'GET /a', '   ', 'GET /missing'] }
  );
  assert.strictEqual(res.samples.total, 2);
  assert.strictEqual(res.samples.results[0].line, 2);
  assert.strictEqual(res.samples.results[1].line, 4);
  assert.strictEqual(res.samples.results[0].input, 'GET /a');
  assert.strictEqual(res.samples.results[0].hit.index, 0);
  assert.strictEqual(res.samples.results[1].hit, null);
});

check('samples: 无效规则不参与命中', () => {
  const res = analyze(
    [
      { method: 'GET', path: 'bad-path' },
      { method: 'GET', path: '/ok' },
    ],
    { samples: ['GET /ok'] }
  );
  assert.strictEqual(res.samples.results[0].hit.index, 1);
});

check('samples: 支持 { method, path } 对象形式，方法大小写不敏感', () => {
  const res = analyze(
    [{ method: 'GET', path: '/obj/:id' }],
    { samples: [{ method: 'get', path: '/obj/9' }] }
  );
  const s = res.samples.results[0];
  assert.strictEqual(s.valid, true);
  assert.strictEqual(s.method, 'GET');
  assert.strictEqual(s.hit.index, 0);
});

check('sampleReplay: 建议顺序下命中改变被标出，可定位新旧规则位置', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/api/*' },
      { method: 'GET', path: '/api/users/:id' },
    ],
    { samples: ['GET /api/users/7'] }
  );
  const rp = res.fixPlan.sampleReplay;
  assert.strictEqual(rp.total, 1);
  assert.strictEqual(rp.changed, 1);
  const r = rp.results[0];
  assert.strictEqual(r.before.index, 0); // 当前命中 /api/*
  assert.strictEqual(r.after.index, 1); // 建议顺序下命中 :id
  assert.strictEqual(r.afterPosition, 1); // :id 被提升到第 1 位
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.unmatchedBefore, false);
  assert.strictEqual(r.unmatchedAfter, false);
});

check('sampleReplay: 原本/调整后无匹配分别标注；无效样例不参与对比', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/api/*' },
      { method: 'GET', path: '/api/users/:id' },
    ],
    { samples: ['GET /none', 'GET /api/users/7', 'BAD /x'] }
  );
  const rp = res.fixPlan.sampleReplay;
  assert.strictEqual(rp.total, 2); // 无效样例不参与
  const [none, moved] = rp.results;
  assert.strictEqual(none.before, null);
  assert.strictEqual(none.after, null);
  assert.strictEqual(none.unmatchedBefore, true);
  assert.strictEqual(none.unmatchedAfter, true);
  assert.strictEqual(none.changed, false); // 前后都无匹配不算“命中改变”
  assert.strictEqual(moved.changed, true);
  assert.strictEqual(rp.unmatchedBefore, 1);
  assert.strictEqual(rp.unmatchedAfter, 1);
});

check('samples: 不传 samples 时响应不含相关字段（向后兼容）', () => {
  const res = analyze([{ method: 'GET', path: '/a' }]);
  assert.strictEqual('samples' in res, false);
  assert.strictEqual('sampleReplay' in res.fixPlan, false);
  const res2 = analyze([{ method: 'GET', path: '/a' }], { samples: [] });
  assert.strictEqual(res2.samples.total, 0);
  assert.strictEqual('sampleReplay' in res2.fixPlan, false);
});

// ---------- 版本差异审计（baselineRules / diff） ----------
check('diff: 完全相同的两版规则行为一致', () => {
  const rules = [
    { method: 'GET', path: '/api/*' },
    { method: 'GET', path: '/api/users/:id' },
  ];
  const res = analyze(rules, { baselineRules: rules.map((r) => ({ ...r })) });
  assert.strictEqual(res.diff.identical, true);
  assert.strictEqual(res.diff.truncated, false);
  assert.strictEqual(res.diff.summary.total, 0);
  assert.deepStrictEqual(res.diff.classes, []);
  assert.strictEqual(res.diff.baseline.total, 2);
  assert.strictEqual(res.diff.baseline.validCount, 2);
});

check('diff: 内容相同但顺序不同也视为一致（命中规则按方法+路径判定）', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/a' },
      { method: 'GET', path: '/b' },
    ],
    {
      baselineRules: [
        { method: 'GET', path: '/b' },
        { method: 'GET', path: '/a' },
      ],
    }
  );
  assert.strictEqual(res.diff.identical, true);
});

check('diff: 新增规则产生新增覆盖，见证为最短具体方法与路径', () => {
  const res = analyze([{ method: 'GET', path: '/new/:id' }], { baselineRules: [] });
  assert.strictEqual(res.diff.summary.added, 1);
  assert.strictEqual(res.diff.summary.total, 1);
  const c = res.diff.classes[0];
  assert.strictEqual(c.kind, 'added');
  assert.strictEqual(c.baseline, null);
  assert.strictEqual(c.current.index, 0);
  assert.strictEqual(c.witness.text, 'GET /new/a');
});

check('diff: 删除规则产生丢失覆盖，通配符零段匹配给出更短见证', () => {
  const res = analyze([], { baselineRules: [{ method: 'GET', path: '/old/*' }] });
  assert.strictEqual(res.diff.summary.lost, 1);
  const c = res.diff.classes[0];
  assert.strictEqual(c.kind, 'lost');
  assert.strictEqual(c.current, null);
  assert.strictEqual(c.baseline.index, 0);
  assert.strictEqual(c.witness.text, 'GET /old'); // * 匹配零段，/old 即命中
});

check('diff: 命中迁移给出迁移双方与最短见证', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/api/users/:id' },
      { method: 'GET', path: '/api/*' },
    ],
    { baselineRules: [{ method: 'GET', path: '/api/*' }] }
  );
  assert.strictEqual(res.diff.summary.migrated, 1);
  assert.strictEqual(res.diff.summary.total, 1);
  const c = res.diff.classes[0];
  assert.strictEqual(c.kind, 'migrated');
  assert.strictEqual(c.baseline.index, 0);
  assert.strictEqual(c.baseline.path, '/api/*');
  assert.strictEqual(c.current.index, 0);
  assert.strictEqual(c.current.path, '/api/users/:id');
  assert.strictEqual(c.witness.text, 'GET /api/users/a');
});

check('diff: 非字面量代表段——基线 /a、当前 /:x 时 /b 揭示新增覆盖', () => {
  const res = analyze([{ method: 'GET', path: '/:x' }], {
    baselineRules: [{ method: 'GET', path: '/a' }],
  });
  assert.strictEqual(res.diff.summary.added, 1);
  assert.strictEqual(res.diff.summary.migrated, 1);
  assert.strictEqual(res.diff.summary.total, 2);
  const added = res.diff.classes.find((c) => c.kind === 'added');
  const moved = res.diff.classes.find((c) => c.kind === 'migrated');
  // "a" 本身是字面量，自由段代表值改取 b，否则会漏掉仅经非字面量段可达的差异类
  assert.strictEqual(added.witness.text, 'GET /b');
  assert.strictEqual(moved.witness.text, 'GET /a');
  assert.strictEqual(moved.baseline.path, '/a');
  assert.strictEqual(moved.current.path, '/:x');
});

check('diff: 方法维度——不同方法分别产生新增与丢失', () => {
  const res = analyze([{ method: 'GET', path: '/x' }], {
    baselineRules: [{ method: 'POST', path: '/x' }],
  });
  assert.strictEqual(res.diff.summary.added, 1);
  assert.strictEqual(res.diff.summary.lost, 1);
  const added = res.diff.classes.find((c) => c.kind === 'added');
  const lost = res.diff.classes.find((c) => c.kind === 'lost');
  assert.strictEqual(added.witness.text, 'GET /x');
  assert.strictEqual(lost.witness.text, 'POST /x');
});

check('diff: ALL 规则只产生一个差异类，方法取 METHODS 顺序首个', () => {
  const res = analyze([], { baselineRules: [{ method: 'ALL', path: '/h' }] });
  assert.strictEqual(res.diff.summary.lost, 1);
  assert.strictEqual(res.diff.summary.total, 1);
  assert.strictEqual(res.diff.classes[0].witness.text, 'GET /h');
});

check('diff: 根路径可作为最短见证', () => {
  const res = analyze([], { baselineRules: [{ method: 'GET', path: '/' }] });
  assert.strictEqual(res.diff.classes[0].witness.text, 'GET /');
});

check('diff: 同一版本内首条命中拆分出的多个空间分别归类', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/:p/static' },
      { method: 'GET', path: '/:p/:q' },
    ],
    { baselineRules: [] }
  );
  assert.strictEqual(res.diff.summary.added, 2);
  const [c0, c1] = res.diff.classes;
  assert.strictEqual(c0.current.path, '/:p/static');
  assert.strictEqual(c0.witness.text, 'GET /a/static');
  assert.strictEqual(c1.current.path, '/:p/:q');
  assert.strictEqual(c1.witness.text, 'GET /a/a');
});

check('diff: 重复内容规则不产生伪差异', () => {
  const res = analyze([{ method: 'GET', path: '/d' }], {
    baselineRules: [
      { method: 'GET', path: '/d' },
      { method: 'GET', path: '/d' },
    ],
  });
  assert.strictEqual(res.diff.identical, true);
});

check('diff: 基线含无效规则时忽略并如实报告', () => {
  const res = analyze([], {
    baselineRules: [
      { method: 'GET', path: 'bad' },
      { method: 'GET', path: '/ok' },
    ],
  });
  assert.strictEqual(res.diff.baseline.total, 2);
  assert.strictEqual(res.diff.baseline.validCount, 1);
  assert.strictEqual(res.diff.baseline.invalid.length, 1);
  assert.strictEqual(res.diff.baseline.invalid[0].index, 0);
  assert.strictEqual(res.diff.summary.lost, 1);
  assert.strictEqual(res.diff.classes[0].witness.text, 'GET /ok');
});

check('diff: 当前表的无效规则不参与命中', () => {
  const res = analyze(
    [
      { method: 'GET', path: 'bad' },
      { method: 'GET', path: '/ok' },
    ],
    { baselineRules: [] }
  );
  assert.strictEqual(res.diff.summary.added, 1);
  assert.strictEqual(res.diff.classes[0].current.index, 1);
});

check('diff: 确定性——相同输入两次计算结果完全一致', () => {
  const base = [
    { method: 'GET', path: '/api/*' },
    { method: 'ALL', path: '/assets/*' },
    { method: 'POST', path: '/api/users' },
  ];
  const curr = [
    { method: 'GET', path: '/api/users/:id' },
    { method: 'GET', path: '/api/*' },
    { method: 'GET', path: '/assets/css/*' },
  ];
  const d1 = analyze(curr, { baselineRules: base }).diff;
  const d2 = analyze(curr, { baselineRules: base }).diff;
  assert.deepStrictEqual(d1, d2);
  // 迁移：/api/users/:id 提升、/assets/css/* 新增；丢失：POST /api/users、部分 /assets/*
  assert.strictEqual(d1.summary.migrated, 2);
  assert.strictEqual(d1.summary.lost, 2);
  assert.strictEqual(d1.summary.added, 0);
  assert.strictEqual(d1.summary.total, 4);
});

check('diff: 不传 baselineRules 时响应不含 diff（向后兼容）', () => {
  const res = analyze([{ method: 'GET', path: '/a' }]);
  assert.strictEqual('diff' in res, false);
  const res2 = analyze([{ method: 'GET', path: '/a' }], { samples: ['GET /a'] });
  assert.strictEqual('diff' in res2, false);
});

check('diff: 与 samples 可同时使用，互不影响', () => {
  const res = analyze([{ method: 'GET', path: '/a' }], {
    samples: ['GET /a'],
    baselineRules: [],
  });
  assert.strictEqual(res.samples.results[0].hit.index, 0);
  assert.strictEqual(res.diff.summary.added, 1);
  assert.ok(res.fixPlan); // fixPlan 照常计算
});

// ---------- 路由行为契约（contracts，全空间验证） ----------
check('contracts: 契约成立时不产生反例', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/api/users/:id' },
      { method: 'GET', path: '/api/*' },
    ],
    { contracts: ['GET /api/users/:id -> #1'] }
  );
  const c = res.contracts;
  assert.strictEqual(c.total, 1);
  assert.strictEqual(c.pass, 1);
  assert.strictEqual(c.fail, 0);
  assert.strictEqual(c.invalid, 0);
  assert.strictEqual(c.results[0].status, 'pass');
  assert.strictEqual(c.results[0].counterexample, null);
  assert.strictEqual(c.results[0].expected.kind, 'hit');
  assert.strictEqual(c.results[0].expected.rule.path, '/api/users/:id');
});

check('contracts: 高优先级遮蔽时给出确定性最短反例与实际命中', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/api/*' },
      { method: 'GET', path: '/api/users/:id' },
    ],
    { contracts: ['GET /api/users/:id -> #2'] }
  );
  const r = res.contracts.results[0];
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.counterexample.text, 'GET /api/users/a');
  assert.strictEqual(r.counterexample.actualHit.index, 0);
  assert.strictEqual(r.counterexample.actualHit.path, '/api/*');
});

check('contracts: 通配符零段匹配给出更短反例', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/api/*' },
      { method: 'GET', path: '/api/users/*' },
    ],
    { contracts: ['GET /api/users/* -> #2'] }
  );
  const r = res.contracts.results[0];
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.counterexample.text, 'GET /api/users'); // * 零段
  assert.strictEqual(r.counterexample.actualHit.index, 0);
});

check('contracts: 应无匹配——规则只覆盖部分契约空间时最短命中即反例', () => {
  // 契约空间 /api/users/* 包含 /api/users（零段，无命中）与 /api/users/<任意>；
  // :id 命中全部单段点，故“应无匹配”不成立，最短反例为自由段 /api/users/a
  const res = analyze(
    [
      { method: 'GET', path: '/api/users/:id' },
      { method: 'GET', path: '/api/users/posts' },
    ],
    { contracts: ['GET /api/users/* -> none'] }
  );
  assert.strictEqual(res.contracts.results[0].status, 'fail');
  assert.strictEqual(res.contracts.results[0].counterexample.text, 'GET /api/users/a');
  assert.strictEqual(res.contracts.results[0].counterexample.actualHit.index, 0);
});

check('contracts: 应无匹配——任何点都不命中时成立（有限样例会漏掉的中间段）', () => {
  // 有限样例若只试 /a/c 会误判无匹配；全空间必须枚举 /a/<任意段>/c 等
  const res = analyze(
    [{ method: 'GET', path: '/a/x/c' }],
    { contracts: ['GET /a/:p/c -> none'] }
  );
  assert.strictEqual(res.contracts.results[0].status, 'fail');
  assert.strictEqual(res.contracts.results[0].counterexample.text, 'GET /a/x/c');
});

check('contracts: 应无匹配且整个空间确实无规则命中时成立', () => {
  const res = analyze(
    [{ method: 'GET', path: '/only-get' }],
    { contracts: ['DELETE /only-get -> none', 'GET /other/* -> none'] }
  );
  assert.strictEqual(res.contracts.pass, 2);
});

check('contracts: 方法不兼容时期望命中必失败，反例为最短具体路径', () => {
  const res = analyze(
    [{ method: 'POST', path: '/x/:id' }],
    { contracts: ['GET /x/:id -> #1'] }
  );
  const r = res.contracts.results[0];
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.counterexample.text, 'GET /x/a');
  assert.strictEqual(r.counterexample.actualHit, null);
});

check('contracts: ALL 规则以契约方法参与命中', () => {
  const res = analyze(
    [{ method: 'ALL', path: '/x/*' }],
    { contracts: ['DELETE /x/:id -> #1'] }
  );
  assert.strictEqual(res.contracts.results[0].status, 'pass');
});

check('contracts: 根路径契约', () => {
  const ok = analyze(
    [{ method: 'GET', path: '/' }],
    { contracts: ['GET / -> #1'] }
  );
  assert.strictEqual(ok.contracts.results[0].status, 'pass');
  const none = analyze(
    [{ method: 'GET', path: '/' }],
    { contracts: ['GET / -> none'] }
  );
  assert.strictEqual(none.contracts.results[0].status, 'fail');
  assert.strictEqual(none.contracts.results[0].counterexample.text, 'GET /');
  assert.strictEqual(none.contracts.results[0].counterexample.actualHit.index, 0);
});

check('contracts: 非字面量代表段——参数规则暴露于非字面量点（a 是字面量时改取 b）', () => {
  // 规则：GET /a（字面量优先）+ GET /:p（覆盖全部单段）。契约要求无匹配：
  // /:p 空间最短命中点为 /a（实际命中 #1）；/b 仅经非字面量段命中 #2 /:p，
  // 若字母表缺少非字面量代表值就会漏检该反例
  const res = analyze(
    [
      { method: 'GET', path: '/a' },
      { method: 'GET', path: '/:p' },
    ],
    { contracts: ['GET /:p -> none', 'GET /b -> none'] }
  );
  assert.strictEqual(res.contracts.results[0].counterexample.text, 'GET /a');
  assert.strictEqual(res.contracts.results[0].counterexample.actualHit.index, 0);
  assert.strictEqual(res.contracts.results[1].counterexample.text, 'GET /b');
  assert.strictEqual(res.contracts.results[1].counterexample.actualHit.index, 1);
});

check('contracts: 无效契约逐条提示且不参与验证', () => {
  const res = analyze(
    [{ method: 'GET', path: '/a' }],
    {
      contracts: [
        'ALL /a -> #1',            // 方法必须具体
        'GET /a -> #9',            // 目标规则不存在
        'GET /a -> maybe',         // 期望非法
        'GET bad -> #1',           // 路径语法错误
        'GET /a',                  // 缺少期望
        '',                        // 空白行跳过
        { method: 'GET', path: '/a', expect: 'none' }, // 对象形式有效
      ],
    }
  );
  const c = res.contracts;
  assert.strictEqual(c.total, 6); // 空白行不计
  assert.strictEqual(c.invalid, 5);
  assert.strictEqual(c.validCount, 1);
  assert.strictEqual(c.pass, 0); // /a 空间有规则命中，none 期望失败
  assert.strictEqual(c.fail, 1);
  assert.strictEqual(c.results[0].errors.join('').includes('具体方法'), true);
  assert.strictEqual(c.results[1].errors.join('').includes('不存在'), true);
  assert.strictEqual(c.results[2].errors.join('').includes('期望格式非法'), true);
  assert.strictEqual(c.results[3].errors.join('').includes('/ 开头'), true);
  assert.strictEqual(c.results[4].errors.join('').includes('缺少期望'), true);
  // 路径含空白只报一次，不重复
  const whitespace = analyze(
    [{ method: 'GET', path: '/a' }],
    { contracts: ['GET /a/b c -> none'] }
  );
  assert.strictEqual(whitespace.contracts.results[0].valid, false);
  assert.strictEqual(whitespace.contracts.results[0].errors.length, 1);
  // 箭头变体 => 与中文“无匹配”同样可用
  const arrows = analyze(
    [{ method: 'GET', path: '/a' }],
    { contracts: ['GET /a => 无匹配', 'GET /a => #1'] }
  );
  assert.strictEqual(arrows.contracts.results[0].valid, true);
  assert.strictEqual(arrows.contracts.results[1].valid, true);
});

check('contracts: 对象形式契约（0-based ruleIndex），并兼容中文“无匹配”', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/a' },
      { method: 'GET', path: '/b' },
    ],
    {
      contracts: [
        { method: 'get', path: '/a', expect: 'hit', ruleIndex: 0 },
        'GET /b -> 无匹配',
      ],
    }
  );
  assert.strictEqual(res.contracts.results[0].status, 'pass');
  assert.strictEqual(res.contracts.results[1].status, 'fail');
  assert.strictEqual(res.contracts.results[1].counterexample.text, 'GET /b');
});

check('contracts: 命中“别的”规则也算违反', () => {
  const res = analyze(
    [
      { method: 'GET', path: '/a' },
      { method: 'GET', path: '/:p' },
    ],
    { contracts: ['GET /a -> #2'] }
  );
  const r = res.contracts.results[0];
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.counterexample.text, 'GET /a');
  assert.strictEqual(r.counterexample.actualHit.index, 0);
});

check('contracts: 不传 contracts 时响应不含该字段（向后兼容）', () => {
  const res = analyze([{ method: 'GET', path: '/a' }]);
  assert.strictEqual('contracts' in res, false);
  const res2 = analyze([{ method: 'GET', path: '/a' }], { contracts: [] });
  assert.strictEqual(res2.contracts.total, 0);
});

check('contracts: 确定性——同一输入多次计算反例一致', () => {
  const rules = [
    { method: 'GET', path: '/*' },
    { method: 'GET', path: '/api/*' },
    { method: 'GET', path: '/api/users/:id' },
  ];
  const a = analyze(rules, { contracts: ['GET /api/users/:id -> #3'] }).contracts;
  const b = analyze(rules, { contracts: ['GET /api/users/:id -> #3'] }).contracts;
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.results[0].counterexample.text, 'GET /api/users/a');
});


console.log(`\n全部 ${passed} 个测试通过。`);
