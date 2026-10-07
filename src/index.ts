import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Round } from "./types";
import { now } from "./types";
import { renderSVG } from "uqr";
import { layout, esc } from "./ui";
import { getTheme } from "./theme";
import { scoreRound, runPendingReview } from "./scoring";

const app = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

/** Players count as "active" if they polled within this many seconds. */
const ACTIVE_WINDOW = 60;
/** Don't auto-close on "everyone answered" until the round is this old. */
const MIN_ROUND_AGE = 20;
/** Only write last_seen if it's at least this stale (cuts D1 writes ~10x). */
const LAST_SEEN_REFRESH = 25;
/** How long the shared (non-per-player) state is served from memory. */
const SHARED_TTL_MS = 2000;

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
// Player gate: /play needs PLAYER_PASSWORD. The board advertises
// /play?pw=<password>, which sets a cookie and redirects, so players arriving
// from the board go straight to the name prompt.
// ---------------------------------------------------------------------------

async function playerToken(env: Env): Promise<string> {
  const data = new TextEncoder().encode(`${env.PLAYER_PASSWORD}:hive-player-v1`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function playerGate(c: C, next: () => Promise<void>) {
  const token = await playerToken(c.env);
  const cookie = c.req.header("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)hm_player=([a-f0-9]+)/);
  if (m && m[1] === token) return next();
  if (c.req.query("pw") === c.env.PLAYER_PASSWORD) {
    c.header(
      "Set-Cookie",
      `hm_player=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`
    );
    return c.redirect(new URL(c.req.url).pathname);
  }
  const err = c.req.query("pw") !== undefined ? `<div class="flash err">Wrong password.</div>` : "";
  return c.html(
    layout({
      theme: getTheme(c.env),
      title: "Password",
      body: `<div class="center"><form class="card" style="max-width:360px;margin:40px auto" method="get">
  <h1>${esc(getTheme(c.env).title)}</h1>${err}
  <label>Password</label>
  <input type="password" name="pw" autofocus>
  <div class="btn-row"><button class="btn" type="submit" style="width:100%">Enter</button></div>
</form></div>`,
    })
  );
}

app.use("/play", playerGate);

// ---------------------------------------------------------------------------
// Round helpers
// ---------------------------------------------------------------------------

async function currentRound(env: Env): Promise<Round | null> {
  return env.DB.prepare(
    "SELECT * FROM rounds WHERE status IN ('open','scoring') ORDER BY id DESC LIMIT 1"
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

// ---------------------------------------------------------------------------
// Shared game state, cached in isolate memory. With 150 players polling every
// 2.5s this turns ~60 identical computations/sec into ~0.5/sec; the per-player
// bits stay fresh on every request. Staleness ≤2s is invisible at poll rate.
// ---------------------------------------------------------------------------

let sharedCache: { at: number; data: Record<string, unknown> } | null = null;

async function computeSharedState(c: C): Promise<Record<string, unknown>> {
  const t = now();
  let round = await currentRound(c.env);
  round = await maybeAutoClose(c, round);

  const out: Record<string, unknown> = { status: "idle" };

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
    };
    out.answer_count = count?.n ?? 0;
  }

  // Precomputed at scoring time (see scoring.ts writeMeta).
  const { results: meta } = await c.env.DB.prepare(
    "SELECT k, v FROM meta WHERE k IN ('last_results', 'leaderboard', 'game_over', 'round_ranks', 'overall_ranks', 'review_pending')"
  ).all<{ k: string; v: string }>();
  for (const m of meta) {
    if (m.k === "last_results") out.last = JSON.parse(m.v);
    if (m.k === "leaderboard") out.leaderboard = JSON.parse(m.v);
    if (m.k === "game_over") out.finale = true;
    // Internal — stripped from every /api/state response.
    if (m.k === "round_ranks") out._round_ranks = JSON.parse(m.v);
    if (m.k === "overall_ranks") out._overall_ranks = JSON.parse(m.v);
    if (m.k === "review_pending") out._review_pending = true;
  }
  out.leaderboard ??= [];

  const { results: sugs } = await c.env.DB.prepare(
    `SELECT s.id, s.text, s.num, COALESCE(SUM(v.vote), 0) AS score
     FROM suggestions s LEFT JOIN suggestion_votes v ON v.suggestion_id = s.id
     WHERE s.status = 'pending'
     GROUP BY s.id ORDER BY score DESC, s.id LIMIT 30`
  ).all<{ id: number; text: string; num: number; score: number }>();
  out.suggestions = sugs.map((g) => ({ ...g, your_vote: 0 }));

  return out;
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
      theme: getTheme(c.env),
      title: "Home",
      body: `
<div class="center" style="margin-top:40px">
  ${getTheme(c.env).bannerHtml}
  <div class="btn-row" style="justify-content:center;margin-top:26px">
    <a class="btn" href="/play">Player</a>
    <a class="btn secondary" href="/welcome">Welcome</a>
    <a class="btn secondary" href="/board">Board</a>
    <a class="btn secondary" href="/admin">Admin</a>
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

app.post("/api/suggest", async (c) => {
  const body = await c.req.json<{ player_id?: string; num?: number; thing?: string }>();
  const thing = String(body.thing ?? "").trim().slice(0, 280);
  const num = Math.max(1, Math.min(10, Number(body.num ?? 1) || 1));
  if (!body.player_id || !thing) return c.json({ error: "bad request" }, 400);
  const player = await c.env.DB.prepare("SELECT id FROM players WHERE id = ?")
    .bind(body.player_id)
    .first();
  if (!player) return c.json({ error: "Join with a name first." }, 403);
  await c.env.DB.prepare(
    "INSERT INTO suggestions (text, num, player_id, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(thing, num, body.player_id, now())
    .run();
  return c.json({ ok: true });
});

app.post("/api/leave", async (c) => {
  const { player_id } = await c.req.json<{ player_id?: string }>();
  if (player_id) {
    // Drop out of the active count right away; answers/scores stay.
    await c.env.DB.prepare("UPDATE players SET last_seen = 0 WHERE id = ?")
      .bind(player_id)
      .run();
  }
  // Expire the player-password cookie so /play shows the password page again.
  c.header("Set-Cookie", "hm_player=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  return c.json({ ok: true });
});

app.post("/api/vote", async (c) => {
  const body = await c.req.json<{ player_id?: string; suggestion_id?: number; vote?: number }>();
  const vote = Number(body.vote);
  if (!body.player_id || !body.suggestion_id || ![1, -1].includes(vote)) {
    return c.json({ error: "bad request" }, 400);
  }
  const sug = await c.env.DB.prepare(
    "SELECT id FROM suggestions WHERE id = ? AND status = 'pending'"
  )
    .bind(body.suggestion_id)
    .first();
  if (!sug) return c.json({ error: "unknown suggestion" }, 404);
  const existing = await c.env.DB.prepare(
    "SELECT vote FROM suggestion_votes WHERE suggestion_id = ? AND player_id = ?"
  )
    .bind(body.suggestion_id, body.player_id)
    .first<{ vote: number }>();
  if (existing && existing.vote === vote) {
    // Tapping the same arrow again removes the vote.
    await c.env.DB.prepare(
      "DELETE FROM suggestion_votes WHERE suggestion_id = ? AND player_id = ?"
    )
      .bind(body.suggestion_id, body.player_id)
      .run();
  } else {
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO suggestion_votes (suggestion_id, player_id, vote) VALUES (?, ?, ?)"
    )
      .bind(body.suggestion_id, body.player_id, vote)
      .run();
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Player page + API
// ---------------------------------------------------------------------------

app.get("/play", (c) =>
  c.html(
    layout({
      theme: getTheme(c.env),
      title: "Play",
      body: `<div id="nameBadge" class="namebadge" style="display:none" title="Tap to change your name"></div>
<div id="leaveBtn" class="namebadge leave" style="display:none">[ leave game ]</div>
<div id="app"><p class="muted">Loading…</p></div>`,
      script:
        `const SUGGEST_PH = ${JSON.stringify(getTheme(c.env).suggestPlaceholder)};\n` +
        PLAY_JS,
    })
  )
);

// Big-screen display: current question + live stats while a round runs,
// results + leaderboard between rounds. Put this on the projector.
app.get("/board", (c) => {
  const origin = new URL(c.req.url).origin;
  const playUrl = `${origin}/play`;
  // Dark-on-light QR (inverted QRs scan poorly), rendered inline as SVG.
  const qrSvg = renderSVG(playUrl, { ecc: "M", border: 2 });
  return c.html(
    layout({
      theme: getTheme(c.env),
      title: "Big screen",
      body: `<style>main{max-width:1600px}</style>
<div class="bqr-corner">${qrSvg}<div class="l">scan to join</div></div>
<div id="app" class="board"><p class="muted">Loading…</p></div>`,
      script:
        `const PLAY_URL = ${JSON.stringify(playUrl)};\nconst BANNER_HTML = ${JSON.stringify(getTheme(c.env).bannerHtml)};\n` +
        BOARD_JS,
    })
  );
});

// ---------------------------------------------------------------------------
// Welcome: hand this to the room — big QR to join, how to play, board link.
// ---------------------------------------------------------------------------

app.get("/welcome", (c) => {
  const origin = new URL(c.req.url).origin;
  const playUrl = `${origin}/play`;
  const qrSvg = renderSVG(playUrl, { ecc: "M", border: 2 });
  const theme = getTheme(c.env);
  return c.html(
    layout({
      theme,
      title: "Welcome",
      body: `<style>main{max-width:1200px}</style>
<div class="center welcome" style="margin-top:20px">
  ${theme.bannerHtml}
  <div class="wcols">
    <div class="card wqr">
      ${qrSvg}
      <p class="big" style="margin:12px 0 0">scan to play — or go to<br><a href="${playUrl}"><strong>${esc(playUrl.replace(/^https?:\/\//, ""))}</strong></a></p>
    </div>
    <div class="card wrules">
      <h2>How to play</h2>
      <ol>
        <li>Join with your name, then wait for the host to open a question.</li>
        <li>Every question asks you to <strong>name N things</strong> — fill in all N boxes with different answers before the round closes.</li>
        <li>Answers that mean the same thing count together (&quot;NYC&quot; = &quot;New York City&quot;). Each of your answers earns one point per player who gave a matching answer — including you.</li>
        <li>So don't be clever: write what you think <strong>most people</strong> will write.</li>
        <li>Between rounds, suggest questions and vote on other players' ideas.</li>
      </ol>
    </div>
  </div>
  <div class="btn-row" style="justify-content:center">
    <a class="btn" href="/play">Join the game</a>
    <a class="btn secondary" href="/board">Open the board</a>
  </div>
</div>`,
    })
  );
});

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

app.post("/api/rename", async (c) => {
  const { player_id, name } = await c.req.json<{ player_id?: string; name?: string }>();
  const clean = String(name ?? "").trim().slice(0, 40);
  if (!player_id || !clean) return c.json({ error: "name required" }, 400);
  const res = await c.env.DB.prepare("UPDATE players SET name = ? WHERE id = ?")
    .bind(clean, player_id)
    .run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "unknown player" }, 404);
  return c.json({ ok: true, name: clean });
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

  // --- per-player: identity check + throttled last_seen write -------------
  let unknownPlayer = false;
  if (playerId) {
    const p = await c.env.DB.prepare("SELECT last_seen FROM players WHERE id = ?")
      .bind(playerId)
      .first<{ last_seen: number }>();
    if (!p) {
      // Player id not in the DB (e.g. after a full reset) → client must re-join.
      unknownPlayer = true;
    } else if (t - p.last_seen >= LAST_SEEN_REFRESH) {
      await c.env.DB.prepare("UPDATE players SET last_seen = ? WHERE id = ?")
        .bind(t, playerId)
        .run();
    }
  }

  // --- shared state: identical for every player, cached per isolate -------
  if (!sharedCache || Date.now() - sharedCache.at > SHARED_TTL_MS) {
    sharedCache = { at: Date.now(), data: await computeSharedState(c) };
  }
  const shared = sharedCache.data;
  const out: Record<string, unknown> = { ...shared, server_time: t };
  // A scored round awaiting its second-opinion review: run it off this poll.
  // (runPendingReview claims atomically, so concurrent polls race safely.)
  if (out._review_pending) {
    c.executionCtx.waitUntil(
      runPendingReview(c.env).then(
        () => {
          sharedCache = null; // review may have changed the published results
        },
        (e) => console.error("cluster review failed", e)
      )
    );
  }
  delete out._review_pending;
  // Never ship the internal rank maps (they're keyed by player id).
  const roundRanks = out._round_ranks as { round_id: number; ranks: Record<string, number> } | undefined;
  const overallRanks = out._overall_ranks as Record<string, number> | undefined;
  delete out._round_ranks;
  delete out._overall_ranks;
  if (unknownPlayer) out.unknown_player = true;
  const round = shared.round as { id: number; closes_at: number | null } | undefined;
  if (round) {
    out.round = {
      ...round,
      seconds_left: round.closes_at ? Math.max(0, round.closes_at - t) : null,
    };
  }

  // --- per-player additions (small indexed lookups) ------------------------
  if (playerId && !unknownPlayer) {
    if (round) {
      const { results: mine } = await c.env.DB.prepare(
        "SELECT text FROM answers WHERE round_id = ? AND player_id = ? ORDER BY idx"
      )
        .bind(round.id, playerId)
        .all<{ text: string }>();
      out.answered = mine.length > 0;
      out.your_answers = mine.map((m) => m.text);
    }
    const last = shared.last as { id: number } | undefined;
    if (last) {
      const { results: mine } = await c.env.DB.prepare(
        `SELECT a.text, a.points, cl.label AS cluster_label
         FROM answers a LEFT JOIN clusters cl ON cl.id = a.cluster_id
         WHERE a.round_id = ? AND a.player_id = ? ORDER BY a.idx`
      )
        .bind(last.id, playerId)
        .all<{ text: string; points: number; cluster_label: string | null }>();
      if (mine.length) {
        out.last = {
          ...last,
          your: { answers: mine, total: mine.reduce((s, m) => s + m.points, 0) },
        };
      }
    }
    const place: Record<string, number> = {};
    if (roundRanks && last && roundRanks.round_id === last.id && roundRanks.ranks[playerId]) {
      place.round = roundRanks.ranks[playerId];
    }
    if (overallRanks?.[playerId]) place.overall = overallRanks[playerId];
    if (Object.keys(place).length) out.your_place = place;
    const { results: votes } = await c.env.DB.prepare(
      "SELECT suggestion_id, vote FROM suggestion_votes WHERE player_id = ?"
    )
      .bind(playerId)
      .all<{ suggestion_id: number; vote: number }>();
    const voteMap = new Map(votes.map((v) => [v.suggestion_id, v.vote]));
    out.suggestions = ((shared.suggestions as { id: number }[]) ?? []).map((g) => ({
      ...g,
      your_vote: voteMap.get(g.id) ?? 0,
    }));
  }

  return c.json(out);
});

// ---------------------------------------------------------------------------
// Results + leaderboard (public, projector-friendly)
// ---------------------------------------------------------------------------

app.get("/results", async (c) => {
  const { results: rounds } = await c.env.DB.prepare(
    "SELECT * FROM rounds WHERE status = 'scored' ORDER BY id DESC LIMIT 10"
  ).all<Round>();

  let body = `<h1>Results</h1>`;
  const open = await currentRound(c.env);
  if (open) {
    body += `<div class="flash ok">Round in progress: “${esc(open.question)}”</div>`;
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
      theme: getTheme(c.env),
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
      }, 10000);`,
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

  const medals = ["#1", "#2", "#3"];
  const body = `<h1>Leaderboard</h1>
${
  rows.length
    ? `<div class="card"><table>
  <tr><th></th><th>Player</th><th>Points</th><th>Rounds</th></tr>
  ${rows
    .map(
      (r, i) =>
        `<tr><td>${medals[i] ?? "#" + (i + 1)}</td><td>${esc(r.name)}</td><td><strong>${r.pts}</strong></td><td class="muted">${r.played}</td></tr>`
    )
    .join("")}
</table></div>`
    : `<p class="muted">No scores yet — play a round first!</p>`
}`;
  return c.html(
    layout({
      theme: getTheme(c.env),
      title: "Leaderboard",
      body,
      script: `setInterval(async () => {
        try {
          const html = await (await fetch(location.href)).text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          const fresh = doc.getElementById("content");
          if (fresh) document.getElementById("content").innerHTML = fresh.innerHTML;
        } catch {}
      }, 10000);`,
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
        theme: getTheme(c.env),
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
    `SELECT s.id, s.text, s.num, p.name AS author,
       COALESCE((SELECT SUM(vote) FROM suggestion_votes v WHERE v.suggestion_id = s.id), 0) AS score
     FROM suggestions s LEFT JOIN players p ON p.id = s.player_id
     WHERE s.status = 'pending' ORDER BY score DESC, s.id`
  ).all<{ id: number; text: string; num: number; author: string | null; score: number }>();
  const { results: recent } = await c.env.DB.prepare(
    "SELECT * FROM rounds ORDER BY id DESC LIMIT 10"
  ).all<Round>();
  const gameOver = !!(await c.env.DB.prepare(
    "SELECT v FROM meta WHERE k = 'game_over'"
  ).first());

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
      : `<p class="muted blink">Scoring</p>`
  }
</div>`;
  } else {
    roundCard = `<div class="card"><span class="pill">NO ACTIVE ROUND</span></div>`;
  }

  const suggestionRows = pending.length
    ? pending
        .map(
          (s) => `<div class="suggestion-row">
  <span class="pill" title="player votes">${s.score > 0 ? "+" : ""}${s.score}</span>
  <span class="text">${esc(composeQuestion(s.num, s.text))} <span class="muted small">— ${esc(s.author ?? "admin")}</span></span>
  <form id="ask${s.id}" method="post" action="/admin/open"><input type="hidden" name="suggestion_id" value="${s.id}"></form>
  ${minutesSelect(`ask${s.id}`)}
  <button class="btn sm" form="ask${s.id}" ${round ? "disabled title='Finish the current round first'" : ""}>Ask now</button>
  <button type="button" class="btn sm secondary" data-edit="${s.id}" data-num="${s.num}" data-text="${esc(s.text)}">Edit</button>
  <form method="post" action="/admin/suggestion/${s.id}/delete"><button class="btn sm secondary">Delete</button></form>
</div>`
        )
        .join("")
    : `<p class="muted">No pending suggestions.</p>`;

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
<p><a href="/board" target="_blank" style="color:var(--honey)">[ open the big-screen board ]</a></p>
${roundCard}
<h2>Open a question</h2>
<div class="card">
  <h3 style="margin-top:0">Suggestions queue (<span id="sugCount">${pending.length}</span>)</h3>
  <div id="sugList">${suggestionRows}</div>
  <h3>Or add your own</h3>
  <form id="custom" method="post" action="/admin/suggest">
    <div class="qcompose">
      <span class="qword">Name</span>
      <input type="number" name="num" value="3" min="1" max="10" class="qnum">
      <input type="text" name="thing" maxlength="280" class="qthing" placeholder="${esc(getTheme(c.env).suggestPlaceholder)}">
    </div>
    <div class="btn-row"><button class="btn">Add to queue</button></div>
  </form>
</div>
<h2>Recent rounds</h2>
<div class="card"><table><tr><th>#</th><th>Question</th><th>Status</th><th></th></tr>${recentRows || ""}</table>
  <p class="small"><a href="/results" style="color:var(--honey)">[ results ]</a></p>
</div>
<h2>End of game</h2>
<div class="card">
  ${
    gameOver
      ? `<span class="pill live">FINAL STANDINGS SHOWING ON BOARD</span>`
      : `<form method="post" action="/admin/finale" onsubmit="return confirm('End the game? The board switches to the final standings.')">
    <button class="btn" ${round ? "disabled title='Finish the current round first'" : ""}>End game</button>
  </form>`
  }
  <p class="muted small" style="margin-bottom:0">Board shows the podium + leaderboard. Opening a new question resumes play.</p>
</div>
<h2>Danger zone</h2>
<div class="card">
  <form method="post" action="/admin/reset-game" onsubmit="return confirm('Delete all GAME data? All rounds, answers, scores, and players. Suggested questions are kept (their votes are cleared).')">
    <button class="btn danger">Reset game data</button>
  </form>
  <p class="muted small">Deletes rounds, answers, scores, and players. Suggested questions are kept (votes are cleared since the voters are deleted).</p>
  <form method="post" action="/admin/reset-suggestions" onsubmit="return confirm('Delete all SUGGESTED QUESTIONS and their votes? Game data is kept.')">
    <button class="btn danger">Reset suggested questions</button>
  </form>
  <p class="muted small" style="margin-bottom:0">Deletes the suggestion queue and its votes. Game data is kept. <a href="/admin/logout" style="color:var(--muted)">Sign out</a></p>
</div>`;

  const script = `const roundKey=${JSON.stringify(round ? round.id + ":" + round.status : "none")};
const hasRound=${round ? "true" : "false"}, closesAt=${round?.closes_at ?? "null"};
const escj=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function tick(){
  if(closesAt===null) return;
  const left=Math.max(0, closesAt - Math.floor(Date.now()/1000));
  const el=document.getElementById('countdown');
  if(el) el.textContent=Math.floor(left/60)+':'+String(left%60).padStart(2,'0');
}
tick(); setInterval(tick,1000);
let sugKey='';
function renderSugs(s){
  if(document.querySelector('.sugedit')) return; // don't wipe an open editor
  const sugs=s.suggestions||[];
  const key=JSON.stringify(sugs);
  if(key===sugKey) return;
  sugKey=key;
  document.getElementById('sugCount').textContent=sugs.length;
  const minutes='<option value="1">1 min</option><option value="2" selected>2 min</option><option value="3">3 min</option><option value="5">5 min</option><option value="0">No timer</option>';
  const dis=hasRound?' disabled title="Finish the current round first"':'';
  document.getElementById('sugList').innerHTML = sugs.length ? sugs.map(g=>
    '<div class="suggestion-row">'+
    '<span class="pill" title="player votes">'+(g.score>0?'+':'')+g.score+'</span>'+
    '<span class="text">'+escj('Name '+g.num+' '+g.text)+' <span class="muted small">— '+escj(g.author??'admin')+'</span></span>'+
    '<form id="ask'+g.id+'" method="post" action="/admin/open"><input type="hidden" name="suggestion_id" value="'+g.id+'"></form>'+
    '<select name="minutes" form="ask'+g.id+'" title="Timer">'+minutes+'</select>'+
    '<button class="btn sm" form="ask'+g.id+'"'+dis+'>Ask now</button>'+
    '<button type="button" class="btn sm secondary" data-edit="'+g.id+'" data-num="'+g.num+'" data-text="'+escj(g.text)+'">Edit</button>'+
    '<form method="post" action="/admin/suggestion/'+g.id+'/delete"><button class="btn sm secondary">Delete</button></form>'+
    '</div>').join('') : '<p class="muted">No pending suggestions.</p>';
}
document.getElementById('sugList').addEventListener('click', e=>{
  const b=e.target.closest('button[data-edit]');
  if(!b) return;
  const row=b.closest('.suggestion-row');
  row.innerHTML='<form method="post" action="/admin/suggestion/'+b.dataset.edit+'/edit" class="sugedit qcompose" style="flex:1">'+
    '<span class="qword">Name</span>'+
    '<input type="number" name="num" min="1" max="10" value="'+escj(b.dataset.num)+'" class="qnum">'+
    '<input type="text" name="thing" maxlength="280" value="'+escj(b.dataset.text)+'" class="qthing" required>'+
    '<button class="btn sm">Save</button>'+
    '<button type="button" class="btn sm secondary" data-cancel>Cancel</button></form>';
  row.querySelector('[data-cancel]').onclick=()=>{ row.remove(); sugKey=''; poll(); };
  row.querySelector('.qthing').focus();
});
async function poll(){
  try{
    const s=await (await fetch('/api/admin/state')).json();
    if((s.round? s.round.id+':'+s.round.status : 'none') !== roundKey){ location.reload(); return; }
    if(hasRound){
      document.getElementById('answerCount').textContent=s.answer_count;
      document.getElementById('activeCount').textContent=s.active_count;
      document.getElementById('liveAnswers').innerHTML=(s.answers||[])
        .map(a=>'<div>'+escj(a.name)+': \u201c'+escj(a.text)+'\u201d</div>').join('');
    }
    renderSugs(s);
  }catch(e){}
}
poll(); setInterval(poll,2000);`;

  return c.html(layout({ theme: getTheme(c.env), title: "Admin", body, script }));
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
  const { results: sugs } = await c.env.DB.prepare(
    `SELECT s.id, s.text, s.num, p.name AS author,
       COALESCE((SELECT SUM(vote) FROM suggestion_votes v WHERE v.suggestion_id = s.id), 0) AS score
     FROM suggestions s LEFT JOIN players p ON p.id = s.player_id
     WHERE s.status = 'pending' ORDER BY score DESC, s.id`
  ).all<{ id: number; text: string; num: number; author: string | null; score: number }>();
  out.suggestions = sugs;
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
  const stmts: D1PreparedStatement[] = [];
  const wasOver = !!(await c.env.DB.prepare(
    "SELECT v FROM meta WHERE k = 'game_over'"
  ).first());
  if (wasOver) {
    // First question after "End game" starts a fresh game: wipe all scores
    // and round history, keep players and the suggestion queue.
    stmts.push(
      c.env.DB.prepare("DELETE FROM answers"),
      c.env.DB.prepare("DELETE FROM clusters"),
      c.env.DB.prepare("DELETE FROM rounds"),
      c.env.DB.prepare(
        "DELETE FROM meta WHERE k IN ('last_results', 'leaderboard', 'round_ranks', 'overall_ranks', 'game_over')"
      )
    );
  }
  stmts.push(
    c.env.DB.prepare(
      "INSERT INTO rounds (question, num, suggestion_id, status, opened_at, closes_at) VALUES (?, ?, ?, 'open', ?, ?)"
    ).bind(composeQuestion(num, thing), num, suggestionId, t, minutes > 0 ? t + minutes * 60 : null)
  );
  await c.env.DB.batch(stmts);
  sharedCache = null;
  return c.redirect("/admin");
});

app.post("/admin/finale", async (c) => {
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO meta (k, v) VALUES ('game_over', '1')"
  ).run();
  sharedCache = null;
  return c.redirect("/admin");
});

app.post("/admin/close", async (c) => {
  const round = await currentRound(c.env);
  if (round && round.status === "open" && (await claimForScoring(c.env, round.id))) {
    startScoring(c, round.id);
  }
  sharedCache = null;
  return c.redirect("/admin");
});

app.post("/admin/suggest", async (c) => {
  const form = await c.req.formData();
  const thing = String(form.get("thing") ?? "").trim().slice(0, 280);
  const num = Math.max(1, Math.min(10, Number(form.get("num") ?? 1) || 1));
  if (thing) {
    // player_id NULL marks it as an admin suggestion.
    await c.env.DB.prepare(
      "INSERT INTO suggestions (text, num, player_id, created_at) VALUES (?, ?, NULL, ?)"
    )
      .bind(thing, num, now())
      .run();
    sharedCache = null;
  }
  return c.redirect("/admin");
});

app.post("/admin/suggestion/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const form = await c.req.formData();
  const thing = String(form.get("thing") ?? "").trim().slice(0, 280);
  const num = Math.max(1, Math.min(10, Number(form.get("num") ?? 1) || 1));
  if (thing) {
    await c.env.DB.prepare(
      "UPDATE suggestions SET text = ?, num = ? WHERE id = ? AND status = 'pending'"
    )
      .bind(thing, num, id)
      .run();
    sharedCache = null;
  }
  return c.redirect("/admin");
});

app.post("/admin/suggestion/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM suggestion_votes WHERE suggestion_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM suggestions WHERE id = ? AND status = 'pending'").bind(id),
  ]);
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
    // Awaited (not waitUntil): the admin waits out both the clustering and
    // the second-opinion review, so neither hits the waitUntil time budget.
    await scoreRound(c.env, id).catch((e) => console.error("scoreRound failed", e));
    await runPendingReview(c.env).catch((e) => console.error("cluster review failed", e));
    sharedCache = null;
  }
  return c.redirect("/admin");
});

app.post("/admin/reset-game", async (c) => {
  // Game wipe: rounds, answers, scores, AND players. Suggestions survive,
  // but their votes go (voters are deleted) and authorship is detached
  // (suggestions.player_id references players).
  // Phones holding a stale player id get bounced back to the name prompt.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM answers"),
    c.env.DB.prepare("DELETE FROM clusters"),
    c.env.DB.prepare("DELETE FROM rounds"),
    c.env.DB.prepare("DELETE FROM suggestion_votes"),
    c.env.DB.prepare("UPDATE suggestions SET player_id = NULL"),
    c.env.DB.prepare("DELETE FROM players"),
    c.env.DB.prepare("DELETE FROM meta"),
  ]);
  sharedCache = null;
  return c.redirect("/admin");
});

app.post("/admin/reset-suggestions", async (c) => {
  // Suggestion-queue wipe: suggested questions and their votes. Game data
  // survives; rounds opened from a suggestion are detached first
  // (rounds.suggestion_id references suggestions).
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE rounds SET suggestion_id = NULL"),
    c.env.DB.prepare("DELETE FROM suggestion_votes"),
    c.env.DB.prepare("DELETE FROM suggestions"),
  ]);
  sharedCache = null;
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
  updateBadge();
  app.innerHTML = \`
  <div class="center" style="margin-top:30px">
    <h1>Hive Mind</h1>
    <form class="card" style="max-width:380px;margin:0 auto" id="joinForm">
      <label style="font-size:1.2em">What is your name?</label>
      <input type="text" id="nameInput" maxlength="40" autofocus required>
      <div class="btn-row"><button class="btn" style="width:100%">Enter</button></div>
    </form>
  </div>\`;
  document.getElementById('joinForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('nameInput').value.trim();
    if (!name) return;
    const r = await fetch('/api/join', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    if (r.ok) { player = await r.json(); localStorage.setItem(LS, JSON.stringify(player)); updateBadge(); viewKey=''; poll(); }
  };
}

function updateBadge() {
  const badge = document.getElementById('nameBadge');
  const leave = document.getElementById('leaveBtn');
  if (!player) { badge.style.display = 'none'; leave.style.display = 'none'; return; }
  badge.textContent = '> ' + player.name;
  badge.style.display = 'block';
  leave.style.display = 'block';
  leave.onclick = async () => {
    if (!window.confirm('Leave the game?')) return;
    try {
      await fetch('/api/leave', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ player_id: player.player_id }) });
    } catch {}
    localStorage.removeItem(LS);
    location.href = '/play';
  };
  badge.onclick = async () => {
    const name = (window.prompt('New name:', player.name) || '').trim();
    if (!name || name === player.name) return;
    const r = await fetch('/api/rename', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ player_id: player.player_id, name }) });
    if (r.ok) {
      const j = await r.json();
      player.name = j.name;
      localStorage.setItem(LS, JSON.stringify(player));
      updateBadge();
      viewKey = '';
      poll();
    }
  };
}
updateBadge();

function lastResultsHtml(s) {
  if (!s.last) return '';
  const tops = (s.last.clusters || []).slice(0, 8).map(c =>
    \`<div class="cluster"><span class="count">\${c.size}</span><strong>\${esc(c.label)}</strong></div>\`).join('');
  const yours = s.last.your
    ? s.last.your.answers.map(a =>
        \`<div class="cluster"><span class="count">\${a.points}</span><span>“\${esc(a.text)}”</span></div>\`).join('') +
      \`<div class="cluster"><span class="count">\${s.last.your.total}</span><strong>TOTAL</strong></div>\`
    : '';
  const p = s.your_place || {};
  const place = '<div class="statgrid" style="justify-content:center;margin:14px 0">' +
    (p.round ? '<div class="stat"><div class="n">#' + p.round + '</div><div class="l">this round</div></div>' : '') +
    (p.overall ? '<div class="stat"><div class="n">#' + p.overall + '</div><div class="l">overall</div></div>' : '') +
    '<a class="stat" href="/leaderboard" style="text-decoration:none"><div class="n">»</div><div class="l">leaderboard</div></a>' +
    '</div>';
  return \`<h2>Last question</h2>
    <div class="question">\${esc(s.last.question)}</div>
    <div class="twocol">
      <div class="card"><h3 style="margin-top:0">Top answers</h3>\${tops || '<p class="muted">No answers.</p>'}</div>
      \${yours ? '<div class="card"><h3 style="margin-top:0">Your answers</h3>' + yours + '</div>' : ''}
    </div>
    \${place}\`;
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
  const key = [s.status, s.round && s.round.id, s.answered, s.last && s.last.id, s.finale ? 'F' : ''].join(':');
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
        <label>Your answer\${n > 1 ? 's' : ''}</label>
        \${inputs}
        <div id="formErr"></div>
        <div class="btn-row"><button class="btn">Lock it in</button></div>
      </form>
      <p class="muted small"><span id="liveCount">\${s.answer_count}</span> answered</p>\`;
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
  } else if ((s.status === 'open' || s.status === 'scoring') && s.answered) {
    // Waiting for the round to wrap up (incl. scoring — no separate screen);
    // the results view takes over on the next poll after scores land.
    app.innerHTML = \`
      <p class="small"><span class="pill live">ROUND LIVE</span> \${s.status === 'open' && s.round.closes_at ? '<span class="countdown" id="cd"></span> left' : ''}</p>
      <div class="question">\${esc(s.round.question)}</div>
      <div class="card center">
        <p class="big">\${(s.your_answers || []).map(a => '“' + esc(a) + '”').join(' · ')}</p>
        <p class="muted"><span id="liveCount">\${s.answer_count}</span> answered</p>
      </div>
      <div id="sugSection"></div>\`;
    startCountdown(s.status === 'open' ? s.round.closes_at : null);
  } else if (s.status === 'scoring') {
    app.innerHTML = \`
      <div class="card center"><p class="big blink">AWAITING NEXT QUESTION</p></div>
      <div id="sugSection"></div>\`;
  } else if (s.finale) {
    const lb = s.leaderboard || [];
    const rows = lb.map((r, i) =>
      \`<tr\${i < 3 ? ' class="me"' : ''}><td>\${['#1','#2','#3'][i] ?? '#' + (i + 1)}</td><td>\${esc(r.name)}</td><td><strong>\${r.pts}</strong></td></tr>\`).join('');
    const p = s.your_place || {};
    app.innerHTML = \`
      <div class="card center"><p class="big blink">GAME OVER</p></div>
      <h2>Final standings</h2>
      <div class="card"><table>\${rows || '<tr><td class="muted">No scores.</td></tr>'}</table></div>
      \${p.overall ? '<div class="statgrid" style="justify-content:center;margin:14px 0"><div class="stat"><div class="n">#' + p.overall + '</div><div class="l">your place</div></div></div>' : ''}
      <div id="sugSection"></div>\`;
  } else {
    app.innerHTML = \`
      <div class="card center"><p class="big blink">AWAITING NEXT QUESTION</p></div>
      \${lastResultsHtml(s)}
      <div id="sugSection"></div>\`;
  }
}

let sugListKey = '';
function renderSuggestions(s) {
  const el = document.getElementById('sugSection');
  if (!el) return;
  if (!document.getElementById('voteBox')) {
    // Static shell built once (the suggest form must survive polls),
    // only the vote list re-renders.
    el.innerHTML = '<h2>Vote on upcoming questions</h2><div class="card" id="voteBox">' +
      '<div id="voteList"></div>' +
      '<form id="sugForm" class="qcompose" style="margin-top:12px">' +
        '<span class="qword">Name</span>' +
        '<input type="number" id="sugNum" value="3" min="1" max="10" class="qnum">' +
        '<input type="text" id="sugThing" maxlength="280" class="qthing" placeholder="' + SUGGEST_PH + '">' +
        '<button class="btn sm">Add</button>' +
      '</form><div id="sugMsg"></div></div>';
    sugListKey = '';
    document.getElementById('voteList').onclick = async (e) => {
      const b = e.target.closest('button[data-vote]');
      if (!b) return;
      await fetch('/api/vote', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ player_id: player.player_id, suggestion_id: Number(b.dataset.id), vote: Number(b.dataset.vote) }) });
      poll();
    };
    document.getElementById('sugForm').onsubmit = async (e) => {
      e.preventDefault();
      const thing = document.getElementById('sugThing').value.trim();
      const num = Number(document.getElementById('sugNum').value) || 1;
      const msg = document.getElementById('sugMsg');
      if (!thing) return;
      const r = await fetch('/api/suggest', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ player_id: player.player_id, num, thing }) });
      if (r.ok) {
        document.getElementById('sugThing').value = '';
        msg.innerHTML = '<div class="flash ok">In the queue.</div>';
        poll();
      } else {
        const j = await r.json().catch(() => ({}));
        msg.innerHTML = '<div class="flash err">' + esc(j.error || 'Something went wrong.') + '</div>';
      }
    };
  }
  const sugs = s.suggestions || [];
  const key = JSON.stringify(sugs);
  if (key === sugListKey) return;
  sugListKey = key;
  document.getElementById('voteList').innerHTML = sugs.length
    ? sugs.map(g =>
        '<div class="sugrow">' +
        '<button class="votebtn' + (g.your_vote === 1 ? ' active' : '') + '" data-id="' + g.id + '" data-vote="1">▲</button>' +
        '<span class="sugscore">' + g.score + '</span>' +
        '<button class="votebtn down' + (g.your_vote === -1 ? ' active' : '') + '" data-id="' + g.id + '" data-vote="-1">▼</button>' +
        '<span class="sugtext">Name ' + g.num + ' ' + esc(g.text) + '</span></div>').join('')
    : '<p class="muted">Nothing in the queue yet.</p>';
}

async function poll() {
  if (!player) { renderJoin(); return; }
  try {
    const r = await fetch('/api/state?player=' + encodeURIComponent(player.player_id));
    if (r.ok) {
      state = await r.json();
      if (state.unknown_player) {
        // Game was reset — this identity no longer exists, start over.
        localStorage.removeItem(LS);
        player = null;
        viewKey = '';
        app.innerHTML = '';
        renderJoin();
        return;
      }
      render();
      renderSuggestions(state);
    }
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
const joinHint = '<div class="bjoinrow">' +
  '<p class="bjoin">&gt;&gt; join the game: <a href="' + PLAY_URL + '"><strong>' + PLAY_URL.replace(/^https?:\\/\\//, '') + '</strong></a> &lt;&lt;</p>' +
  '</div>';
const bannerHtml = BANNER_HTML;

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

function scoreTableHtml(title, rows) {
  if (!(rows || []).length) return '';
  return '<div class="bpanel"><h2>' + title + '</h2><table class="btable">' +
    rows.slice(0, 8).map((r, i) =>
      '<tr><td>' + (['#1','#2','#3'][i] ?? '#' + (i + 1)) + '</td><td>' + esc(r.name) + '</td><td><strong>' + r.pts + '</strong></td></tr>').join('') +
    '</table></div>';
}

function suggestionsHtml(s) {
  // Same row count as the other panels, so a full queue fills the column;
  // with fewer suggestions the panel just stays shorter.
  const sugs = (s.suggestions || []).slice(0, 8);
  if (!sugs.length) return '';
  return '<div class="bpanel"><h2>Top suggestions</h2>' +
    sugs.map(g =>
      '<div class="bcluster"><span class="count">' + g.score + '</span><span>Name ' + g.num + ' ' + esc(g.text) + '</span></div>').join('') +
    '</div>';
}

function podiumHtml(s) {
  const lb = s.leaderboard || [];
  const spot = (r, cls, medal) => r
    ? '<div class="pspot ' + cls + '"><div class="pmedal">' + medal + '</div>' +
      '<div class="pname">' + esc(r.name) + '</div><div class="ppts">' + r.pts + ' pts</div></div>'
    : '';
  return '<div class="podium">' + spot(lb[1], 'second', '2ND') + spot(lb[0], 'first', '1ST') + spot(lb[2], 'third', '3RD') + '</div>' +
    (lb.length > 3
      ? '<div class="bcols"><div class="bpanel"><table class="btable">' +
        lb.slice(3, 10).map((r, i) =>
          '<tr><td>#' + (i + 4) + '</td><td>' + esc(r.name) + '</td><td><strong>' + r.pts + '</strong></td></tr>').join('') +
        '</table></div></div>'
      : '');
}

function render(s) {
  const sugKey = (s.suggestions || []).slice(0, 5).map(g => g.id + '.' + g.score).join(',');
  const key = [s.status, s.round && s.round.id, s.last && s.last.id, sugKey, s.finale ? 'F' : ''].join(':');
  const aEl = document.getElementById('bAnswered');
  if (aEl) aEl.textContent = s.answer_count;
  const pEl = document.getElementById('bActive');
  if (pEl) pEl.textContent = s.active_count;
  if (key === viewKey) return;
  viewKey = key;

  if (s.finale && s.status !== 'open' && s.status !== 'scoring') {
    clearInterval(countdownTimer);
    app.innerHTML = \`
      \${bannerHtml}
      <div class="bfinal">FINAL STANDINGS</div>
      \${podiumHtml(s)}\`;
  } else if (s.status === 'open') {
    app.innerHTML = \`
      \${bannerHtml}
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
      \${bannerHtml}
      <div class="bq">\${esc(s.round.question)}</div>
      <div class="bcd blink">SCORING</div>\`;
  } else if (s.last) {
    const clusters = (s.last.clusters || []).slice(0, 8).map(c => {
      const extra = (c.texts || []).filter(t => t.toLowerCase() !== String(c.label).toLowerCase());
      return '<div class="bcluster"><span class="count">' + c.size + '</span><span class="bclab">' + esc(c.label) + '</span>' +
        (extra.length ? '<span class="bctexts">' + esc(extra.join('  ·  ')) + '</span>' : '') + '</div>';
    }).join('');
    app.innerHTML = \`
      \${bannerHtml}
      <div class="bq">\${esc(s.last.question)}</div>
      <div class="bcols">
        <div class="bpanel"><h2>Top answers</h2>\${clusters || '<p class="muted">No answers.</p>'}<p class="bmore"><a href="/results">&raquo; full results</a></p></div>
        \${scoreTableHtml('Round scores', s.last.top)}
        \${scoreTableHtml('Leaderboard', s.leaderboard)}
        \${suggestionsHtml(s)}
      </div>
      \${joinHint}\`;
  } else {
    app.innerHTML = \`
      \${bannerHtml}
      <div class="bq"><span class="blink">STAND BY</span></div>
      <div class="bstats">
        <div class="stat"><div class="n" id="bActive">\${s.active_count}</div><div class="l">players joined</div></div>
      </div>
      \${s.suggestions && s.suggestions.length ? '<div class="bcols">' + suggestionsHtml(s) + '</div>' : ''}
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
