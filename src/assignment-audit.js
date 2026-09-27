'use strict';

/**
 * 变量赋值消费审计（Variable Assignment Consumption Audit）
 *
 * 在编辑页对**当前草稿**直接运行（不落盘），回答：
 *   “场景进入赋值与选项赋值写下的每个变量值，是否在**再次被赋值**或**路线结束**
 *     之前，被后续条件引用（消费）过？”
 *
 * 追踪语义完全沿用现有「场景 + 变量状态」合法跳转：
 *   - 到达具体状态 = 「场景 + 全部布尔变量取值位图」；
 *   - 选项条件先于本选项赋值求值：条件不成立则选项赋值不执行（该位置不可达）；
 *   - 选项条件成立后依次执行：本选项赋值 → 目标场景进入赋值 → 目标场景前置条件；
 *     即**目标场景的进入赋值先于其前置条件**，前置条件可以读到目标场景自己写下的值；
 *   - 目标场景不存在（悬空跳转）时选项赋值不执行（与其余模块一致，不构成合法边）；
 *   - 目标前置条件不成立（入口受阻）时跳转不可继续，但求值本身已经发生，
 *     这次读取仍是一次有效引用；
 *   - 起点初始状态 = 全部 false 叠加起点场景进入赋值，随后再求起点前置条件。
 *
 * 三类有效引用（读取点）：
 *   R0 场景前置条件：每次进入该场景时（含起点），在其进入赋值之后求值；
 *   R1 选项显示条件：到达该场景的每个具体状态下，每个选项条件都在“本选项赋值之前”
 *      求值一次（恒假也读，读了即算引用；恒假只代表该选项此状态下不可走）；
 *   R2 目标场景前置条件：选项条件成立且目标存在时，在选项赋值 + 目标进入赋值
 *      之后求值（入口受阻也算）。
 *
 * **同一位置在不同可达状态下只要存在一次有效引用即算已消费。**
 *
 * 为在含环图上精确追踪“当前这个值是哪个赋值位置写下的”，把每个变量额外附带
 * 一位**溯源（provenance）**：prov[vi] = 最近一次写变量 vi 的赋值位置 ID。
 * 去重键 = (场景 ID, 变量位图, 溯源向量)：
 *   - 同一 (场景, 变量状态) 在“值由不同位置写下”时视为不同节点，因此“绕环一圈
 *     后同一位置再次写下同值”与“首次写下”不会被错误合并，绕环后的引用能被发现；
 *   - 溯源只取有限的赋值位置，状态总数至多 场景数 × 2^n × (赋值位置数+1)^n，
 *     必然有限，任意环路都保证终止（沿用约 100 万状态安全上限）。
 *
 * BFS 按选项步数展开，首次发现某位置被引用即记录该次引用——它就是从起点到
 * **首次引用**的最短可走路线（路线中顺带标注沿途哪些赋值块写下了哪些位置）。
 *
 * 状态上限截断时，**只把已确证“已消费”的位置判为已消费**；其余可达位置一律标为
 * “未知（unknown）”，绝不把未探索区域可能存在的引用误判成未消费。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// 赋值位置 ID：
//   场景进入赋值  s:<sceneId>#<块内下标>
//   选项赋值      o:<sceneId>#<选项下标>#<块内下标>
// 块内下标均指过滤掉空变量名后的有效赋值下标（与分析引擎 applyAssigns 口径一致）。
const scenePosId = (sceneId, i) => `s:${sceneId}#${i}`;
const optionPosId = (sceneId, oi, i) => `o:${sceneId}#${oi}#${i}`;

/**
 * 对剧情（草稿或已保存）运行变量赋值消费审计。
 *
 * @param storyInput 剧情对象
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function auditAssignments(storyInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法审计变量赋值消费');
  }

  // 编译条件；语法错误按恒真处理（与其余模块一致），记录到 conditionErrors
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();   // sceneId -> 编译后的前置条件（null=恒真/语法错误）
  const sceneCondRaw = new Map();
  const sceneAssigns = new Map();
  const optionCompiled = new Map(); // `${sceneId}#${idx}` -> { cond, condRaw, assigns }

  // posMeta: 赋值位置 ID -> 位置元数据（结果按位置列出时使用）
  const posMeta = new Map();
  const sceneAssignPids = new Map();  // sceneId -> [位置ID...]（与过滤后赋值等长）
  const optionAssignPids = new Map(); // optKey -> [位置ID...]
  const registerBlock = (assigns, mkId, mkMeta) => {
    const pids = [];
    assigns.forEach((a, i) => {
      const pid = mkId(i);
      pids.push(pid);
      posMeta.set(pid, { ...mkMeta(a, i), assignIndex: i });
    });
    return pids;
  };

  for (const scene of sceneMap.values()) {
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneCondRaw.set(scene.id, (scene.precondition || '').trim());
    const sAssigns = (scene.assigns || []).filter((a) => a && a.variable);
    sceneAssigns.set(scene.id, sAssigns);
    sceneAssignPids.set(scene.id, registerBlock(
      sAssigns,
      (i) => scenePosId(scene.id, i),
      (a) => ({ kind: 'sceneAssign', sceneId: scene.id, variable: a.variable, value: !!a.value }),
    ));
    (scene.options || []).forEach((opt, idx) => {
      const key = `${scene.id}#${idx}`;
      const oAssigns = ((opt && opt.assigns) || []).filter((a) => a && a.variable);
      optionCompiled.set(key, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        condRaw: ((opt && opt.condition) || '').trim(),
        assigns: oAssigns,
      });
      optionAssignPids.set(key, registerBlock(
        oAssigns,
        (i) => optionPosId(scene.id, idx, i),
        (a) => ({
          kind: 'optionAssign', sceneId: scene.id, optionIndex: idx,
          variable: a.variable, value: !!a.value,
        }),
      ));
    });
  }

  const knownVars = collectStateVars({ ...story, scenes });
  const varIndex = new Map(knownVars.map((v, i) => [v, i]));

  /** 顺序执行一个赋值块：同时更新变量位图状态与溯源向量，返回块后仍作为“最后写入者”
   *  存活下来的位置（同块内被后续同变量赋值覆盖的位置不计）。 */
  const applyBlock = (stateObj, codeArr, prov, assigns, pids) => {
    const survived = [];
    assigns.forEach((a, i) => {
      const vi = varIndex.get(a.variable);
      if (vi === undefined) return;
      stateObj[a.variable] = !!a.value;
      codeArr[vi] = a.value ? '1' : '0';
      if (prov[vi] !== pids[i]) prov[vi] = pids[i];
      survived.push(pids[i]);
    });
    // 同块内若多次写同一变量，只有最后一次写入的位置存活
    const lastByVar = new Map();
    assigns.forEach((a, i) => { if (varIndex.has(a.variable)) lastByVar.set(a.variable, pids[i]); });
    return [...new Set(lastByVar.values())];
  };

  // ---- 溯源增强 BFS ----
  // 节点：{ sceneId, code, prov:[位置ID|null...], depth, parentKey, edge, entryWrites }
  const nodeInfo = new Map(); // key -> 节点记录
  const enqueued = new Set(); // 实际入队（将被展开）的 key；恰在状态上限上记录的节点不入队
  const sceneFirst = new Map(); // sceneId -> 首次进入的节点 key（最短链见证）
  const firedFirst = new Map(); // optKey -> 选项条件首次成立时所在节点 key
  const consumed = new Map();   // 位置ID -> 首次引用事件（BFS 首个发现 = 最短路线）
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let transitionCount = 0;

  const keyOf = (sceneId, code, prov) => `${sceneId} ${code} ${prov.map((p) => p || '').join(' ')}`;

  /** 记录一次有效引用；同一位置只保留 BFS 中首次发现的那次（距离最短） */
  const consume = (pid, event) => {
    if (!pid || consumed.has(pid)) return;
    consumed.set(pid, event);
  };

  /** 条件 AST 中实际出现（且在状态变量空间内）的变量，逐个触发其当前写入位置的消费 */
  const consumeByCompiled = (compiled, prov, makeEvent) => {
    if (!compiled) return;
    for (const v of compiled.vars()) {
      const vi = varIndex.get(v);
      if (vi === undefined) continue; // 未声明且从未赋值的变量：无赋值位置可消费
      consume(prov[vi], makeEvent(v));
    }
  };

  // 返回 true 表示新节点入队
  const offer = (sceneId, code, prov, depth, parentKey, edge, entryWrites) => {
    const key = keyOf(sceneId, code, prov);
    if (nodeInfo.has(key)) return key;
    const node = { sceneId, code, prov: [...prov], depth, parentKey, edge: edge || null, entryWrites: entryWrites || [] };
    nodeInfo.set(key, node);
    statesExplored++;
    if (!sceneFirst.has(sceneId)) sceneFirst.set(sceneId, key);
    if (statesExplored > maxStates) { truncated = true; return null; }
    enqueued.add(key);
    queue.push(key);
    return key;
  };

  // ---- 起点：全部 false 叠加起点进入赋值，随后再求起点前置条件（R0） ----
  const startState = {};
  const startCodeArr = knownVars.map(() => '0');
  const startProv = knownVars.map(() => null);
  const startEntryWrites = applyBlock(
    startState, startCodeArr, startProv,
    sceneAssigns.get(story.startScene) || [],
    sceneAssignPids.get(story.startScene) || [],
  );
  const startCode = startCodeArr.join('');
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));

  const base = {
    startScene: story.startScene,
    knownVars,
    conditionErrors,
    maxStates,
  };

  if (startBlocked) {
    return {
      ...base,
      ok: false,
      status: 'start-blocked',
      startBlocked: true,
      truncated: false,
      complete: false,
      groups: [],
      counts: {
        total: 0, consumed: 0, unconsumed: 0, unknown: 0, excluded: 0,
        states: 0, transitions: 0, variables: knownVars.length, reachableScenes: 0,
      },
      statesExplored: 0,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始，无法审计赋值消费。',
    };
  }

  // R0：起点前置条件在起点进入赋值之后求值（读到的位置即被消费）
  const startKey = offer(story.startScene, startCode, startProv, 0, null, null, startEntryWrites);
  if (startKey) {
    consumeByCompiled(startPc, startProv, (variable) => ({
      kind: 'R0', key: startKey, depth: 0, variable,
      reference: {
        type: 'scenePrecondition', sceneId: story.startScene,
        raw: sceneCondRaw.get(story.startScene),
      },
    }));
  }

  let head = 0;
  while (head < queue.length && !truncated) {
    const curKey = queue[head++];
    const cur = nodeInfo.get(curKey);
    const { sceneId, code, prov, depth } = cur;
    const scene = sceneMap.get(sceneId);
    const state = decodeState(code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated) return;
      const optKey = `${sceneId}#${idx}`;
      const oc = optionCompiled.get(optKey);
      const cond = oc ? oc.cond : null;

      // R1：选项显示条件先于本选项赋值求值；恒假也读，读了即算一次有效引用
      consumeByCompiled(cond, prov, (variable) => ({
        kind: 'R1', key: curKey, depth, variable,
        reference: {
          type: 'optionCondition', sceneId, optionIndex: idx,
          optionText: (option && option.text) || '', raw: oc ? oc.condRaw : '',
          evaluated: !cond || cond.evaluate(state),
        },
      }));

      const condOk = !cond || cond.evaluate(state);
      if (!condOk) return; // 条件不成立：选项赋值不执行（该赋值块不可达）
      if (!firedFirst.has(optKey)) firedFirst.set(optKey, curKey);

      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return; // 悬空跳转：选项赋值不执行

      // 本选项赋值
      const stateAfterOpt = { ...state };
      const codeAfterOpt = code.split('');
      const provAfterOpt = [...prov];
      const optWrites = applyBlock(
        stateAfterOpt, codeAfterOpt, provAfterOpt,
        oc ? oc.assigns : [],
        optionAssignPids.get(optKey) || [],
      );

      // 目标场景进入赋值（先于其前置条件）
      const nextState = stateAfterOpt;
      const nextCodeArr = codeAfterOpt;
      const nextProv = provAfterOpt;
      const sceneWrites = applyBlock(
        nextState, nextCodeArr, nextProv,
        sceneAssigns.get(targetId) || [],
        sceneAssignPids.get(targetId) || [],
      );
      const nextCode = nextCodeArr.join('');

      const edgeBase = {
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionText: (option && option.text) || '',
        fromSceneId: sceneId,
        target: targetId,
        targetTitle: (sceneMap.get(targetId) || {}).title || '',
        writes: optWrites,
        stateAfter: { ...nextState },
      };

      const targetPc = sceneCond.get(targetId);
      const entryOk = !targetPc || targetPc.evaluate(nextState);

      // R2：目标场景前置条件在“选项赋值 + 目标进入赋值”之后求值；入口受阻也算引用
      const r2EventBase = {
        kind: 'R2', depth: depth + 1,
        parentKey: curKey,
        edge: edgeBase,
        nextCode,
        nextProv: [...nextProv],
        sceneWrites,
        blocked: !entryOk,
        reference: {
          type: 'targetPrecondition', sceneId: targetId,
          raw: sceneCondRaw.get(targetId),
          via: { sceneId, optionIndex: idx, optionText: (option && option.text) || '' },
        },
      };
      consumeByCompiled(targetPc, nextProv, (variable) => ({ ...r2EventBase, variable }));

      if (entryOk) {
        const childKey = offer(targetId, nextCode, nextProv, depth + 1, curKey, edgeBase, sceneWrites);
        if (childKey) transitionCount++;
      }
      // 入口受阻：不产生后续节点，但 R2 引用已经记录，选项赋值块确实执行过（可达）
    });
  }

  // ---- 路线重建：从节点 key 沿 parent 回溯为起点 -> 引用点的场景/选项交替序列 ----
  const chainTo = (key) => {
    const trail = [];
    let k = key;
    while (k) {
      const n = nodeInfo.get(k);
      const sc = sceneMap.get(n.sceneId);
      trail.push({
        kind: 'scene',
        sceneId: n.sceneId,
        title: sc ? (sc.title || '') : n.sceneId,
        state: decodeState(n.code, knownVars),
        writes: [...n.entryWrites],
      });
      if (n.edge) trail.push({ kind: 'option', ...n.edge });
      k = n.parentKey;
    }
    trail.reverse();
    return trail;
  };

  /** 为已消费位置构造到首次引用的最短可走路线，并在引用点与沿途写入点打标 */
  const buildWitness = (pid, event) => {
    let path;
    if (event.kind === 'R2') {
      // 始终沿事件所在 BFS 节点的父链 + 触发引用的那条边重建：
      // 即便目标具体状态此前已由别的路线到达，这样也能保证路线深度与事件深度一致，
      // 且路线终点就是“读取该值的那个目标场景前置条件”。
      const childKey = keyOf(event.reference.sceneId, event.nextCode, event.nextProv);
      const childExists = !event.blocked && enqueued.has(childKey);
      path = chainTo(event.parentKey);
      path.push({ kind: 'option', ...event.edge, blockedEntry: event.blocked });
      const targetScene = sceneMap.get(event.reference.sceneId);
      path.push({
        kind: 'scene',
        sceneId: event.reference.sceneId,
        title: targetScene ? (targetScene.title || '') : event.reference.sceneId,
        state: decodeState(event.nextCode, knownVars),
        writes: [...event.sceneWrites],
        blockedEntry: event.blocked,
        notExpanded: !event.blocked && !childExists,
      });
    } else {
      path = chainTo(event.key);
    }

    // 引用点固定为路线最后一个场景节点（R1 发生在该场景选项求值时，不产生跳转）
    const lastScene = [...path].reverse().find((n) => n.kind === 'scene');
    if (lastScene) {
      lastScene.reference = { ...event.reference, variable: event.variable };
      lastScene.referenceEnd = true;
    }
    // 起点标注
    const firstScene = path.find((n) => n.kind === 'scene');
    if (firstScene) firstScene.isStart = true;

    return {
      depth: event.depth,
      reference: { ...event.reference, variable: event.variable },
      path,
      finalState: lastScene ? lastScene.state : null,
    };
  };

  // ---- 汇总：按剧情顺序（场景 -> 场景赋值 / 各选项赋值）列出每个赋值位置 ----
  const meta = (pid) => posMeta.get(pid);
  const statusOf = (pid) => {
    if (consumed.has(pid)) return 'consumed';
    return truncated ? 'unknown' : 'unconsumed';
  };

  const groups = [];
  const counts = {
    total: 0, consumed: 0, unconsumed: 0, unknown: 0, excluded: 0,
    states: statesExplored, transitions: transitionCount,
    variables: knownVars.length, reachableScenes: sceneFirst.size,
  };
  const buildPos = (pid, reachable, excludedReason) => {
    const m = meta(pid);
    const item = {
      id: pid,
      kind: m.kind,
      sceneId: m.sceneId,
      optionIndex: m.kind === 'optionAssign' ? m.optionIndex : null,
      assignIndex: m.assignIndex,
      variable: m.variable,
      value: m.value,
      reachable,
      status: reachable ? statusOf(pid) : 'excluded',
      excludedReason: reachable ? null : excludedReason,
      witness: reachable && consumed.has(pid) ? buildWitness(pid, consumed.get(pid)) : null,
    };
    if (reachable) counts.total++;
    counts[item.status]++;
    return item;
  };

  for (const scene of scenes) {
    if (!scene || !scene.id || !sceneMap.has(scene.id)) continue;
    const sceneReachable = sceneFirst.has(scene.id);
    const group = {
      sceneId: scene.id,
      title: scene.title || '',
      assigns: [],
      options: [],
    };

    // 场景进入赋值：场景可达（至少进入过一次）即执行
    (sceneAssignPids.get(scene.id) || []).forEach((pid) => {
      if (sceneReachable) {
        group.assigns.push(buildPos(pid, true, null));
      } else {
        group.assigns.push(buildPos(pid, false, 'sceneUnreachable'));
      }
    });

    (scene.options || []).forEach((opt, idx) => {
      const optKey = `${scene.id}#${idx}`;
      const targetId = ((opt && opt.target) || '').trim();
      const orphan = !targetId || !sceneMap.has(targetId);
      const fired = firedFirst.has(optKey);
      let reason = null;
      if (!sceneReachable) reason = 'optionInUnreachableScene';
      else if (orphan) reason = 'orphanOption';
      else if (!fired) reason = 'optionNeverEnabled';

      const assigns = (optionAssignPids.get(optKey) || []).map((pid) => (
        reason ? buildPos(pid, false, reason) : buildPos(pid, true, null)
      ));

      group.options.push({
        optionIndex: idx,
        text: (opt && opt.text) || '',
        uid: (opt && opt.uid) || null,
        target: targetId,
        assigns,
      });
    });

    groups.push(group);
  }

  // 汇总各排除原因的数量
  const excludedReasons = {};
  for (const g of groups) {
    for (const p of g.assigns) if (p.status === 'excluded') {
      excludedReasons[p.excludedReason] = (excludedReasons[p.excludedReason] || 0) + 1;
    }
    for (const o of g.options) for (const p of o.assigns) {
      if (p.status === 'excluded') {
        excludedReasons[p.excludedReason] = (excludedReasons[p.excludedReason] || 0) + 1;
      }
    }
  }

  // ---- 结论与文案 ----
  const status = startBlocked ? 'start-blocked' : (truncated ? 'truncated' : 'complete');
  let message;
  if (status === 'truncated') {
    message = `分析被状态上限截断（已枚举 ${statesExplored} 个「场景 + 变量状态 + 赋值溯源」具体状态）：`
      + `已确证 ${counts.consumed} 个赋值被后续条件引用；其余可达赋值一律标为“未知”，`
      + '不会把未探索区域可能存在的引用误判为未消费。请减少变量数量后重试。';
  } else if (counts.total === 0) {
    message = `已完整探索 ${statesExplored} 个具体状态：当前草稿中没有任何可达的变量赋值位置（不可达场景 / 恒假或悬空选项中的赋值已单独排除）。`;
  } else {
    message = `已完整探索 ${statesExplored} 个具体状态：${counts.total} 个可达赋值位置中，`
      + `${counts.consumed} 个的值在被再次赋值或路线结束前被后续条件引用，`
      + `${counts.unconsumed} 个从未被引用`
      + (counts.excluded ? `；另有 ${counts.excluded} 个赋值位于不可达位置，未计入。` : '。');
  }

  return {
    ...base,
    ok: !truncated,
    status,
    startBlocked: false,
    truncated,
    complete: !truncated,
    groups,
    counts,
    excludedReasons,
    statesExplored,
    message,
  };
}

module.exports = { auditAssignments };
