#!/usr/bin/env node
/**
 * 办公厅检索器（只读）
 * 跨记忆库按关键词检索，返回摘录 + 指针（库/表/记忆 id），不做向量、不写库。
 *
 * 用法：
 *   node query.mjs --query "关键词 关键词" [--limit 8] [--libs main,fish] [--out result.json]
 * 参数：
 *   --dbs <json>   覆盖库列表：[["main","C:\\...\\memory.db"], ...]
 *   --out <path>   把结果 JSON 写文件（插件靠文件取结果，不依赖管道）
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
const DEFAULT_DBS = probeLibs(HOME)
let DBS = parseDbs(opt.dbs) || DEFAULT_DBS
const libFilter = String(opt.libs || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (libFilter.length) DBS = DBS.filter(([id]) => libFilter.includes(id))

const query = String(opt.query || '').trim()
const limit = Math.max(1, Math.min(30, Number(opt.limit) || 8))
const contentMax = Math.max(80, Math.min(2000, Number(opt.contentMax) || 240))

const TABLES = [
  ['project', 'project'],
  ['fact', 'fact'],
  ['lesson', 'lesson'],
  ['topic', 'topic'],
  ['rules', 'rules'],
  ['user', 'user'],
  ['soul', 'soul'],
]

function termsOf(q) {
  const raw = String(q || '')
    .split(/[\s,，。；;、/|()（）【】\[\]"'“”]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  for (const t of raw) {
    if (t.length <= 24) out.push({ t, w: 1 })
  }
  // 中文长句没有空格可切，补一组 3-gram 提高召回（整词权重 1，gram 权重 0.25）；
  // 英文词/包名不拆（拆了只会命中 "dsh" 这种噪声）。
  if (out.length === 1 && /[\u3400-\u9fff]/.test(out[0].t) && out[0].t.length >= 6) {
    const s = out[0].t
    for (let i = 0; i + 3 <= s.length; i += 2) out.push({ t: s.slice(i, i + 3), w: 0.25 })
  }
  const seen = new Set()
  const uniq = []
  for (const x of out) {
    if (seen.has(x.t)) continue
    seen.add(x.t)
    uniq.push(x)
  }
  return uniq.slice(0, 12)
}
function countAll(hay, needle) {
  if (!needle) return 0
  let n = 0
  let i = 0
  while ((i = hay.indexOf(needle, i)) >= 0) {
    n++
    i += needle.length
  }
  return n
}
function trim(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : t.slice(0, n) + '…'
}
function iso(ms) {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}

const terms = termsOf(query)
const result = {
  query,
  terms: terms.map((x) => x.t),
  limit,
  libs: [],
  hits: [],
  perLib: {},
  scanned: 0,
}

if (!terms.length) {
  result.error = 'empty-query'
} else {
  for (const [id, dbPath] of DBS) {
    const lib = { id, path: dbPath, ok: false, rows: 0, tables: {}, error: null }
    if (!fs.existsSync(dbPath)) {
      lib.error = 'missing'
      result.libs.push(lib)
      continue
    }
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
      lib.tables = {}
      for (const [t, level] of TABLES) {
        if (!tables.has(t)) continue
        const cols = new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name))
        const hasProject = cols.has('project')
        const sql = `SELECT id, title, content, keywords, status, updated_at${hasProject ? ', project' : ''} FROM "${t}"`
        let rows
        try {
          rows = db.prepare(sql).all()
        } catch {
          continue
        }
        lib.rows += rows.length
        lib.tables[t] = rows.length
        for (const row of rows) {
          if (String(row.status || 'active') === 'archived') continue
          const content = String(row.content || '')
          const title = String(row.title || '')
          const kw = String(row.keywords || '')
          let score = 0
          let matched = 0
          for (const term of terms) {
            const inC = Math.min(countAll(content, term.t), 4)
            const inT = title.includes(term.t) ? 1 : 0
            const inK = kw.includes(term.t) ? 1 : 0
            const part = (inC + inT * 4 + inK * 3) * term.w
            if (part > 0) matched++
            score += part
          }
          if (score <= 0) continue
          // 命中词数比单字重复更重要；但 3-gram 会多命中，封顶 4 个
          score = score * (1 + 0.35 * Math.min(matched, 4))
          result.perLib[id] = (result.perLib[id] || 0) + 1
          result.hits.push({
            lib: id,
            table: t,
            level,
            id: row.id,
            project: hasProject ? (row.project ?? null) : null,
            title: title ? trim(title, 60) : null,
            status: row.status || 'active',
            updatedAt: iso(row.updated_at),
            score: Math.round(score * 100) / 100,
            excerpt: trim(content, contentMax),
          })
        }
      }
      lib.ok = true
      db.close()
    } catch (e) {
      lib.error = String(e.message || e)
      try {
        db?.close()
      } catch {
        /* skip */
      }
    }
    result.scanned += lib.rows
    result.libs.push(lib)
  }
  result.hits.sort((a, b) => b.score - a.score)
  const top = result.hits.slice(0, limit)
  result.totalHits = result.hits.length
  result.hits = top
}

const payload = JSON.stringify(result, null, 1)
if (typeof opt.out === 'string' && opt.out) {
  fs.mkdirSync(path.dirname(opt.out), { recursive: true })
  fs.writeFileSync(opt.out, payload, 'utf8')
}
console.log(
  JSON.stringify({
    query: result.query,
    terms: result.terms,
    scanned: result.scanned,
    totalHits: result.totalHits ?? 0,
    returned: result.hits.length,
    libs: result.libs.map((l) => `${l.id}:${l.ok ? l.rows : 'ERR'}`),
    out: typeof opt.out === 'string' ? opt.out : null,
  }),
)
