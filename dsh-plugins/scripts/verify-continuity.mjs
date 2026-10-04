// scripts/verify-continuity.mjs —— dsh-continuity / handoff 的自动验证。
//
// 覆盖两块：
//   A. core.js 的纯逻辑（用桩 deps，不碰真实 DSH_HOME、不建真实会话）
//   B. 包结构 / 伞仓约定（版本字段、install.ps1、无凭证、patch 节头规范）
//
// 用法: node scripts/verify-continuity.mjs

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectHandoffState,
  findPlanText,
  renderBrief,
  runHandoff,
  shortId,
  slugifyCwd,
  stamp,
} from '../plugins/dsh-continuity-dsh-plugin/plugins/handoff/core.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(root, 'plugins', 'dsh-continuity-dsh-plugin');
const payloadDir = join(pkgDir, 'plugins', 'handoff');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed += 1; console.log(`  ok - ${name}`); }
  else { failures += 1; console.error(`  FAIL - ${name}`); }
};

/** 构造一份可控的桩环境。 */
function makeEnv({ goal = null, todos = null, planGet = { active: false }, messages = [] } = {}) {
  const calls = { stateOf: [], created: [], goalCreated: [], paused: [], seeded: [], files: [] };
  const home = mkdtempSync(join(tmpdir(), 'continuity-verify-'));
  const deps = {
    stateOf: (session, key) => {
      calls.stateOf.push(key);
      if (key === 'goal') return { current: goal, seenGoalIds: [], failure: null };
      if (key === 'todos') return todos;
      return undefined;
    },
    planMode: { get: () => planGet },
    goals: {
      create: (agent, request) => { calls.goalCreated.push({ agent, request }); return { ok: true }; },
      pause: (...args) => { calls.paused.push(args); },
    },
    agents: {
      resolveAgent: async (sessionId) => ({ agent: { id: sessionId, session: { id: sessionId } } }),
      presetForSession: () => 'standard',
    },
    workspaces: () => [{ id: 'ws-1', sessionIds: [SRC_ID], path: 'G:\\project\\demo' }],
    createSession: async (request) => { calls.created.push(request); return { sessionId: NEW_ID }; },
    home: () => home,
    now: () => new Date('2026-10-04T13:00:00Z'),
    mkdir: async () => {},
    writeFile: async (path, text) => { calls.files.push({ path, text }); },
    seed: async (agent, text) => { calls.seeded.push({ agent, text }); },
  };
  return { deps, calls, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const SRC_ID = 'session-11111111-2222-3333-4444-555555555555';
const NEW_ID = 'session-99999999-8888-7777-6666-555555555555';

function makeAgent() {
  return {
    session: {
      id: SRC_ID,
      header: { cwd: 'G:\\project\\demo' },
      deriveMessages: () => ENV_MESSAGES,
    },
  };
}

const ENV_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '帮我做 A 功能' }] },
  { role: 'assistant', content: [{ type: 'text', text: '先看代码结构' }] },
  {
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCall: { name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 计划\n1. 改 core\n2. 跑测试' }) },
    }],
  },
  { role: 'user', content: [{ type: 'text', text: '批准，开始干' }] },
];

async function main() {
  console.log('1. 纯函数');
  {
    ok(slugifyCwd('G:\\project\\dsh-ecosystem') === 'G-project-dsh-ecosystem', '1-1 slugifyCwd 去掉非法字符');
    ok(slugifyCwd(undefined) === 'unknown-workspace', '1-2 slugifyCwd 兜底');
    ok(shortId(SRC_ID) === '11111111', '1-3 shortId 取前 8 位');
    ok(/^\d{8}-\d{6}$/.test(stamp(new Date('2026-10-04T13:05:09Z'))), '1-4 stamp 形如 YYYYMMDD-HHmmss');
  }

  console.log('2. plan 文本抽取（容错形状）');
  {
    ok(findPlanText(ENV_MESSAGES)?.includes('# 计划'), '2-1 toolCall.arguments 为 JSON 字符串');
    ok(findPlanText([{ content: [{ toolCall: { name: 'exit_plan_mode', input: { plan: 'P2' } } }] }]) === 'P2', '2-2 input 为对象');
    ok(findPlanText([{ a: { b: [{ name: 'exit_plan_mode', args: { plan: 'P3' } }] } }]) === 'P3', '2-3 深层嵌套');
    ok(findPlanText([{ content: [{ type: 'text', text: 'no plan here' }] }]) === undefined, '2-4 无计划返回 undefined');
  }

  console.log('3. 状态收集');
  {
    const { deps, cleanup } = makeEnv({
      goal: { goal: { id: 'goal-1', revision: 3, objective: '交付 X', phase: 'paused', maxGoalRounds: 12 }, roundsStarted: 5 },
      todos: [{ content: '改 core', status: 'in_progress' }, { content: '跑测试', status: 'pending' }],
    });
    const state = collectHandoffState(deps, makeAgent());
    ok(state.goal.goal.objective === '交付 X', '3-1 读到 goal objective');
    ok(state.todos.length === 2, '3-2 读到 todo 快照');
    ok(state.planText?.includes('# 计划'), '3-3 读到计划文本');
    ok(state.planActive === false, '3-4 plan 未激活');
    ok(state.cwd === 'G:\\project\\demo', '3-5 读到 cwd');
    const brief = renderBrief(state, { now: new Date('2026-10-04T13:00:00Z'), note: '注意缓存' });
    ok(brief.includes('交付 X') && brief.includes('# 计划'), '3-6 brief 含目标与计划');
    ok(brief.includes('[~] 改 core') && brief.includes('[ ] 跑测试'), '3-7 brief 含 todo 勾选表');
    ok(brief.includes('注意缓存'), '3-8 brief 含交接备注');
    ok(brief.includes('轮次计数归零'), '3-9 brief 声明 goal 轮次归零');
    cleanup();
  }

  console.log('4. 计划模式 → 拒绝');
  {
    const env = makeEnv({ planGet: { active: true } });
    const result = await runHandoff(env.deps, { agent: makeAgent() });
    ok(result.kind === 'error', '4-1 返回 error');
    ok(result.text.includes('拒绝'), '4-2 说明拒绝原因');
    ok(env.calls.created.length === 0, '4-3 没有创建会话');
    ok(env.calls.files.length === 0, '4-4 没有写交接文档');
    env.cleanup();
  }

  console.log('5. dry-run');
  {
    const env = makeEnv({ goal: { goal: { id: 'g', revision: 1, objective: 'O', phase: 'active', maxGoalRounds: 4 }, roundsStarted: 1 } });
    const result = await runHandoff(env.deps, { agent: makeAgent(), dryRun: true });
    ok(result.kind === 'success' && result.dryRun === true, '5-1 成功且标记 dry-run');
    ok(env.calls.created.length === 0, '5-2 没有创建会话');
    ok(env.calls.files.length === 2, '5-3 写了 <base>.md 与 latest.md 两份');
    ok(env.calls.files.some((f) => f.path.endsWith('latest.md')), '5-4 含 latest.md');
    ok(env.calls.files[0].path.includes(join('handoff', 'G-project-demo')), '5-5 落在 handoff/<workspace>/ 下');
    ok(env.calls.seeded.length === 0, '5-6 没有播种');
    env.cleanup();
  }

  console.log('6. 完整执行');
  {
    const env = makeEnv({
      goal: { goal: { id: 'g', revision: 7, objective: '交付 X', phase: 'paused', maxGoalRounds: 9 }, roundsStarted: 6 },
      todos: [{ content: 'a', status: 'pending' }],
    });
    const result = await runHandoff(env.deps, { agent: makeAgent(), note: '接着干' });
    ok(result.kind === 'success', '6-1 成功');
    ok(result.sessionId === NEW_ID, '6-2 返回新会话 id');
    ok(env.calls.created.length === 1, '6-3 恰好创建 1 个会话');
    ok(env.calls.created[0].workspaceId === 'ws-1', '6-4 用源会话所在 workspace');
    ok(env.calls.created[0].preset === 'standard', '6-5 继承源 preset');
    ok(env.calls.created[0].cwd === undefined || env.calls.created[0].cwd === 'G:\\project\\demo', '6-6 workspaceId 与 cwd 不冲突');
    ok(env.calls.goalCreated.length === 1, '6-7 克隆 goal 一次');
    ok(env.calls.goalCreated[0].request.objective === '交付 X', '6-8 objective 一致');
    ok(env.calls.goalCreated[0].request.maxGoalRounds === 9, '6-9 maxGoalRounds 继承');
    ok(env.calls.paused.length === 0, '6-10 不保持 paused（用户决定）');
    ok(env.calls.seeded.length === 1, '6-11 播种一次（followup 唤醒 → 自动执行）');
    ok(env.calls.seeded[0].text.includes(result.briefPath), '6-12 首条消息带交接文档路径');
    ok(env.calls.seeded[0].text.includes('交付 X'), '6-13 首条消息内联目标');
    ok(env.calls.seeded[0].text.includes('接着干'), '6-14 首条消息内联备注');
    ok(result.goalCloned === true, '6-15 报告 goal 已克隆');
    env.cleanup();
  }

  console.log('7. 边界：无 goal / goal 已 complete');
  {
    const env = makeEnv();
    const r1 = await runHandoff(env.deps, { agent: makeAgent() });
    ok(r1.kind === 'success' && env.calls.goalCreated.length === 0, '7-1 无 goal 时不克隆、仍交接');
    env.cleanup();

    const env2 = makeEnv({ goal: { goal: { id: 'g', revision: 2, objective: 'O', phase: 'complete', maxGoalRounds: 3 }, roundsStarted: 3 } });
    await runHandoff(env2.deps, { agent: makeAgent() });
    ok(env2.calls.goalCreated.length === 0, '7-2 goal 已 complete 时不克隆');
    env2.cleanup();
  }

  console.log('8. 失败路径');
  {
    const env = makeEnv();
    env.deps.createSession = async () => { throw new Error('boom'); };
    const r = await runHandoff(env.deps, { agent: makeAgent() });
    ok(r.kind === 'error' && r.briefPath, '8-1 建会话失败仍保留交接文档路径');
    ok(env.calls.seeded.length === 0, '8-2 没有播种');
    env.cleanup();

    const env2 = makeEnv();
    env2.deps.agents.resolveAgent = async () => ({ error: new Error('gone') });
    const r2 = await runHandoff(env2.deps, { agent: makeAgent() });
    ok(r2.kind === 'error' && r2.sessionId === NEW_ID, '8-3 agent 解析失败时报告已建会话 id');
    env2.cleanup();

    const r3 = await runHandoff({}, { agent: undefined });
    ok(r3.kind === 'error', '8-4 没有会话时给出可读错误');
  }

  console.log('9. 包结构 / 伞仓约定');
  {
    const files = readdirSync(payloadDir).sort();
    ok(files.includes('index.js') && files.includes('package.json') && files.includes('core.js'), `9-1 载荷文件齐备(${files.join(', ')})`);
    const pkgJson = JSON.parse(readFileSync(join(payloadDir, 'package.json'), 'utf8'));
    ok(/^\d+\.\d+\.\d+$/.test(pkgJson.version), '9-2 package.json 带 SemVer version');
    const indexSrc = readFileSync(join(payloadDir, 'index.js'), 'utf8');
    ok(indexSrc.includes('export const version'), '9-3 index.js 导出 version');
    ok(indexSrc.includes("export const name = 'tool-handoff'"), '9-4 服务名 tool-handoff');
    ok(indexSrc.includes('ctx.inject([\'commands\']'), '9-5 命令面为可选挂载(headless 可装)');
    ok(indexSrc.includes("source: { kind: 'plugin', plugin:"), '9-6 播种消息带 plugin 来源');
    const installPath = join(pkgDir, 'install.ps1');
    const readmePath = join(pkgDir, 'README.md');
    ok(existsSync(installPath), '9-7 自带 install.ps1');
    ok(existsSync(readmePath), '9-8 自带 README');
    const installSrc = existsSync(installPath) ? readFileSync(installPath, 'utf8') : '';
    const readmeSrc = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
    ok(installSrc.includes('-Encoding UTF8'), '9-9 install.ps1 读 patch 带 -Encoding UTF8');
    ok(installSrc.includes('# --- ${pkg}: $svcId (native dsh) ---'), '9-10 patch 节头符合规范(dsh-<pkg>: <svc>)');
    ok(installSrc.includes('-Only') && installSrc.includes('-Uninstall'), '9-10b 支持 -Only 子集与 -Uninstall');
    ok(readmeSrc.includes('plan mode') && readmeSrc.includes('拒绝'), '9-10c README 写明 plan 模式拒绝语义');
    const skillPath = join(root, 'skills', 'install-continuity', 'SKILL.md');
    ok(existsSync(skillPath), '9-11 配套安装技能存在');
    const allPayload = readdirSync(payloadDir)
      .filter((f) => statSync(join(payloadDir, f)).isFile())
      .map((f) => readFileSync(join(payloadDir, f), 'utf8'))
      .join('\n');
    ok(!/sk-[A-Za-z0-9]{16,}|ARK_API_KEY\s*=\s*["'][^"']+["']/.test(allPayload), '9-12 载荷内无真实 key');
    ok(statSync(payloadDir).isDirectory(), '9-13 载荷目录形态');
    if (existsSync(installPath)) {
      const head = readFileSync(installPath).subarray(0, 3);
      ok(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf,
        '9-14 install.ps1 带 UTF-8 BOM（PS 5.1 无 BOM 会按 ANSI 解码中文注释导致解析失败）');
    } else {
      ok(false, '9-14 install.ps1 带 UTF-8 BOM');
    }
  }

  console.log('10. patch 校验器回归（普通行条目不再被误判）');
  {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-patch-'));
    const good = join(dir, 'good.yml');
    writeFileSync(good, [
      '- insert:',
      "    - id: tool-handoff",
      "      name: './plugins/handoff/index.js'",
      '- id: ui-theme',
      '  name: "@deepseek-ai/dsh-client-ui-theme"',
      '  config:',
      '    preference: dark',
      '',
    ].join('\n'));
    const bad = join(dir, 'bad.yml');
    writeFileSync(bad, [
      '- id: tool-x',
      '  name: "x"',
      '  config:',
      '    # comment right after bare config key swallows the next line',
      '    requireApproval: false',
      '',
    ].join('\n'));
    const rGood = spawnSync(process.execPath, [join(root, 'scripts', 'validate-patch.mjs'), good], { encoding: 'utf8' });
    ok(rGood.status === 0, '10-1 insert 条目 + 普通行条目 → 通过（2026-10-04 修正的误判）');
    const rBad = spawnSync(process.execPath, [join(root, 'scripts', 'validate-patch.mjs'), bad], { encoding: 'utf8' });
    ok(rBad.status === 1, '10-2 裸 config: 后紧跟注释仍被判失败（守护能力未减弱）');
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('');
  if (failures === 0) {
    console.log(`verify-continuity: ALL PASS (${passed} checks)`);
    process.exit(0);
  }
  console.error(`verify-continuity: ${failures} FAILED, ${passed} passed`);
  process.exit(1);
}

await main();
