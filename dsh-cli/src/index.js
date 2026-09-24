/**
 * dsh-cli 的程序化入口（node API）。
 * 别的 Node 应用可以直接 import 这里的 `callTool` 用全部工具面，不必起 HTTP。
 */

export { callTool, toolCatalog, toolGroups, TOOLS, IMPLEMENTED, TOOLS_PENDING, PARAMS, facts, digest, resolveSession, recordsOf } from './tools.js'
export { startServer, loadEndpoint, endpointPath } from './serve.js'
export { main, COMMANDS, VERSION, usageText, toolUsage, skillHint } from './cli.js'
export { skillCommand } from './skill-command.js'
export { SKILL_FILENAME, skillDir, skillFilePath, skillFileExists, embeddedSkill, skillStatus, installSkill, ensureSkillFile, isSelfContained } from './skill.js'
export { buildRecords, recordsSince } from './step-records.js'
export { listSessions, readEvents, readTailEvents, readSessionHeader, findSession } from './session-log.js'
export { claim, forget, ownershipOf, writeVerdict, runState, loadRegistry } from './ownership.js'
export { makeOut, jsonSafe, OUT_STATUS } from './out.js'
export { checkContract, CONTRACT, findDshBin, instanceState, runHeadless } from './dsh.js'
export { decompressFrames, decompressFramesFrom, walkFrames } from './zstd-frames.js'
export { dshHome, sessionsRoot, stateDir } from './paths.js'
