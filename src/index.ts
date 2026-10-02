import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Round } from "./types";
import { now } from "./types";
import { layout, esc } from "./ui";
import { scoreRound } from "./scoring";

const app = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

/** Players count as "active" if they polled within this many seconds. */
const ACTIVE_WINDOW = 45;
/** Don't auto-close on "everyone answered" until the round is this old. */
const MIN_ROUND_AGE = 20;

// ---------------------------------------------------------------------------
// Admin auth: single password → signed-ish cookie (hash of the password).
// ---------------------------------------------------------------------------

async function adminToken(env: Env): Promise<string> {
  const data = new TextEncoder().encode(`${env.ADMIN_PASSWORD}:hive-admin-v1`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAdmin(c: C): Promise<boolean> {
  const cookie = c.req.header("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)hm_admin=([a-f0-9]+)/);
  return !!m && m[1] === (await adminToken(c.env));
}

// ---------------------------------------------------------------------------
// Round helpers
// ---------------------------------------------------------------------------

async function currentRound(env: Env): Promise<Round | null> {
  return env.DB.prepare(
    "SELECT * FROM rounds WHERE status IN ('open','scoring') ORDER BY id DESC LIMIT 1"
  ).first<Round>();
}

async function lastScoredRound(env: Env): Promise<Round | null> {
  return env.DB.prepare(
    "SELECT * FROM rounds WHERE status = 'scored' ORDER BY id DESC LIMIT 1"
  ).first<Round>();
}

/** Atomically claim an open round for scoring; returns true for the winner. */
async function claimForScoring(env: Env, roundId: number): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE rounds SET status = 'scoring' WHERE id = ? AND status = 'open'"
  )
    .bind(roundId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

function startScoring(c: C, roundId: number) {
  c.executionCtx.waitUntil(
    scoreRound(c.env, roundId).catch((e) => console.error("scoreRound failed", e))
  );
}

/** Close the round if the timer expired or every active player has answered. */
async function maybeAutoClose(c: C, round: Round | null): Promise<Round | null> {
  if (!round || round.status !== "open") return round;
  const t = now();
  let shouldClose = false;

  if (round.closes_at && t >= round.closes_at) {
    shouldClose = true;
  } else if (t - round.opened_at >= MIN_ROUND_AGE) {
    const stats = await c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM players WHERE last_seen >= ?1) AS active,
         (SELECT COUNT(DISTINCT a.player_id) FROM answers a JOIN players p ON p.id = a.player_id
           WHERE a.round_id = ?2 AND p.last_seen >= ?1) AS answered_active`
    )
      .bind(t - ACTIVE_WINDOW, round.id)
      .first<{ active: number; answered_active: number }>();
    if (stats && stats.active >= 1 && stats.answered_active >= stats.active) {
      shouldClose = true;
    }
  }

  if (shouldClose && (await claimForScoring(c.env, round.id))) {
    startScoring(c, round.id);
    return { ...round, status: "scoring" };
  }
  return round;
}

type ClusterRow = { id: number; label: string; size: number };

async function roundClusters(env: Env, roundId: number): Promise<ClusterRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, label, size FROM clusters WHERE round_id = ? ORDER BY size DESC, id"
  )
    .bind(roundId)
    .all<ClusterRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

app.get("/", (c) =>
  c.html(
    layout({
      title: "Home",
      body: `
<h1>🐝 Hive Mind</h1>
<p class="muted">Think like the group! Answer each question with whatever you think
<em>most other people</em> will say. The more players who match your answer, the more
points everyone in that group gets.</p>
<div class="card center">
  <a class="btn big" href="/play">Join the game</a>
  <div class="btn-row" style="justify-content:center">
    <a class="btn secondary" href="/suggest">Suggest a question</a>
    <a class="btn secondary" href="/results">Results</a>
    <a class="btn secondary" href="/leaderboard">Leaderboard</a>
  </div>
</div>`,
    })
  )
);

// ---------------------------------------------------------------------------
// Suggestions (public)
// ---------------------------------------------------------------------------

/** Compose the displayed question from its parts: "Name 3 important NLP researchers". */
const composeQuestion = (num: number, thing: string) => `Name ${num} ${thing}`;

app.get("/suggest", (c) => {
  const ok = c.req.query("ok");
  return c.html(
    layout({
      title: "Suggest a question",
      body: `
<h1>Suggest a question</h1>
<p class="muted">Questions are always “Name <em>N</em> <em>things</em>”, e.g.
“Name 3 important NLP researchers” or “Name 1 food you’d bring to a potluck”.
Pick things with lots of plausible answers!</p>
${ok ? `<div class="flash ok">Thanks! Your question is in the queue.</div>` : ""}
<form class="card" method="post" action="/suggest">
  <label>Your question</label>
  <div class="qcompose">
    <span class="qword">Name</span>
    <input type="number" name="num" value="1" min="1" max="10" required class="qnum">
    <input type="text" name="thing" required maxlength="280" class="qthing"
      placeholder="important NLP researchers">
  </div>
  <div class="btn-row"><button class="btn" type="submit">Submit question</button></div>
  <p class="muted small">Suggestions are anonymous.</p>
</form>`,
    })
  );
});

app.post("/suggest", async (c) => {
  const form = await c.req.formData();
  const thing = String(form.get("thing") ?? "").trim().slice(0, 280);
  const num = Math.max(1, Math.min(10, Number(form.get("num") ?? 1) || 1));
  if (thing) {
    await c.env.DB.prepare(
      "INSERT INTO suggestions (text, num, created_at) VALUES (?, ?, ?)"
    )
      .bind(thing, num, now())
      .run();
  }
  return c.redirect("/suggest?ok=1");
});

// ---------------------------------------------------------------------------
// Player page + API
// ---------------------------------------------------------------------------

app.get("/play", (c) =>
  c.html(layout({ title: "Play", body: `<div id="app"><p class="muted">Loading…</p></div>`, script: PLAY_JS }))
);

// Big-screen display: current question + live stats while a round runs,
// results + leaderboard between rounds. Put this on the projector.
app.get("/board", (c) =>
  c.html(
    layout({
      title: "Big screen",
      nav: false,
      body: `<style>main{max-width:1150px}</style><div id="app" class="board"><p class="muted">Loading…</p></div>`,
      script: BOARD_JS,
    })
  )
);

app.post("/api/join", async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  const clean = String(name ?? "").trim().slice(0, 40);
  if (!clean) return c.json({ error: "name required" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO players (id, name, created_at, last_seen) VALUES (?, ?, ?, ?)"
  )
    .bind(id, clean, now(), now())
    .run();
  return c.json({ player_id: id, name: clean });
});

app.post("/api/answer", async (c) => {
  const body = await c.req.json<{ player_id?: string; round_id?: number; texts?: string[] }>();
  const texts = (Array.isArray(body.texts) ? body.texts : [])
    .map((s) => String(s ?? "").trim().slice(0, 200));
  if (!body.player_id || !body.round_id || !texts.length || texts.some((s) => !s)) {
    return c.json({ error: "Please fill in every answer." }, 400);
  }
  const round = await c.env.DB.prepare(
    "SELECT * FROM rounds WHERE id = ? AND status = 'open'"
  )
    .bind(body.round_id)
    .first<Round>();
  if (!round) return c.json({ error: "Round is closed" }, 409);
  if (texts.length !== round.num) {
    return c.json({ error: `This question needs ${round.num} answer(s).` }, 400);
  }
  const normed = texts.map((s) => s.toLowerCase().replace(/\s+/g, " "));
  if (new Set(normed).size !== normed.length) {
    return c.json({ error: "Your answers must all be different." }, 400);
  }
  // Answers are final — no edits once locked in.
  const existing = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM answers WHERE round_id = ? AND player_id = ?"
  )
    .bind(round.id, body.player_id)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return c.json({ error: "You already locked in your answers." }, 409);
  }
  const t = now();
  await c.env.DB.batch(
    texts.map((text, idx) =>
      c.env.DB.prepare(
        "INSERT INTO answers (round_id, player_id, idx, text, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(round.id, body.player_id, idx, text, t)
    )
  );
  return c.json({ ok: true });
});

app.get("/api/state", async (c) => {
  const playerId = c.req.query("player") ?? "";
  const t = now();
  if (playerId) {
    await c.env.DB.prepare("UPDATE players SET last_seen = ? WHERE id = ?")
      .bind(t, playerId)
      .run();
  }

  let round = await currentRound(c.env);
  round = await maybeAutoClose(c, round);

  const out: Record<string, unknown> = { status: "idle", server_time: t };

  const active = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM players WHERE last_seen >= ?"
  )
    .bind(t - ACTIVE_WINDOW)
    .first<{ n: number }>();
  out.active_count = active?.n ?? 0;

  if (round) {
    const count = await c.env.DB.prepare(
      "SELECT COUNT(DISTINCT player_id) AS n FROM answers WHERE round_id = ?"
    )
      .bind(round.id)
      .first<{ n: number }>();
    out.status = round.status; // open | scoring
    out.round = {
      id: round.id,
      question: round.question,
      num: round.num,
      closes_at: round.closes_at,
      seconds_left: round.closes_at ? Math.max(0, round.closes_at - t) : null,
    };
    out.answer_count = count?.n ?? 0;
    if (playerId) {
      const { results: mine } = await c.env.DB.prepare(
        "SELECT text FROM answers WHERE round_id = ? AND player_id = ? ORDER BY idx"
      )
        .bind(round.id, playerId)
        .all<{ text: string }>();
      out.answered = mine.length > 0;
      out.your_answers = mine.map((m) => m.text);
    }
  }

  // Latest finished round (shown between rounds, and under "scoring…").
  const last = await lastScoredRound(c.env);
  if (last) {
    const clusters = await roundClusters(c.env, last.id);
    const lastOut: Record<string, unknown> = {
      id: last.id,
      question: last.question,
      total_answers: clusters.reduce((s, cl) => s + cl.size, 0),
      clusters: clusters.slice(0, 10).map((cl) => ({ label: cl.label, size: cl.size })),
    };
    if (playerId) {
      const { results: mine } = await c.env.DB.prepare(
        `SELECT a.text, a.points, cl.label AS cluster_label
         FROM answers a LEFT JOIN clusters cl ON cl.id = a.cluster_id
         WHERE a.round_id = ? AND a.player_id = ? ORDER BY a.idx`
      )
        .bind(last.id, playerId)
        .all<{ text: string; points: number; cluster_label: string | null }>();
      if (mine.length) {
        lastOut.your = {
          answers: mine,
          total: mine.reduce((s, m) => s + m.points, 0),
        };
      }
    }
    out.last = lastOut;
  }

  // Mini leaderboard for the between-rounds screen.
  const { results: top } = await c.env.DB.prepare(
    `SELECT p.name, SUM(a.points) AS pts FROM answers a
     JOIN players p ON p.id = a.player_id
     JOIN rounds r ON r.id = a.round_id AND r.status = 'scored'
     GROUP BY p.id ORDER BY pts DESC LIMIT 10`
  ).all<{ name: string; pts: number }>();
  out.leaderboard = top;

  return c.json(out);
});

// ---------------------------------------------------------------------------
// Results + leaderboard (public, projector-friendly)
// ---------------------------------------------------------------------------

app.get("/results", async (c) => {
  const { results: rounds } = await c.env.DB.prepare(
    "SELECT * FROM rounds WHERE status = 'scored' ORDER BY id DESC LIMIT 20"
  ).all<Round>();

  let body = `<h1>Results</h1>`;
  const open = await currentRound(c.env);
  if (open) {
    body += `<div class="flash ok">A round is in progress: “${esc(open.question)}” — results appear here when it’s scored.</div>`;
  }
  if (!rounds.length) body += `<p class="muted">No rounds scored yet.</p>`;

  for (const r of rounds) {
    const clusters = await roundClusters(c.env, r.id);
    const total = clusters.reduce((s, cl) => s + cl.size, 0);
    const { results: members } = await c.env.DB.prepare(
      `SELECT a.cluster_id, a.text, p.name FROM answers a
       JOIN players p ON p.id = a.player_id WHERE a.round_id = ?`
    )
      .bind(r.id)
      .all<{ cluster_id: number; text: string; name: string }>();
    const byCluster = new Map<number, string[]>();
    for (const m of members) {
      const arr = byCluster.get(m.cluster_id) ?? [];
      arr.push(`${m.name}: “${m.text}”`);
      byCluster.set(m.cluster_id, arr);
    }
    body += `<div class="card">
      <div class="question">${esc(r.question)}</div>
      <p class="muted small">${total} answer${total === 1 ? "" : "s"}</p>
      ${clusters
        .map(
          (cl) => `<div class="cluster">
        <span class="count">${cl.size}</span>
        <div><strong>${esc(cl.label)}</strong><br>
          <span class="members">${esc((byCluster.get(cl.id) ?? []).join(" · "))}</span>
        </div>
      </div>`
        )
        .join("")}
    </div>`;
  }

  return c.html(
    layout({
      title: "Results",
      body,
      // Auto-refresh so a projector copy stays current between rounds.
      script: `setInterval(async () => {
        try {
          const html = await (await fetch(location.href)).text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          const fresh = doc.getElementById("content");
          if (fresh) document.getElementById("content").innerHTML = fresh.innerHTML;
        } catch {}
      }, 5000);`,
    })
  );
});

app.get("/leaderboard", async (c) => {
  const { results: rows } = await c.env.DB.prepare(
    `SELECT p.name, SUM(a.points) AS pts, COUNT(DISTINCT a.round_id) AS played
     FROM answers a
     JOIN players p ON p.id = a.player_id
     JOIN rounds r ON r.id = a.round_id AND r.status = 'scored'
     GROUP BY p.id ORDER BY pts DESC, p.name LIMIT 100`
  ).all<{ name: string; pts: number; played: number }>();

  const medals = ["🥇", "🥈", "🥉"];
  const body = `<h1>Leaderboard</h1>
${
  rows.length
    ? `<div class="card"><table>
  <tr><th></th><th>Player</th><th>Points</th><th>Rounds</th></tr>
  ${rows
    .map(
      (r, i) =>
        `<tr><td>${medals[i] ?? i + 1}</td><td>${esc(r.name)}</td><td><strong>${r.pts}</strong></td><td class="muted">${r.played}</td></tr>`
    )
    .join("")}
</table></div>`
    : `<p class="muted">No scores yet — play a round first!</p>`
}`;
  return c.html(
    layout({
      title: "Leaderboard",
      body,
      script: `setInterval(async () => {
        try {
          const html = await (await fetch(location.href)).text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          const fresh = doc.getElementById("content");
          if (fresh) document.getElementById("content").innerHTML = fresh.innerHTML;
        } catch {}
      }, 5000);`,
    })
  );
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

app.post("/admin/login", async (c) => {
  const form = await c.req.formData();
  if (String(form.get("password") ?? "") === c.env.ADMIN_PASSWORD) {
    const token = await adminToken(c.env);
    c.header(
      "Set-Cookie",
      `hm_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`
    );
    return c.redirect("/admin");
  }
  return c.redirect("/admin?e=1");
});

app.get("/admin/logout", (c) => {
  c.header("Set-Cookie", "hm_admin=; Path=/; Max-Age=0");
  return c.redirect("/admin");
});

/** Everything under /admin/* (except login) and /api/admin/* requires the cookie.
 * Note: "/admin/*" also matches bare "/admin", which must pass through —
 * its handler shows the login form itself (redirecting it here would loop). */
app.use("/admin/*", async (c, next) => {
  const open = ["/admin", "/admin/login", "/admin/logout"];
  if (open.includes(c.req.path)) return next();
  if (!(await isAdmin(c))) return c.redirect("/admin");
  return next();
});
app.use("/api/admin/*", async (c, next) => {
  if (!(await isAdmin(c))) return c.json({ error: "unauthorized" }, 401);
  return next();
});

app.get("/admin", async (c) => {
  if (!(await isAdmin(c))) {
    const err = c.req.query("e") ? `<div class="flash err">Wrong password.</div>` : "";
    return c.html(
      layout({
        title: "Admin sign in",
        body: `<div class="center"><form class="card" style="max-width:360px;margin:40px auto" method="post" action="/admin/login">
  <h1>Admin</h1>${err}
  <label>Password</label>
  <input type="password" name="password" autofocus>
  <div class="btn-row"><button class="btn" type="submit" style="width:100%">Sign in</button></div>
</form></div>`,
      })
    );
  }

  const t = now();
  const round = await currentRound(c.env);
  const { results: pending } = await c.env.DB.prepare(
    "SELECT * FROM suggestions WHERE status = 'pending' ORDER BY id"
  ).all<{ id: number; text: string; num: number; author: string | null }>();
  const { results: recent } = await c.env.DB.prepare(
    "SELECT * FROM rounds ORDER BY id DESC LIMIT 10"
  ).all<Round>();

  const minutesSelect = (formId: string) => `<select name="minutes" form="${formId}" title="Timer">
    <option value="1">1 min</option><option value="2" selected>2 min</option>
    <option value="3">3 min</option><option value="5">5 min</option>
    <option value="0">No timer</option></select>`;

  let roundCard: string;
  if (round) {
    roundCard = `<div class="card">
  <span class="pill live">ROUND ${round.id} — ${round.status.toUpperCase()}</span>
  <div class="question">${esc(round.question)}</div>
  <div class="statgrid">
    <div class="stat"><div class="n" id="answerCount">…</div><div class="l">answered</div></div>
    <div class="stat"><div class="n" id="activeCount">…</div><div class="l">active players</div></div>
    <div class="stat"><div class="n countdown" id="countdown">${round.closes_at ? "…" : "—"}</div><div class="l">time left</div></div>
  </div>
  <div id="liveAnswers" class="small muted" style="margin-top:10px"></div>
  ${
    round.status === "open"
      ? `<form method="post" action="/admin/close" class="btn-row"><button class="btn">Close &amp; score now</button></form>`
      : `<p class="muted">Scoring in progress… this page refreshes automatically.</p>`
  }
</div>`;
  } else {
    roundCard = `<div class="card"><span class="pill">NO ACTIVE ROUND</span>
  <p class="muted">Pick a question below to start the next round.</p></div>`;
  }

  const suggestionRows = pending.length
    ? pending
        .map(
          (s) => `<div class="suggestion-row">
  <span class="text">${esc(composeQuestion(s.num, s.text))} ${s.author ? `<span class="muted small">— ${esc(s.author)}</span>` : ""}</span>
  <form id="ask${s.id}" method="post" action="/admin/open"><input type="hidden" name="suggestion_id" value="${s.id}"></form>
  ${minutesSelect(`ask${s.id}`)}
  <button class="btn sm" form="ask${s.id}" ${round ? "disabled title='Finish the current round first'" : ""}>Ask now</button>
  <form method="post" action="/admin/suggestion/${s.id}/reject"><button class="btn sm secondary">Reject</button></form>
</div>`
        )
        .join("")
    : `<p class="muted">No pending suggestions. Send people to <a href="/suggest" style="color:var(--honey)">/suggest</a>!</p>`;

  const recentRows = recent
    .map(
      (r) => `<tr>
  <td>#${r.id}</td><td>${esc(r.question.slice(0, 60))}</td>
  <td><span class="pill ${r.status === "open" ? "live" : ""}">${r.status}</span></td>
  <td>${
    r.status === "scored"
      ? `<form method="post" action="/admin/rescore/${r.id}" style="display:inline"><button class="btn sm secondary" title="Re-run AI clustering">Rescore</button></form>`
      : ""
  }</td>
</tr>`
    )
    .join("");

  const body = `<h1>Admin</h1>
<p><a href="/board" target="_blank" style="color:var(--honey)">Open the big-screen board ↗</a> <span class="muted small">— put it on the projector</span></p>
${roundCard}
<h2>Open a question</h2>
<div class="card">
  <h3 style="margin-top:0">Suggestions queue (${pending.length})</h3>
  ${suggestionRows}
  <h3>Or ask your own</h3>
  <form id="custom" method="post" action="/admin/open">
    <div class="qcompose">
      <span class="qword">Name</span>
      <input type="number" name="num" value="1" min="1" max="10" class="qnum">
      <input type="text" name="thing" maxlength="280" class="qthing" placeholder="important NLP researchers">
    </div>
    <div class="btn-row">${minutesSelect("custom")}
      <button class="btn" ${round ? "disabled title='Finish the current round first'" : ""}>Ask now</button></div>
  </form>
</div>
<h2>Recent rounds</h2>
<div class="card"><table><tr><th>#</th><th>Question</th><th>Status</th><th></th></tr>${recentRows || ""}</table>
  <p class="muted small">Full answer breakdowns are on the <a href="/results" style="color:var(--honey)">results page</a>.</p>
</div>
<h2>Danger zone</h2>
<div class="card">
  <form method="post" action="/admin/reset" onsubmit="return confirm('Delete ALL rounds, answers, and scores? Suggestions and players are kept.')">
    <button class="btn danger">Reset game</button>
  </form>
  <p class="muted small" style="margin-bottom:0">Deletes all rounds, answers, and scores (keeps players and suggestions). <a href="/admin/logout" style="color:var(--muted)">Sign out</a></p>
</div>`;

  const script = round
    ? `const roundId=${round.id}, roundStatus=${JSON.stringify(round.status)}, closesAt=${round.closes_at ?? "null"};
function tick(){
  if(closesAt===null) return;
  const left=Math.max(0, closesAt - Math.floor(Date.now()/1000));
  const el=document.getElementById('countdown');
  if(el) el.textContent=Math.floor(left/60)+':'+String(left%60).padStart(2,'0');
}
tick(); setInterval(tick,1000);
async function poll(){
  try{
    const s=await (await fetch('/api/admin/state')).json();
    if((s.round? s.round.id+':'+s.round.status : 'none') !== roundId+':'+roundStatus){ location.reload(); return; }
    document.getElementById('answerCount').textContent=s.answer_count;
    document.getElementById('activeCount').textContent=s.active_count;
    document.getElementById('liveAnswers').innerHTML=(s.answers||[])
      .map(a=>'<div>'+a.name.replace(/</g,'&lt;')+': \u201c'+a.text.replace(/</g,'&lt;')+'\u201d</div>').join('');
  }catch(e){}
}
poll(); setInterval(poll,2000);`
    : `async function poll(){
  try{
    const s=await (await fetch('/api/admin/state')).json();
    if(s.round){ location.reload(); }
  }catch(e){}
}
setInterval(poll,3000);`;

  return c.html(layout({ title: "Admin", body, script }));
});

app.get("/api/admin/state", async (c) => {
  const t = now();
  let round = await currentRound(c.env);
  round = await maybeAutoClose(c, round);
  const out: Record<string, unknown> = {
    server_time: t,
    round: round ? { id: round.id, status: round.status, closes_at: round.closes_at } : null,
  };
  const active = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM players WHERE last_seen >= ?"
  )
    .bind(t - ACTIVE_WINDOW)
    .first<{ n: number }>();
  out.active_count = active?.n ?? 0;
  if (round) {
    const { results: answers } = await c.env.DB.prepare(
      `SELECT p.name, GROUP_CONCAT(a.text, ' · ') AS text
       FROM answers a JOIN players p ON p.id = a.player_id
       WHERE a.round_id = ? GROUP BY a.player_id ORDER BY MIN(a.created_at)`
    )
      .bind(round.id)
      .all<{ name: string; text: string }>();
    out.answer_count = answers.length;
    out.answers = answers;
  } else {
    out.answer_count = 0;
  }
  return c.json(out);
});

app.post("/admin/open", async (c) => {
  const form = await c.req.formData();
  const existing = await currentRound(c.env);
  if (existing) return c.redirect("/admin"); // one round at a time

  const minutes = Math.max(0, Math.min(30, Number(form.get("minutes") ?? 2)));
  const suggestionId = Number(form.get("suggestion_id") ?? 0) || null;
  let thing = String(form.get("thing") ?? "").trim().slice(0, 280);
  let num = Math.max(1, Math.min(10, Number(form.get("num") ?? 1) || 1));

  if (suggestionId) {
    const s = await c.env.DB.prepare(
      "SELECT text, num FROM suggestions WHERE id = ? AND status = 'pending'"
    )
      .bind(suggestionId)
      .first<{ text: string; num: number }>();
    if (!s) return c.redirect("/admin");
    thing = s.text;
    num = s.num;
    await c.env.DB.prepare("UPDATE suggestions SET status = 'used' WHERE id = ?")
      .bind(suggestionId)
      .run();
  }
  if (!thing) return c.redirect("/admin");

  const t = now();
  await c.env.DB.prepare(
    "INSERT INTO rounds (question, num, suggestion_id, status, opened_at, closes_at) VALUES (?, ?, ?, 'open', ?, ?)"
  )
    .bind(composeQuestion(num, thing), num, suggestionId, t, minutes > 0 ? t + minutes * 60 : null)
    .run();
  return c.redirect("/admin");
});

app.post("/admin/close", async (c) => {
  const round = await currentRound(c.env);
  if (round && round.status === "open" && (await claimForScoring(c.env, round.id))) {
    startScoring(c, round.id);
  }
  return c.redirect("/admin");
});

app.post("/admin/suggestion/:id/reject", async (c) => {
  await c.env.DB.prepare(
    "UPDATE suggestions SET status = 'rejected' WHERE id = ? AND status = 'pending'"
  )
    .bind(Number(c.req.param("id")))
    .run();
  return c.redirect("/admin");
});

app.post("/admin/rescore/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const res = await c.env.DB.prepare(
    "UPDATE rounds SET status = 'scoring', scored_at = NULL WHERE id = ? AND status = 'scored'"
  )
    .bind(id)
    .run();
  if ((res.meta.changes ?? 0) > 0) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE answers SET cluster_id = NULL, points = 0 WHERE round_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM clusters WHERE round_id = ?").bind(id),
    ]);
    startScoring(c, id);
  }
  return c.redirect("/admin");
});

app.post("/admin/reset", async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM answers"),
    c.env.DB.prepare("DELETE FROM clusters"),
    c.env.DB.prepare("DELETE FROM rounds"),
  ]);
  return c.redirect("/admin");
});

// ---------------------------------------------------------------------------
// Player page client script
// ---------------------------------------------------------------------------

const PLAY_JS = `
const LS = 'hiveMindPlayer';
let player = null;
try { player = JSON.parse(localStorage.getItem(LS) || 'null'); } catch {}
let state = null, viewKey = '', countdownTimer = null;
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function renderJoin() {
  // Rendered once; re-rendering on every poll would wipe what the user typed.
  if (document.getElementById('joinForm')) return;
  app.innerHTML = \`
  <div class="center" style="margin-top:30px">
    <h1>🐝 Join the hive</h1>
    <p class="muted">Answer each question with what you think <em>most people</em> will say.<br>Match more people = more points.</p>
    <form class="card" style="max-width:380px;margin:0 auto" id="joinForm">
      <label>Your name</label>
      <input type="text" id="nameInput" maxlength="40" autofocus required>
      <div class="btn-row"><button class="btn" style="width:100%">Join</button></div>
    </form>
  </div>\`;
  document.getElementById('joinForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('nameInput').value.trim();
    if (!name) return;
    const r = await fetch('/api/join', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    if (r.ok) { player = await r.json(); localStorage.setItem(LS, JSON.stringify(player)); viewKey=''; poll(); }
  };
}

function lastResultsHtml(s) {
  if (!s.last) return '';
  const your = s.last.your
    ? \`<div class="flash \${s.last.your.total > s.last.your.answers.length ? 'ok' : 'err'}">
        \${s.last.your.answers.map(a =>
          \`“\${esc(a.text)}” — \${a.points} pt\${a.points === 1 ? '' : 's'}\${a.points > 1 ? ' (matched ' + (a.points - 1) + ' other' + (a.points === 2 ? '' : 's') + ')' : ''}\`
        ).join('<br>')}
        <br><strong>Total: \${s.last.your.total} point\${s.last.your.total === 1 ? '' : 's'}</strong></div>\`
    : '';
  const clusters = (s.last.clusters || []).map(c =>
    \`<div class="cluster"><span class="count">\${c.size}</span><strong>\${esc(c.label)}</strong></div>\`).join('');
  const lb = (s.leaderboard || []).length
    ? '<h2>Top players</h2><div class="card"><table>' + s.leaderboard.map((r, i) =>
        \`<tr\${player && r.name === player.name ? ' class="me"' : ''}><td>\${['🥇','🥈','🥉'][i] ?? i+1}</td><td>\${esc(r.name)}</td><td><strong>\${r.pts}</strong></td></tr>\`).join('')
      + '</table></div><p class="center"><a class="btn secondary" href="/leaderboard">Full leaderboard</a></p>'
    : '';
  return \`<h2>Last question</h2>
    <div class="question">\${esc(s.last.question)}</div>
    \${your}
    <div class="card">\${clusters || '<p class="muted">No answers.</p>'}</div>
    \${lb}\`;
}

function startCountdown(closesAt) {
  clearInterval(countdownTimer);
  if (!closesAt) return;
  const tick = () => {
    const el = document.getElementById('cd');
    if (!el) return clearInterval(countdownTimer);
    const left = Math.max(0, closesAt - Math.floor(Date.now() / 1000));
    el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function render() {
  const s = state;
  const key = [s.status, s.round && s.round.id, s.answered, s.last && s.last.id].join(':');
  const countEl = document.getElementById('liveCount');
  if (countEl && s.answer_count != null) countEl.textContent = s.answer_count;
  if (key === viewKey) return;
  viewKey = key;

  if (s.status === 'open' && !s.answered) {
    const n = s.round.num || 1;
    const prev = s.your_answers || [];
    const inputs = Array.from({ length: n }, (_, i) =>
      \`<input type="text" class="ans" maxlength="200" value="\${esc(prev[i] || '')}"
        placeholder="\${n > 1 ? 'Answer ' + (i + 1) : ''}" \${i === 0 ? 'autofocus' : ''}
        style="margin-bottom:8px">\`).join('');
    app.innerHTML = \`
      <p class="small"><span class="pill live">ROUND LIVE</span> \${s.round.closes_at ? '<span class="countdown" id="cd"></span> left' : ''}</p>
      <div class="question">\${esc(s.round.question)}</div>
      <form class="card" id="answerForm">
        <label>Your answer\${n > 1 ? 's' : ''} <span class="muted small">— what will most people say?</span></label>
        \${inputs}
        <div id="formErr"></div>
        <div class="btn-row"><button class="btn">Lock it in</button></div>
        <p class="muted small" style="margin-bottom:0">Careful — answers are final once locked in!</p>
      </form>
      <p class="muted small"><span id="liveCount">\${s.answer_count}</span> player(s) answered so far</p>\`;
    startCountdown(s.round.closes_at);
    document.getElementById('answerForm').onsubmit = async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('formErr');
      const texts = [...document.querySelectorAll('#answerForm .ans')].map(el => el.value.trim());
      if (texts.some(t => !t)) { errEl.innerHTML = '<div class="flash err">Please fill in every answer.</div>'; return; }
      const normed = texts.map(t => t.toLowerCase().replace(/\\s+/g, ' '));
      if (new Set(normed).size !== normed.length) { errEl.innerHTML = '<div class="flash err">Your answers must all be different.</div>'; return; }
      const r = await fetch('/api/answer', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ player_id: player.player_id, round_id: s.round.id, texts }) });
      if (r.ok) { viewKey = ''; poll(); }
      else { const j = await r.json().catch(() => ({})); errEl.innerHTML = '<div class="flash err">' + esc(j.error || 'Something went wrong.') + '</div>'; }
    };
  } else if (s.status === 'open' && s.answered) {
    app.innerHTML = \`
      <p class="small"><span class="pill live">ROUND LIVE</span> \${s.round.closes_at ? '<span class="countdown" id="cd"></span> left' : ''}</p>
      <div class="question">\${esc(s.round.question)}</div>
      <div class="card center">
        <p class="big">✅ Locked in: \${(s.your_answers || []).map(a => '“' + esc(a) + '”').join(' · ')}</p>
        <p class="muted"><span id="liveCount">\${s.answer_count}</span> player(s) answered. Waiting for the round to close…</p>
      </div>\`;
    startCountdown(s.round.closes_at);
  } else if (s.status === 'scoring') {
    app.innerHTML = \`
      <div class="question">\${esc(s.round.question)}</div>
      <div class="card center"><p class="big">🧮 Scoring…</p>
      <p class="muted">The hive is comparing everyone's answers.</p></div>\`;
  } else {
    app.innerHTML = \`
      <div class="card center"><p class="big">⏳ Waiting for the next question…</p>
      <p class="muted">Hi \${esc(player.name)} — stay on this page, the question appears automatically.</p></div>
      \${lastResultsHtml(s)}\`;
  }
}

async function poll() {
  if (!player) { renderJoin(); return; }
  try {
    const r = await fetch('/api/state?player=' + encodeURIComponent(player.player_id));
    if (r.ok) { state = await r.json(); render(); }
  } catch {}
}
poll();
setInterval(poll, 2500);
`;

// ---------------------------------------------------------------------------
// Big-screen board client script
// ---------------------------------------------------------------------------

const BOARD_JS = `
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let viewKey = '', countdownTimer = null;
const joinHint = '<p class="bjoin">📱 Play at <strong>' + location.host + '/play</strong> · suggest questions at <strong>' + location.host + '/suggest</strong></p>';

function startCountdown(closesAt) {
  clearInterval(countdownTimer);
  if (!closesAt) return;
  const tick = () => {
    const el = document.getElementById('bcd');
    if (!el) return clearInterval(countdownTimer);
    const left = Math.max(0, closesAt - Math.floor(Date.now() / 1000));
    el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function leaderboardHtml(s) {
  if (!(s.leaderboard || []).length) return '';
  return '<div class="bpanel"><h2>🏆 Leaderboard</h2><table class="btable">' +
    s.leaderboard.map((r, i) =>
      '<tr><td>' + (['🥇','🥈','🥉'][i] ?? (i + 1)) + '</td><td>' + esc(r.name) + '</td><td><strong>' + r.pts + '</strong></td></tr>').join('') +
    '</table></div>';
}

function render(s) {
  const key = [s.status, s.round && s.round.id, s.last && s.last.id].join(':');
  const aEl = document.getElementById('bAnswered');
  if (aEl) aEl.textContent = s.answer_count;
  const pEl = document.getElementById('bActive');
  if (pEl) pEl.textContent = s.active_count;
  if (key === viewKey) return;
  viewKey = key;

  if (s.status === 'open') {
    app.innerHTML = \`
      <h1>🐝 Hive Mind</h1>
      <div class="bq">\${esc(s.round.question)}</div>
      \${s.round.closes_at ? '<div class="bcd" id="bcd"></div>' : ''}
      <div class="bstats">
        <div class="stat"><div class="n" id="bAnswered">\${s.answer_count}</div><div class="l">answered</div></div>
        <div class="stat"><div class="n" id="bActive">\${s.active_count}</div><div class="l">playing</div></div>
      </div>
      \${joinHint}\`;
    startCountdown(s.round.closes_at);
  } else if (s.status === 'scoring') {
    app.innerHTML = \`
      <h1>🐝 Hive Mind</h1>
      <div class="bq">\${esc(s.round.question)}</div>
      <div class="bcd">🧮</div>
      <p class="muted" style="font-size:1.4em">Scoring — the hive is comparing answers…</p>\`;
  } else if (s.last) {
    const clusters = (s.last.clusters || []).map(c =>
      '<div class="bcluster"><span class="count">' + c.size + '</span><span>' + esc(c.label) + '</span></div>').join('');
    app.innerHTML = \`
      <h1>🐝 Hive Mind</h1>
      <div class="bq">\${esc(s.last.question)}</div>
      <div class="bcols">
        <div class="bpanel"><h2>Top answers</h2>\${clusters || '<p class="muted">No answers.</p>'}</div>
        \${leaderboardHtml(s)}
      </div>
      <p class="muted" style="font-size:1.2em">Next question coming up…</p>
      \${joinHint}\`;
  } else {
    app.innerHTML = \`
      <h1>🐝 Hive Mind</h1>
      <div class="bq">Get ready…</div>
      <div class="bstats">
        <div class="stat"><div class="n" id="bActive">\${s.active_count}</div><div class="l">players joined</div></div>
      </div>
      \${joinHint}\`;
  }
}

async function poll() {
  try {
    const r = await fetch('/api/state');
    if (r.ok) render(await r.json());
  } catch {}
}
poll();
setInterval(poll, 2000);
`;

export default app;
