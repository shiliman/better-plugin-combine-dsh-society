# 办公厅 · Office Catalog for DSH

> 装了一堆插件之后，你还记得哪个管什么吗？

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装一个**只读的"前台"**：它知道本机每个插件是干什么的、对外有哪些工具、设置页在哪、数据存在哪儿、以前有没有记过什么。但它不替你干活——要动手，它告诉你该找谁。

---

## 它解决什么

DSH 的插件天生是"各部门各管一摊"：刷贴吧、刷 B 站、QQ 桥、记忆、画布、Office……每个都有自己的设置页、数据目录和记忆库。这样每个都能自己判断，代价是**彼此不认识**。

于是每问一句「这东西归谁管」「上次那个配置在哪改的」「这事以前记过没有」，都得把每一张卡翻一遍。

这个插件只做三件事：

1. **目录**——把每个插件变成一张卡（一句话职能 / 工具名 / 入口 / 数据位置 / 记忆条数 / 最后活动时间）；
2. **检索**——平时只留一行索引，问到了才展开；跨 meow-memory 的多个库查过往；
3. **转交**——能答就答，要动手就把你交给原来的部门，不代跑。

模型的上下文装不下三十张卡，但它装得下「一个工具，按需查」。

---

## 两个工具

### `office_catalog`

| 参数 | 说明 |
|---|---|
| 不传 | 返回索引：每个部门一行 `包名 版本 ｜ 一句话职能 ｜ T工具数 M记忆数 @最后活动` |
| `name` | 单个部门的详情卡（职能 / 工具列表 / 入口 / 数据目录 / 记忆 / 宿主要求 / 包目录 / 边界） |
| `q` | 按关键词筛部门（名字、职能、说明、工具名） |
| `limit` | `q` 模式最多返回几张，默认 6 |

### `office_ask`

| 参数 | 说明 |
|---|---|
| `query` | 必填。关键词，空格分隔更准（如 `贴吧 日报 签到`），别整段长句 |
| `limit` | 返回几条记忆摘录，默认 8 |
| `libs` | 只查某几个库，逗号分隔（id 由你的配置决定） |

返回：命中的部门 + 记忆摘录（库 / 表 / 记忆 id / 时间 / 分数）+ "要读全文用 memory_read" 的指针。

两个工具都是**只读**的：不写记忆库、不改插件配置、不执行任何部门的能力。

---

## 安装

1. 把这个仓库放到任意目录（比如 `~/dsh-plugins/dsh-office-catalog`）；
2. 在 DSH 里装本地 bundle：

```
plugin_manager  action: install_bundle  target: <上面那个目录的绝对路径>
```

3. 看到 `application: "applied"` 即生效；宿主侧插件代码改动需要重启一次 DSH 客户端（`index.js` 是宿主侧，`scan.mjs` / `query.mjs` 是子进程脚本，改后者不用重启）。
4. 试一下：让它「列出办公厅目录」或「查一下刷贴吧的插件归谁管」。

依赖只有 Node.js ≥ 22.5（用到内置 `node:sqlite`），不需要 npm install，没有第三方包。

---

## 配置

写在 `cordis.patch.yml` 的 `config` 里（或安装时传）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | DSH 家目录 |
| `profile` | `desktop` | 读哪个 profile 的 `node_modules` |
| `nodePath` | 自动探测 | 跑扫描脚本用的 node。默认找 `$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node`，最后回退到宿主进程自己的 node |
| `timeoutMs` | `30000` | 单次扫描/检索超时 |
| `memoryLibs` | 自动探测 | 记忆库列表 `[["main","C:\\...\\memory.db"], ...]` |

记忆库的三种指定方式，优先级从高到低：

1. 插件配置 `memoryLibs`；
2. `<DSH_HOME>/storages/office-catalog/libs.json`（手写一个 JSON 数组）；
3. 自动探测：`<DSH_HOME>/../.dsh-meow/memory.db`、`<DSH_HOME>/.dsh-meow/memory.db`、`<DSH_HOME>/{im,qq,fish}/.dsh-meow/memory.db`——**探到才算**，一个都没探到就是空的（不报错，卡片上如实写"无记忆库"）。

> meow-memory 的库按工作区散落，路径因机器而异，所以默认是"探测"而不是写死。

---

## 数据从哪来（全部只读）

| 字段 | 来源 |
|---|---|
| 名字 / 版本 / 说明 | 插件的 `package.json`，以及包内 `locale/*.json` 的 `meta.title/description` |
| 一句话职能 | 从 `description` 提炼：去掉 `DSH 插件 ·` 前缀，取第一个分句，截 42 字 |
| 工具名 | **静态扫**包内宿主侧 JS（`name: 'xxx' … parameters:`、常量表、`tools.register({...})`），跳过 `client*.js` 与注释行 |
| 设置页入口 | 扫 `client*.js` 里有没有 `settings.section` 注册 |
| 数据目录 | 插件 `package.json` 的 `dsh.dataDir` 优先，其次按包名 / 去 `dsh-` 前缀 / `-scroll→-duty` 在 `$DSH_HOME/storages` 与 `$DSH_HOME` 下探测 |
| 最后活动 | 数据目录里最新文件的 mtime（只统计，不打开） |
| 记忆条数 | 只读打开 meow-memory 的 SQLite，按 `project` 列分组计数 |

一次扫描几十个插件约 1 秒，结果缓存在 `$DSH_HOME/storages/office-catalog/catalog.json`，过期就重扫。

---

## 三条设计原则

1. **不建第二份真相。** 目录缓存只是"上一轮扫描的 JSON"，不是权威；插件改了版本、数据动过，下次扫描就变。它不复制任何部门的内容，只存指针。
2. **只读。** 不写记忆库、不改配置、不执行部门能力、不碰密钥。要动手就转交。
3. **懒更新。** 没有后台轮询、没有守护进程。查询时比一下缓存时间，过期就重扫。

---

## 已知边界

- **静态扫描只能看到字面量。** 工具名如果是运行时拼的（`'diagram_' + action`）、跨文件变量、或被压缩混淆，扫不到。卡片会如实写「未静态识别」，不会猜。
- **外部记忆库只给摘录**（默认 240 字），要全文得去那个库自己的会话。
- **它不执行任何东西。** 它不会替你回帖、发消息、改配置——那是各部门自己的事。
- 英文插件的"职能"会直接出英文，没有翻译层。
- 只支持 meow-memory 的库结构；别的记忆插件需要在 `query.mjs` 里改表名与列名。

---

## 卸载

```
plugin_manager  action: remove_bundle  target: dsh-office-catalog
```

`$DSH_HOME/storages/office-catalog/`（缓存、日志、`libs.json`）可以一并删掉，删了下次重扫会重建。

---

## 目录结构

```
dsh-office-catalog/
├─ index.js           宿主侧：注册 office_catalog / office_ask、spawn 脚本、系统提示一行
├─ scan.mjs           扫描器（只读）：产出 catalog.json
├─ query.mjs          检索器（只读）：跨库关键词检索
├─ cordis.patch.yml   bundle 描述
├─ package.json
├─ locale/            en.json / zh-CN.json（标题与说明）
├─ icon.svg
├─ docs/
│  ├─ DESIGN.md       三层结构、五条硬约束、为什么不用向量库
│  └─ catalog.sample.json  一份脱敏的示例输出
└─ examples/
   └─ tiny_host.py    最小宿主示例：不装 DSH 也能读同一份 catalog.json
```

---

## License

MIT
