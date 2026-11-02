#!/usr/bin/env node
/**
 * 办公厅扫描器（只读）
 * 扫描本机 DSH profile 里的插件包 + 四个记忆库，生成"部门目录卡" catalog.json。
 * 不做任何写操作，不碰插件数据目录以外的文件，不启动任何东西。
 *
 * 用法：
 *   node scan.mjs --out <catalog.json 路径> [--brief]
 * 参数：
 *   --home <DSH_HOME>        默认 %USERPROFILE%\.dsh
 *   --profile <name>         默认 desktop
 *   --out <path>             输出路径（不写就只打印统计）
 *   --brief                  只在 stdout 打印统计，不打印整份 JSON
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseDbs, probeLibs } from './libs.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const key = a.slice(2)
  const next = argv[i + 1]
  if (next && !next.startsWith('--')) {
    opt[key] = next
    i++
  } else {
    opt[key] = true
  }
}

const HOME = opt.home || process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const PROFILE = path.join(HOME, 'profiles', String(opt.profile || 'desktop'))
const NM = path.join(PROFILE, 'node_modules')
const STORAGES = path.join(HOME, 'storages')

// 记忆库列表：优先用插件传来的 --dbs（[["main","...memory.db"], ...]），
// 否则按常见位置探测（meow-memory 的库按工作区散落，路径因机器而异）。
const MEMORY_DBS = parseDbs(opt.dbs) || probeLibs(HOME)

const MEMORY_TABLES = ['project', 'fact', 'lesson', 'topic', 'rules', 'user', 'soul']

// ---------- 小工具 ----------
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
function statOf(p) {
  try {
    const s = fs.statSync(p)
    return { bytes: s.size, mtime: s.mtime.toISOString() }
  } catch {
    return null
  }
}
function dirSize(p) {
  let total = 0
  const walk = (dir, depth) => {
    if (depth > 4) return
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = path.join(dir, e.name)
      try {
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.isFile()) total += fs.statSync(full).size
      } catch {
        /* skip */
      }
    }
  }
  walk(p, 0)
  return total
}
function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}
// 打包产物里的字符串常量可能写成 \u4FEE 形式，这里还原成可读中文
function decodeEscapes(s) {
  return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}
function clamp(s, n) {
  const t = oneLine(s)
  return t.length <= n ? t : t.slice(0, n) + '…'
}

// 从 description 里提炼一句话职能：去掉"DSH 插件 · "，取第一个分句，截 42 字
function dutyOf(desc) {
  let d = oneLine(decodeEscapes(desc)).replace(/^DSH\s*插件\s*[·•]\s*/, '')
  d = d.split(/[。；;\n]/)[0]
  d = d.replace(/^[\s:：]+/, '')
  return clamp(d, 42)
}
// 从 description 里提炼短标题："刷贴吧：每天替你看贴吧…" → 刷贴吧
function titleOf(desc) {
  const d = oneLine(decodeEscapes(desc))
  const m = d.match(/DSH\s*插件\s*[·•]\s*([^：:，,。（(]{1,20})/)
  if (m) return m[1].trim()
  const m2 = d.match(/^([^：:，,。（(]{1,20})[：:]/)
  if (m2) return m2[1].trim()
  return ''
}

// 递归收集包内宿主侧 js（跳过 node_modules 与 client*.js —— 工具只注册在宿主侧）
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'docs'])
function walkJs(dir, depth = 0, acc = [], budget = { n: 0 }) {
  if (depth > 6 || budget.n > 600) return acc
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of ents) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walkJs(full, depth + 1, acc, budget)
    } else if (e.isFile() && /\.(js|mjs|cjs)$/i.test(e.name)) {
      const base = e.name.toLowerCase()
      if (base.includes('client')) continue
      try {
        const st = fs.statSync(full)
        if (st.size > 8 * 1024 * 1024) continue
        acc.push(full)
        budget.n++
      } catch {
        /* skip */
      }
    }
  }
  return acc
}

// 扫包内全部宿主侧 js，提取"工具定义"特征：name 紧跟 parameters 的对象。
// 有些插件把工具名写成常量（export const TOOL_NAME = 'video_storyboard'），
// 所以先建包级常量表，再解析 name: SOMECONST。
function scanToolNames(pkgDir, entryFiles) {
  const names = new Set()
  const files = walkJs(pkgDir)
  const srcs = []
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8')
      // 去掉整行注释：注释里的示例（name: 'xxx' … parameters:）会被正则当成真工具
      const src = raw
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .join('\n')
      srcs.push([f, src])
    } catch {
      /* skip */
    }
  }
  const constMap = new Map()
  for (const [, src] of srcs) {
    const re = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([a-z][a-z0-9_]{1,48})['"]/g
    let m
    while ((m = re.exec(src))) constMap.set(m[1], m[2])
  }
  for (const [, src] of srcs) {
    // 字面量：name: 'xxx' … parameters:
    const re1 = /\bname:\s*['"]([a-z][a-z0-9_]{1,48})['"][\s\S]{0,800}?\bparameters:/g
    let m
    while ((m = re1.exec(src))) names.add(m[1])
    // 常量：name: TOOL_NAME … parameters:
    const re3 = /\bname:\s*([A-Za-z_$][\w$]*)[\s\S]{0,800}?\bparameters:/g
    while ((m = re3.exec(src))) {
      const v = constMap.get(m[1])
      if (v) names.add(v)
    }
    // 直接注册：tools.register({ name: 'xxx' ...
    const re2 = /tools\s*\.\s*register\s*\(\s*\{[\s\S]{0,160}?\bname:\s*['"]([a-z][a-z0-9_]{1,48})['"]/g
    while ((m = re2.exec(src))) names.add(m[1])
  }
  const NOISE = new Set(['xxx', 'foo', 'bar', 'baz', 'test', 'example'])
  return [...names].filter((n) => !NOISE.has(n)).sort()
}

// 静态找"设置页入口"：client.js 里出现 settings.section / settingsSection 注册
function scanEntries(pkgDir, clientFile) {
  const entries = []
  const files = []
  if (clientFile) files.push(path.join(pkgDir, clientFile))
  try {
    for (const e of fs.readdirSync(pkgDir, { withFileTypes: true })) {
      if (e.isFile() && /^client.*\.js$/.test(e.name)) files.push(path.join(pkgDir, e.name))
    }
  } catch {
    /* skip */
  }
  for (const f of files) {
    let src
    try {
      src = fs.readFileSync(f, 'utf8')
    } catch {
      continue
    }
    // settings.section / settings.sections.register 都算贡献了设置页
    if (/settings\s*\.\s*sections?\s*\.?\s*(register|section)?/.test(src) || /\bsection:\s*\{/.test(src)) {
      // 尝试抓 title（只接受短标签；带标点或过长说明抓到的是一句句子，宁可只写"设置页"）
      const t = src.match(/\btitle:\s*['"]([^'"]{1,24})['"]/)
      const label = t ? decodeEscapes(t[1]).trim() : ''
      const okLabel = label && label.length <= 10 && !/[，。；：、,.;]/.test(label)
      entries.push('设置页' + (okLabel ? '→' + label : ''))
    }
    break
  }
  return [...new Set(entries)]
}

// 数据目录体检：存在性、体积、最新文件时间、是否有日志
const HOME_DIR_BLACKLIST = new Set([
  'attachments', 'backups', 'bin', 'cache', 'dsh-runtimes', 'integrations', 'plugin-cache',
  'plugins', 'profiles', 'sessions', 'sessions-archive', 'shared', 'skills', 'storages',
  'telemetry', 'tools',
])
function probeDataDir(dir) {
  let last = null
  const logFiles = []
  const walk = (d, depth) => {
    if (depth > 3) return
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = path.join(d, e.name)
      try {
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.isFile()) {
          const st = fs.statSync(full)
          if (!last || st.mtime > last.mtime) last = { name: e.name, path: path.relative(dir, full), mtime: st.mtime, bytes: st.size }
          if (/\.(log|jsonl)$/i.test(e.name)) logFiles.push(path.relative(dir, full))
        }
      } catch {
        /* skip */
      }
    }
  }
  walk(dir, 0)
  return {
    path: dir,
    bytes: dirSize(dir),
    last: last ? { file: last.path || last.name, mtime: last.mtime.toISOString(), bytes: last.bytes } : null,
    logs: logFiles.slice(0, 5),
  }
}
function dataDirOf(pkgName, pj) {
  const bare = String(pkgName).split('/').pop()
  const short = bare.replace(/^dsh-/, '')
  const cands = []
  // 包自己声明的目录名优先（"dsh": { "dataDir": "office-catalog" }）
  const declared = pj?.dsh?.dataDir
  if (typeof declared === 'string' && declared.trim()) {
    const d = declared.trim()
    cands.push(path.isAbsolute(d) ? d : path.join(STORAGES, d), path.isAbsolute(d) ? d : path.join(HOME, d))
  }
  for (const c of [pkgName, bare, short]) {
    cands.push(path.join(STORAGES, c), path.join(HOME, c))
  }
  for (const c of [short, bare]) {
    if (/-scroll$/.test(c)) {
      const duty = c.replace(/-scroll$/, '-duty')
      cands.push(path.join(HOME, duty), path.join(STORAGES, duty))
    }
  }
  for (const dir of cands) {
    const base = path.basename(dir)
    if (HOME_DIR_BLACKLIST.has(base)) continue
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return probeDataDir(dir)
  }
  return null
}

// ---------- 记忆库统计（只读） ----------
function memoryStats(dbs) {
  const libs = []
  const byProject = {} // project -> { tables: {fact:n,...}, updatedAt }
  const byProjectAll = {} // 任何表里出现过的 project 名（含 fact/lesson 上的标签）
  for (const [label, p] of dbs) {
    const entry = { id: label, path: p, ok: false }
    if (!fs.existsSync(p)) {
      entry.error = 'missing'
      libs.push(entry)
      continue
    }
    let db
    try {
      db = new DatabaseSync(p, { readOnly: true })
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
      )
      entry.tables = {}
      let total = 0
      for (const t of MEMORY_TABLES) {
        if (!tables.has(t)) continue
        const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
        entry.tables[t] = n
        total += n
      }
      entry.rows = total
      entry.ok = true
      // project 表最权威：逐行统计归属
      if (tables.has('project')) {
        for (const row of db.prepare('SELECT project, COUNT(*) AS n, MAX(updated_at) AS u FROM project GROUP BY project').all()) {
          const key = String(row.project || '(未标记)')
          const slot = (byProject[key] ||= { tables: {}, updatedAt: 0, lib: label })
          slot.tables.project = (slot.tables.project || 0) + row.n
          slot.updatedAt = Math.max(slot.updatedAt, row.u || 0)
        }
      }
      // 其他表上的 project 标签（同一条记忆可能是跨表散落）
      for (const t of ['fact', 'lesson', 'topic', 'rules']) {
        if (!tables.has(t)) continue
        let rows = []
        try {
          rows = db.prepare(`SELECT project, COUNT(*) AS n FROM "${t}" WHERE project IS NOT NULL AND project <> '' GROUP BY project`).all()
        } catch {
          continue
        }
        for (const row of rows) {
          const key = String(row.project)
          const slot = (byProjectAll[key] ||= { tables: {}, lib: label })
          slot.tables[t] = (slot.tables[t] || 0) + row.n
        }
      }
      db.close()
    } catch (e) {
      entry.error = String(e.message || e)
      libs.push(entry)
      continue
    }
    libs.push(entry)
  }
  // 合并两个视图
  for (const [k, v] of Object.entries(byProjectAll)) {
    const slot = (byProject[k] ||= { tables: {}, updatedAt: 0, lib: v.lib })
    for (const [t, n] of Object.entries(v.tables)) slot.tables[t] = (slot.tables[t] || 0) + n
  }
  const projects = Object.entries(byProject)
    .map(([name, v]) => ({
      project: name,
      total: Object.values(v.tables).reduce((a, b) => a + b, 0),
      tables: v.tables,
      updatedAt: v.updatedAt ? new Date(v.updatedAt).toISOString() : null,
      lib: v.lib,
    }))
    .sort((a, b) => b.total - a.total)
  return { libs, projects }
}

// ---------- 插件包扫描 ----------
function listPackageDirs() {
  const out = []
  if (!fs.existsSync(NM)) return out
  for (const ent of fs.readdirSync(NM, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(NM, ent.name)
    if (ent.name.startsWith('@')) {
      let subs = []
      try {
        subs = fs.readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of subs) if (s.isDirectory() || s.isSymbolicLink()) out.push(path.join(full, s.name))
      continue
    }
    if (ent.isDirectory() || ent.isSymbolicLink()) out.push(full)
  }
  return out
}

function scanPackages() {
  const pkgs = []
  const skipped = []
  for (const dir of listPackageDirs()) {
    const pjPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pjPath)) {
      skipped.push({ dir: path.basename(dir), reason: 'no package.json' })
      continue
    }
    let pj
    try {
      pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
    } catch (e) {
      skipped.push({ dir: path.basename(dir), reason: 'bad json: ' + e.message })
      continue
    }
    const dsh = pj.dsh && typeof pj.dsh === 'object' ? pj.dsh : null
    const isPlugin = !!dsh || /^dsh[-_]/.test(pj.name || '') || /deepseek|dsh/i.test(String(pj.keywords || ''))
    if (!isPlugin) {
      skipped.push({ dir: path.basename(dir), reason: 'not a dsh plugin' })
      continue
    }
    // 入口文件
    let entry = []
    if (typeof pj.main === 'string') entry.push(pj.main)
    if (pj.exports && typeof pj.exports === 'object') {
      for (const v of Object.values(pj.exports)) {
        if (typeof v === 'string') entry.push(v)
        else if (v && typeof v === 'object') for (const vv of Object.values(v)) if (typeof vv === 'string') entry.push(vv)
      }
    } else if (typeof pj.exports === 'string') entry.push(pj.exports)
    entry = [...new Set(entry.filter((v) => v.endsWith('.js')))].map((v) => v.replace(/^\.\//, ''))

    const clientFile =
      (dsh && typeof dsh.client === 'string' ? dsh.client.replace(/^\.\//, '') : null) ||
      (entry.find((f) => /client/.test(f)) || null)

    let localeTitle = ''
    let localeDesc = ''
    const locDir = path.join(dir, 'locale')
    for (const locName of ['zh.json', 'zh-CN.json', 'en.json']) {
      const loc = readJson(path.join(locDir, locName))
      if (loc) {
        const meta = loc.meta || loc.$meta || loc
        if (typeof meta.title === 'string') localeTitle = meta.title
        if (typeof meta.description === 'string') localeDesc = meta.description
        if (localeTitle) break
      }
    }

    const desc = oneLine(decodeEscapes(pj.description || localeDesc || ''))
    const tools = scanToolNames(dir, entry)
    const entries = scanEntries(dir, clientFile)
    const data = dataDirOf(pj.name || path.basename(dir), pj)

    pkgs.push({
      name: pj.name || path.basename(dir),
      version: String(pj.version || '?'),
      title: localeTitle || titleOf(desc) || (pj.name || path.basename(dir)),
      duty: dutyOf(desc),
      description: desc,
      tools,
      entries,
      data,
      form: dsh ? (dsh.client ? 'host+client' : 'host') : 'plain',
      engines: (pj.engines && pj.engines.dsh) || null,
      dir,
    })
  }
  pkgs.sort((a, b) => a.name.localeCompare(b.name))
  return { pkgs, skipped }
}

// ---------- 主流程 ----------
const t0 = Date.now()
const mem = memoryStats(MEMORY_DBS)
const { pkgs, skipped } = scanPackages()

// 把记忆归属挂到部门卡上：按包名 + 常见别名匹配 project 名
const projIndex = new Map(mem.projects.map((p) => [p.project, p]))
function memFor(pkgName) {
  const hit = projIndex.get(pkgName)
  if (hit) return { project: pkgName, total: hit.total, tables: hit.tables, updatedAt: hit.updatedAt }
  return null
}

const departments = pkgs.map((p) => ({
  name: p.name,
  version: p.version,
  title: p.title,
  duty: p.duty,
  tools: p.tools,
  entries: p.entries,
  form: p.form,
  memory: memFor(p.name),
  data: p.data,
  dir: p.dir,
  boundary: '只读目录卡；要动手请转交给该部门自己的会话/工具',
  engineGap: p.engines || null,
}))

const catalog = {
  generatedAt: new Date().toISOString(),
  scanMs: Date.now() - t0,
  host: {
    dshHome: HOME,
    profile: path.dirname(PROFILE).endsWith('profiles') ? path.basename(PROFILE) : PROFILE,
    profileDir: PROFILE,
    storages: STORAGES,
    node: process.version,
  },
  counts: {
    departments: departments.length,
    skipped: skipped.length,
    memoryLibs: mem.libs.filter((l) => l.ok).length,
    memoryLibsEmpty: mem.libs.filter((l) => l.ok && l.rows === 0).length,
    memoryRows: mem.libs.reduce((a, l) => a + (l.rows || 0), 0),
    tools: departments.reduce((a, d) => a + d.tools.length, 0),
  },
  memoryLibs: mem.libs,
  memoryProjects: mem.projects,
  departments,
  skipped: skipped.slice(0, 40),
}

if (opt.out) {
  fs.mkdirSync(path.dirname(String(opt.out)), { recursive: true })
  fs.writeFileSync(String(opt.out), JSON.stringify(catalog, null, 1), 'utf8')
}

const brief = {
  scanMs: catalog.scanMs,
  counts: catalog.counts,
  topProjects: mem.projects.slice(0, 12).map((p) => `${p.project}:${p.total}`),
  emptyTools: departments.filter((d) => d.tools.length === 0).map((d) => d.name),
  out: opt.out ? String(opt.out) : null,
}
console.log(JSON.stringify(brief, null, 1))
if (!opt.brief && !opt.out) console.log(JSON.stringify(catalog, null, 1))
