const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Token",
};
const MAX_EXTRA_JSON_CHARS = 200000;
const MAX_FONT_INVENTORY_FONTS = 2500;
const MAX_FONT_INVENTORY_ALIAS_KEYS = 2500;
const MAX_FONT_ALIAS_VALUES = 12;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function adminOk(request, env) {
  const expected = env.ADMIN_TOKEN || "";
  if (!expected) return false;
  const auth = request.headers.get("Authorization") || "";
  const token = request.headers.get("X-Admin-Token") || auth.replace(/^Bearer\s+/i, "");
  return token && token === expected;
}

function cleanText(value, max = 120) {
  return String(value || "").slice(0, max);
}

function uniqueTexts(values, maxItems, maxChars = 160) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = cleanText(String(value || "").replace(/\s+/g, " ").trim(), maxChars);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function compactFontKey(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  for (const token of [" ", "-", "_", ".", "regular", "normal", "常规", "標準", "标准"]) {
    text = text.split(token).join("");
  }
  return text;
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function preferredFontName(names) {
  const cleanNames = uniqueTexts(names, 32);
  if (!cleanNames.length) return "";
  const chinese = cleanNames.filter(hasChinese);
  const pool = chinese.length ? chinese : cleanNames;
  return [...pool].sort((a, b) => (a.length - b.length) || a.localeCompare(b, "zh-CN"))[0];
}

function compactFontInventory(fonts, aliases, limit) {
  const groups = new Map();
  const rawAliases = aliases && typeof aliases === "object" ? aliases : {};
  for (const font of Array.isArray(fonts) ? fonts : []) {
    const cleanFont = cleanText(String(font || "").replace(/\s+/g, " ").trim(), 160);
    if (!cleanFont) continue;
    const names = [cleanFont, ...(Array.isArray(rawAliases[cleanFont]) ? rawAliases[cleanFont] : [])];
    const keys = names.map(compactFontKey).filter(Boolean).sort((a, b) => a.length - b.length);
    const groupKey = keys[0] || compactFontKey(cleanFont);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(...names);
  }
  const compacted = [];
  const seen = new Set();
  for (const names of groups.values()) {
    const preferred = preferredFontName(names);
    const key = compactFontKey(preferred);
    if (!preferred || seen.has(key)) continue;
    seen.add(key);
    compacted.push(preferred);
    if (compacted.length >= limit) break;
  }
  return compacted.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function trimExtra(event, extra) {
  if (!extra || typeof extra !== "object") return {};
  if (event !== "font_inventory") return extra;
  const aliases = {};
  const rawAliases = extra.aliases && typeof extra.aliases === "object" ? extra.aliases : {};
  const seenAliasKeys = new Set();
  for (const [key, values] of Object.entries(rawAliases)) {
    const cleanKey = cleanText(String(key || "").replace(/\s+/g, " ").trim(), 160);
    const foldedKey = compactFontKey(cleanKey);
    if (!cleanKey || seenAliasKeys.has(foldedKey)) continue;
    const cleanValues = uniqueTexts(values, MAX_FONT_ALIAS_VALUES);
    if (!cleanValues.length) continue;
    seenAliasKeys.add(foldedKey);
    aliases[cleanKey] = cleanValues;
    if (Object.keys(aliases).length >= MAX_FONT_INVENTORY_ALIAS_KEYS) break;
  }
  const fonts = compactFontInventory(extra.fonts, aliases, MAX_FONT_INVENTORY_FONTS);
  return {
    app_version: cleanText(extra.app_version, 32),
    resolve_version: cleanText(extra.resolve_version, 64),
    platform: cleanText(extra.platform, 32),
    platform_release: cleanText(extra.platform_release, 64),
    exported_at: cleanText(extra.exported_at, 40),
    learned_rules: Array.isArray(extra.learned_rules) ? extra.learned_rules.slice(-300) : [],
    fonts,
    aliases,
    family_styles: {},
  };
}

function parseExtraJson(text) {
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (_error) {
    return {};
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function csvResponse(rows, filename) {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function collect(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_error) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const installId = cleanText(body.install_id, 128);
  const event = cleanText(body.event, 48);
  if (!installId || !event) {
    return json({ ok: false, error: "missing_install_id_or_event" }, 400);
  }

  const now = new Date().toISOString();
  const cf = request.cf || {};
  const country = cleanText(cf.country || "unknown", 48);
  const region = cleanText(cf.region || "", 80);
  const city = cleanText(cf.city || "", 80);
  const installHash = await sha256Hex(`${env.INSTALL_HASH_SALT || "qinghe-bfd"}:${installId}`);
  const appVersion = cleanText(body.app_version, 32);
  const resolveVersion = cleanText(body.resolve_version, 64);
  const platform = cleanText(body.platform, 32);
  const sessionSeconds = Math.max(0, Math.min(7 * 24 * 3600, Number(body.session_seconds || 0)));
  const extraJson = JSON.stringify(trimExtra(event, body.extra || {}));
  if (extraJson.length > MAX_EXTRA_JSON_CHARS) {
    return json({ ok: false, error: "extra_too_large", max_chars: MAX_EXTRA_JSON_CHARS }, 413);
  }

  await env.DB.prepare(
    `INSERT INTO users (
      install_hash, first_seen, last_seen, country, region, city, platform, app_version, resolve_version, event_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(install_hash) DO UPDATE SET
      last_seen = excluded.last_seen,
      country = excluded.country,
      region = excluded.region,
      city = excluded.city,
      platform = excluded.platform,
      app_version = excluded.app_version,
      resolve_version = excluded.resolve_version,
      event_count = users.event_count + 1`
  ).bind(installHash, now, now, country, region, city, platform, appVersion, resolveVersion).run();

  await env.DB.prepare(
    `INSERT INTO events (
      install_hash, event, created_at, country, region, city, app_version, resolve_version, platform, session_seconds, extra_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(installHash, event, now, country, region, city, appVersion, resolveVersion, platform, sessionSeconds, extraJson).run();

  return json({ ok: true });
}

async function fontData(request, env) {
  if (!adminOk(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  const limit = Math.max(1, Math.min(10000, Number(url.searchParams.get("limit") || 5000)));
  const rows = await env.DB.prepare(
    `SELECT event, created_at, country, region, city, app_version, resolve_version, platform, extra_json
     FROM events
     WHERE event IN ('font_rule_learned', 'font_rule_failed', 'font_inventory')
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(limit).all();

  const rules = [];
  const inventories = [];
  const fontSet = new Set();
  const aliasSet = new Set();
  const results = rows.results || [];
  for (const row of results) {
    const extra = parseExtraJson(row.extra_json);
    if (row.event === "font_rule_learned" || row.event === "font_rule_failed") {
      const rule = extra.rule && typeof extra.rule === "object" ? extra.rule : extra;
      rules.push({
        ok: row.event === "font_rule_learned" && rule.ok !== false,
        event: cleanText(row.event, 48),
        source: cleanText(rule.source, 160),
        accepted: cleanText(rule.accepted, 160),
        actual_font: cleanText(rule.actual_font, 160),
        accepted_candidate: cleanText(rule.accepted_candidate, 220),
        registered_font_file: cleanText(rule.registered_font_file || rule.registered_font_path, 160),
        registered_font_name: cleanText(rule.registered_font_name, 160),
        candidate_attempts: Math.max(0, Math.min(10000, Number(rule.candidate_attempts || 0))),
        probe_warning: cleanText(rule.probe_warning, 300),
        message: cleanText(rule.message, 500),
        candidates: Array.isArray(rule.candidates) ? rule.candidates.slice(0, 24).map((item) => cleanText(item, 160)) : [],
        rejected: Array.isArray(rule.rejected) ? rule.rejected.slice(0, 24).map((item) => cleanText(item, 160)) : [],
        source_keys: Array.isArray(rule.source_keys) ? rule.source_keys.slice(0, 24).map((item) => cleanText(item, 160)) : [],
        created_at: cleanText(rule.created_at || row.created_at, 40),
        app_version: cleanText(row.app_version, 32),
        resolve_version: cleanText(rule.resolve_version || row.resolve_version, 64),
        platform: cleanText(rule.platform || row.platform, 32),
        country: cleanText(row.country, 48),
        city: cleanText(row.city, 80),
      });
    }
    if (row.event === "font_inventory") {
      const rawAliases = extra.aliases && typeof extra.aliases === "object" ? extra.aliases : {};
      const aliases = {};
      const seenAliasKeys = new Set();
      for (const [name, values] of Object.entries(rawAliases)) {
        const cleanName = cleanText(name, 160);
        const key = compactFontKey(cleanName);
        if (!cleanName || seenAliasKeys.has(key)) continue;
        const cleanValues = uniqueTexts(values, MAX_FONT_ALIAS_VALUES);
        if (!cleanValues.length) continue;
        aliases[cleanName] = cleanValues;
        seenAliasKeys.add(key);
      }
      const fonts = compactFontInventory(extra.fonts, aliases, MAX_FONT_INVENTORY_FONTS);
      const learned = Array.isArray(extra.learned_rules) ? extra.learned_rules : [];
      for (const font of fonts) fontSet.add(font);
      for (const [name, values] of Object.entries(aliases)) {
        aliasSet.add(cleanText(name, 160));
        if (Array.isArray(values)) {
          for (const value of values) aliasSet.add(cleanText(value, 160));
        }
      }
      inventories.push({
        created_at: cleanText(row.created_at, 40),
        app_version: cleanText(row.app_version, 32),
        resolve_version: cleanText(extra.resolve_version || row.resolve_version, 64),
        platform: cleanText(extra.platform || row.platform, 32),
        country: cleanText(row.country, 48),
        city: cleanText(row.city, 80),
        font_count: fonts.length,
        alias_key_count: Object.keys(aliases).length,
        learned_rule_count: learned.length,
        fonts,
        aliases,
        family_styles: extra.family_styles && typeof extra.family_styles === "object" ? extra.family_styles : {},
      });
    }
  }

  if (format === "csv") {
    return csvResponse([
      [
        "ok",
        "event",
        "source",
        "accepted",
        "actual_font",
        "accepted_candidate",
        "registered_font_file",
        "registered_font_name",
        "candidate_attempts",
        "probe_warning",
        "message",
        "candidates",
        "rejected",
        "source_keys",
        "created_at",
        "app_version",
        "resolve_version",
        "platform",
        "country",
        "city",
      ],
      ...rules.map((rule) => [
        rule.ok ? "1" : "0",
        rule.event,
        rule.source,
        rule.accepted,
        rule.actual_font,
        rule.accepted_candidate,
        rule.registered_font_file,
        rule.registered_font_name,
        rule.candidate_attempts,
        rule.probe_warning,
        rule.message,
        rule.candidates.join(" | "),
        rule.rejected.join(" | "),
        rule.source_keys.join(" | "),
        rule.created_at,
        rule.app_version,
        rule.resolve_version,
        rule.platform,
        rule.country,
        rule.city,
      ]),
    ], "qinghe-font-rules.csv");
  }

  return json({
    ok: true,
    generated_at: new Date().toISOString(),
    counts: {
      events: results.length,
      rules: rules.length,
      failed_rules: rules.filter((rule) => !rule.ok).length,
      learned_rules: rules.filter((rule) => rule.ok).length,
      inventories: inventories.length,
      unique_fonts: fontSet.size,
      unique_alias_names: aliasSet.size,
    },
    rules,
    inventories,
    unique_fonts: [...fontSet].sort((a, b) => a.localeCompare(b, "zh-CN")),
  });
}

async function summary(request, env) {
  if (!adminOk(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const totals = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM events WHERE event = 'app_start') AS starts,
      (SELECT COUNT(*) FROM events WHERE event = 'detect_start') AS detect_starts,
      (SELECT COUNT(*) FROM events WHERE event = 'detect_done') AS detect_done,
      (SELECT AVG(session_seconds) FROM events WHERE event = 'app_close') AS avg_session_seconds`
  ).first();
  const byCountry = await env.DB.prepare(
    `SELECT country, COUNT(DISTINCT install_hash) AS users, COUNT(*) AS events
     FROM events GROUP BY country ORDER BY events DESC LIMIT 50`
  ).all();
  const byCity = await env.DB.prepare(
    `SELECT country, city, COUNT(DISTINCT install_hash) AS users, COUNT(*) AS events
     FROM events WHERE city != '' GROUP BY country, city ORDER BY events DESC LIMIT 50`
  ).all();
  const byDay = await env.DB.prepare(
    `SELECT substr(created_at, 1, 10) AS day,
      COUNT(DISTINCT install_hash) AS users,
      COUNT(*) AS events,
      SUM(CASE WHEN event = 'detect_start' THEN 1 ELSE 0 END) AS detect_starts
     FROM events GROUP BY day ORDER BY day DESC LIMIT 60`
  ).all();
  const byVersion = await env.DB.prepare(
    `SELECT app_version, resolve_version, platform, COUNT(DISTINCT install_hash) AS users, COUNT(*) AS events
     FROM events GROUP BY app_version, resolve_version, platform ORDER BY events DESC LIMIT 50`
  ).all();
  const byEvent = await env.DB.prepare(
    `SELECT event, COUNT(*) AS events, COUNT(DISTINCT install_hash) AS users
     FROM events GROUP BY event ORDER BY events DESC LIMIT 50`
  ).all();
  const byPlatform = await env.DB.prepare(
    `SELECT platform, COUNT(DISTINCT install_hash) AS users, COUNT(*) AS events,
      SUM(CASE WHEN event = 'detect_start' THEN 1 ELSE 0 END) AS detect_starts,
      SUM(CASE WHEN event = 'detect_done' THEN 1 ELSE 0 END) AS detect_done
     FROM events GROUP BY platform ORDER BY events DESC LIMIT 50`
  ).all();
  const recent = await env.DB.prepare(
    `SELECT event, created_at, country, region, city, app_version, resolve_version, platform, session_seconds
     FROM events ORDER BY created_at DESC LIMIT 80`
  ).all();

  return json({
    ok: true,
    totals,
    byCountry: byCountry.results || [],
    byCity: byCity.results || [],
    byDay: byDay.results || [],
    byVersion: byVersion.results || [],
    byEvent: byEvent.results || [],
    byPlatform: byPlatform.results || [],
    recent: recent.results || [],
  });
}

function dashboardPage() {
  return html(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>清何剪辑工具箱后台</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --panel: #ffffff;
      --panel-2: #f8fbff;
      --text: #172033;
      --muted: #64748b;
      --line: #dbe4ee;
      --blue: #2563eb;
      --green: #059669;
      --orange: #ea580c;
      --red: #dc2626;
      --purple: #7c3aed;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { padding: 24px 28px 14px; background: linear-gradient(135deg, #111827 0%, #1f3a5f 100%); color: white; }
    main { padding: 20px 28px 48px; max-width: 1580px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 26px; letter-spacing: 0; }
    h2 { margin: 0 0 5px; font-size: 16px; }
    input, select { height: 38px; padding: 0 11px; border: 1px solid #cbd5e1; border-radius: 7px; min-width: 250px; background: white; color: var(--text); }
    button { height: 38px; padding: 0 14px; border: 1px solid var(--blue); background: var(--blue); color: white; border-radius: 7px; cursor: pointer; font-weight: 650; }
    button.secondary { background: white; color: var(--blue); }
    button.ghost { background: #eef4ff; color: #1e40af; border-color: #bfdbfe; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #eaf0f8; border: 1px solid #d5e0ee; border-radius: 6px; padding: 2px 6px; }
    .muted { color: var(--muted); }
    .toolbar { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .status { min-height: 22px; margin: 8px 0 14px; color: #475569; }
    .cards { display: grid; grid-template-columns: repeat(8, minmax(120px, 1fr)); gap: 12px; margin: 14px 0; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-height: 92px; }
    .card.accent-blue { border-top: 4px solid var(--blue); }
    .card.accent-green { border-top: 4px solid var(--green); }
    .card.accent-orange { border-top: 4px solid var(--orange); }
    .card.accent-red { border-top: 4px solid var(--red); }
    .card.accent-purple { border-top: 4px solid var(--purple); }
    .num { font-size: 25px; font-weight: 750; margin-bottom: 4px; font-variant-numeric: tabular-nums; }
    .label { color: var(--muted); font-size: 13px; }
    .subvalue { color: var(--muted); font-size: 12px; margin-top: 7px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 14px; align-items: start; }
    .wide { grid-column: 1 / -1; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; overflow: hidden; }
    .panel-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 10px; }
    .note { color: var(--muted); font-size: 12px; }
    .table-wrap { overflow: auto; max-height: 520px; border: 1px solid #edf2f7; border-radius: 7px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #e5eaf2; text-align: left; white-space: nowrap; vertical-align: top; }
    th { position: sticky; top: 0; background: #eef3f9; z-index: 1; color: #475569; }
    td.num-cell, th.num-cell { text-align: right; font-variant-numeric: tabular-nums; }
    tr.bad td { background: #fff7f7; }
    .mini-chart { height: 230px; display: flex; align-items: end; gap: 5px; padding: 10px 8px 4px; border: 1px solid #edf2f7; border-radius: 7px; background: var(--panel-2); overflow: hidden; }
    .bar-col { flex: 1; min-width: 8px; background: linear-gradient(180deg, #60a5fa, #2563eb); border-radius: 5px 5px 0 0; position: relative; }
    .bar-col:hover::after { content: attr(data-title); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); white-space: nowrap; background: #111827; color: white; padding: 5px 7px; border-radius: 5px; font-size: 12px; margin-bottom: 5px; z-index: 5; }
    .bar-line { height: 7px; border-radius: 999px; background: #e2e8f0; overflow: hidden; min-width: 96px; }
    .bar-line > span { display: block; height: 100%; background: var(--blue); border-radius: inherit; }
    .tabs { display: flex; gap: 7px; flex-wrap: wrap; margin: 10px 0 14px; }
    .tab { background: white; border-color: var(--line); color: #334155; }
    .tab.active { background: #dbeafe; border-color: #93c5fd; color: #1d4ed8; }
    .hidden { display: none; }
    @media (max-width: 1180px) {
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .wide { grid-column: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>清何剪辑工具箱后台</h1>
    <div class="muted">匿名统计、功能使用、版本分布、地区维度、字体探针与规则导出</div>
  </header>
  <main>
    <div class="toolbar">
      <input id="token" type="password" placeholder="Admin Token" />
      <button id="load">刷新数据</button>
      <button id="exportSummary" class="secondary">导出统计 JSON</button>
      <button id="csv" class="secondary">导出字体 CSV</button>
      <button id="json" class="secondary">导出字体 JSON</button>
      <select id="range">
        <option value="60">最近 60 天</option>
        <option value="30">最近 30 天</option>
        <option value="14">最近 14 天</option>
        <option value="7">最近 7 天</option>
      </select>
    </div>
    <div id="status" class="status"></div>
    <div class="tabs">
      <button class="tab active" data-tab="overview">概览</button>
      <button class="tab" data-tab="usage">功能使用</button>
      <button class="tab" data-tab="fonts">字体数据</button>
      <button class="tab" data-tab="raw">最近事件</button>
    </div>
    <section class="cards" id="cards"></section>
    <div id="view-overview" class="view grid">
      <section class="panel wide">
        <div class="panel-head"><div><h2>按天趋势</h2><div class="note">用户、事件、检测启动量，适合看版本发布后的使用变化。</div></div></div>
        <div id="trendChart" class="mini-chart"></div>
        <div class="table-wrap" style="margin-top:10px"><table id="byDay"></table></div>
      </section>
      <section class="panel"><div class="panel-head"><div><h2>国家 / 地区</h2><div class="note">Cloudflare 粗略地理维度，不显示原始 IP。</div></div></div><div class="table-wrap"><table id="byCountry"></table></div></section>
      <section class="panel"><div class="panel-head"><div><h2>城市</h2><div class="note">城市维度用于观察主要使用区域。</div></div></div><div class="table-wrap"><table id="byCity"></table></div></section>
      <section class="panel wide"><div class="panel-head"><div><h2>插件 / Resolve / 系统版本</h2><div class="note">判断用户是否升级到新版本，以及 Resolve 19/20/21 的占比。</div></div></div><div class="table-wrap"><table id="byVersion"></table></div></section>
    </div>
    <div id="view-usage" class="view grid hidden">
      <section class="panel"><div class="panel-head"><div><h2>事件维度</h2><div class="note">启动、检测、字体、音频、反馈等行为分布。</div></div></div><div class="table-wrap"><table id="byEvent"></table></div></section>
      <section class="panel"><div class="panel-head"><div><h2>平台维度</h2><div class="note">不同系统上的用户、检测启动和完成情况。</div></div></div><div class="table-wrap"><table id="byPlatform"></table></div></section>
      <section class="panel wide"><div class="panel-head"><div><h2>功能健康度</h2><div class="note">检测完成率、字体失败量、平均会话时长。</div></div></div><div class="table-wrap"><table id="health"></table></div></section>
    </div>
    <div id="view-fonts" class="view grid hidden">
      <section class="panel wide"><div class="panel-head"><div><h2>字体失败队列</h2><div class="note">优先看这里，失败字体可导出后用于下个版本补规则。</div></div></div><div class="table-wrap"><table id="failed"></table></div></section>
      <section class="panel wide"><div class="panel-head"><div><h2>字体规则明细</h2><div class="note">成功和失败都会列出，包含候选、实际字体、Resolve 版本和地区。</div></div></div><div class="table-wrap"><table id="rules"></table></div></section>
      <section class="panel wide"><div class="panel-head"><div><h2>字体清单上报</h2><div class="note">去重后的字体库存和别名数量，避免上传重复字体撑爆后台。</div></div></div><div class="table-wrap"><table id="inventories"></table></div></section>
    </div>
    <div id="view-raw" class="view hidden">
      <section class="panel"><div class="panel-head"><div><h2>最近事件</h2><div class="note">最近 80 条匿名事件，不包含原始 IP。</div></div></div><div class="table-wrap"><table id="recent"></table></div></section>
    </div>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const status = $("status");
    const tokenInput = $("token");
    tokenInput.value = localStorage.getItem("qh_admin_token") || "";
    let latestSummary = null;
    let latestFonts = null;

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function num(value) {
      const n = Number(value || 0);
      return Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) : "0";
    }
    function pct(part, whole) {
      const p = Number(part || 0);
      const w = Number(whole || 0);
      return w ? (p / w * 100).toFixed(1) + "%" : "0%";
    }
    async function api(path) {
      const token = tokenInput.value.trim();
      if (!token) throw new Error("请输入 Admin Token");
      localStorage.setItem("qh_admin_token", token);
      const res = await fetch(path, { headers: { "X-Admin-Token": token } });
      if (!res.ok) throw new Error("请求失败: " + res.status);
      return res.json();
    }
    function bar(value, max) {
      const width = max ? Math.max(2, Math.min(100, Number(value || 0) / max * 100)) : 0;
      return "<div class='bar-line'><span style='width:" + width + "%'></span></div>";
    }
    function renderTable(id, rows, columns, options = {}) {
      const table = $(id);
      if (!rows || !rows.length) {
        table.innerHTML = "<tbody><tr><td class='muted'>暂无数据</td></tr></tbody>";
        return;
      }
      const maxBy = {};
      for (const col of columns) {
        maxBy[col.key] = Math.max(...rows.map((row) => Number(row[col.key] || 0)));
      }
      table.innerHTML = "<thead><tr>" + columns.map((c) => "<th>" + esc(c.label) + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map((row) => "<tr class='" + (row.ok === false ? "bad" : "") + "'>" +
          columns.map((c) => {
            const value = typeof c.value === "function" ? c.value(row) : row[c.key];
            if (options.barKey === c.key) return "<td>" + bar(row[c.key], maxBy[c.key]) + "</td>";
            return "<td class='" + (c.num ? "num-cell" : "") + "'>" + esc(c.num ? num(value) : value) + "</td>";
          }).join("") +
        "</tr>").join("") + "</tbody>";
    }
    function withShare(rows, key = "events") {
      const total = rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
      return rows.map((row) => ({ ...row, share: pct(row[key], total) }));
    }
    function renderTrend(rows) {
      const rangeDays = Number($("range").value || 60);
      const data = [...(rows || [])].sort((a, b) => String(a.day).localeCompare(String(b.day))).slice(-rangeDays);
      const max = Math.max(1, ...data.map((row) => Number(row.events || 0)));
      $("trendChart").innerHTML = data.map((row) => {
        const height = Math.max(4, Number(row.events || 0) / max * 100);
        const title = row.day + " / 事件 " + num(row.events) + " / 用户 " + num(row.users) + " / 检测 " + num(row.detect_starts);
        return "<div class='bar-col' data-title='" + esc(title) + "' style='height:" + height + "%'></div>";
      }).join("");
    }
    function renderCards(summary, fonts) {
      const totals = summary.totals || {};
      const counts = fonts.counts || {};
      const items = [
        ["用户", totals.users, "匿名安装数", "accent-blue"],
        ["事件", totals.events, "全部上报行为", "accent-blue"],
        ["启动", totals.starts, "打开插件次数", "accent-green"],
        ["开始检测", totals.detect_starts, "点击检测次数", "accent-orange"],
        ["检测完成", totals.detect_done, "完成率 " + pct(totals.detect_done, totals.detect_starts), "accent-green"],
        ["平均时长", Math.round(Number(totals.avg_session_seconds || 0)) + "s", "关闭时上报", "accent-purple"],
        ["字体规则", counts.rules, "成功 " + num(counts.learned_rules), "accent-blue"],
        ["字体失败", counts.failed_rules, "优先补规则", "accent-red"],
      ];
      $("cards").innerHTML = items.map(([label, value, sub, klass]) => "<div class='card " + klass + "'><div class='num'>" + esc(value ?? 0) + "</div><div class='label'>" + esc(label) + "</div><div class='subvalue'>" + esc(sub) + "</div></div>").join("");
    }
    function renderAll(summary, fonts) {
      latestSummary = summary;
      latestFonts = fonts;
      renderCards(summary, fonts);
      renderTrend(summary.byDay || []);
      renderTable("byDay", [...(summary.byDay || [])].reverse(), [
        { label: "日期", key: "day" },
        { label: "用户", key: "users", num: true },
        { label: "事件", key: "events", num: true },
        { label: "检测启动", key: "detect_starts", num: true },
      ], { barKey: "events" });
      renderTable("byCountry", withShare(summary.byCountry || []), [
        { label: "国家/地区", key: "country" },
        { label: "用户", key: "users", num: true },
        { label: "事件", key: "events", num: true },
        { label: "占比", key: "share" },
      ], { barKey: "events" });
      renderTable("byCity", summary.byCity || [], [
        { label: "国家", key: "country" },
        { label: "城市", key: "city" },
        { label: "用户", key: "users", num: true },
        { label: "事件", key: "events", num: true },
      ], { barKey: "events" });
      renderTable("byVersion", summary.byVersion || [], [
        { label: "插件版本", key: "app_version" },
        { label: "Resolve", key: "resolve_version" },
        { label: "系统", key: "platform" },
        { label: "用户", key: "users", num: true },
        { label: "事件", key: "events", num: true },
      ], { barKey: "events" });
      renderTable("byEvent", withShare(summary.byEvent || []), [
        { label: "事件", key: "event" },
        { label: "用户", key: "users", num: true },
        { label: "次数", key: "events", num: true },
        { label: "占比", key: "share" },
      ], { barKey: "events" });
      renderTable("byPlatform", (summary.byPlatform || []).map((row) => ({ ...row, completion_rate: pct(row.detect_done, row.detect_starts) })), [
        { label: "系统", key: "platform" },
        { label: "用户", key: "users", num: true },
        { label: "事件", key: "events", num: true },
        { label: "开始检测", key: "detect_starts", num: true },
        { label: "检测完成", key: "detect_done", num: true },
        { label: "完成率", key: "completion_rate" },
      ]);
      renderTable("health", [
        { metric: "检测完成率", value: pct(summary.totals?.detect_done, summary.totals?.detect_starts), note: "detect_done / detect_start" },
        { metric: "平均会话时长", value: Math.round(Number(summary.totals?.avg_session_seconds || 0)) + " 秒", note: "app_close 上报" },
        { metric: "字体失败规则", value: num(fonts.counts?.failed_rules), note: "font_rule_failed" },
        { metric: "字体库存上报", value: num(fonts.counts?.inventories), note: "font_inventory 去重后" },
      ], [
        { label: "指标", key: "metric" },
        { label: "数值", key: "value" },
        { label: "说明", key: "note" },
      ]);
      const rules = fonts.rules || [];
      const failed = rules.filter((row) => row.ok === false);
      const fontCols = [
        { label: "时间", key: "created_at" },
        { label: "状态", value: (r) => r.ok ? "成功" : "失败" },
        { label: "源字体", key: "source" },
        { label: "接受字体", key: "accepted" },
        { label: "实际字体", key: "actual_font" },
        { label: "候选", key: "accepted_candidate" },
        { label: "文件", key: "registered_font_file" },
        { label: "尝试", key: "candidate_attempts", num: true },
        { label: "提示", key: "probe_warning" },
        { label: "Resolve", key: "resolve_version" },
        { label: "地区", value: (r) => [r.country, r.city].filter(Boolean).join(" / ") },
      ];
      renderTable("failed", failed, fontCols);
      renderTable("rules", rules.slice(0, 800), fontCols);
      renderTable("inventories", fonts.inventories || [], [
        { label: "时间", key: "created_at" },
        { label: "插件", key: "app_version" },
        { label: "Resolve", key: "resolve_version" },
        { label: "系统", key: "platform" },
        { label: "地区", value: (r) => [r.country, r.city].filter(Boolean).join(" / ") },
        { label: "字体数", key: "font_count", num: true },
        { label: "别名数", key: "alias_key_count", num: true },
        { label: "学习规则", key: "learned_rule_count", num: true },
      ]);
      renderTable("recent", summary.recent || [], [
        { label: "时间", key: "created_at" },
        { label: "事件", key: "event" },
        { label: "版本", key: "app_version" },
        { label: "Resolve", key: "resolve_version" },
        { label: "平台", key: "platform" },
        { label: "地区", value: (r) => [r.country, r.city].filter(Boolean).join(" / ") },
        { label: "时长", key: "session_seconds", num: true },
      ]);
    }
    async function load() {
      status.textContent = "加载中...";
      const [summary, fonts] = await Promise.all([api("/api/summary"), api("/api/font-data?limit=8000")]);
      renderAll(summary, fonts);
      status.textContent = "已加载 " + new Date().toLocaleString();
    }
    async function download(path, filename) {
      const token = tokenInput.value.trim();
      if (!token) throw new Error("请输入 Admin Token");
      const res = await fetch(path, { headers: { "X-Admin-Token": token } });
      if (!res.ok) throw new Error("导出失败: " + res.status);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    function downloadJson(data, filename) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    document.querySelectorAll(".tab").forEach((button) => {
      button.onclick = () => {
        document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
        document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
        $("view-" + button.dataset.tab).classList.remove("hidden");
      };
    });
    $("range").onchange = () => {
      if (latestSummary) renderTrend(latestSummary.byDay || []);
    };
    $("load").onclick = () => load().catch((err) => status.textContent = err.message);
    $("exportSummary").onclick = () => {
      if (!latestSummary) {
        status.textContent = "请先刷新数据";
        return;
      }
      downloadJson({ summary: latestSummary, fonts: latestFonts }, "qinghe-dashboard-data.json");
    };
    $("csv").onclick = () => download("/api/font-data?format=csv&limit=10000", "qinghe-font-rules.csv").catch((err) => status.textContent = err.message);
    $("json").onclick = () => download("/api/font-data?format=json&limit=10000", "qinghe-font-rules.json").catch((err) => status.textContent = err.message);
  </script>
</body>
</html>`);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/collect") {
      return collect(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/summary") {
      return summary(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/font-data") {
      return fontData(request, env);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      return dashboardPage();
    }
    return json({ ok: true, service: "qinghe-bfd-analytics" });
  },
};
