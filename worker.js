const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Token",
};

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
  const extraJson = JSON.stringify(body.extra || {});

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
    recent: recent.results || [],
  });
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
    return json({ ok: true, service: "qinghe-bfd-analytics" });
  },
};
