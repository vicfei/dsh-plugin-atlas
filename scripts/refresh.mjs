// refresh.mjs — zero-dependency: fetch metadata for every seed slug (GraphQL batches),
// persist data/entries.json, regenerate README.md + README.zh-CN.md.
// Usage: GITHUB_TOKEN=… node scripts/refresh.mjs [--discovery]
// --discovery additionally pulls the GitHub `dsh-plugin` topic (first 1000) into the seeds.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN ?? "";
if (!TOKEN) { console.error("GITHUB_TOKEN required"); process.exit(1); }
const DISCOVERY = process.argv.includes("--discovery");
const GEN_ONLY = process.argv.includes("--generate-only");

const CATEGORIES = [
  ["official", /deepseek-ai\//],
  ["security", /secur|permission|guard|auth|secret|vault|sandbox|injection|approv|policy/i],
  ["memory", /memor|knowledge|rag|retriev|embedd|vector|kb\b/i],
  ["model", /model|provider|llm|api-key|router|ollama|\bgpt\b|\bgemini\b|vllm|litellm/i],
  ["session", /session|history|compact|context|token/i],
  ["git", /git|worktree|branch|commit|pr\b|review/i],
  ["ui", /theme|appearance|sidebar|panel|ui|tui|desktop|status/i],
  ["notify", /notif|webhook|telegram|slack|discord|email|smtp|push/i],
  ["browser", /browser|chrome|firefox|playwright|puppeteer|web\b/i],
  ["voice", /voice|tts|asr|speech|audio/i],
  ["vision", /vision|image|ocr|multimodal/i],
  ["docs", /doc|markdown|render|export|pdf|slide|ppt/i],
  ["workflow", /workflow|automat|cron|schedule|job|pipeline|orchestr|agent-team|swarm|multi-agent/i],
  ["dev", /dev|debug|test|lint|benchmark|profil|log/i],
  ["usage", /usage|cost|billing|quota|price|token-count/i],
  ["remote", /remote|mobile|ssh|vnc|relay|tunnel/i],
  ["identity", /identity|login|account|user/i],
  ["mcp", /mcp|model-context/i],
  ["fun", /pet|fun|game|joke|meme/i],
];

const STALE_DAYS = 60;
const featured = new Set(JSON.parse(readFileSync(new URL("../data/featured.json", import.meta.url), "utf8")));

// ── seeds ──────────────────────────────────────────────────────────────────
const seedPath = new URL("../data/seed-slugs.txt", import.meta.url);
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sanitize = (s) => s.trim().split("#")[0].split("?")[0];
let slugs = readFileSync(seedPath, "utf8").split("\n").map(sanitize).filter((s) => SLUG_RE.test(s));
const seedRaw = readFileSync(seedPath, "utf8").split("\n").map((s) => s.trim()).filter(Boolean).length;
console.log(`seeds: ${seedRaw} raw → ${new Set(slugs).size} clean`);

async function gh(url, init) {
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${TOKEN}`, "user-agent": "dsh-plugin-atlas" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

if (DISCOVERY) {
  for (let page = 1; page <= 10; page++) {
    const q = encodeURIComponent("topic:dsh-plugin");
    const j = await gh(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=100&page=${page}`);
    for (const it of j.items ?? []) slugs.push(it.full_name);
    if ((j.items ?? []).length < 100) break;
    await new Promise((r) => setTimeout(r, 2500)); // search rate limit 30/min
  }
  slugs = [...new Set(slugs)];
  writeFileSync(seedPath, slugs.sort().join("\n") + "\n");
}

slugs = [...new Set(slugs)];

// ── metadata via GraphQL batches of 100 ────────────────────────────────────
slugs = [...new Set(slugs)];
const SKIP_FETCH = GEN_ONLY && existsSync(new URL("../data/entries.json", import.meta.url));
// merge mode: never lose previously fetched entries on a partial (rate-limited) run
const entriesPath = new URL("../data/entries.json", import.meta.url);
const entries = existsSync(entriesPath) ? JSON.parse(readFileSync(entriesPath, "utf8")) : {};
let remaining = SKIP_FETCH ? Number.POSITIVE_INFINITY : (await gh("https://api.github.com/rate_limit")).resources.graphql.remaining;
function absorb(slug, r, out) {
  if (!r) return;
  out[slug] = {
    slug,
    desc: r.description ?? "",
    stars: r.stargazerCount,
    pushedAt: r.pushedAt,
    archived: r.isArchived,
    topics: r.repositoryTopics.nodes.map((n) => n.topic.name),
  };
}

async function batchQuery(slugs, depth = 0) {
  // returns {ok, data} — on poisoned batches, bisect so one dead repo costs ~log2(n) calls
  const body = slugs.map((s, k) => {
    const [owner, name] = s.split("/");
    return `e${k}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { description stargazerCount pushedAt isArchived repositoryTopics(first: 10) { nodes { topic { name } } } }`;
  }).join("\n");
  const q = `query { rateLimit { remaining } ${body} }`;
  let j;
  try {
    j = await gh("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query: q }) });
  } catch (e) {
    j = { errors: [{ message: String(e) }] };
  }
  if (j.errors) {
    if (slugs.length === 1) return { ok: false, dead: slugs[0] };
    if (depth > 6) return { ok: false, dead: `${slugs.length}-slug batch` };
    const mid = Math.floor(slugs.length / 2);
    const a = await batchQuery(slugs.slice(0, mid), depth + 1);
    const b = await batchQuery(slugs.slice(mid), depth + 1);
    return { ok: false, merged: [a, b] };
  }
  const data = {};
  slugs.forEach((s, k) => absorb(s, j.data[`e${k}`], data));
  return { ok: true, data, remaining: j.data.rateLimit.remaining };
}

let done = 0, dead = 0;
for (let i = 0; !SKIP_FETCH && i < slugs.length; i += 100) {
  if (remaining !== -1 && remaining < 60) { console.error(`rate low (${remaining}), stopping at ${i}`); break; }
  const res = await batchQuery(slugs.slice(i, i + 100));
  const collect = (r) => {
    if (r.ok) { Object.assign(entries, r.data); if (r.remaining !== undefined) remaining = r.remaining; done += Object.keys(r.data).length; }
    else if (r.dead) { dead++; }
    else for (const m of r.merged ?? []) collect(m);
  };
  collect(res);
  if ((i / 100) % 10 === 0) console.log(`batch ${i / 100 + 1}/${Math.ceil(slugs.length / 100)} ok=${done} dead=${dead} rate=${remaining} ${new Date().toISOString().slice(11, 19)}`);
  if ((i / 100) % 20 === 19) writeFileSync(new URL("../data/entries.json", import.meta.url), JSON.stringify(entries, null, 0)); // crash-safe
}
console.log(`entries: ${Object.keys(entries).length}/${slugs.length}`);
if (!SKIP_FETCH) writeFileSync(entriesPath, JSON.stringify(entries, null, 0));

// ── generate READMEs ───────────────────────────────────────────────────────
function categoryOf(e) {
  const hay = `${e.slug} ${e.desc} ${e.topics.join(" ")}`;
  for (const [cat, re] of CATEGORIES) if (re.test(hay)) return cat;
  return "tools";
}
const now = Date.now();
const byCat = {};
for (const e of Object.values(entries)) {
  if (e.archived) continue; // atlas maps the living; dead repos sink out of sight
  const cat = categoryOf(e);
  (byCat[cat] ??= []).push(e);
}
const ORDER = ["official", "security", "workflow", "memory", "model", "session", "git", "ui", "tools", "dev", "docs", "notify", "browser", "remote", "mcp", "vision", "voice", "identity", "usage", "fun"];
const CAT_LABEL = {
  official: "Official / official", security: "Security & Permissions", workflow: "Workflow & Multi-Agent", memory: "Memory & Knowledge",
  model: "Models & Providers", session: "Session & Context", git: "Git & Review", ui: "UI & Themes", tools: "Tools & Integrations",
  dev: "Developer Tooling", docs: "Docs & Rendering", notify: "Notifications & Bridges", browser: "Browser & Web", remote: "Remote & Mobile",
  mcp: "MCP Servers", vision: "Vision & Multimodal", voice: "Voice & Audio", identity: "Identity", usage: "Cost & Usage", fun: "Just for Fun",
};
const CAT_LABEL_ZH = {
  official: "官方", security: "安全与权限", workflow: "工作流与多智能体", memory: "记忆与知识库", model: "模型与提供者",
  session: "会话与上下文", git: "Git 与评审", ui: "界面与主题", tools: "工具与集成", dev: "开发者工具", docs: "文档与渲染",
  notify: "通知与桥接", browser: "浏览器", remote: "远程与移动", mcp: "MCP 服务", vision: "视觉", voice: "语音", identity: "身份",
  usage: "成本与用量", fun: "纯玩",
};
const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
const line = (e) => {
  const stale = (now - Date.parse(e.pushedAt)) / 86400000 > STALE_DAYS ? " 💤" : "";
  const feat = featured.has(e.slug) ? " **★**" : "";
  const desc = (e.desc.replace(/\s+/g, " ").trim().slice(0, 140)) || "(no description)";
  return `- [${e.slug}](https://github.com/${e.slug})${feat}${stale} — ${desc} · ⭐${e.stars}`;
};

const header = (zh) => zh
? `# dsh-plugin-atlas · DSH 插件生态活地图

> [English](README.md)

一张**每天自动刷新**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件生态地图:星数实时、60 天未更新自动标记 💤、已归档仓库自动除名。不是又一本静态精选——是数据本身在呼吸。

- 刷新时间(UTC):**${generatedAt}** · 条目:**${Object.values(entries).filter((e) => !e.archived).length}**
- ★ = 本仓库维护者亲自背书的条目;💤 = 60 天未推送
- 收录:加一行 \`data/seed-slugs.txt\` 提 PR 即可;分类由关键词自动推断,欢迎纠偏
- 数据来源:GitHub API 实时元数据;种子链接集自 [Dominic789654/awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness) 与 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 两个公开清单(致谢),条目描述取自各仓库自己的 GitHub description
`
: `# dsh-plugin-atlas — a live map of the DSH plugin ecosystem

> [中文](README.zh-CN.md)

A **daily-refreshed** map of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin ecosystem: live star counts, entries not pushed for 60 days get 💤, archived repos drop out automatically. Not another static awesome list — the data breathes.

- Refreshed (UTC): **${generatedAt}** · entries: **${Object.values(entries).filter((e) => !e.archived).length}**
- ★ = endorsed by this repo's maintainer · 💤 = no push in 60 days
- Add an entry: PR one line to \`data/seed-slugs.txt\`; categories are keyword-inferred and corrections welcome
- Metadata: live from the GitHub API. Seed link set taken from the public lists [Dominic789654/awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (with thanks); every entry's description is that repo's own GitHub description
`;

mkdirSync(new URL("../docs/full/", import.meta.url), { recursive: true });
for (const [file, zh] of [["README.md", false], ["README.zh-CN.md", true]]) {
  let out = header(zh) + "\n";
  out += (zh ? "## 目录\n" : "## Contents\n") + ORDER.filter((c) => byCat[c]?.length).map((c) => `- [${zh ? CAT_LABEL_ZH[c] : CAT_LABEL[c]}](#${c})`).join("\n") + "\n";
  const fullParts = [];
  for (const c of ORDER) {
    const list = byCat[c];
    if (!list?.length) continue;
    list.sort((a, b) => b.stars - a.stars);
    // GitHub truncates multi-MB READMEs — main page caps at 150/category, full lists live in docs/full/
    const CAP = 100;
    const shown = list.slice(0, CAP);
    // chunk oversized full lists — GitHub stops rendering files over ~512KB
    const CHUNK = 900;
    const parts = Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));
    const partName = (i) => parts.length === 1 ? `docs/full/${c}.md` : `docs/full/${c}-${i + 1}.md`;
    const more = list.length > shown.length
      ? `\n\n… ${list.length - shown.length} more → full list: ` + parts.map((_, i) => `[part ${i + 1}](${partName(i)})`).join(" · ")
      : "";
    out += `\n## ${zh ? CAT_LABEL_ZH[c] : CAT_LABEL[c]}\n\n` + shown.map(line).join("\n") + more + "\n";
    parts.forEach((p, i) => writeFileSync(
      new URL(`../${partName(i)}`, import.meta.url),
      `# ${CAT_LABEL[c]} — ${list.length} entries (part ${i + 1}/${parts.length})\n\n> live data · full category export · [back to atlas](../../README.md)\n\n` + p.map(line).join("\n") + "\n",
    ));
  }
  out += `\n---\n\n${zh ? "本地图由 [scripts/refresh.mjs](scripts/refresh.mjs) 生成,GitHub Actions 每日刷新。MIT。" : "Generated by [scripts/refresh.mjs](scripts/refresh.mjs); GitHub Actions refreshes it daily. MIT."}\n`;
  writeFileSync(new URL("../" + file, import.meta.url), out);
  console.log("wrote", file);
}
