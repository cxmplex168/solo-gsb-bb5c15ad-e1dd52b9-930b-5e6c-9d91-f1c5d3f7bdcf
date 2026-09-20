'use strict';

const path = require('path');
const express = require('express');
const { analyze } = require('./lib/analyzer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /api/analyze
 * body: { rules: [{ method: string, path: string }],
 *         samples?: ["METHOD /path" | { method, path }],
 *         baselineRules?: [{ method: string, path: string }] }
 * 规则在数组中的顺序即优先级（索引 0 最先匹配）。
 * samples 可选：逐行“方法 路径”的真实请求样例，用于请求行为回归预演
 * （首条命中计算 + 修复方案前后对比）。
 * baselineRules 可选：基线路由表（旧版本规则），携带时按首条命中语义
 * 与当前规则表做全空间版本差异审计，响应附带 diff 字段。
 * contracts 可选：路由行为契约数组（字符串行或 { method, path, expect, ruleIndex }
 * 对象），携带时在契约覆盖的整个请求空间上验证当前优先级，响应附带 contracts 字段；
 * 其中有效的命中型契约还会并入 fixPlan 的同一约束图（见 analyzer.buildFixPlan），
 * 目标不全覆盖 / none 空间已命中 / 合并后成环时 fixPlan.feasible=false 且不返回顺序。
 */
app.post('/api/analyze', (req, res) => {
  const body = req.body || {};
  const rules = body.rules;
  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: '请求体必须为 { rules: [...] }' });
  }
  if (rules.length > 500) {
    return res.status(400).json({ error: '规则数量不能超过 500 条' });
  }
  const samples = body.samples;
  if (samples !== undefined) {
    if (!Array.isArray(samples)) {
      return res
        .status(400)
        .json({ error: 'samples 必须为数组（每行一个“方法 路径”样例）' });
    }
    if (samples.length > 1000) {
      return res.status(400).json({ error: '请求样例数量不能超过 1000 条' });
    }
  }
  const baselineRules = body.baselineRules;
  if (baselineRules !== undefined) {
    if (!Array.isArray(baselineRules)) {
      return res
        .status(400)
        .json({ error: 'baselineRules 必须为数组（基线路由表）' });
    }
    if (baselineRules.length > 500) {
      return res.status(400).json({ error: '基线规则数量不能超过 500 条' });
    }
  }
  const contracts = body.contracts;
  if (contracts !== undefined) {
    if (!Array.isArray(contracts)) {
      return res
        .status(400)
        .json({ error: 'contracts 必须为数组（每条一个路由行为契约）' });
    }
    if (contracts.length > 200) {
      return res.status(400).json({ error: '契约数量不能超过 200 条' });
    }
    const bad = contracts.find(
      (c) =>
        c !== null &&
        c !== undefined &&
        typeof c !== 'string' &&
        (typeof c !== 'object' || Array.isArray(c))
    );
    if (bad) {
      return res
        .status(400)
        .json({ error: '契约必须是字符串行（“方法 路径模式 -> #序号/none”）或对象' });
    }
  }
  res.json(analyze(rules, { samples, baselineRules, contracts }));
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`路由冲突实验室已启动: http://localhost:${PORT}`);
});
