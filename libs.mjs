/**
 * 记忆库定位（只读）。
 *
 * 宿主插件（index.js）与两个子进程脚本（scan.mjs / query.mjs）共用这一份逻辑，
 * 避免"三处各写一遍、改一处忘两处"。
 *
 * 优先级：插件配置 memoryLibs > <DSH_HOME>/storages/office-catalog/libs.json > 自动探测
 *   - 自动探测：DSH 家目录附近的常见位置
 *   - 加上宿主工作区注册表里每个工作区的 <工作区>/.dsh-meow/memory.db（meow-memory 的主库默认在这里）
 */
import fs from 'node:fs'
import path from 'node:path'

/** 手写的库列表：<stateDir>/libs.json，形如 [["main","/abs/path/memory.db"], ...] */
export function customLibs(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, 'libs.json'), 'utf8'))
    if (Array.isArray(j)) {
      const ok = j.filter((x) => Array.isArray(x) && x.length >= 2 && fs.existsSync(String(x[1])))
      if (ok.length) return ok
    }
  } catch {
    /* 没有自定义就往下探测 */
  }
  return null
}

/**
 * 自动探测。workspaces = 工作区目录绝对路径数组（宿主能拿到，子进程拿不到）。
 * 只收真实存在的 memory.db，其余静默跳过。
 */
export function probeLibs(HOME, workspaces = []) {
  const cands = [
    ['main', path.join(HOME, '..', '.dsh-meow', 'memory.db')], // 与 DSH 家目录同级
    ['main', path.join(HOME, '.dsh-meow', 'memory.db')],
    ['im', path.join(HOME, 'im', '.dsh-meow', 'memory.db')],
    ['qq', path.join(HOME, 'qq', '.dsh-meow', 'memory.db')],
    ['fish', path.join(HOME, 'fish', '.dsh-meow', 'memory.db')],
  ]
  for (const ws of workspaces) {
    const p = String(ws || '')
    if (!p) continue
    cands.push([path.basename(p) || 'workspace', path.join(p, '.dsh-meow', 'memory.db')])
  }
  const seen = new Set()
  const out = []
  for (const [id, p] of cands) {
    try {
      if (!p || seen.has(p) || !fs.existsSync(p)) continue
      seen.add(p)
      out.push([id, p])
    } catch {
      /* skip */
    }
  }
  return out
}

/** 解析 --dbs 参数；坏 JSON 或路径全不存在时返回 null（调用方回退探测）。 */
export function parseDbs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const ok = parsed.filter((x) => Array.isArray(x) && x.length >= 2 && fs.existsSync(String(x[1])))
    return ok.length ? ok : null
  } catch {
    return null
  }
}

/** 宿主侧入口：配置 > libs.json > 探测。 */
export function resolveLibs({ HOME, stateDir, config = {}, workspaces = [] }) {
  if (Array.isArray(config.memoryLibs) && config.memoryLibs.length) return config.memoryLibs
  return customLibs(stateDir) || probeLibs(HOME, workspaces)
}
