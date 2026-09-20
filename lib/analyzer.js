'use strict';

/*
 * 路由冲突分析引擎（纯函数，Node 与浏览器均可使用）
 *
 * 规则路径由若干“段”组成：
 *   - 静态段：字面匹配单个非空段
 *   - :参数  ：匹配任意一个非空段
 *   - *     ：匹配零个或多个任意段
 *
 * 每条路径模式被建模成一个带 ε 边的 NFA：
 *   静态段 / :参数  -> 消耗一个段的普通边
 *   *              -> ε 边（匹配零段）+ 消耗一个任意段且仍停留在 * 的自环 + ε 边到下一位置
 *
 * 对两个模式做“乘积 DFA”（子集构造，状态用 BigInt 位掩码），
 * 从而判定：
 *   - 完全遮蔽：L(A) ⊇ L(B)
 *   - 部分重叠：L(A) ∩ L(B) ≠ ∅
 * 并在两个模式的乘积自动机上按“段数最少、并列时字典序最小”搜索
 * 同时命中的具体示例路径。
 *
 * 具体段取值约定：自由段（参数或通配符产生的段）固定使用 "a"，
 * 这是约定的最小自由段值，因此最短并列时得到确定的字典序最小答案。
 */

const OTHER = '__OTHER__';
const FREE_VALUE = 'a'; // 自由段的最小值约定
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** 解析路径字符串为段 token 数组。根路径 "/" -> [] */
function parsePath(path) {
  if (typeof path !== 'string') {
    return { error: '路径必须是字符串', tokens: null };
  }
  if (path.length === 0 || path[0] !== '/') {
    return { error: '路径必须以 / 开头', tokens: null };
  }
  if (path === '/') return { tokens: [] };
  if (path.length > 1 && path[path.length - 1] === '/') {
    return { error: '路径不能以 / 结尾（根路径除外）', tokens: null };
  }
  const segments = path.split('/').slice(1);
  const tokens = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length === 0) {
      return { error: `第 ${i + 1} 段为空（不允许连续的 /）`, tokens: null };
    }
    if (seg === '*') {
      tokens.push({ type: 'wildcard', raw: seg });
    } else if (seg[0] === ':') {
      const name = seg.slice(1);
      if (name.length === 0) {
        return { error: `第 ${i + 1} 段的参数名不能为空`, tokens: null };
      }
      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        return {
          error: `第 ${i + 1} 段参数名 :${name} 非法（仅允许字母、数字、下划线）`,
          tokens: null,
        };
      }
      tokens.push({ type: 'param', name, raw: seg });
    } else {
      if (seg.indexOf('*') !== -1) {
        return { error: `第 ${i + 1} 段 "${seg}" 中的 * 必须独占整段`, tokens: null };
      }
      tokens.push({ type: 'literal', value: seg, raw: seg });
    }
  }
  return { tokens };
}

/** ε-闭包：从一组 NFA 位置（BigInt 位掩码）出发，沿 ε 边可达的全部位置 */
function epsilonClosure(tokens, mask) {
  const n = tokens.length;
  let changed = true;
  // * 位于位置 i 时：i --ε--> i+1（通配符匹配零段），
  // 且消耗一个段的自环 i->i 由 step 处理。闭包按位置从小到大传播即可达到不动点。
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (tokens[i].type === 'wildcard') {
        const bit = 1n << BigInt(i);
        const next = 1n << BigInt(i + 1);
        if ((mask & bit) !== 0n && (mask & next) === 0n) {
          mask |= next;
          changed = true;
        }
      }
    }
  }
  return mask;
}

/** 一个 DFA 状态（NFA 位置集合）在消耗一个具体段后的转移 */
function subsetStep(tokens, mask, letter) {
  const n = tokens.length;
  let next = 0n;
  for (let i = 0; i <= n; i++) {
    if ((mask & (1n << BigInt(i))) === 0n) continue;
    if (i < n) {
      const t = tokens[i];
      if (t.type === 'literal') {
        if (letter === t.value) next |= 1n << BigInt(i + 1);
      } else if (t.type === 'param') {
        next |= 1n << BigInt(i + 1);
      } else {
        // * 的消耗自环：吃掉一个任意段后仍停留在位置 i
        next |= 1n << BigInt(i);
      }
    }
  }
  return next === 0n ? 0n : epsilonClosure(tokens, next);
}

/**
 * 构造模式的惰性 DFA。
 *   step(mask, letter)：带缓存的子集转移
 *   accepts(mask)     ：集合中是否含接受位置 n
 *   start             ：起始状态（ε-闭包({0})）
 */
function buildDFA(tokens) {
  const n = tokens.length;
  const acceptBit = 1n << BigInt(n);
  const start = epsilonClosure(tokens, 1n);
  const cache = new Map();

  function step(mask, letter) {
    let byLetter = cache.get(mask);
    if (!byLetter) {
      byLetter = new Map();
      cache.set(mask, byLetter);
    }
    let res = byLetter.get(letter);
    if (res === undefined) {
      res = subsetStep(tokens, mask, letter);
      byLetter.set(letter, res);
    }
    return res;
  }

  return {
    tokens,
    n,
    start,
    step,
    accepts: (mask) => (mask & acceptBit) !== 0n,
  };
}

/** 收集模式中出现的所有静态字面量 */
function literalsOf(tokens) {
  const set = new Set();
  for (const t of tokens) {
    if (t.type === 'literal') set.add(t.value);
  }
  return set;
}

/**
 * 判定 L(A) 是否覆盖 L(B)（即 A 是否遮蔽 B）。
 * 对两个 DFA 做乘积可达性搜索：
 * 若存在可达状态 (a, b) 满足 B 接受而 A 不接受，则不覆盖。
 * 字母表 = 两个模式的全部字面量 + OTHER（代表任何其他段值）。
 */
function covers(dfaA, dfaB) {
  const alphabet = new Set([OTHER]);
  for (const v of literalsOf(dfaA.tokens)) alphabet.add(v);
  for (const v of literalsOf(dfaB.tokens)) alphabet.add(v);
  const letters = [...alphabet];

  const seen = new Set();
  const stack = [[dfaA.start, dfaB.start]];
  while (stack.length) {
    const [ma, mb] = stack.pop();
    const key = `${ma.toString(16)}|${mb.toString(16)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (dfaB.accepts(mb) && !dfaA.accepts(ma)) return false;

    for (const letter of letters) {
      const na = letter === OTHER ? stepOther(dfaA, ma) : dfaA.step(ma, letter);
      const nb = letter === OTHER ? stepOther(dfaB, mb) : dfaB.step(mb, letter);
      if (nb === 0n) continue; // B 不接受该段 -> 此路不在 L(B) 中
      stack.push([na, nb]);
    }
  }
  return true;
}

/** OTHER 字母的转移：把字母当作不匹配任何字面量的段 */
function stepOther(dfa, mask) {
  const n = dfa.n;
  let next = 0n;
  for (let i = 0; i <= n; i++) {
    if ((mask & (1n << BigInt(i))) === 0n) continue;
    if (i < n) {
      const t = dfa.tokens[i];
      if (t.type === 'literal') continue;
      next |= 1n << BigInt(t.type === 'param' ? i + 1 : i);
    }
  }
  return next === 0n ? 0n : epsilonClosure(dfa.tokens, next);
}

/**
 * 在 L(A) ∩ L(B) 中搜索“段数最少、并列字典序最小”的段序列。
 * 乘积 DFA 上按长度做 BFS；同一层的边按字母升序处理，
 * 每个乘积状态仅保留第一条到达路径，因此首个到达的接受状态即答案。
 */
function shortestIntersectionWord(dfaA, dfaB) {
  const alphabet = new Set([FREE_VALUE]);
  for (const v of literalsOf(dfaA.tokens)) alphabet.add(v);
  for (const v of literalsOf(dfaB.tokens)) alphabet.add(v);
  // 字典序：UTF-16 码元升序（即 JavaScript 原生字符串比较）
  const letters = [...alphabet].sort();

  const seen = new Set();
  let frontier = [{ a: dfaA.start, b: dfaB.start, word: '' }];

  for (let depth = 0; frontier.length; depth++) {
    // 同层按已有单词字典序处理，保证同深度下先访问字典序更小的状态
    frontier.sort((x, y) => (x.word < y.word ? -1 : x.word > y.word ? 1 : 0));
    const nextFrontier = [];
    for (const state of frontier) {
      const key = `${state.a.toString(16)}|${state.b.toString(16)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (dfaA.accepts(state.a) && dfaB.accepts(state.b)) {
        return depth === 0 ? '/' : state.word;
      }

      for (const letter of letters) {
        const na = dfaA.step(state.a, letter);
        const nb = dfaB.step(state.b, letter);
        if (na === 0n || nb === 0n) continue;
        const nk = `${na.toString(16)}|${nb.toString(16)}`;
        if (seen.has(nk)) continue;
        nextFrontier.push({
          a: na,
          b: nb,
          word: state.word === '' ? `/${letter}` : `${state.word}/${letter}`,
        });
      }
    }
    // 同层可能经不同单词到达同一状态：去重，保留字典序最小的单词
    const byKey = new Map();
    for (const st of nextFrontier) {
      const k = `${st.a.toString(16)}|${st.b.toString(16)}`;
      const prev = byKey.get(k);
      if (!prev || st.word < prev.word) byKey.set(k, st);
    }
    frontier = [...byKey.values()];
  }
  return null;
}

/** 规范化请求方法；非法时返回 null */
function normalizeMethod(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toUpperCase();
  if (m === 'ALL' || m === '*') return 'ALL';
  if (METHODS.includes(m)) return m;
  return null;
}

/** 规范化样例方法：真实请求必须是具体方法（ALL/* 不是合法的样例方法） */
function normalizeSampleMethod(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toUpperCase();
  return METHODS.includes(m) ? m : null;
}

/**
 * 解析一条请求样例（“方法 路径”行字符串或 { method, path } 对象）。
 * 样例路径必须是具体路径：不允许 :参数 与 * 通配符，也不允许空白字符。
 * 返回 { methodRaw, pathRaw, method, segments, errors }。
 */
function parseSample(raw) {
  let methodRaw = '';
  let pathRaw = '';
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    methodRaw = m && m[1] ? m[1] : '';
    pathRaw = m && typeof m[2] === 'string' ? m[2].trim() : '';
  } else if (raw && typeof raw === 'object') {
    methodRaw = typeof raw.method === 'string' ? raw.method.trim() : '';
    pathRaw = typeof raw.path === 'string' ? raw.path.trim() : '';
  }

  const errors = [];
  const method = normalizeSampleMethod(methodRaw);
  if (!method) {
    errors.push(`请求方法非法（样例须为具体方法：${METHODS.join(' / ')}）`);
  }

  let segments = null;
  if (pathRaw === '') {
    errors.push('缺少路径（每行格式：方法 路径）');
  } else if (/\s/.test(pathRaw)) {
    errors.push('路径中不允许出现空白字符（每行格式：方法 路径）');
  } else {
    const parsed = parsePath(pathRaw);
    if (parsed.error) {
      errors.push(parsed.error);
    } else {
      const bad = parsed.tokens.findIndex((t) => t.type !== 'literal');
      if (bad === -1) {
        segments = parsed.tokens.map((t) => t.value);
      } else {
        const t = parsed.tokens[bad];
        errors.push(
          t.type === 'wildcard'
            ? `第 ${bad + 1} 段不允许使用通配符 *（请求样例必须是具体路径）`
            : `第 ${bad + 1} 段不允许使用参数 ${t.raw}（请求样例必须是具体路径）`
        );
      }
    }
  }

  return {
    methodRaw: methodRaw.toUpperCase(),
    pathRaw,
    method,
    segments,
    errors,
  };
}

/** 判断模式 DFA 是否接受一个具体段序列（逐段转移，最后检查接受态） */
function matchesConcrete(dfa, segments) {
  let mask = dfa.start;
  for (const seg of segments) {
    mask = dfa.step(mask, seg);
    if (mask === 0n) return false;
  }
  return dfa.accepts(mask);
}

/**
 * 按优先级（compiled 数组顺序）返回首条命中规则的原始索引；无命中返回 null。
 * 方法兼容语义与冲突分析一致：规则为 ALL 或与样例方法相同即可命中。
 */
function firstHitIndex(compiled, method, segments) {
  for (const r of compiled) {
    if (!r.valid) continue;
    if (r.method !== 'ALL' && r.method !== method) continue;
    if (matchesConcrete(r.dfa, segments)) return r.index;
  }
  return null;
}

/**
 * 编译请求样例：逐条解析校验。空白行与 null/undefined 被跳过，
 * 结果保留原始行号（1-based），顺序与输入一致。
 */
function compileSamples(rawSamples) {
  const items = [];
  for (let i = 0; i < rawSamples.length; i++) {
    const raw = rawSamples[i];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const p = parseSample(raw);
    items.push({
      line: i + 1,
      input:
        typeof raw === 'string'
          ? raw.trim()
          : `${p.methodRaw} ${p.pathRaw}`.trim(),
      methodRaw: p.methodRaw,
      pathRaw: p.pathRaw,
      method: p.method,
      segments: p.segments,
      errors: p.errors,
    });
  }
  return items;
}

/**
 * 请求行为回归预演：对编译后的样例按当前优先级计算首条命中规则。
 * 返回可序列化结果（按输入顺序，含原始行号；hit 为 null 表示无匹配）。
 */
function evaluateSamples(compiled, items) {
  let validCount = 0;
  let unmatched = 0;
  const results = items.map((s, idx) => {
    const valid = s.errors.length === 0;
    let hit = null;
    if (valid) {
      validCount++;
      const hitIdx = firstHitIndex(compiled, s.method, s.segments);
      if (hitIdx === null) unmatched++;
      else hit = ruleRef(compiled, hitIdx);
    }
    return {
      index: idx,
      line: s.line,
      input: s.input,
      method: s.methodRaw,
      path: s.pathRaw,
      valid,
      errors: s.errors,
      hit,
    };
  });
  return { total: results.length, validCount, unmatched, results };
}

/**
 * 修复方案中的样例对比：同一批样例分别在当前顺序与建议顺序下计算首条命中，
 * 逐条标出命中规则改变、原本无匹配、调整后无匹配的请求。
 * after.index 为规则的原始索引，afterPosition 为建议顺序中的位置（1-based）。
 */
function replaySamples(compiled, order, items) {
  const reordered = order.map((idx) => compiled[idx]);
  const newPosOf = new Array(compiled.length).fill(-1);
  order.forEach((origIdx, pos) => {
    newPosOf[origIdx] = pos;
  });

  const results = [];
  let changed = 0;
  let unmatchedBefore = 0;
  let unmatchedAfter = 0;
  items.forEach((s, idx) => {
    if (s.errors.length > 0) return; // 无效样例不参与对比
    const beforeIdx = firstHitIndex(compiled, s.method, s.segments);
    const afterIdx = firstHitIndex(reordered, s.method, s.segments);
    const isChanged = beforeIdx !== afterIdx;
    const ub = beforeIdx === null;
    const ua = afterIdx === null;
    if (isChanged) changed++;
    if (ub) unmatchedBefore++;
    if (ua) unmatchedAfter++;
    results.push({
      index: idx,
      line: s.line,
      input: s.input,
      before: beforeIdx === null ? null : ruleRef(compiled, beforeIdx),
      after: afterIdx === null ? null : ruleRef(compiled, afterIdx),
      afterPosition: afterIdx === null ? null : newPosOf[afterIdx] + 1,
      changed: isChanged,
      unmatchedBefore: ub,
      unmatchedAfter: ua,
    });
  });
  return {
    total: results.length,
    changed,
    unmatchedBefore,
    unmatchedAfter,
    results,
  };
}

/** 编译规则表：逐条校验方法/路径并构建 DFA；当前规则与基线规则共用 */
function compileRules(rawRules) {
  const rules = Array.isArray(rawRules) ? rawRules : [];
  const compiled = [];
  let validCount = 0;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] || {};
    const method = normalizeMethod(r.method);
    const parsed = parsePath(r.path);
    const errors = [];
    if (!method) errors.push('请求方法非法');
    if (parsed.error) errors.push(parsed.error);

    const ok = errors.length === 0;
    compiled.push({
      index: i,
      id: r.id ?? i,
      methodRaw: typeof r.method === 'string' ? r.method.trim().toUpperCase() : '',
      method: ok ? method : null,
      path: typeof r.path === 'string' ? r.path : '',
      tokens: ok ? parsed.tokens : null,
      dfa: ok ? buildDFA(parsed.tokens) : null,
      valid: ok,
      errors,
    });
    if (ok) validCount++;
  }
  return { compiled, validCount, total: rules.length };
}

/* ---------------- 路由行为契约（全空间首条命中验证） ---------------- */

/** 单条契约联合乘积 BFS 的状态数安全上限（防止病态规则集失控） */
const MAX_CONTRACT_STATES = 50000;

/**
 * 编译契约表：逐条校验方法 / 路径模式 / 期望，契约路径模式构建 DFA。
 * 规则表长度 ruleCount 用于校验「应由 #N 首条命中」的规则序号是否存在。
 * 空白字符串行与 null/undefined 被跳过（保留 1-based 行号，与 samples 一致）。
 *
 * 两种输入形式：
 *   - 字符串行："METHOD /path/-> #3" 或 "METHOD /path/* -> none"
 *     （箭头支持 -> 与 =>；none 不区分大小写，也接受中文“无匹配”）
 *   - 对象：{ method, path, expect: 'hit', ruleIndex }（ruleIndex 为 0-based）
 *          或 { method, path, expect: 'none' }
 */
function compileContracts(rawContracts, ruleCount) {
  const items = [];
  const arr = Array.isArray(rawContracts) ? rawContracts : [];
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (raw === null || raw === undefined) continue;

    const errors = [];
    let methodRaw = '';
    let pathRaw = '';
    let expect = null; // 'hit'（指定规则首条命中）| 'none'（无匹配）
    let ruleIndex = null;

    if (typeof raw === 'string') {
      const line = raw.trim();
      if (line === '') continue;
      const head = line.match(/^(\S+)\s+([\s\S]*)$/);
      if (!head) {
        errors.push(
          '契约格式错误：每行应为「方法 路径模式 -> #序号」或「方法 路径模式 -> none」'
        );
      } else {
        methodRaw = head[1];
        const rest = head[2].trim();
        // 显式拆分箭头，避免「路径含空白且又缺少箭头」时把尾部误吞为路径的一部分
        const arrow = rest.match(/^(.*?)\s*(?:->|=>)\s*([\s\S]*)$/);
        if (!arrow) {
          pathRaw = rest.split(/\s+/)[0] || '';
          errors.push(
            '缺少期望：在路径模式后添加「-> #序号」（应由该规则首条命中）或「-> none」（应无匹配）'
          );
        } else {
          pathRaw = arrow[1].trim();
          if (/\s/.test(pathRaw)) {
            errors.push(
              '路径中不允许出现空白字符；每行格式为「方法 路径模式 -> #序号」或「方法 路径模式 -> none」'
            );
          } else {
            const token = arrow[2].trim();
            if (token === '') {
              errors.push('期望不能为空：使用「-> #序号」（如 -> #3）或「-> none」');
            } else if (/^none$/i.test(token) || token === '无匹配') {
              expect = 'none';
            } else {
              const hm = token.match(/^#(\d+)$/);
              if (!hm) {
                errors.push('期望格式非法：使用「-> #序号」（如 -> #3）或「-> none」');
              } else if (Number(hm[1]) < 1) {
                errors.push('期望规则序号必须从 1 开始（如 -> #1）');
              } else {
                expect = 'hit';
                ruleIndex = Number(hm[1]) - 1;
              }
            }
          }
        }
      }
    } else if (typeof raw === 'object') {
      methodRaw = typeof raw.method === 'string' ? raw.method.trim() : '';
      pathRaw = typeof raw.path === 'string' ? raw.path.trim() : '';
      if (raw.expect === 'none') {
        expect = 'none';
      } else if (raw.expect === 'hit' || raw.expect === 'first') {
        if (Number.isInteger(raw.ruleIndex)) {
          expect = 'hit';
          ruleIndex = raw.ruleIndex;
        } else {
          errors.push("expect 为 hit 时必须携带整数 ruleIndex（0-based 规则序号）");
        }
      } else {
        errors.push("expect 必须为 'hit'（携带 ruleIndex）或 'none'");
      }
    } else {
      errors.push(
        '契约必须是「方法 路径模式 -> #序号/none」字符串或 { method, path, expect, ruleIndex } 对象'
      );
    }

    // 契约方法必须具体：ALL/* 不是合法的契约方法（契约逐方法成立）
    const method = normalizeSampleMethod(methodRaw);
    if (!method) {
      errors.push(
        `请求方法非法（契约须为具体方法：${METHODS.join(' / ')}，不接受 ALL）`
      );
    }

    let dfa = null;
    if (pathRaw === '') {
      errors.push('缺少路径模式（与规则同语法：静态段 / :参数 / * 通配符）');
    } else if (/\s/.test(pathRaw)) {
      // 字符串行的空白错误已在上方给出；对象形式直接在此给出一次
      if (typeof raw !== 'string') errors.push('路径中不允许出现空白字符');
    } else {
      const parsed = parsePath(pathRaw);
      if (parsed.error) {
        errors.push(parsed.error);
      } else {
        dfa = buildDFA(parsed.tokens);
      }
    }

    if (expect === 'hit' && (!Number.isInteger(ruleIndex) || ruleIndex < 0)) {
      errors.push('期望规则序号非法（序号从 1 开始）');
    } else if (expect === 'hit' && ruleIndex >= ruleCount) {
      errors.push(`期望规则 #${ruleIndex + 1} 不存在：当前规则表共 ${ruleCount} 条规则`);
    }

    const input =
      typeof raw === 'string'
        ? raw.trim()
        : expect === 'hit'
          ? `${methodRaw.toUpperCase()} ${pathRaw} -> #${Number.isInteger(ruleIndex) ? ruleIndex + 1 : '?'}`
          : `${methodRaw.toUpperCase()} ${pathRaw} -> none`;

    items.push({
      line: i + 1,
      input,
      methodRaw: methodRaw.toUpperCase(),
      pathRaw,
      method,
      dfa,
      expect,
      ruleIndex,
      errors,
    });
  }
  return items;
}

/**
 * 构造契约空间联合乘积 BFS 的公共上下文（方法兼容的有效规则 + 字母表）。
 */
function contractSpaceContext(compiled, item) {
  const compatible = compiled.filter(
    (r) => r.valid && (r.method === 'ALL' || r.method === item.method)
  );

  const literals = new Set(literalsOf(item.dfa.tokens));
  for (const r of compatible) {
    for (const v of literalsOf(r.tokens)) literals.add(v);
  }
  const letters = [...literals, freeSegmentValue(literals)].sort();

  const firstHit = (masks) => {
    for (let i = 0; i < compatible.length; i++) {
      if (compatible[i].dfa.accepts(masks[i])) return compatible[i].index;
    }
    return null;
  };
  return { compatible, letters, firstHit };
}

/** 契约见证对象（确定性最短请求 + 当时的首条命中） */
function makeContractWitness(compiled, item, word, hit) {
  const p = word === '' ? '/' : word;
  return {
    method: item.method,
    path: p,
    text: `${item.method} ${p}`,
    actualHit: hit === null ? null : ruleRef(compiled, hit),
  };
}

/**
 * 在契约模式覆盖的请求空间上做联合乘积 BFS，按调用方谓词寻找第一个接受状态。
 *
 * isWanted(hit, masks) 返回 true 的“契约模式接受状态”即答案；按（段数、
 * UTF-16 字典序）展开，首个命中状态即段数最少、同长度字典序最小的见证。
 * 返回：
 *   { status: 'found', word, hit, masks }  谓词首次成立
 *   { status: 'exhausted' }                全空间枚举完毕且谓词从不成立
 *   { status: 'truncated' }                状态数超过安全上限（无法证明）
 */
function searchContractSpace(compiled, item, isWanted) {
  const { compatible, letters, firstHit } = contractSpaceContext(compiled, item);
  const startRules = compatible.map((r) => r.dfa.start);
  const keyOf = (p, rs) =>
    `${p.toString(16)}|${rs.map((m) => m.toString(16)).join(',')}`;

  let frontier = [{ p: item.dfa.start, rs: startRules, word: '' }];
  const seen = new Set([keyOf(item.dfa.start, startRules)]);

  while (frontier.length) {
    // 同层按单词字典序处理：父状态按字典序展开、同层边按字母升序，
    // 经 seen 去重后首个目标状态即段数最少、同长度字典序最小的见证
    frontier.sort((x, y) => (x.word < y.word ? -1 : x.word > y.word ? 1 : 0));
    const next = [];
    let overflow = false;

    for (const st of frontier) {
      if (item.dfa.accepts(st.p)) {
        const hit = firstHit(st.rs);
        if (isWanted(hit, st.rs, compatible)) {
          return { status: 'found', word: st.word, hit, masks: st.rs };
        }
      }

      for (const letter of letters) {
        const np = item.dfa.step(st.p, letter);
        if (np === 0n) continue; // 离开契约模式语言的请求不在契约覆盖空间内
        const nrs = new Array(compatible.length);
        for (let i = 0; i < compatible.length; i++) {
          nrs[i] = st.rs[i] === 0n ? 0n : compatible[i].dfa.step(st.rs[i], letter);
        }
        const key = keyOf(np, nrs);
        if (seen.has(key)) continue;
        if (seen.size >= MAX_CONTRACT_STATES) {
          overflow = true;
          break;
        }
        seen.add(key);
        next.push({
          p: np,
          rs: nrs,
          word: st.word === '' ? `/${letter}` : `${st.word}/${letter}`,
        });
      }
      if (overflow) break;
    }
    if (overflow) return { status: 'truncated' };
    frontier = next;
  }
  return { status: 'exhausted' };
}

/**
 * 在单条契约覆盖的整个请求空间上验证当前优先级。
 *
 * 不是抽样检查：把契约模式 DFA 与全部“方法兼容的有效规则”的 DFA 做联合乘积，
 * 沿契约模式仍然存活（np !== 0）的方向 BFS 遍历全部可达乘积状态——
 * 这恰好枚举 L(契约模式) 内全部具体路径在“段值商集”上的代表：
 * 字母表 = 契约模式与兼容规则的全部字面量 + 一个非字面量代表值
 * （freeSegmentValue），任何非字面量段与代表值的转移行为完全一致。
 *
 * 每个可达且契约模式接受的状态，标签 = 当前优先级下首条命中规则的原始索引
 * （无命中为 null）：
 *   - expect none：标签必须为 null；
 *   - expect hit #k：标签必须恰为 k（目标规则方法不兼容 / 语法无效时永远失败）。
 * 按（段数、UTF-16 字典序）BFS，首个违例状态即确定性反例。
 * 状态数超过 MAX_CONTRACT_STATES 时返回 truncated（无法证明全空间成立，如实标记）。
 */
function verifyContractSpace(compiled, item) {
  const violates = (hit) =>
    item.expect === 'none' ? hit !== null : hit !== item.ruleIndex;
  const res = searchContractSpace(compiled, item, (hit) => violates(hit));
  if (res.status === 'found') {
    return {
      status: 'fail',
      counterexample: makeContractWitness(compiled, item, res.word, res.hit),
    };
  }
  return { status: res.status === 'truncated' ? 'truncated' : 'pass' };
}

/**
 * 契约验证：逐条返回 valid/status/expected/counterexample。
 * 无效契约（status: 'invalid'）逐条携带错误且不参与验证计数。
 */
function verifyContracts(compiled, items) {
  const results = [];
  let validCount = 0;
  let pass = 0;
  let fail = 0;
  let truncatedCount = 0;

  for (const item of items) {
    const row = {
      index: item.line - 1,
      line: item.line,
      input: item.input,
      method: item.methodRaw,
      path: item.pathRaw,
      valid: item.errors.length === 0,
      errors: item.errors,
    };
    if (!row.valid) {
      results.push({
        ...row,
        status: 'invalid',
        expected: null,
        counterexample: null,
      });
      continue;
    }

    validCount++;
    const expected =
      item.expect === 'none'
        ? { kind: 'none' }
        : { kind: 'hit', rule: ruleRef(compiled, item.ruleIndex) };
    const verdict = verifyContractSpace(compiled, item);

    if (verdict.status === 'pass') {
      pass++;
      results.push({ ...row, status: 'pass', expected, counterexample: null });
    } else if (verdict.status === 'truncated') {
      truncatedCount++;
      results.push({ ...row, status: 'truncated', expected, counterexample: null });
    } else {
      fail++;
      results.push({
        ...row,
        status: 'fail',
        expected,
        counterexample: verdict.counterexample,
      });
    }
  }

  return {
    total: results.length,
    validCount,
    invalid: results.length - validCount,
    pass,
    fail,
    truncated: truncatedCount,
    results,
  };
}

/* ---------------- 版本差异审计（首条命中语义的全空间对比） ---------------- */

/** 每种方法下联合乘积 BFS 的状态数安全上限（防止病态规则集失控） */
const MAX_DIFF_STATES = 50000;

/** 规则内容键：命中规则是否“相同”按规范化方法 + 路径判定（与规则位置无关） */
function ruleContentKey(r) {
  return `${r.method} ${r.path}`;
}

/**
 * 自由段代表值：优先使用约定的最小值 "a"；
 * 若 "a" 本身是某条规则的字面量，则必须另选一个非字面量值——
 * 否则“非字面量”这一段值类（OTHER）在字母表中缺失，会漏掉仅经非字面量段
 * 才可达的差异类（例如基线含 /a 而当前含 /:x 时，/b 才能揭示新增覆盖）。
 */
function freeSegmentValue(literals) {
  if (!literals.has(FREE_VALUE)) return FREE_VALUE;
  for (const c of 'bcdefghijklmnopqrstuvwxyz') {
    if (!literals.has(c)) return c;
  }
  for (const c of '0123456789') {
    if (!literals.has(c)) return c;
  }
  let s = FREE_VALUE + FREE_VALUE;
  while (literals.has(s)) s += FREE_VALUE;
  return s;
}

/**
 * 版本差异审计：比较基线规则表与当前规则表的首条命中行为。
 *
 * 不是抽样检查：对每个具体方法，把两侧全部“方法兼容的有效规则”的 DFA
 * 做联合乘积，按（段数、字典序）BFS 遍历全部可达乘积状态。每个状态的
 * 标签 = (基线首条命中规则的内容键, 当前首条命中规则的内容键)；
 * 标签不同的状态即一类行为差异：
 *   - (无, c)  新增覆盖：仅当前版本可命中
 *   - (b, 无)  丢失覆盖：仅基线可命中
 *   - (b, c)   命中迁移：两侧均可命中但命中规则不同
 * 每类记录确定性最短见证：段数最少；并列时方法按 METHODS 顺序、
 * 路径按 UTF-16 字典序最小（自由段取值约定同 shortestIntersectionWord）。
 *
 * 字母表 = 两侧全部字面量 + 一个非字面量代表（freeSegmentValue），
 * 它精确覆盖段值的商集：任何非字面量段与代表值的转移行为完全一致，
 * 因此枚举是完备的而非有限抽样。
 */
function diffRuleSets(baseCompiled, currCompiled) {
  const classes = new Map(); // 类键 -> { bIndex, cIndex, method, path, depth }
  let truncated = false;

  for (let mi = 0; mi < METHODS.length; mi++) {
    const method = METHODS[mi];
    const bRules = [];
    const cRules = [];
    for (const r of baseCompiled) {
      if (r.valid && (r.method === 'ALL' || r.method === method)) bRules.push(r);
    }
    for (const r of currCompiled) {
      if (r.valid && (r.method === 'ALL' || r.method === method)) cRules.push(r);
    }
    if (bRules.length === 0 && cRules.length === 0) continue;

    const literals = new Set();
    for (const r of bRules) for (const v of literalsOf(r.tokens)) literals.add(v);
    for (const r of cRules) for (const v of literalsOf(r.tokens)) literals.add(v);
    const letters = [...literals, freeSegmentValue(literals)].sort();

    const bKeys = bRules.map(ruleContentKey);
    const cKeys = cRules.map(ruleContentKey);
    const startB = bRules.map((r) => r.dfa.start);
    const startC = cRules.map((r) => r.dfa.start);

    const firstAccept = (masks, rules) => {
      for (let i = 0; i < rules.length; i++) {
        if (rules[i].dfa.accepts(masks[i])) return i;
      }
      return -1;
    };
    const stateKey = (mb, mc) =>
      `${mb.map((m) => m.toString(16)).join(',')}|${mc.map((m) => m.toString(16)).join(',')}`;

    const seen = new Set([stateKey(startB, startC)]);
    let frontier = [{ b: startB, c: startC, word: '', depth: 0 }];
    let overflow = false;

    while (frontier.length && !overflow) {
      // 同层按单词字典序处理：首个到达某差异类的状态即该类最短、字典序最小的见证
      frontier.sort((x, y) => (x.word < y.word ? -1 : x.word > y.word ? 1 : 0));
      const next = [];
      for (const st of frontier) {
        const bi = firstAccept(st.b, bRules);
        const ci = firstAccept(st.c, cRules);
        const bk = bi === -1 ? null : bKeys[bi];
        const ck = ci === -1 ? null : cKeys[ci];
        if (bk !== ck) {
          const classKey = `${bk === null ? '' : bk}\n${ck === null ? '' : ck}`;
          const rec = classes.get(classKey);
          // 方法按 METHODS 顺序处理：仅当严格更短时才替换已有见证
          if (!rec || st.depth < rec.depth) {
            classes.set(classKey, {
              bIndex: bi === -1 ? null : bRules[bi].index,
              cIndex: ci === -1 ? null : cRules[ci].index,
              method,
              path: st.word === '' ? '/' : st.word,
              depth: st.depth,
            });
          }
        }

        for (const letter of letters) {
          const nb = new Array(bRules.length);
          let deadB = true;
          for (let i = 0; i < bRules.length; i++) {
            nb[i] = st.b[i] === 0n ? 0n : bRules[i].dfa.step(st.b[i], letter);
            if (nb[i] !== 0n) deadB = false;
          }
          const nc = new Array(cRules.length);
          let deadC = true;
          for (let i = 0; i < cRules.length; i++) {
            nc[i] = st.c[i] === 0n ? 0n : cRules[i].dfa.step(st.c[i], letter);
            if (nc[i] !== 0n) deadC = false;
          }
          // 两侧全死的状态只会自环，且标签恒为 (无, 无)，无需入队
          if (deadB && deadC) continue;
          const key = stateKey(nb, nc);
          if (seen.has(key)) continue;
          if (seen.size >= MAX_DIFF_STATES) {
            overflow = true;
            break;
          }
          seen.add(key);
          next.push({
            b: nb,
            c: nc,
            word: st.word === '' ? `/${letter}` : `${st.word}/${letter}`,
            depth: st.depth + 1,
          });
        }
        if (overflow) break;
      }
      frontier = next;
    }
    if (overflow) truncated = true;
  }

  const kindRank = { added: 0, lost: 1, migrated: 2 };
  const list = [...classes.values()].map((rec) => {
    const kind =
      rec.bIndex === null ? 'added' : rec.cIndex === null ? 'lost' : 'migrated';
    return {
      kind,
      baseline: rec.bIndex === null ? null : ruleRef(baseCompiled, rec.bIndex),
      current: rec.cIndex === null ? null : ruleRef(currCompiled, rec.cIndex),
      witness: {
        method: rec.method,
        path: rec.path,
        text: `${rec.method} ${rec.path}`,
      },
    };
  });
  list.sort((x, y) => {
    if (kindRank[x.kind] !== kindRank[y.kind]) return kindRank[x.kind] - kindRank[y.kind];
    const bx = x.baseline ? x.baseline.index : -1;
    const by = y.baseline ? y.baseline.index : -1;
    if (bx !== by) return bx - by;
    const cx = x.current ? x.current.index : -1;
    const cy = y.current ? y.current.index : -1;
    return cx - cy;
  });

  const count = (k) => list.reduce((n, c) => n + (c.kind === k ? 1 : 0), 0);
  return {
    identical: list.length === 0 && !truncated,
    truncated,
    summary: {
      added: count('added'),
      lost: count('lost'),
      migrated: count('migrated'),
      total: list.length,
    },
    classes: list,
  };
}

/**
 * 分析规则集。
 * 入参：[{ id?, method, path }]，数组顺序即优先级（索引 0 最先匹配）。
 * opts.computeFixPlan !== false 时附带确定性修复方案；
 * opts.samples 为请求样例数组（“方法 路径”行或 { method, path } 对象）时，
 * 附带请求行为回归预演结果（samples）与修复方案前后对比（fixPlan.sampleReplay）；
 * opts.baselineRules 为基线路由表（同格式规则数组）时，附带版本差异审计结果（diff）。
 * opts.contracts 为路由行为契约数组（字符串行或 { method, path, expect, ruleIndex }
 * 对象）时，附带契约全空间验证结果（contracts）；其中有效的命中型契约还会并入
 * fixPlan 的同一约束图（目标全空间覆盖时建立“目标在前”边，与严格覆盖边合并排序；
 * 不可重排满足或合并成环时 fixPlan.feasible=false 且 order=null）。
 * 返回：{ valid, rules:[...逐条结果], conflicts:[...], summary:{...}, ... }
 */
function analyze(rawRules, opts) {
  const computeFixPlan = !opts || opts.computeFixPlan !== false;
  const rawSamples = opts && Array.isArray(opts.samples) ? opts.samples : null;
  const rawBaseline = opts && Array.isArray(opts.baselineRules) ? opts.baselineRules : null;
  const rawContracts = opts && Array.isArray(opts.contracts) ? opts.contracts : null;
  const rules = Array.isArray(rawRules) ? rawRules : [];
  const { compiled, validCount } = compileRules(rules);
  for (const r of compiled) {
    r.shadows = [];
    r.overlaps = [];
  }

  const conflicts = [];
  // 所有“方法兼容的有效规则对”及其双向覆盖关系，供修复方案构建约束图
  const pairRelations = [];

  for (let i = 0; i < compiled.length; i++) {
    for (let j = i + 1; j < compiled.length; j++) {
      const hi = compiled[i];
      const lo = compiled[j];
      if (!hi.valid || !lo.valid) continue;

      // 仅相同方法、或任一方为 ALL 时才可能冲突
      if (hi.method !== 'ALL' && lo.method !== 'ALL' && hi.method !== lo.method) continue;

      const coversHL = covers(hi.dfa, lo.dfa);
      const coversLH = covers(lo.dfa, hi.dfa);
      pairRelations.push({ i, j, coversIJ: coversHL, coversJI: coversLH });

      let type;
      if (coversHL) {
        type = 'shadow'; // 高优先级规则完全遮蔽低优先级
      } else {
        if (shortestIntersectionWord(hi.dfa, lo.dfa) === null) continue; // 交集为空
        type = 'partial';
      }

      // 同时命中的最短示例路径（并列时字典序最小）
      const example = shortestIntersectionWord(hi.dfa, lo.dfa);

      // 示例路径使用的方法：优先具体方法；含 ALL 时取另一方的具体方法
      const exampleMethod =
        hi.method !== 'ALL' ? hi.method : lo.method !== 'ALL' ? lo.method : 'GET';

      conflicts.push({
        type, // 'shadow' 完全遮蔽 | 'partial' 部分重叠
        higher: { index: hi.index, id: hi.id, method: hi.methodRaw, path: hi.path },
        lower: { index: lo.index, id: lo.id, method: lo.methodRaw, path: lo.path },
        method: exampleMethod,
        examplePath: example,
        example: `${exampleMethod} ${example}`,
      });
    }
  }

  // 逐条规则标注与之冲突的其他规则索引
  for (const r of compiled) {
    r.shadows = [];
    r.overlaps = [];
  }
  for (const c of conflicts) {
    const hi = compiled[c.higher.index];
    const lo = compiled[c.lower.index];
    if (c.type === 'shadow') {
      hi.shadows.push(lo.index);
      lo.overlaps.push(hi.index);
    } else {
      hi.overlaps.push(lo.index);
      lo.overlaps.push(hi.index);
    }
  }

  const ruleResults = compiled.map((r) => ({
    index: r.index,
    id: r.id,
    method: r.methodRaw,
    path: r.path,
    valid: r.valid,
    errors: r.errors,
    shadows: r.shadows,
    overlaps: r.overlaps,
  }));

  const shadowCount = conflicts.filter((c) => c.type === 'shadow').length;
  const partialCount = conflicts.length - shadowCount;
  const signature = rawRulesSignature(rules);

  // 请求行为回归预演：逐条校验“方法 路径”样例并按当前优先级计算首条命中
  const sampleItems = rawSamples === null ? null : compileSamples(rawSamples);

  // 路由行为契约：逐条在契约覆盖的整个请求空间上验证当前首条命中优先级。
  // 编译结果同时供修复方案把“有效的命中型契约”纳入同一约束图，因此提前编译一次。
  const contractItems = rawContracts === null ? null : compileContracts(rawContracts, compiled.length);
  let contractReport = null;

  const result = {
    valid: compiled.every((r) => r.valid),
    total: rules.length,
    validCount,
    rules: ruleResults,
    conflicts,
    signature,
    summary: {
      shadow: shadowCount,
      partial: partialCount,
      total: conflicts.length,
    },
  };
  if (sampleItems) {
    result.samples = evaluateSamples(compiled, sampleItems);
  }
  // 路由行为契约：逐条在契约覆盖的整个请求空间上验证当前首条命中优先级
  if (contractItems !== null) {
    contractReport = verifyContracts(compiled, contractItems);
    result.contracts = contractReport;
  }
  // 版本差异审计：基线规则表 × 当前规则表，按首条命中语义的全空间对比
  if (rawBaseline !== null) {
    const base = compileRules(rawBaseline);
    const diff = diffRuleSets(base.compiled, compiled);
    diff.baseline = {
      total: base.total,
      validCount: base.validCount,
      invalid: base.compiled
        .filter((r) => !r.valid)
        .map((r) => ({
          index: r.index,
          method: r.methodRaw,
          path: r.path,
          errors: r.errors,
        })),
    };
    result.diff = diff;
  }
  if (!computeFixPlan) return result;

  result.fixPlan = buildFixPlan(
    compiled,
    rules,
    pairRelations,
    shadowCount,
    partialCount,
    sampleItems,
    contractItems,
    contractReport
  );
  return result;
}

/** 规则集内容签名：顺序 + 方法 + 路径，供前端判断预览的方案是否已过期 */
function rawRulesSignature(rawRules) {
  return JSON.stringify(
    (Array.isArray(rawRules) ? rawRules : []).map((r) => [
      r && typeof r.method === 'string' ? r.method.trim().toUpperCase() : '',
      r && typeof r.path === 'string' ? r.path : '',
    ])
  );
}

/**
 * 生成确定性的重排修复方案。
 *
 * 思路：
 *   1. 按“路径语言等价”（covers 双向成立）且方法兼容的关系，用并查集把规则
 * *      合并为语言等价组（language equivalence class）；
 *   2. 约束图由两类边合并而成：
 *      a. 严格覆盖边（现有）：对所有“i 的路径被 j 的路径严格覆盖”
 *         （covers(i,j) 且 !covers(j,i)）的规则对，在组间添加
 *         group(i) -> group(j)，即“更具体的规则必须排在严格覆盖它的规则之前”；
 *      b. 契约边（新增）：仅当契约为有效的“命中型”契约、且其目标规则的路径
 *         覆盖契约**整个路径空间**时，在“目标规则 → 同方法、且在该空间内有
 *         交集的每条竞争规则”之间添加“目标在前”约束（跨组落在组图上，
 *         组内落在组成员图上——它允许在等价组内部指定先后，消解
 *         “等价规则谁在前”这类排序问题）；
 *   3. 以下契约**不可通过重排满足**，直接生成阻塞项且不给可应用顺序：
 *      - none 契约：契约空间内已存在任意规则命中（重排无法让规则消失）；
 *      - hit 契约目标无效 / 方法不兼容；
 *      - hit 契约目标不全覆盖契约路径空间（重排无法产生新覆盖）；
 *      - 合并后的组图或组内成员图成环（互为先后的约束无解）；
 *     每条阻塞项给出契约、原因、确定性最短见证请求与冲突约束链；
 *   4. 无阻塞时分别对组图、组内成员图做确定性拓扑排序（Kahn，并列时按
 *      组内最小原始索引 / 成员原始索引升序），组成确定性建议顺序；
 *   5. 组内路径语言互相覆盖、方法又兼容的规则对，无论怎么排序都存在遮蔽，
 *      显式标记为 unavoidable（不可通过排序消除），绝不伪装成已修复；
 *   6. 按建议顺序重排后再次运行 analyze，得到应用后仍不可避免的真实遮蔽数；
 *   7. 若提供了请求样例（sampleItems），用同一批样例在建议顺序下重算首条命中，
 *      输出逐条前后对比（sampleReplay）；
 *   8. 若提供了契约（contractItems），输出契约修复前后状态（contractReplay）；
 *      应用重排后，hit 契约的期望规则仍按**原规则目标**自动重映射到新位置。
 */
function buildFixPlan(
  compiled,
  rawRules,
  pairRelations,
  shadowCount,
  partialCount,
  sampleItems,
  contractItems,
  contractReport
) {
  const n = compiled.length;
  const validFlags = compiled.map((r) => r.valid);
  const hasContracts = Array.isArray(contractItems) && contractItems.length > 0;

  /* --- 1. 并查集：路径语言等价且方法兼容的规则合并 --- */
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const p of pairRelations) {
    if (p.coversIJ && p.coversJI) union(p.i, p.j);
  }

  const memberMap = new Map();
  for (let i = 0; i < n; i++) {
    if (!validFlags[i]) continue; // 无效规则不参与等价组
    const root = find(i);
    if (!memberMap.has(root)) memberMap.set(root, []);
    memberMap.get(root).push(i);
  }
  // 组内保持原始顺序
  const groups = [...memberMap.values()].map((members) => members.sort((a, b) => a - b));
  groups.sort((a, b) => a[0] - b[0]); // 组顺序确定：按组内最小原始索引

  const groupIdOf = new Array(n).fill(-1);
  groups.forEach((members, gi) => {
    for (const m of members) groupIdOf[m] = gi;
  });

  /* --- 2a. 组图：严格覆盖边（更具体组 -> 更宽泛组） --- */
  const G = groups.length;
  const groupAdj = Array.from({ length: G }, () => new Map()); // ga -> Map(gb -> records[])
  const addGroupRecord = (ga, gb, rec) => {
    if (!groupAdj[ga].has(gb)) groupAdj[ga].set(gb, []);
    groupAdj[ga].get(gb).push(rec);
  };
  for (const p of pairRelations) {
    // covers(i,j) 为真表示 L(i) ⊇ L(j)：i 更宽泛、j 更具体
    const iWider = p.coversIJ && !p.coversJI; // j 的路径被 i 严格覆盖
    const jWider = p.coversJI && !p.coversIJ; // i 的路径被 j 严格覆盖
    if (!iWider && !jWider) continue;
    const narrower = iWider ? p.j : p.i; // 路径更具体
    const wider = iWider ? p.i : p.j; // 严格覆盖 narrower
    const ga = groupIdOf[narrower];
    const gb = groupIdOf[wider];
    if (ga === gb || ga < 0 || gb < 0) continue;
    addGroupRecord(ga, gb, { kind: 'cover', narrower, wider });
  }

  /* --- 2b. 契约分析：不可重排满足的契约直接阻塞；其余向约束图添加契约边 --- */
  const blockers = [];
  const contractEdgeRecords = []; // {contractLine, target, competitor, ga, gb, witness(text)}
  // 组内成员图：仅契约边（严格覆盖边不可能出现在语言等价组内部）
  const memberAdj = new Map(); // gi -> Map(from -> Map(to -> records[]))
  const ensureMemberGraph = (gi) => {
    if (!memberAdj.has(gi)) {
      const m = new Map();
      for (const mem of groups[gi]) m.set(mem, new Map());
      memberAdj.set(gi, m);
    }
    return memberAdj.get(gi);
  };
  const addMemberRecord = (gi, from, to, rec) => {
    const mg = ensureMemberGraph(gi);
    if (!mg.get(from).has(to)) mg.get(from).set(to, []);
    mg.get(from).get(to).push(rec);
  };

  const contractEdgeWitness = (item, competitorIdx) =>
    shortestIntersectionWord(item.dfa, compiled[competitorIdx].dfa);

  const reportRowByLine = new Map();
  if (contractReport) {
    for (const row of contractReport.results) reportRowByLine.set(row.line, row);
  }

  if (hasContracts) {
    // 行号升序处理，保证阻塞项与边的加入顺序确定
    const validItems = contractItems
      .filter((it) => it.errors.length === 0)
      .sort((a, b) => a.line - b.line);
    for (const item of validItems) {
      const expectedRef =
        item.expect === 'none'
          ? { kind: 'none' }
          : { kind: 'hit', rule: ruleRef(compiled, item.ruleIndex) };
      const baseContract = () => ({
        line: item.line,
        input: item.input,
        method: item.methodRaw,
        path: item.pathRaw,
        expected: expectedRef,
      });
      const row = reportRowByLine.get(item.line) || null;

      if (item.expect === 'none') {
        // none 契约：空间内已有任意规则命中即不可经重排满足（重排不消除覆盖）
        if (row && row.status === 'fail') {
          blockers.push({
            ...baseContract(),
            kind: 'none-covered',
            reason: '“应无匹配”契约的路径空间内已存在规则命中：重排只能改变首条命中，不能让规则不再匹配。',
            witness: row.counterexample,
            conflicts:
              row.counterexample && row.counterexample.actualHit
                ? [
                    matchedRuleConflict(
                      compiled,
                      row.counterexample.actualHit.index,
                      row.counterexample.text
                    ),
                  ]
                : [],
          });
        } else if (row && row.status === 'truncated') {
          blockers.push(unverifiedBlocker(baseContract(), '应无匹配'));
        }
        continue;
      }

      // hit 契约
      const target = compiled[item.ruleIndex];
      const targetCompat =
        target.valid && (target.method === 'ALL' || target.method === item.method);

      if (!targetCompat) {
        // 目标规则语法无效或方法不兼容：任何顺序下都不可能由它首条命中
        blockers.push({
          ...baseContract(),
          kind: 'target-unsatisfiable',
          reason:
            '目标规则语法无效或方法与契约不兼容：任何顺序下该契约都不可能由它首条命中。',
          witness: row && row.counterexample ? row.counterexample : null,
          conflicts: [targetRuleConflict(compiled, item.ruleIndex, item)],
        });
        continue;
      }

      // 目标必须覆盖契约的**整个**路径空间，否则存在重排无法填补的覆盖缺口
      if (!covers(target.dfa, item.dfa)) {
        const ctx = contractSpaceContext(compiled, item);
        const tPos = ctx.compatible.findIndex((r) => r.index === item.ruleIndex);
        const found = searchContractSpace(
          compiled,
          item,
          (_hit, masks) => !ctx.compatible[tPos].dfa.accepts(masks[tPos])
        );
        if (found.status === 'found') {
          const witness = makeContractWitness(compiled, item, found.word, found.hit);
          blockers.push({
            ...baseContract(),
            kind: 'target-not-cover',
            reason:
              '目标规则不覆盖契约的整个路径空间：存在契约请求目标规则本身不匹配，重排无法产生新的覆盖。',
            witness,
            conflicts: [targetRuleConflict(compiled, item.ruleIndex, item)],
          });
        } else if (found.status === 'truncated') {
          blockers.push(unverifiedBlocker(baseContract(), '目标规则全空间覆盖'));
        }
        continue;
      }

      // 目标全空间覆盖：为每个“同方法、且在契约空间内有交集”的竞争规则添加
      // “目标在前”约束（边见证 = 契约空间 ∩ 竞争规则语言的最短请求）
      for (const r of ctxCompatible(compiled, item)) {
        if (r.index === item.ruleIndex) continue;
        const witnessText = contractEdgeWitness(item, r.index);
        if (witnessText === null) continue; // 在契约空间无交集 -> 不构成竞争
        const rec = {
          kind: 'contract',
          contractLine: item.line,
          contractInput: item.input,
          target: item.ruleIndex,
          competitor: r.index,
          witness: `${item.method} ${witnessText}`,
        };
        const ga = groupIdOf[item.ruleIndex];
        const gb = groupIdOf[r.index];
        contractEdgeRecords.push({ ...rec, ga, gb });
        if (ga === gb) {
          addMemberRecord(ga, item.ruleIndex, r.index, rec);
        } else {
          addGroupRecord(ga, gb, rec);
        }
      }
    }
  }

  /* --- 3. 成环检测：组图 SCC + 组内成员图 SCC；环上契约边即无解契约 --- */
  const cyclicGroupSets = cyclicSccNodes(
    G,
    (u) => [...groupAdj[u].keys()]
  );
  const blockedLines = new Set(blockers.map((b) => b.line));
  const edgeKey = (e) => `${e.target}>${e.competitor}>${e.contractLine}`;
  // 同一（契约行 × 目标 × 竞争规则）的边只保留一条记录（跨组去重的兜底）
  const dedupEdge = new Map();
  for (const e of contractEdgeRecords) {
    const k = edgeKey(e);
    if (!dedupEdge.has(k)) dedupEdge.set(k, e);
  }
  const contractEdges = [...dedupEdge.values()].sort(
    (a, b) =>
      a.contractLine - b.contractLine || a.target - b.target || a.competitor - b.competitor
  );

  // 3a. 组间契约边：两端组落入同一个成环 SCC => 该契约不可满足
  for (const e of contractEdges) {
    if (e.ga === e.gb || blockedLines.has(e.contractLine)) continue;
    if (cyclicGroupSets.some((scc) => scc.has(e.ga) && scc.has(e.gb))) {
      blockedLines.add(e.contractLine);
      blockers.push(
        cycleBlocker(compiled, contractItems, e, {
          type: 'group',
          sccEdges: groupAdj,
          groups,
          pairRelations,
          groupIdOf,
        })
      );
    }
  }

  // 3b. 组内成员边：成员图成环 => 环上的契约不可满足
  for (const [gi, mg] of memberAdj) {
    const members = groups[gi];
    const neighborOf = (u) => [...mg.get(u).keys()];
    const cyclicSets = cyclicSccNodes(members.length, (localU) =>
      neighborOf(members[localU]).map((v) => members.indexOf(v))
    );
    for (const scc of cyclicSets) {
      const globalNodes = [...scc].map((local) => members[local]);
      for (const from of globalNodes) {
        for (const [to, recs] of mg.get(from)) {
          if (!globalNodes.includes(to)) continue;
          for (const rec of recs) {
            if (blockedLines.has(rec.contractLine)) continue;
            blockedLines.add(rec.contractLine);
            const e = contractEdges.find(
              (x) =>
                x.contractLine === rec.contractLine &&
                x.target === rec.target &&
                x.competitor === rec.competitor
            );
            blockers.push(
              cycleBlocker(compiled, contractItems, e, {
                type: 'member',
                gi,
                memberEdges: memberAdj,
                groups,
              })
            );
          }
        }
      }
    }
  }

  blockers.sort((a, b) => a.line - b.line);
  const feasible = blockers.length === 0;

  /* --- 4. 不可消除的等价组与规则对（与契约无关，先计算供输出） --- */
  const unavoidablePairs = [];
  const unavoidableByGroup = new Array(G).fill(0);
  for (const p of pairRelations) {
    if (p.coversIJ && p.coversJI) {
      const gi = groupIdOf[p.i];
      unavoidableByGroup[gi]++;
      unavoidablePairs.push({
        a: ruleRef(compiled, p.i),
        b: ruleRef(compiled, p.j),
      });
    }
  }
  const unavoidableCount = unavoidablePairs.length;
  const equivalenceGroups = groups.map((members, gi) => ({
    members: members.map((idx) => ruleRef(compiled, idx)),
    size: members.length,
    unavoidableShadow: unavoidableByGroup[gi],
    resolvableByOrder: unavoidableByGroup[gi] === 0,
  }));

  /* --- 5. 约束导出（审计用）：严格覆盖边 + 契约边 --- */
  const constraints = [];
  for (let ga = 0; ga < G; ga++) {
    for (const [gb, recs] of groupAdj[ga]) {
      // 每组对只导出一条覆盖边（若存在）；契约边逐条导出
      const coverRec = pickCoverRecord(recs);
      if (coverRec) {
        constraints.push({
          kind: 'cover',
          narrower: ruleRef(compiled, coverRec.narrower),
          wider: ruleRef(compiled, coverRec.wider),
          reason: '前者路径更具体，必须位于严格覆盖它的后者之前',
        });
      }
      for (const rec of recs) {
        if (rec.kind !== 'contract') continue;
        constraints.push(contractConstraintDescriptor(compiled, rec));
      }
    }
  }
  for (const [gi, mg] of memberAdj) {
    for (const [from, tos] of mg) {
      for (const [to, recs] of tos) {
        for (const rec of recs) constraints.push(contractConstraintDescriptor(compiled, rec));
      }
    }
  }
  constraints.sort((a, b) =>
    a.kind === b.kind
      ? 0
      : a.kind === 'cover'
        ? -1
        : 1
  );

  // 不可行（存在不可重排满足的契约 / 成环）：不提供任何可应用顺序
  if (!feasible) {
    return {
      needed: true,
      feasible: false,
      blockers,
      shadowBefore: shadowCount,
      partialBefore: partialCount,
      unavoidableShadow: unavoidableCount,
      equivalenceGroups: equivalenceGroups.filter((g) => g.size > 1),
      unavoidablePairs,
      constraints,
      contractReplay: null,
      order: null,
      moves: [],
      shadowAfter: null,
      fixedCount: null,
      partialAfter: null,
      residualConflicts: [],
    };
  }

  /* --- 6. 确定性拓扑排序：先组图，再组内成员图 --- */
  const indeg = new Array(G).fill(0);
  for (let u = 0; u < G; u++) for (const v of groupAdj[u].keys()) indeg[v]++;
  const queue = [];
  for (let g = 0; g < G; g++) if (indeg[g] === 0) queue.push(g);
  const sortedGroups = [];
  while (queue.length) {
    queue.sort((a, b) => groups[a][0] - groups[b][0]);
    const g = queue.shift();
    sortedGroups.push(g);
    for (const w of groupAdj[g].keys()) {
      indeg[w]--;
      if (indeg[w] === 0) queue.push(w);
    }
  }
  // 成环已在上方阻塞处理；此处成环只可能是内部状态错误，保守兜底
  if (sortedGroups.length !== G) {
    for (let g = 0; g < G; g++) if (!sortedGroups.includes(g)) sortedGroups.push(g);
  }

  // 组内成员拓扑：无契约边时即保持原始顺序
  const memberOrderByGroup = new Map();
  groups.forEach((members, gi) => {
    memberOrderByGroup.set(gi, topoMembers(members, memberAdj.get(gi) || null));
  });

  /* --- 7. 无效规则作为独立单元，按原始索引与组交错（保持其原有相对位置） --- */
  const units = sortedGroups.map((gi) => ({
    kind: 'group',
    gi,
    members: memberOrderByGroup.get(gi),
    min: groups[gi][0],
  }));
  for (let i = 0; i < n; i++) {
    if (!validFlags[i]) units.push({ kind: 'invalid', members: [i], min: i });
  }
  const groupRank = new Map(sortedGroups.map((gi, pos) => [gi, pos]));
  units.sort((u1, u2) => {
    if (u1.kind === 'group' && u2.kind === 'group') {
      return groupRank.get(u1.gi) - groupRank.get(u2.gi);
    }
    return u1.min - u2.min; // 含无效单元时退化为按原始索引，不扰动其位置
  });
  const order = units.flatMap((u) => u.members);

  const newPosOf = new Array(n).fill(-1);
  order.forEach((origIdx, pos) => {
    newPosOf[origIdx] = pos;
  });

  /* --- 8. 位置调整明细：1-based 位置，仅列出实际移动的规则 --- */
  const moves = order
    .map((origIdx) => ({
      rule: ruleRef(compiled, origIdx),
      from: origIdx + 1,
      to: newPosOf[origIdx] + 1,
    }))
    .filter((m) => m.from !== m.to)
    .sort((a, b) => a.to - b.to);

  /* --- 9. 应用建议顺序后重新分析，得到真实的残留遮蔽数（不伪装） --- */
  const reordered = order.map((idx) => rawRules[idx]);
  const after = analyze(reordered, { computeFixPlan: false });
  const residualShadow = after.summary.shadow;
  const residualPartial = after.summary.partial;
  // 残留冲突（用于预览），位置按“应用后”的新顺序标注
  const residualConflicts = after.conflicts.map((c) => ({
    type: c.type,
    higher: ruleRef(compiled, order[c.higher.index]),
    lower: ruleRef(compiled, order[c.lower.index]),
    newPositionA: c.higher.index + 1,
    newPositionB: c.lower.index + 1,
    example: c.example,
  }));

  const orderChanged = order.some((origIdx, pos) => origIdx !== pos);

  const plan = {
    needed: shadowCount > 0 || orderChanged,
    feasible: true,
    shadowBefore: shadowCount,
    shadowAfter: residualShadow,
    fixedCount: shadowCount - residualShadow,
    unavoidableShadow: unavoidableCount,
    partialBefore: partialCount,
    partialAfter: residualPartial,
    moves,
    order: order.map((idx) => idx), // 建议顺序：原始索引的排列（0-based）
    constraints,
    equivalenceGroups: equivalenceGroups.filter((g) => g.size > 1),
    unavoidablePairs,
    residualConflicts,
  };

  // 请求行为回归预演对比：同一批样例 × 建议顺序（仅当存在有效样例时给出）
  if (sampleItems && sampleItems.length > 0) {
    const replay = replaySamples(compiled, order, sampleItems);
    if (replay.total > 0) plan.sampleReplay = replay;
  }

  // 契约修复前后状态：同一批契约 × 建议顺序；hit 期望按原规则目标自动重映射
  if (hasContracts) {
    const crPlan = replayContracts(
      compiled,
      contractItems,
      contractReport,
      order,
      newPosOf
    );
    if (crPlan.total > 0) {
      plan.contractReplay = crPlan;
      if (crPlan.fixedCount > 0 || crPlan.brokenCount > 0) plan.needed = true;
    }
  }

  return plan;
}

/* ---------------- 修复方案：契约辅助函数 ---------------- */

/** 契约方法兼容的有效规则（ALL 规则以契约方法参与） */
function ctxCompatible(compiled, item) {
  return compiled.filter(
    (r) => r.valid && (r.method === 'ALL' || r.method === item.method)
  );
}

/** “状态空间超限”阻塞项（无法证明目标覆盖 / none 空间时不给方案） */
function unverifiedBlocker(contract, what) {
  return {
    ...contract,
    kind: 'unverified',
    reason: `契约空间状态数超过安全上限，无法证明${what}，不能保证重排后契约成立，故不提供可应用方案。`,
    witness: null,
    conflicts: [],
  };
}

/** none 契约被某规则覆盖的冲突约束描述 */
function matchedRuleConflict(compiled, ruleIdx, witnessText) {
  return {
    kind: 'matched-rule',
    rule: ruleRef(compiled, ruleIdx),
    reason: '该规则在契约路径空间内产生命中：重排只能改变首条命中，无法让请求变为无匹配。',
    witness: witnessText,
  };
}

/** 目标规则本身的冲突约束描述 */
function targetRuleConflict(compiled, ruleIdx, item) {
  const exists = ruleIdx >= 0 && ruleIdx < compiled.length;
  return {
    kind: 'target',
    rule: exists ? ruleRef(compiled, ruleIdx) : { index: ruleIdx },
    reason:
      item.expect === 'hit'
        ? '期望首条命中的目标规则无法通过重排覆盖该请求（规则无效、方法不兼容或路径不全覆盖契约空间）。'
        : '契约目标无法通过重排满足。',
    witness: null,
  };
}

/** 契约约束边的导出/审计描述 */
function contractConstraintDescriptor(compiled, rec) {
  return {
    kind: 'contract',
    contractLine: rec.contractLine,
    contract: { line: rec.contractLine, input: rec.contractInput },
    target: ruleRef(compiled, rec.target),
    competitor: ruleRef(compiled, rec.competitor),
    witness: rec.witness,
    reason: `契约第 ${rec.contractLine} 行要求目标规则在其整个路径空间内先于该竞争规则（约束图成环时不可满足）。`,
  };
}

function pickCoverRecord(recs) {
  const covers2 = recs.filter((r) => r.kind === 'cover');
  if (covers2.length === 0) return null;
  covers2.sort((a, b) => a.narrower - b.narrower || a.wider - b.wider);
  return covers2[0];
}

/**
 * Tarjan SCC：返回所有“成环节点集合”（自环或 SCC 大小 > 1）。
 * nodeCount 个节点，neighborsOf(i) 返回后继节点下标列表。
 */
function cyclicSccNodes(nodeCount, neighborsOf) {
  let nextIndex = 0;
  const idx = new Array(nodeCount).fill(-1);
  const low = new Array(nodeCount).fill(0);
  const onStack = new Array(nodeCount).fill(false);
  const stack = [];
  const cycles = [];

  const strong = (v) => {
    const work = [{ v, pi: 0 }];
    idx[v] = low[v] = nextIndex++;
    stack.push(v);
    onStack[v] = true;
    while (work.length) {
      const top = work[work.length - 1];
      const neighbors = neighborsOf(top.v);
      if (top.pi < neighbors.length) {
        const w = neighbors[top.pi++];
        if (idx[w] === -1) {
          idx[w] = low[w] = nextIndex++;
          stack.push(w);
          onStack[w] = true;
          work.push({ v: w, pi: 0 });
        } else if (onStack[w]) {
          low[top.v] = Math.min(low[top.v], idx[w]);
        }
      } else {
        if (low[top.v] === idx[top.v]) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack[w] = false;
            comp.push(w);
          } while (w !== top.v);
          let cyclic = comp.length > 1;
          if (!cyclic) {
            if (neighborsOf(comp[0]).includes(comp[0])) cyclic = true;
          }
          if (cyclic) cycles.push(new Set(comp));
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low[parent] = Math.min(low[parent], low[top.v]);
        }
      }
    }
  };

  for (let v = 0; v < nodeCount; v++) if (idx[v] === -1) strong(v);
  return cycles;
}

/**
 * 组图一跳的代表性约束记录：优先严格覆盖边（确定性取 narrower 最小者），
 * 否则取契约边（按契约行号、目标、竞争规则升序）。
 */
function representativeHop(records) {
  const covers2 = pickCoverRecord(records);
  if (covers2) return covers2;
  const ce = records
    .filter((r) => r.kind === 'contract')
    .sort(
      (a, b) =>
        a.contractLine - b.contractLine || a.target - b.target || a.competitor - b.competitor
    );
  return ce[0] || null;
}

/** 严格覆盖组对 (ga -> gb) 的确定性边见证（“方法 路径”文本） */
function coverHopWitness(compiled, pairRelations, groupIdOf, ga, gb) {
  const pairs = [];
  for (const p of pairRelations) {
    const iWider = p.coversIJ && !p.coversJI;
    const jWider = p.coversJI && !p.coversIJ;
    if (!iWider && !jWider) continue;
    const narrower = iWider ? p.j : p.i;
    const wider = iWider ? p.i : p.j;
    if (groupIdOf[narrower] === ga && groupIdOf[wider] === gb) pairs.push({ narrower, wider });
  }
  pairs.sort((a, b) => a.narrower - b.narrower || a.wider - b.wider);
  const pair = pairs[0];
  if (!pair) return null;
  const path = shortestIntersectionWord(
    compiled[pair.narrower].dfa,
    compiled[pair.wider].dfa
  );
  const nr = compiled[pair.narrower];
  const wr = compiled[pair.wider];
  const method = nr.method !== 'ALL' ? nr.methodRaw : wr.methodRaw;
  return {
    kind: 'cover',
    narrower: ruleRef(compiled, pair.narrower),
    wider: ruleRef(compiled, pair.wider),
    witness: `${method} ${path}`,
    reason: '前者路径更具体，必须位于严格覆盖它的后者之前。',
  };
}

/** 契约边记录 -> 冲突约束描述（成环见证用） */
function contractHopConflict(compiled, rec) {
  return {
    kind: 'contract',
    contractLine: rec.contractLine,
    target: ruleRef(compiled, rec.target),
    competitor: ruleRef(compiled, rec.competitor),
    witness: rec.witness,
    reason: `契约第 ${rec.contractLine} 行要求目标规则在其整个路径空间内先于竞争规则。`,
  };
}

/**
 * 构造成环阻塞项：找出经过该契约边的最短闭环，闭环上的约束互为先后、无解。
 * scope: { type:'group', sccEdges, groups, pairRelations, groupIdOf } 或
 *        { type:'member', gi, memberEdges, groups }。
 */
function cycleBlocker(compiled, contractItems, edge, scope) {
  const item = contractItems.find((it) => it.line === edge.contractLine);
  const expected =
    item.expect === 'none'
      ? { kind: 'none' }
      : { kind: 'hit', rule: ruleRef(compiled, item.ruleIndex) };

  // 第一条：契约自身要求 target 先于 competitor
  const ownEdge = {
    kind: 'contract',
    contractLine: edge.contractLine,
    target: ruleRef(compiled, edge.target),
    competitor: ruleRef(compiled, edge.competitor),
    witness: edge.witness,
    reason: `契约第 ${edge.contractLine} 行要求目标规则在其整个路径空间内先于该竞争规则。`,
  };

  let chain = [];
  if (scope.type === 'group') {
    // BFS：从 competitor 组返回 target 组的最短组路径（确定性，按组号升序）
    const G2 = scope.groups.length;
    const prev = new Array(G2).fill(null);
    const seen = new Set([edge.gb]);
    const qq = [edge.gb];
    while (qq.length) {
      const u = qq.shift();
      for (const v of [...scope.sccEdges[u].keys()].sort((a, b) => a - b)) {
        if (seen.has(v)) continue;
        seen.add(v);
        prev[v] = u;
        qq.push(v);
      }
    }
    if (prev[edge.ga] !== null) {
      // 还原 gb -> ... -> ga
      const pathNodes = [];
      let cur = edge.ga;
      while (cur !== null) {
        pathNodes.push(cur);
        if (cur === edge.gb) break;
        cur = prev[cur];
      }
      pathNodes.reverse();
      for (let i = 0; i + 1 < pathNodes.length; i++) {
        const from = pathNodes[i];
        const to = pathNodes[i + 1];
        const rec = representativeHop(scope.sccEdges[from].get(to));
        if (!rec) continue;
        chain.push(
          rec.kind === 'cover'
            ? coverHopWitness(compiled, scope.pairRelations, scope.groupIdOf, from, to)
            : contractHopConflict(compiled, rec)
        );
      }
    }
  } else if (scope.type === 'member') {
    const mg = scope.memberEdges.get(scope.gi);
    // BFS：成员 competitor -> target（仅契约边）
    const prev = new Map();
    const seen = new Set([edge.competitor]);
    const qq = [edge.competitor];
    while (qq.length) {
      const u = qq.shift();
      for (const v of [...mg.get(u).keys()].sort((a, b) => a - b)) {
        if (seen.has(v)) continue;
        seen.add(v);
        prev.set(v, u);
        qq.push(v);
      }
    }
    if (prev.has(edge.target)) {
      const pathNodes = [];
      let cur = edge.target;
      while (cur !== undefined) {
        pathNodes.push(cur);
        if (cur === edge.competitor) break;
        cur = prev.get(cur);
      }
      pathNodes.reverse();
      for (let i = 0; i + 1 < pathNodes.length; i++) {
        const rec = representativeHop(mg.get(pathNodes[i]).get(pathNodes[i + 1]));
        if (rec) chain.push(contractHopConflict(compiled, rec));
      }
    }
  }

  return {
    line: item.line,
    input: item.input,
    method: item.methodRaw,
    path: item.pathRaw,
    expected,
    kind: 'cycle',
    reason:
      '该契约要求的“目标在前”约束与其他契约/严格覆盖约束互为先后，合并后的约束图成环：不存在能同时满足的规则顺序。',
    witness: {
      method: item.method,
      path: edge.witness.split(' ').slice(1).join(' '),
      text: edge.witness,
      actualHit: null,
    },
    conflicts: [ownEdge, ...chain.filter(Boolean)],
  };
}

/** 组内成员拓扑排序：Kahn，并列按原始索引；无图时保持原始顺序 */
function topoMembers(members, mg) {
  if (!mg) return members.slice();
  const indeg = new Map(members.map((m) => [m, 0]));
  for (const u of members) for (const v of mg.get(u).keys()) indeg.set(v, (indeg.get(v) || 0) + 1);
  const ready = members.filter((m) => indeg.get(m) === 0);
  const out = [];
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const u = ready.shift();
    out.push(u);
    for (const v of mg.get(u).keys()) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) ready.push(v);
    }
  }
  if (out.length !== members.length) {
    for (const m of members) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * 契约修复前后状态对比。
 * before 取当前分析结果；after 在建议顺序上重新验证，规则引用按原始索引重映射
 * （hit 契约的期望目标始终是“原来那条规则”，应用重排后自动指向它的新位置）。
 */
function replayContracts(compiled, contractItems, contractReport, order, newPosOf) {
  const reorderedCompiled = compileRules(order.map((idx) => ({
    method: compiled[idx].methodRaw || compiled[idx].method,
    path: compiled[idx].path,
  }))).compiled;
  // hit 契约的期望目标始终是“原来那条规则”：应用重排后它在新表中的序号即新位置，
  // 验证 after 状态时必须把 ruleIndex 自动重映射到该位置（路径模式 DFA 不变）。
  const afterItems = contractItems.map((it) => {
    if (it.expect !== 'hit') return it;
    return { ...it, ruleIndex: newPosOf[it.ruleIndex] };
  });
  const afterReport = verifyContracts(reorderedCompiled, afterItems);
  const remapRef = (ref) => {
    if (!ref) return ref;
    const origIdx = order[ref.index];
    return {
      ...ruleRef(compiled, origIdx),
      afterPosition: newPosOf[origIdx] + 1,
    };
  };
  const remapWitness = (ce) =>
    ce
      ? {
          ...ce,
          actualHit: ce.actualHit ? remapRef(ce.actualHit) : null,
        }
      : null;

  const beforeRowByLine = new Map();
  if (contractReport) for (const r of contractReport.results) beforeRowByLine.set(r.line, r);
  const afterRowByLine = new Map();
  for (const r of afterReport.results) afterRowByLine.set(r.line, r);

  const results = [];
  let beforePass = 0;
  let afterPass = 0;
  let afterFail = 0;
  let afterTruncated = 0;
  let fixedCount = 0;
  let brokenCount = 0;

  for (const item of contractItems) {
    if (item.errors.length > 0) continue; // 无效契约不参与修复前后对比
    const before = beforeRowByLine.get(item.line) || null;
    const after = afterRowByLine.get(item.line) || null;

    const expected =
      item.expect === 'none'
        ? { kind: 'none' }
        : {
            kind: 'hit',
            rule: ruleRef(compiled, item.ruleIndex),
            afterPosition: newPosOf[item.ruleIndex] + 1,
          };

    const beforeStatus = before ? before.status : null;
    const afterStatus = after ? after.status : null;
    if (beforeStatus === 'pass') beforePass++;
    if (afterStatus === 'pass') afterPass++;
    if (afterStatus === 'fail') afterFail++;
    if (afterStatus === 'truncated') afterTruncated++;
    const fixed = beforeStatus !== 'pass' && afterStatus === 'pass';
    const broken = beforeStatus === 'pass' && afterStatus !== 'pass';
    if (fixed) fixedCount++;
    if (broken) brokenCount++;

    results.push({
      line: item.line,
      input: item.input,
      method: item.methodRaw,
      path: item.pathRaw,
      expected,
      before: {
        status: beforeStatus,
        counterexample: before ? before.counterexample : null,
      },
      after: {
        status: afterStatus,
        counterexample: after ? remapWitness(after.counterexample) : null,
      },
      fixed,
      broken,
    });
  }

  return {
    total: results.length,
    beforePass,
    afterPass,
    afterFail,
    afterTruncated,
    fixedCount,
    brokenCount,
    results,
  };
}

function ruleRef(compiled, idx) {
  const r = compiled[idx];
  return { index: r.index, id: r.id, method: r.methodRaw, path: r.path };
}

const api = {
  parsePath,
  buildDFA,
  covers,
  shortestIntersectionWord,
  normalizeMethod,
  normalizeSampleMethod,
  matchesConcrete,
  compileRules,
  diffRuleSets,
  compileContracts,
  verifyContracts,
  analyze,
  METHODS,
  FREE_VALUE,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.RouteAnalyzer = api;
}
