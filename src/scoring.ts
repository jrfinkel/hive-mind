import type { Env, Answer } from "./types";
import { now } from "./types";

// Fast + cheap Workers AI model used to cluster free-text answers.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

type ClusterDraft = { label: string; ids: number[] };

/**
 * Score a round: cluster all answers (AI with exact-match fallback), store
 * clusters, and award each player points equal to the size of their cluster.
 * The caller must have already claimed the round (status = 'scoring') so this
 * runs exactly once.
 */
export async function scoreRound(env: Env, roundId: number): Promise<void> {
  const round = await env.DB.prepare("SELECT * FROM rounds WHERE id = ?")
    .bind(roundId)
    .first<{ question: string }>();
  const { results: answers } = await env.DB.prepare(
    "SELECT * FROM answers WHERE round_id = ?"
  )
    .bind(roundId)
    .all<Answer>();

  let clusters: ClusterDraft[] = [];
  if (answers.length > 0) {
    try {
      // Pre-group exact duplicates so the model only sees unique answers —
      // with 150 players most answers repeat, so this keeps the prompt and
      // the response small no matter the crowd size.
      const { reps, expand } = dedupe(answers);
      const repClusters = await clusterWithAI(env, round?.question ?? "", reps);
      clusters = repClusters.map((cl) => ({
        label: cl.label,
        ids: (Array.isArray(cl.ids) ? cl.ids : []).flatMap(
          (id) => expand.get(Number(id)) ?? [Number(id)]
        ),
      }));
    } catch (err) {
      console.error("AI clustering failed, using exact-match fallback", err);
      clusters = clusterExact(answers);
    }
    clusters = sanitize(clusters, answers);
  }

  // A cluster's size (and the points it awards) counts DISTINCT players, so a
  // player whose multiple answers get over-merged can't score off themselves.
  const playerOf = new Map(answers.map((a) => [a.id, a.player_id]));
  const sizeOf = (cl: ClusterDraft) =>
    new Set(cl.ids.map((id) => playerOf.get(id))).size;
  clusters.sort((x, y) => sizeOf(y) - sizeOf(x));

  // Persist: clusters, then per-answer cluster assignment + points.
  const stmts: D1PreparedStatement[] = [];
  for (const cl of clusters) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO clusters (round_id, label, size) VALUES (?, ?, ?)"
      ).bind(roundId, cl.label, sizeOf(cl))
    );
  }
  if (stmts.length) await env.DB.batch(stmts);

  const { results: saved } = await env.DB.prepare(
    "SELECT id, label FROM clusters WHERE round_id = ? ORDER BY id"
  )
    .bind(roundId)
    .all<{ id: number; label: string }>();

  const updates: D1PreparedStatement[] = [];
  clusters.forEach((cl, i) => {
    const clusterId = saved[i]?.id;
    for (const answerId of cl.ids) {
      updates.push(
        env.DB.prepare(
          "UPDATE answers SET cluster_id = ?, points = ? WHERE id = ?"
        ).bind(clusterId, sizeOf(cl), answerId)
      );
    }
  });
  updates.push(
    env.DB.prepare(
      "UPDATE rounds SET status = 'scored', scored_at = ? WHERE id = ?"
    ).bind(now(), roundId)
  );
  await env.DB.batch(updates);

  await writeMeta(env, roundId);
}

/**
 * Precompute the payloads that every player poll displays (last round results
 * + leaderboard) so /api/state never aggregates over the answers table.
 */
/** player_id -> place, with ties sharing a place (1,2,2,4). Rows must be
 * sorted by pts descending. */
function rankMap(rows: { player_id: string; pts: number }[]): Record<string, number> {
  const m: Record<string, number> = {};
  let rank = 0;
  let prev = Infinity;
  rows.forEach((r, i) => {
    if (r.pts < prev) {
      rank = i + 1;
      prev = r.pts;
    }
    m[r.player_id] = rank;
  });
  return m;
}

async function writeMeta(env: Env, roundId: number): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  // Leaderboard always reflects all scored rounds.
  const { results: top } = await env.DB.prepare(
    `SELECT p.name, SUM(a.points) AS pts FROM answers a
     JOIN players p ON p.id = a.player_id
     JOIN rounds r ON r.id = a.round_id AND r.status = 'scored'
     GROUP BY p.id ORDER BY pts DESC LIMIT 10`
  ).all<{ name: string; pts: number }>();
  stmts.push(
    env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('leaderboard', ?)").bind(
      JSON.stringify(top)
    )
  );

  // Full overall rank map for per-player "your place" stats on /play.
  const { results: overallAll } = await env.DB.prepare(
    `SELECT a.player_id, SUM(a.points) AS pts FROM answers a
     JOIN rounds r ON r.id = a.round_id AND r.status = 'scored'
     GROUP BY a.player_id ORDER BY pts DESC`
  ).all<{ player_id: string; pts: number }>();
  stmts.push(
    env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('overall_ranks', ?)").bind(
      JSON.stringify(rankMap(overallAll))
    )
  );

  // "Last results" only if this is the newest scored round (a rescore of an
  // older round must not hijack the between-rounds screen).
  const latest = await env.DB.prepare(
    "SELECT MAX(id) AS id FROM rounds WHERE status = 'scored'"
  ).first<{ id: number }>();
  if (latest?.id === roundId) {
    const round = await env.DB.prepare("SELECT question FROM rounds WHERE id = ?")
      .bind(roundId)
      .first<{ question: string }>();
    const { results: cls } = await env.DB.prepare(
      "SELECT label, size FROM clusters WHERE round_id = ? ORDER BY size DESC, id LIMIT 10"
    )
      .bind(roundId)
      .all<{ label: string; size: number }>();
    const total = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM answers WHERE round_id = ?"
    )
      .bind(roundId)
      .first<{ n: number }>();
    const { results: roundTop } = await env.DB.prepare(
      `SELECT p.name, SUM(a.points) AS pts FROM answers a
       JOIN players p ON p.id = a.player_id
       WHERE a.round_id = ?
       GROUP BY p.id ORDER BY pts DESC LIMIT 10`
    )
      .bind(roundId)
      .all<{ name: string; pts: number }>();
    const { results: roundAll } = await env.DB.prepare(
      `SELECT player_id, SUM(points) AS pts FROM answers
       WHERE round_id = ? GROUP BY player_id ORDER BY pts DESC`
    )
      .bind(roundId)
      .all<{ player_id: string; pts: number }>();
    stmts.push(
      env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('round_ranks', ?)").bind(
        JSON.stringify({ round_id: roundId, ranks: rankMap(roundAll) })
      )
    );
    stmts.push(
      env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_results', ?)").bind(
        JSON.stringify({
          id: roundId,
          question: round?.question ?? "",
          total_answers: total?.n ?? 0,
          clusters: cls,
          top: roundTop,
        })
      )
    );
  }
  await env.DB.batch(stmts);
}

/** Group answers whose normalized text matches exactly; return one
 * representative per group plus a map to expand back to all ids. */
function dedupe(answers: Answer[]): { reps: Answer[]; expand: Map<number, number[]> } {
  const norm = (s: string) =>
    s.toLowerCase().trim().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ");
  const groups = new Map<string, Answer[]>();
  for (const a of answers) {
    const key = norm(a.text) || a.text;
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  const reps: Answer[] = [];
  const expand = new Map<number, number[]>();
  for (const group of groups.values()) {
    reps.push(group[0]);
    expand.set(
      group[0].id,
      group.map((a) => a.id)
    );
  }
  return { reps, expand };
}

async function clusterWithAI(
  env: Env,
  question: string,
  answers: Answer[]
): Promise<ClusterDraft[]> {
  const list = answers.map((a) => `${a.id}: ${a.text.slice(0, 200)}`).join("\n");
  const res = (await env.AI.run(MODEL as Parameters<Ai["run"]>[0], {
    messages: [
      {
        role: "system",
        content:
          "You group answers for a party game where players try to give the same answer as each other. " +
          "Group two answers ONLY if they refer to the exact same thing — the same person, place, object, or concept. " +
          "Different spellings, capitalization, abbreviations, plurals, typos, or alternate names of the SAME thing " +
          'belong together (e.g. "NYC" / "new york" / "New York City"; "dog" / "dogs"; "Geoff Hinton" / "hinton"). ' +
          "NEVER group answers just because they belong to the same category: for “name a farm animal”, " +
          '"cow" and "chicken" are both farm animals but are DIFFERENT answers and must be in separate groups. ' +
          "When unsure, keep answers separate. " +
          "Label each group with the most common phrasing among its answers — never a category name. " +
          "Every answer id must appear in exactly one group; an answer with no match is its own group of one. " +
          'Reply with ONLY valid JSON: {"clusters":[{"label":"most common phrasing","ids":[1,2]}]}',
      },
      {
        role: "user",
        content: `Question: ${question}\n\nAnswers (id: text):\n${list}`,
      },
    ],
    max_tokens: 4096,
    temperature: 0.1,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          clusters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                ids: { type: "array", items: { type: "integer" } },
              },
              required: ["label", "ids"],
            },
          },
        },
        required: ["clusters"],
      },
    },
  })) as { response?: unknown };

  // With JSON mode the model may return a parsed object or a JSON string.
  let parsed: { clusters?: ClusterDraft[] };
  if (typeof res.response === "string") {
    const match = res.response.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON in model output: " + res.response.slice(0, 200));
    parsed = JSON.parse(match[0]);
  } else if (res.response && typeof res.response === "object") {
    parsed = res.response as { clusters?: ClusterDraft[] };
  } else {
    throw new Error("unexpected model output: " + JSON.stringify(res).slice(0, 200));
  }
  if (!Array.isArray(parsed.clusters)) throw new Error("missing clusters array");
  return parsed.clusters;
}

/** Fallback: group answers whose normalized text matches exactly. */
export function clusterExact(answers: Answer[]): ClusterDraft[] {
  const norm = (s: string) =>
    s.toLowerCase().trim().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ");
  const groups = new Map<string, ClusterDraft>();
  for (const a of answers) {
    const key = norm(a.text) || a.text;
    const g = groups.get(key);
    if (g) g.ids.push(a.id);
    else groups.set(key, { label: a.text.trim(), ids: [a.id] });
  }
  return [...groups.values()];
}

/**
 * Make model output safe: drop unknown/duplicate ids, give any unassigned
 * answer its own singleton cluster, drop empty clusters.
 */
function sanitize(clusters: ClusterDraft[], answers: Answer[]): ClusterDraft[] {
  const valid = new Map(answers.map((a) => [a.id, a]));
  const seen = new Set<number>();
  const out: ClusterDraft[] = [];
  for (const cl of clusters) {
    const ids = (Array.isArray(cl.ids) ? cl.ids : [])
      .map(Number)
      .filter((id) => valid.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (ids.length) {
      out.push({ label: String(cl.label ?? "").trim() || valid.get(ids[0])!.text, ids });
    }
  }
  for (const a of answers) {
    if (!seen.has(a.id)) out.push({ label: a.text.trim(), ids: [a.id] });
  }
  out.sort((x, y) => y.ids.length - x.ids.length);
  return out;
}
