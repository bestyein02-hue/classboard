// 수업 보드 Worker — D1(DB) 저장소 + GitHub Pages 화면 중계
// 필요한 설정 (Worker → Settings)
//   Bindings: D1 database, 변수 이름 DB
//   Variables: PAGES_URL (예: https://bestyein02-hue.github.io/classboard/)
//   Secrets:   ADMIN_PASSWORD (관리자 비밀번호)

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (col, id))",
  "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pairs (code TEXT PRIMARY KEY, created INTEGER NOT NULL, token TEXT)",
  "CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL)"
];
let ready = false;
async function init(env) {
  if (ready) return;
  for (const s of SCHEMA) await env.DB.prepare(s).run();
  ready = true;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sha(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function isAdmin(req, env) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return false;
  const row = await env.DB.prepare("SELECT expires FROM sessions WHERE token = ?").bind(t).first();
  return !!row && row.expires > Date.now();
}
async function newSession(env, days) {
  const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
  await env.DB.prepare("INSERT INTO sessions (token, expires) VALUES (?, ?)").bind(token, Date.now() + days * 864e5).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(Date.now()).run();
  return token;
}
async function bumpVer(env) {
  await env.DB.prepare(
    "INSERT INTO docs (col, id, body, updated) VALUES ('meta','ver','1',?) ON CONFLICT(col,id) DO UPDATE SET body = CAST(CAST(body AS INTEGER) + 1 AS TEXT), updated = excluded.updated"
  ).bind(Date.now()).run();
}
const COLS = new Set(["units", "passages"]);
const okId = id => /^[A-Za-z0-9_-]{1,64}$/.test(id);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    // 화면(HTML)은 GitHub Pages에서 가져와 보여 준다
    if (!p.startsWith("/api/") && !p.startsWith("/img/")) {
      if (!env.PAGES_URL) return new Response("PAGES_URL 변수가 설정되지 않았습니다.", { status: 500 });
      // 앱 설치용 파일(아이콘·앱 정보·설치 파일)은 GitHub Pages에서 그대로 가져온다
      if (/^\/(manifest\.webmanifest|sw\.js|icon-192\.png|icon-512\.png|icon-maskable\.png|apple-touch-icon\.png)$/.test(p)) {
        const base = env.PAGES_URL.endsWith("/") ? env.PAGES_URL : env.PAGES_URL + "/";
        const r = await fetch(base + p.slice(1) + "?v=" + Date.now(), { cf: { cacheTtl: 0 } });
        const ext = p.split(".").pop();
        const type = { webmanifest: "application/manifest+json", js: "text/javascript; charset=utf-8", png: "image/png" }[ext];
        const h = { "content-type": type, "cache-control": ext === "png" ? "public, max-age=86400" : "no-cache" };
        if (ext === "js") h["service-worker-allowed"] = "/";
        return new Response(r.body, { status: r.status, headers: h });
      }
      const r = await fetch(env.PAGES_URL + "?v=" + Date.now(), { cf: { cacheTtl: 0 } });
      return new Response(r.body, { status: r.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    await init(env);

    try {
      // ---------- 공개 ----------
      if (p === "/api/data" && m === "GET") {
        const rows = await env.DB.prepare("SELECT col, id, body FROM docs WHERE col IN ('units','passages','meta')").all();
        const out = { units: [], passages: [], ver: 0 };
        for (const r of rows.results) {
          if (r.col === "meta") { if (r.id === "ver") out.ver = +r.body; continue; }
          out[r.col].push({ id: r.id, ...JSON.parse(r.body) });
        }
        return json(out);
      }
      if (p === "/api/live" && m === "GET") {
        const rows = await env.DB.prepare("SELECT col, id, body FROM docs WHERE (col='live' AND id='state') OR (col='meta' AND id='ver')").all();
        let state = null, ver = 0;
        for (const r of rows.results) { if (r.col === "live") state = JSON.parse(r.body); else ver = +r.body; }
        return json({ state, ver });
      }
      if (p === "/api/login" && m === "POST") {
        const { password, remember } = await req.json();
        if (!env.ADMIN_PASSWORD) return bad("ADMIN_PASSWORD 비밀값이 설정되지 않았습니다.", 500);
        if ((await sha(String(password || ""))) !== (await sha(env.ADMIN_PASSWORD))) { await sleep(900); return bad("비밀번호가 맞지 않습니다.", 401); }
        return json({ token: await newSession(env, remember ? 30 : 0.5) });
      }
      if (p === "/api/me" && m === "GET") return json({ admin: await isAdmin(req, env) });
      if (p === "/api/pair" && m === "POST") {
        await env.DB.prepare("DELETE FROM pairs WHERE created < ?").bind(Date.now() - 5 * 60e3).run();
        let code;
        for (let i = 0; i < 20; i++) {
          code = String(1000 + Math.floor(Math.random() * 9000));
          const ex = await env.DB.prepare("SELECT code FROM pairs WHERE code = ?").bind(code).first();
          if (!ex) break;
        }
        await env.DB.prepare("INSERT OR REPLACE INTO pairs (code, created, token) VALUES (?, ?, NULL)").bind(code, Date.now()).run();
        return json({ code });
      }
      let mm;
      if ((mm = p.match(/^\/api\/pair\/(\d{4})$/)) && m === "GET") {
        const row = await env.DB.prepare("SELECT created, token FROM pairs WHERE code = ?").bind(mm[1]).first();
        if (!row || row.created < Date.now() - 5 * 60e3) return json({ status: "expired" });
        if (!row.token) return json({ status: "waiting" });
        await env.DB.prepare("DELETE FROM pairs WHERE code = ?").bind(mm[1]).run();
        return json({ status: "ok", token: row.token });
      }
      if ((mm = p.match(/^\/img\/([A-Za-z0-9_-]+)$/)) && m === "GET") {
        const row = await env.DB.prepare("SELECT mime, data FROM images WHERE id = ?").bind(mm[1]).first();
        if (!row) return new Response("Not found", { status: 404 });
        return new Response(new Uint8Array(row.data), { headers: { "content-type": row.mime, "cache-control": "public, max-age=31536000, immutable" } });
      }

      // ---------- 관리자 ----------
      if (!(await isAdmin(req, env))) return bad("관리자 로그인이 필요합니다.", 401);

      if (p === "/api/logout" && m === "POST") {
        const t = (req.headers.get("authorization") || "").slice(7);
        await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(t).run();
        return json({ ok: true });
      }
      if (p === "/api/logout-all" && m === "POST") {
        if (!(await isAdmin(req, env))) return bad("인증 필요", 401);
        await env.DB.prepare("DELETE FROM sessions").run();
        return json({ ok: true });
      }
      if ((mm = p.match(/^\/api\/doc\/(\w+)\/([A-Za-z0-9_-]+)$/))) {
        const [, col, id] = mm;
        if (!COLS.has(col) || !okId(id)) return bad("잘못된 경로입니다.");
        if (m === "PUT") {
          const body = await req.text();
          if (body.length > 900000) return bad("자료가 너무 큽니다.", 413);
          JSON.parse(body);
          await env.DB.prepare("INSERT INTO docs (col, id, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT(col,id) DO UPDATE SET body = excluded.body, updated = excluded.updated")
            .bind(col, id, body, Date.now()).run();
          await bumpVer(env);
          return json({ ok: true });
        }
        if (m === "DELETE") {
          await env.DB.prepare("DELETE FROM docs WHERE col = ? AND id = ?").bind(col, id).run();
          await bumpVer(env);
          return json({ ok: true });
        }
      }
      if (p === "/api/live" && m === "POST") {
        const body = await req.text();
        if (body.length > 20000) return bad("too large", 413);
        await env.DB.prepare("INSERT INTO docs (col, id, body, updated) VALUES ('live','state',?,?) ON CONFLICT(col,id) DO UPDATE SET body = excluded.body, updated = excluded.updated")
          .bind(body, Date.now()).run();
        return json({ ok: true });
      }
      if (p === "/api/pair/approve" && m === "POST") {
        const { code } = await req.json();
        const row = await env.DB.prepare("SELECT created FROM pairs WHERE code = ?").bind(String(code)).first();
        if (!row || row.created < Date.now() - 5 * 60e3) return bad("번호가 없거나 5분이 지났습니다. 칠판에서 번호를 새로 받으세요.", 404);
        const token = await newSession(env, 0.5);
        await env.DB.prepare("UPDATE pairs SET token = ? WHERE code = ?").bind(token, String(code)).run();
        return json({ ok: true });
      }
      if (p === "/api/img" && m === "POST") {
        const mime = req.headers.get("content-type") || "";
        if (!mime.startsWith("image/")) return bad("이미지 파일만 올릴 수 있습니다.");
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 1900000) return bad("이미지가 너무 큽니다 (1.9MB 이하).", 413);
        const id = crypto.randomUUID().replace(/-/g, "");
        await env.DB.prepare("INSERT INTO images (id, mime, data, created) VALUES (?, ?, ?, ?)").bind(id, mime, buf, Date.now()).run();
        return json({ id });
      }
      if (p === "/api/import" && m === "POST") {
        const { units = [], passages = [] } = await req.json();
        const now = Date.now();
        const stmts = [env.DB.prepare("DELETE FROM docs WHERE col IN ('units','passages')")];
        for (const [col, list] of [["units", units], ["passages", passages]]) {
          for (const d of list) {
            const { id, ...body } = d;
            if (!okId(String(id))) continue;
            stmts.push(env.DB.prepare("INSERT INTO docs (col, id, body, updated) VALUES (?, ?, ?, ?)").bind(col, String(id), JSON.stringify(body), now));
          }
        }
        await env.DB.batch(stmts);
        await bumpVer(env);
        return json({ ok: true, units: units.length, passages: passages.length });
      }
      return bad("없는 주소입니다.", 404);
    } catch (e) {
      return bad("서버 오류: " + (e && e.message ? e.message : e), 500);
    }
  }
};
