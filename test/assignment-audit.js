'use strict';

// 变量赋值消费审计自检（node test/assignment-audit.js）
// 覆盖：三类读取点（选项条件 / 目标前置条件 / 起点前置条件）、选项条件先于本选项
//       赋值、目标进入赋值先于其前置条件、入口受阻也算引用、再次赋值关闭消费窗口、
//       同块内写入即被覆盖、多可达状态任一引用即消费、环路（同位置重写后再引用、
//       绕环后才出现的引用）、路线结束未读、悬空 / 恒假选项与不可达场景中的赋值
//       排除、起点受阻、缺起点 400、状态上限截断不误判、条件语法错误容错、
//       最短路线、确定性、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { auditAssignments } = require('../src/assignment-audit');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name, actual, expected) => {
  assert.strictEqual(actual, expected, `${name}（实际 ${JSON.stringify(actual)}）`);
  passed++; console.log(`  ✓ ${name}`);
};
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};

/** 便捷：按位置 ID 取结果项（所有场景 / 选项摊平） */
const flatItems = (r) => {
  const out = new Map();
  for (const g of r.groups) {
    g.assigns.forEach((p) => out.set(p.id, p));
    g.options.forEach((o) => o.assigns.forEach((p) => out.set(p.id, p)));
  }
  return out;
};
const sceneSeq = (w) => w.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(',');

// ---------- R1：场景进入赋值被本场景选项条件引用（到达即读，深度 0） ----------
console.log('R1 选项条件消费场景进入赋值');
const st1 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }], options: [
      { uid: 'o1', text: '用 x', condition: 'x', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r1 = auditAssignments(st1);
const m1 = flatItems(r1);
eq('结论完整', r1.status, 'complete');
eq('x 赋值已消费', m1.get('s:a#0').status, 'consumed');
eq('引用类型为选项条件', m1.get('s:a#0').witness.reference.type, 'optionCondition');
eq('首次引用深度 = 0', m1.get('s:a#0').witness.depth, 0);
eq('引用变量为 x', m1.get('s:a#0').witness.reference.variable, 'x');
ok('路线末节点带引用标注', m1.get('s:a#0').witness.path.at(-1).referenceEnd === true);
eq('计数：1 已消费 0 未消费', `${r1.counts.consumed}/${r1.counts.unconsumed}`, '1/0');

// ---------- 未消费：赋值后无人引用，路线直接结束 ----------
console.log('路线结束前从未被引用 => 未消费');
const st2 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }], options: [
      { uid: 'o1', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const m2 = flatItems(auditAssignments(st2));
eq('x 赋值未消费', m2.get('s:a#0').status, 'unconsumed');
ok('未消费项无路线', m2.get('s:a#0').witness === null);

// ---------- 选项条件先于本选项赋值：自身条件读不到自己写下的值 ----------
console.log('选项条件先于本选项赋值（不自身消费）');
const st3 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }], options: [
      { uid: 'o1', condition: 'x', target: 'e', assigns: [{ variable: 'x', value: true }] },
    ] },
    { id: 'e', options: [] },
  ],
};
const m3 = flatItems(auditAssignments(st3));
eq('场景赋值被自己选项的条件消费', m3.get('s:a#0').status, 'consumed');
eq('选项赋值不被自身条件消费且路线即结束', m3.get('o:a#0#0').status, 'unconsumed');

// ---------- R2：目标场景进入赋值先于其前置条件（最关键语义） ----------
console.log('R2 目标进入赋值先于目标前置条件');
const st4 = {
  startScene: 'a', variables: [{ name: 'k' }],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', precondition: 'k', assigns: [{ variable: 'k', value: true }], options: [
      { uid: 'o2', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r4 = auditAssignments(st4);
const m4 = flatItems(r4);
eq('b 的进入赋值被其自身前置条件消费', m4.get('s:b#0').status, 'consumed');
eq('引用类型为目标前置条件', m4.get('s:b#0').witness.reference.type, 'targetPrecondition');
eq('首次引用深度 = 1', m4.get('s:b#0').witness.depth, 1);
eq('路线场景序列 a,b', sceneSeq(m4.get('s:b#0').witness), 'a,b');
ok('b 可正常进入（目标赋值满足前置）', r4.counts.reachableScenes === 3);

// 对照：若不做目标进入赋值，前置读不到；选项赋值在前置求值前生效，同样可被 R2 消费
const st4b = {
  startScene: 'a', variables: [{ name: 'k' }],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b', assigns: [{ variable: 'k', value: true }] }] },
    { id: 'b', precondition: 'k', options: [{ uid: 'o2', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const m4b = flatItems(auditAssignments(st4b));
eq('选项赋值也先于目标前置条件而被消费', m4b.get('o:a#0#0').status, 'consumed');

// ---------- 入口前置不成立（入口受阻）：求值已发生，仍算一次有效引用 ----------
console.log('入口受阻：目标前置条件的读取仍算消费');
const st5 = {
  startScene: 'a', variables: [{ name: 'x' }, { name: 'y' }],
  scenes: [
    { id: 'a', options: [
      { uid: 'o1', target: 'b', assigns: [{ variable: 'x', value: true }] },
      { uid: 'o2', target: 'e' },
    ] },
    { id: 'b', precondition: 'x && y', options: [{ uid: 'never', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const m5 = flatItems(auditAssignments(st5));
eq('x 选项赋值被受阻前置条件消费', m5.get('o:a#0#0').status, 'consumed');
const w5 = m5.get('o:a#0#0').witness;
ok('受阻路线末节点标注 blockedEntry', w5.path.at(-1).blockedEntry === true);
eq('受阻路线最后场景为 b', w5.path.at(-1).sceneId, 'b');
ok('边带选项赋值写入标注', w5.path.some((n) => n.kind === 'option' && n.writes.includes('o:a#0#0')));
// y 从未被任何赋值写过，前置对 y 的读取没有对应位置，不影响 x 消费结论
const r5scenes = auditAssignments(st5);
ok('场景 b 不可达（入口恒受阻，不在可达场景集合中）', !r5scenes.counts || r5scenes.counts.reachableScenes === 2);

// ---------- 再次赋值关闭消费窗口：旧值在被引用前已被覆盖 ----------
console.log('再次赋值关闭旧值的消费窗口');
const st6 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b', assigns: [
      { variable: 'x', value: true }, { variable: 'x', value: false },
    ] }] },
    { id: 'b', options: [{ uid: 'o2', condition: '!x', target: 'e' }, { uid: 'o3', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const m6 = flatItems(auditAssignments(st6));
eq('第一个赋值（true）被同块后写覆盖 => 未消费', m6.get('o:a#0#0').status, 'unconsumed');
eq('第二个赋值（false）被 b 的选项条件消费', m6.get('o:a#0#1').status, 'consumed');

// ---------- 同一位置在不同可达状态下：存在一次有效引用即算已消费 ----------
console.log('多可达状态：一次引用即消费，取最短路线');
const st7 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', options: [
      { uid: 'no', target: 'b' },
      { uid: 'yes', target: 'b', assigns: [{ variable: 'x', value: true }] },
    ] },
    { id: 'b', options: [
      { uid: 'chk', condition: 'x', target: 'e' },
      { uid: 'cont', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const m7 = flatItems(auditAssignments(st7));
eq('yes 选项的 x 赋值已消费', m7.get('o:a#1#0').status, 'consumed');
eq('最短首次引用深度 = 1（选项 yes 一步到达 b，b 的 chk 条件即首次引用）', m7.get('o:a#1#0').witness.depth, 1);
// 恒假条件在另一状态下也被“求值”：x=false 状态读 x（读的是别的来源），不影响结论
eq('引用点在 b 场景选项 chk 上',
  m7.get('o:a#1#0').witness.reference.type, 'optionCondition');
eq('引用选项下标为 0', m7.get('o:a#1#0').witness.reference.optionIndex, 0);

// ---------- 选项恒假也读：条件求值本身是引用（只要溯源位置存活） ----------
console.log('恒假求值也是引用');
const st8 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }], options: [
      { uid: 'o1', condition: '!x', target: 'e' }, // 恒假，但读了 x
      { uid: 'o2', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const m8 = flatItems(auditAssignments(st8));
eq('恒假选项的条件求值消费了场景赋值', m8.get('s:a#0').status, 'consumed');
ok('恒假选项本身没有赋值块', !m8.has('o:a#0#0'));

// ---------- 环路 1：同位置绕环后再次写入，再次之后被引用（溯源并入键，不提前合并） ----------
console.log('环路：绕环后由同位置重写的值再次被引用');
const st9 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', options: [{ uid: 'in', target: 'h' }] },
    { id: 'h', assigns: [{ variable: 'x', value: true }], options: [
      { uid: 'set', target: 'g', assigns: [{ variable: 'x', value: false }] },
    ] },
    { id: 'g', options: [{ uid: 'back', target: 'h' }] }, // 回 h：h 进入赋值重新写 x=true
  ],
};
const r9 = auditAssignments(st9);
const m9 = flatItems(r9);
ok('环路分析终止且未截断', r9.truncated === false);
// 首次进入 h 时没有任何条件读 x（set 条件恒真），x=true 未消费；
// 绕 g 一圈再进 h 仍无读取 => 仍然未消费（完整探索后可以下此结论）
eq('h 的 x=true 在所有绕行中均未被引用 => 未消费', m9.get('s:h#0').status, 'unconsumed');

// 环路 2：绕环后才出现的引用（引用点在环上，首次写入后走一圈读到）
const st10 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', options: [{ uid: 'in', target: 'h', assigns: [{ variable: 'x', value: true }] }] },
    { id: 'h', options: [
      { uid: 'read', condition: 'x', target: 'e' },
      { uid: 'loop', target: 'h' }, // 自环：再回 h（无场景赋值，x 溯源仍是选项位置）
    ] },
    { id: 'e', options: [] },
  ],
};
const m10 = flatItems(auditAssignments(st10));
eq('选项赋值 x 在首次到达 h 时即被 read 条件引用（无需绕环）', m10.get('o:a#0#0').status, 'consumed');
eq('首次引用深度 = 1', m10.get('o:a#0#0').witness.depth, 1);

// 环路 3：引用只在“重新赋值之后”才生效——同位置第二次写入后读到，仍算该位置消费
const st11 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', options: [{ uid: 'in', target: 'h' }] },
    { id: 'h', assigns: [{ variable: 'x', value: true }], options: [
      { uid: 'loop', target: 'g' },
    ] },
    { id: 'g', options: [
      { uid: 'clear', target: 'h', assigns: [{ variable: 'x', value: true }] }, // 重写（同值，选项位置）
      { uid: 'readg', condition: 'x', target: 'e' }, // 在 g 读到 x：来源是 s:h#0（首次）
    ] },
    { id: 'e', options: [] },
  ],
};
const m11 = flatItems(auditAssignments(st11));
eq('h 场景赋值在 g 的选项条件处被消费（绕环一圈）', m11.get('s:h#0').status, 'consumed');
eq('首次引用深度 = 2（a->h->g）', m11.get('s:h#0').witness.depth, 2);
eq('路线场景序列 a,h,g', sceneSeq(m11.get('s:h#0').witness), 'a,h,g');

// ---------- 排除项：不可达场景 / 悬空选项 / 恒假选项中的赋值 ----------
console.log('不可达位置的赋值单独排除');
const st12 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', options: [
      { uid: 'o1', target: 'ghost', assigns: [{ variable: 'x', value: true }] }, // 悬空
      { uid: 'o2', condition: 'x', target: 'e', assigns: [{ variable: 'x', value: false }] }, // 恒假
    ] },
    { id: 'u', assigns: [{ variable: 'x', value: true }], options: [] }, // 孤岛
    { id: 'e', options: [] },
  ],
};
const r12 = auditAssignments(st12);
const m12 = flatItems(r12);
eq('悬空选项赋值被排除', m12.get('o:a#0#0').status, 'excluded');
eq('原因为悬空跳转', m12.get('o:a#0#0').excludedReason, 'orphanOption');
eq('恒假选项赋值被排除', m12.get('o:a#1#0').status, 'excluded');
eq('原因为选项从未成立', m12.get('o:a#1#0').excludedReason, 'optionNeverEnabled');
eq('孤岛场景赋值被排除', m12.get('s:u#0').status, 'excluded');
eq('孤岛原因', m12.get('s:u#0').excludedReason, 'sceneUnreachable');
eq('可达位置（已消费+未消费+未知）为 0',
  r12.counts.consumed + r12.counts.unconsumed + r12.counts.unknown, 0);
eq('审计分母 total 为 0', r12.counts.total, 0);
eq('排除 3 项', r12.counts.excluded, 3);
ok('排除项不计入已消费/未消费', r12.counts.consumed === 0 && r12.counts.unconsumed === 0);

// ---------- R0：起点前置条件在起点进入赋值之后求值 ----------
console.log('R0 起点前置条件消费起点赋值');
const st13 = {
  startScene: 'a', variables: [{ name: 'k' }],
  scenes: [
    { id: 'a', precondition: 'k', assigns: [{ variable: 'k', value: true }], options: [
      { uid: 'o1', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const m13 = flatItems(auditAssignments(st13));
eq('起点赋值被起点前置条件消费', m13.get('s:a#0').status, 'consumed');
eq('引用类型为场景前置条件', m13.get('s:a#0').witness.reference.type, 'scenePrecondition');
eq('起点引用深度 = 0', m13.get('s:a#0').witness.depth, 0);

// ---------- 起点受阻：不审计任何位置 ----------
console.log('起点受阻');
const st14 = {
  startScene: 'a', variables: [{ name: 'k' }],
  scenes: [
    { id: 'a', precondition: 'k', assigns: [], options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [] },
  ],
};
const r14 = auditAssignments(st14);
eq('起点受阻状态', r14.status, 'start-blocked');
ok('startBlocked 标记', r14.startBlocked === true);
eq('不列出任何分组', r14.groups.length, 0);

// ---------- 缺起点：400 ----------
console.log('参数校验');
ok('缺起点 => 400',
  throws400(() => auditAssignments({ scenes: [{ id: 'a' }] }), /起点/));
ok('起点不存在 => 400',
  throws400(() => auditAssignments({ startScene: 'ghost', scenes: [{ id: 'a' }] }), /起点/));

// ---------- 状态上限截断：未确证项一律未知，绝不判未消费 ----------
console.log('状态上限截断');
const st15 = {
  startScene: 'a', variables: [{ name: 'v' }],
  scenes: [
    { id: 'a', assigns: [{ variable: 'v', value: true }], options: [{ uid: 'o1', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r15 = auditAssignments(st15, { maxStates: 1 });
eq('截断状态', r15.status, 'truncated');
ok('truncated 标记且 complete=false', r15.truncated === true && r15.complete === false);
const m15 = flatItems(r15);
eq('未确证位置标为未知', m15.get('s:a#0').status, 'unknown');
ok('未知项无路线', m15.get('s:a#0').witness === null);
ok('未消费计数为 0（不把未知判为未消费）', r15.counts.unconsumed === 0);
eq('未知计数为 1', r15.counts.unknown, 1);
ok('截断文案明确', /截断/.test(r15.message) && /未知/.test(r15.message));

// 截断前已确证的消费仍保留
const st16 = {
  startScene: 'a', variables: [{ name: 'x' }, { name: 'y' }],
  scenes: [
    { id: 'a', assigns: [
      { variable: 'x', value: true },
      { variable: 'y', value: true },
    ], options: [{ uid: 'r', condition: 'x', target: 'b' }] },
    { id: 'b', options: [{ uid: 'deep', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r16 = auditAssignments(st16, { maxStates: 2 });
const m16 = flatItems(r16);
eq('截断时 x 已在深度 0 确证消费', m16.get('s:a#0').status, 'consumed');
eq('截断时 y 未确证 => 未知（不判未消费）', m16.get('s:a#1').status, 'unknown');

// ---------- 条件语法错误容错（按恒真处理） ----------
console.log('条件语法错误容错');
const st17 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }], options: [
      { uid: 'o1', condition: 'x &&', target: 'b' }, // 语法错误按恒真
    ] },
    { id: 'b', options: [] },
  ],
};
const r17 = auditAssignments(st17);
eq('记录 1 处语法错误', r17.conditionErrors.length, 1);
eq('语法错误条件不读 x：x 未消费', flatItems(r17).get('s:a#0').status, 'unconsumed');
ok('语法错误选项仍可走（b 可达）', r17.counts.reachableScenes === 2);

// ---------- 空变量名的无效赋值不参与（与分析引擎口径一致） ----------
console.log('无效赋值过滤');
const st18 = {
  startScene: 'a', variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', assigns: [{ variable: '', value: true }, { variable: 'x', value: true }],
      options: [{ uid: 'o1', condition: 'x', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r18 = auditAssignments(st18);
eq('只有 1 个有效赋值位置', r18.counts.total + r18.counts.excluded, 1);

// ---------- 确定性：同一草稿两次结果完全一致 ----------
console.log('确定性');
eq('同一剧情两次审计结果一致',
  JSON.stringify(auditAssignments(st11)),
  JSON.stringify(auditAssignments(st11)));

// ---------- 示例剧情：可正常运行并返回结构化结果 ----------
console.log('示例剧情');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rDemo = auditAssignments(demo);
ok('示例剧情审计正常返回', typeof rDemo.status === 'string' && rDemo.counts.states > 0);
ok('示例剧情结果含按场景分组', Array.isArray(rDemo.groups) && rDemo.groups.length > 0);

// ---------- HTTP API ----------
(async () => {
  console.log('HTTP API：');
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const req = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let data = '';
      res.on('data', (x) => { data += x; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    // 草稿审计（不落盘）：请求体即剧情
    const p1 = await req('POST', '/api/assignment-audit', st4);
    ok('POST /api/assignment-audit 返回 200', p1.status === 200);
    ok('目标前置条件消费结论经 API 返回',
      p1.body.status === 'complete' && p1.body.counts.consumed >= 1);

    // { story } 包装形式
    const p1b = await req('POST', '/api/assignment-audit', { story: st2 });
    ok('接受 { story } 包装', p1b.status === 200 && p1b.body.counts.unconsumed === 1);

    // maxStates 注入
    const p1t = await req('POST', '/api/assignment-audit', { story: st15, maxStates: 1 });
    ok('maxStates 注入生效：截断且未知',
      p1t.status === 200 && p1t.body.status === 'truncated' && p1t.body.counts.unknown === 1);

    // 缺起点 400
    const p1e = await req('POST', '/api/assignment-audit', { scenes: [] });
    ok('缺起点返回 400', p1e.status === 400 && /起点/.test(p1e.body.error || ''));

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', st4);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const p2 = await req('GET', `/api/stories/${sid}/assignment-audit`);
    ok('GET /api/stories/:id/assignment-audit 正常',
      p2.status === 200 && p2.body.status === 'complete');
    const p3 = await req('GET', '/api/stories/no-such-id/assignment-audit');
    ok('剧情不存在返回 404', p3.status === 404);

    // 草稿审计不落盘
    const after = await req('GET', `/api/stories/${sid}`);
    ok('审计后剧情内容未被修改',
      JSON.stringify(after.body.scenes) === JSON.stringify(created.body.scenes));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项变量赋值消费审计断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
