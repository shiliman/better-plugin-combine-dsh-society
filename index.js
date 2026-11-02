/**
 * dsh-office-catalog —— 只读的"办公厅"
 * =============================================================================
 * 目的：本机所有插件的职能、入口、数据位置、记忆归属，一处可查；查得到就答，
 *       要动手就转交。它自己**不**执行任何部门的能力，也不写任何记忆库。
 *
 * 两个工具：
 *   · office_catalog —— 部门目录：索引 / 单卡详情 / 关键词筛选
 *   · office_ask     —— 跨记忆库检索（主库 + 肥鱼 + QQ + IM），返回摘录与指针
 *
 * 数据来源是现成的：插件 package.json + 包内宿主侧 JS 静态扫出的工具名 + DSH_HOME
 * 下的数据目录 mtime + 四个 meow-memory SQLite 库。全部只读，不落第二份真相：
 * 目录缓存只是"上一轮扫描的 JSON"，过期就重算，不当权威。
 *
 * 扫描/检索脚本放在本包内（scan.mjs / query.mjs），由子进程执行；子进程结果走
 * 文件而不是管道（stdio: 'ignore'），这样在受限沙箱里也能跑。
 * =============================================================================
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveLibs } from './libs.mjs'

export const name = 'office-catalog'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_SCAN = path.join(HERE, 'scan.mjs')
const SCRIPT_QUERY = path.join(HERE, 'query.mjs')

export function apply(ctx, config = {}) {
  const HOME =
    config.dshHome ||
    process.env.DSH_HOME ||
    path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
  const PROFILE = config.profile || process.env.DSH_PROFILE || 'desktop'
  const TIMEOUT = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 30000
  const STATE_DIR = path.join(HOME, 'storages', 'office-catalog')
  const TMP_DIR = path.join(STATE_DIR, 'tmp')
  const CATALOG_CACHE = path.join(STATE_DIR, 'catalog.json')
  // 本次要查的记忆库：配置 > storages/office-catalog/libs.json > 自动探测
  // 延迟到每次调用时算：workspaceRegistry 是可选服务，apply 时未必就绪。
  const currentLibs = () => {
    let workspaces = []
    try {
      workspaces = (ctx?.get?.('workspaceRegistry')?.list?.() || []).map((w) => w?.path).filter(Boolean)
    } catch {
      /* 没有 workspaceRegistry（或其他宿主）就只按常见位置探测 */
    }
    return resolveLibs({ HOME, stateDir: STATE_DIR, config, workspaces })
  }

  const rows = [] // 进度/错误记录，便于排错
  const log = (evt) => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.appendFileSync(path.join(STATE_DIR, 'office.log'), JSON.stringify({ t: new Date().toISOString(), ...evt }) + '\n', 'utf8')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  // ---------- 子进程：跑脚本，结果走文件 ----------
  function resolveNode() {
    const cands = []
    if (config.nodePath) cands.push(String(config.nodePath))
    if (process.env.DSH_NODE) cands.push(process.env.DSH_NODE)
    const rt = path.join(HOME, 'dsh-runtimes')
    try {
      for (const e of fs.readdirSync(rt, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        cands.push(path.join(rt, e.name, 'dependencies', 'node', 'bin', 'node.exe'))
        cands.push(path.join(rt, e.name, 'dependencies', 'node', 'bin', 'node'))
      }
    } catch {
      /* 没有 runtimes 就往下走 */
    }
    cands.push(process.execPath)
    for (const c of cands) {
      try {
        if (c && fs.existsSync(c)) return c
      } catch {
        /* skip */
      }
    }
    return null
  }

  function runScript(nodeExe, script, args) {
    return new Promise((resolve) => {
      if (!nodeExe) return resolve({ ok: false, error: 'no-node' })
      let settled = false
      const finish = (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      let child
      const timer = setTimeout(() => {
        try {
          child?.kill()
        } catch {
          /* skip */
        }
        finish({ ok: false, error: 'timeout' })
      }, TIMEOUT)
      try {
        child = spawn(nodeExe, [script, ...args], {
          cwd: HERE,
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch (e) {
        return finish({ ok: false, error: String(e) })
      }
      child.on('error', (e) => finish({ ok: false, error: String(e) }))
      child.on('close', (code) => finish({ ok: code === 0, code }))
    })
  }

  function tmpFile(tag) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
    return path.join(TMP_DIR, `${tag}-${process.pid}-${Date.now()}.json`)
  }
  function readJsonSafe(p) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      return null
    }
  }
  function cleanup(p) {
    try {
      if (p) fs.unlinkSync(p)
    } catch {
      /* skip */
    }
  }

  // ---------- 扫描 ----------
  async function scanCatalog() {
    const nodeExe = resolveNode()
    if (!nodeExe) {
      log({ evt: 'no-node' })
      return { ok: false, error: 'no-node' }
    }
    const out = tmpFile('scan')
    const libs = currentLibs()
    // 留痕：这次到底查了哪几个库。探测失败时用户能从日志看出"只探测到 N 个"而不是静默少查。
    log({ evt: 'scan-libs', count: libs.length, ids: libs.map((l) => l[0]) })
    const args = ['--out', out, '--home', HOME, '--profile', PROFILE, '--dbs', JSON.stringify(libs)]
    const res = await runScript(nodeExe, SCRIPT_SCAN, args)
    const catalog = res.ok ? readJsonSafe(out) : null
    cleanup(out)
    if (!catalog) {
      log({ evt: 'scan-failed', res })
      return { ok: false, error: res.error || `scan-exit-${res.code}` }
    }
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(CATALOG_CACHE, JSON.stringify(catalog, null, 1), 'utf8')
    } catch {
      /* 缓存失败不影响本次结果 */
    }
    log({ evt: 'scan-ok', ms: catalog.scanMs, departments: catalog.counts?.departments })
    return { ok: true, catalog }
  }

  function cacheAgeMs() {
    try {
      return Date.now() - fs.statSync(CATALOG_CACHE).mtimeMs
    } catch {
      return Infinity
    }
  }

  // ---------- 格式化 ----------
  const short = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    return t.length <= n ? t : t.slice(0, n) + '…'
  }
  const fmtTime = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const fmtBytes = (n) => {
    const v = Number(n) || 0
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + 'MB'
    if (v >= 1024) return Math.round(v / 1024) + 'KB'
    return v + 'B'
  }

  function indexLine(d) {
    const bits = [`${d.name} ${d.version}`, short(d.duty, 26), `T${d.tools.length}`]
    if (d.memory?.total) bits.push(`M${d.memory.total}`)
    if (d.data?.last?.mtime) bits.push(`@${fmtTime(d.data.last.mtime)}`)
    return '· ' + bits.join(' ｜ ')
  }

  function formatIndex(catalog) {
    const c = catalog.counts || {}
    const head =
      `办公厅索引：${c.departments} 个部门 / ${c.tools} 个工具 / ${c.memoryRows} 条记忆` +
      `（扫描 ${catalog.scanMs}ms · ${fmtTime(catalog.generatedAt)}）\n` +
      `T=工具数 M=记忆条数 @=数据目录最后活动。看详情：office_catalog {"name":"<包名>"}；搜：{"q":"关键词"}`
    const lines = catalog.departments.map(indexLine)
    const empty = catalog.departments.filter((d) => d.tools.length === 0).map((d) => d.name)
    const tail = empty.length
      ? `\n注：${empty.length} 个包未静态识别到工具名（可能只提供设置页/按钮/路由，或工具名由变量拼装）：${empty.join('、')}`
      : ''
    return [head, '', ...lines, tail].join('\n')
  }

  function formatCard(d) {
    const out = []
    out.push(`■ ${d.name} ${d.version} · ${d.title}`)
    out.push(`职能：${d.duty}`)
    if (d.desc && d.desc !== d.duty) out.push(`说明：${short(d.desc, 320)}`)
    out.push(
      d.tools.length
        ? `工具（${d.tools.length}）：${d.tools.join(', ')}`
        : `工具：未静态识别到（该包可能只提供设置页/按钮/HTTP 路由，或工具名由变量拼装）`,
    )
    out.push(`入口：${d.entries?.length ? d.entries.join('；') : '未静态识别（多为设置页或按钮，见说明）'}`)
    if (d.data) {
      out.push(
        `数据：${d.data.path}（${fmtBytes(d.data.bytes)}；最后 ${d.data.last?.file || '—'} @ ${fmtTime(d.data.last?.mtime)}）`,
      )
      if (d.data.logs?.length) out.push(`日志：${d.data.logs.slice(0, 3).join(', ')}`)
    } else {
      out.push('数据：无独立数据目录（无状态或数据在别处）')
    }
    out.push(
      d.memory?.total
        ? `记忆：${d.memory.total} 条（project=${d.memory.project}${d.memory.updatedAt ? '，最近 ' + fmtTime(d.memory.updatedAt) : ''}）`
        : '记忆：无同名 project（条目可能挂在「全局」或别的 project 名下）',
    )
    out.push(`形态：${d.form}${d.engineGap ? ' ｜ engines.dsh ' + d.engineGap : ''}`)
    out.push(`包目录：${d.dir}`)
    out.push(`边界：${d.boundary}`)
    return out.join('\n')
  }

  function matchDepartments(catalog, q) {
    const terms = String(q)
      .split(/[\s,，。；;、/|]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    if (!terms.length) return []
    const scored = []
    for (const d of catalog.departments) {
      const hay = [d.name, d.title, d.duty, d.desc, ...(d.tools || [])].join(' ').toLowerCase()
      let s = 0
      for (const t of terms) if (hay.includes(t)) s++
      if (s) scored.push([s, d])
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name))
    return scored.map(([, d]) => d)
  }

  // ---------- 输出契约（工具对象在定义时就要引用它，必须先声明） ----------
  const renderOutput = (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ]
  const output = { schema: { type: 'string' }, render: renderOutput }

  // ---------- 工具 1：部门目录 ----------
  const catalogTool = {
    name: 'office_catalog',
    description:
      '只读的"办公厅"目录：本机所有 DSH 插件的职能、对外工具名、设置页入口、数据目录与记忆条数。不传参数给索引（每个部门一行：一句话职能 + 工具数 + 记忆数）；传 name 给单个部门的详情卡；传 q 按关键词筛。要动手做具体的事，先在这里查"归哪个部门、入口在哪"，再转交或直接调用它的工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '部门（插件包名或标题），如 meow-memory；给则返回详情卡' },
        q: { type: 'string', description: '关键词，如"贴吧""记忆""B站"；给则在名字/职能/说明/工具名里筛' },
        limit: { type: 'integer', description: 'q 模式最多返回几张，默认 6' },
      },
    },
    output,
    async execute(args) {
      const { ok, catalog, error } = await scanCatalog()
      if (!ok) return `办公厅扫描失败：${error}。脚本 ${SCRIPT_SCAN} 无法执行（可能是 node 路径或权限问题）。先看 ${STATE_DIR}\\office.log。`
      const name = String(args?.name || '').trim()
      const q = String(args?.q || '').trim()
      const limit = Math.max(1, Math.min(40, Number(args?.limit) || 6))
      if (name) {
        const hit =
          catalog.departments.find((d) => d.name.toLowerCase() === name.toLowerCase()) ||
          catalog.departments.find((d) => d.name.toLowerCase().includes(name.toLowerCase())) ||
          catalog.departments.find((d) => String(d.title).toLowerCase().includes(name.toLowerCase()))
        if (!hit) {
          const near = matchDepartments(catalog, name).slice(0, 5)
          return `没有 ${name} 这个部门。` + (near.length ? `相近的：${near.map((d) => d.name).join('、')}` : '用不带参数的 office_catalog 看全部。')
        }
        return formatCard(hit)
      }
      if (q) {
        const hits = matchDepartments(catalog, q)
        if (!hits.length) return `没有命中"${q}"的部门。用不带参数的 office_catalog 看全部 ${catalog.departments.length} 个。`
        const top = hits.slice(0, limit)
        const lines = top.map(
          (d) => `■ ${d.name} ${d.version} · ${d.title}\n  职能：${d.duty}\n  入口：${d.entries?.length ? d.entries.join('；') : '未静态识别'} ｜ 工具 ${d.tools.length} ｜ 记忆 ${d.memory?.total || 0}`,
        )
        return `关键词"${q}"命中 ${hits.length} 个部门：\n\n${lines.join('\n\n')}` + (hits.length > top.length ? `\n\n（只列前 ${top.length} 个；要详情用 office_catalog {"name":"..."}）` : '')
      }
      return formatIndex(catalog)
    },
    presentCall() {
      return { card: 'generic', title: 'office_catalog', kind: 'other' }
    },
  }

  // ---------- 工具 2：跨库检索 ----------
  const askTool = {
    name: 'office_ask',
    description:
      '跨记忆库检索（meow-memory 的多个库：主库与各工作区/桥接库，可用配置或 libs.json 指定）：拿关键词/问句去查，返回相关部门的入口提示 + 记忆摘录与指针（库/表/记忆 id/时间/分数）。用于"这件事以前有没有记过、归哪个部门、在哪看到过"。它只读、不改库；要读全文用 memory_read（仅主库 id 可用），外部库的条目这里给摘录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '关键词（空格分隔多个更准，如"贴吧 日报 签到"），不要整段长句' },
        limit: { type: 'integer', description: '最多返回几条记忆摘录，默认 8' },
        libs: { type: 'string', description: '只查某几个库，逗号分隔：main,fish,qq,im；默认全部' },
      },
    },
    output,
    async execute(args) {
      const query = String(args?.query || '').trim()
      if (!query) return 'office_ask 需要 query（关键词，空格分隔多个更准）。'
      const limit = Math.max(1, Math.min(30, Number(args?.limit) || 8))
      const nodeExe = resolveNode()
      if (!nodeExe) return '跨库检索不可用：找不到可执行的 node（检查 DSH_HOME/dsh-runtimes 或给插件配置 nodePath）。'

      const out = tmpFile('ask')
      const dbsJson = JSON.stringify(currentLibs())
      const askArgs = ['--query', query, '--limit', String(limit), '--out', out, '--home', HOME, '--dbs', dbsJson]
      const libs = String(args?.libs || '').trim()
      if (libs) askArgs.push('--libs', libs)
      const res = await runScript(nodeExe, SCRIPT_QUERY, askArgs)
      const data = res.ok ? readJsonSafe(out) : null
      cleanup(out)
      if (!data) {
        log({ evt: 'ask-failed', res })
        return `跨库检索失败：${res.error || `query-exit-${res.code}`}。脚本 ${SCRIPT_QUERY}；日志 ${STATE_DIR}\\office.log。`
      }

      // 目录：优先用 10 分钟内的缓存，过期就重扫（成本 ~1s）
      let catalog = cacheAgeMs() < 10 * 60 * 1000 ? readJsonSafe(CATALOG_CACHE) : null
      if (!catalog) {
        const fresh = await scanCatalog()
        catalog = fresh.ok ? fresh.catalog : null
      }

      const lines = []
      const libStats = (data.libs || [])
        .map((l) => `${l.id}:${l.ok ? l.rows : 'ERR'}`)
        .join(' / ')
      lines.push(`问：${query} ｜ 词：${(data.terms || []).join(', ')} ｜ 扫 ${data.scanned} 行（${libStats}）`)
      lines.push(`命中 ${data.totalHits || 0} 条，返回 ${(data.hits || []).length} 条。`)

      if (catalog) {
        const deps = matchDepartments(catalog, query).slice(0, 4)
        if (deps.length) {
          lines.push('')
          lines.push('可能相关的部门：')
          for (const d of deps) {
            lines.push(
              `- ${d.name} · ${d.title}（工具 ${d.tools.length}，记忆 ${d.memory?.total || 0}；入口 ${d.entries?.length ? d.entries.join('；') : '未静态识别'}）`,
            )
          }
        }
      }

      if (data.hits?.length) {
        lines.push('')
        lines.push('记忆命中：')
        data.hits.forEach((h, i) => {
          lines.push(
            `${i + 1}. [${h.lib}/${h.table}]${h.project ? ' ' + h.project : ''} · ${h.id} · ${fmtTime(h.updatedAt)} · 分 ${h.score}` +
              (h.status !== 'active' ? `（${h.status}）` : ''),
          )
          lines.push(`   ${short(h.excerpt, 260)}`)
        })
        lines.push('')
        const mainIds = data.hits.filter((h) => h.lib === 'main').map((h) => h.id)
        lines.push(
          mainIds.length
            ? `主库条目可用 memory_read {"id":"${mainIds[0]}"} 读全文；外部库（非主库）的条目这里只给摘录。`
            : '命中的都是外部库，这里只给摘录；要全文得去那个库自己的会话。',
        )
      } else {
        lines.push('')
        lines.push('没有记忆命中。可换更短、更具体的词再试；或先用不带参数的 office_catalog 看有哪些部门。')
      }
      return lines.join('\n')
    },
    presentCall() {
      return { card: 'generic', title: 'office_ask', kind: 'other' }
    },
  }

  for (const tool of [catalogTool, askTool]) {
    try {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') rows.push(dispose)
    } catch (error) {
      log({ evt: 'register-failed', tool: tool.name, message: String(error) })
    }
  }

  // 系统提示里留一行索引（服务可能晚于本插件就绪，重试挂载）
  let sectionDone = false
  const trySection = (attempt) => {
    if (sectionDone) return
    let service
    try {
      service = ctx.get?.('systemPrompt')
    } catch {
      service = undefined
    }
    if (!service || typeof service.section !== 'function') {
      if (attempt < 20) setTimeout(() => trySection(attempt + 1), 1000)
      return
    }
    try {
      const dispose = service.section({
        name: 'office-catalog:index',
        order: 132,
        text: '【办公厅】本机插件分属不同"部门"（刷贴吧/刷B站/QQ/记忆/画布…），各有自己的设置页与数据目录。要搞清"这事归谁、入口在哪、以前记过什么"，先 office_catalog 查目录（不传参数=索引，传 name=详情），跨记忆库查过往用 office_ask。两条都只读；要动手请用该部门自己的工具，或告诉用户去它的设置页。',
      })
      sectionDone = true
      if (typeof dispose === 'function') rows.push(dispose)
      log({ evt: 'section-registered' })
    } catch (error) {
      sectionDone = true
      log({ evt: 'section-error', message: String(error) })
    }
  }
  trySection(0)

  log({ evt: 'applied', home: HOME, profile: PROFILE })
}
