#!/usr/bin/env python3
"""最小宿主示例：不装 DSH，也能读同一份目录 + 查同一批记忆库。

用途：任何 Python 程序（桌宠、面板、CLI）都可以复用办公厅的数据，
不必重新实现一遍扫描逻辑。

    python tiny_host.py "catalog.json"            # 打印索引
    python tiny_host.py "catalog.json" "贴吧 日报"  # 跨库检索

catalog.json 由 scan.mjs 产出：
    node scan.mjs --out catalog.json --home <你的 DSH_HOME>
"""

import json
import os
import sqlite3
import sys

TABLES = ("project", "fact", "lesson", "topic", "rules", "user", "soul")


def load_catalog(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def print_index(cat):
    c = cat.get("counts") or {}
    print("办公厅：%s 个部门 / %s 个工具 / %s 条记忆（扫描 %sms）"
          % (c.get("departments"), c.get("tools"), c.get("memoryRows"), cat.get("scanMs")))
    for d in cat.get("departments") or []:
        bits = ["%s %s" % (d.get("name"), d.get("version")), (d.get("duty") or "")[:26]]
        bits.append("T%d" % len(d.get("tools") or []))
        if (d.get("memory") or {}).get("total"):
            bits.append("M%d" % d["memory"]["total"])
        print("· " + " ｜ ".join(bits))


def terms_of(q):
    """空格/标点切词；中文长句补 3-gram（与 query.mjs 同一套规则）。"""
    raw = [t for t in __import__("re").split(r"[\s,，。；;、/|()（）【】\[\]\"'“”]+", q or "") if t]
    out = [{"t": t, "w": 1.0} for t in raw if len(t) <= 24]
    if len(out) == 1 and len(out[0]["t"]) >= 6 and __import__("re").search(r"[\u3400-\u9fff]", out[0]["t"]):
        s = out[0]["t"]
        for i in range(0, len(s) - 2, 2):
            out.append({"t": s[i:i + 3], "w": 0.25})
    seen, uniq = set(), []
    for x in out:
        if x["t"] not in seen:
            seen.add(x["t"])
            uniq.append(x)
    return uniq[:12]


def search(cat, query, limit=8, content_max=240):
    terms = terms_of(query)
    hits = []
    for lib in cat.get("memoryLibs") or []:
        path = lib.get("path")
        if not lib.get("ok") or not path or not os.path.exists(path):
            continue
        db = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
        try:
            have = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for t in TABLES:
                if t not in have:
                    continue
                cols = {r[1] for r in db.execute('PRAGMA table_info("%s")' % t)}
                proj = ", project" if "project" in cols else ""
                rows = db.execute(
                    'SELECT id, title, content, keywords, status, updated_at%s FROM "%s"' % (proj, t)
                ).fetchall()
                for row in rows:
                    rid, title, content, kws, status, upd = row[:6]
                    if (status or "active") == "archived":
                        continue
                    body = content or ""
                    title = title or ""
                    kws = kws or ""
                    score, matched = 0.0, 0
                    for term in terms:
                        cnt = min(body.count(term["t"]), 4)
                        part = (cnt + (4 if term["t"] in title else 0) + (3 if term["t"] in kws else 0)) * term["w"]
                        if part > 0:
                            matched += 1
                        score += part
                    if score <= 0:
                        continue
                    score *= 1 + 0.35 * min(matched, 4)
                    excerpt = body[:content_max].replace("\n", " ")
                    hits.append((score, lib["id"], t, rid, proj and row[6] or None, upd, excerpt))
        finally:
            db.close()
    hits.sort(reverse=True)
    return hits[:limit]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cat = load_catalog(sys.argv[1])
    if len(sys.argv) < 3:
        print_index(cat)
        return 0
    q = sys.argv[2]
    hits = search(cat, q)
    print("问：%s ｜ 命中 %d 条" % (q, len(hits)))
    for i, (score, lib, table, rid, proj, upd, excerpt) in enumerate(hits, 1):
        print("%d. [%s/%s]%s · %s · 分 %.2f" % (i, lib, table, " " + proj if proj else "", rid, score))
        print("   " + excerpt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
