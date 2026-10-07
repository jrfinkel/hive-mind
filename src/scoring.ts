import type { Env, Answer } from "./types";
import { now } from "./types";

// Fast + cheap Workers AI model used to cluster free-text answers.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// Stronger reasoning model that reviews the proposed clusters (second
// opinion): it evicts members that don't belong (e.g. "lost luggage"
// sneaking into the "airplanes" cluster).
const REVIEW_MODEL = "@cf/openai/gpt-oss-120b";

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
      const t0 = Date.now();
      const repClusters = await clusterWithAI(env, round?.question ?? "", reps);
      console.log(`clusterWithAI: ${reps.length} reps in ${Date.now() - t0}ms`);
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

  await persistClusters(env, roundId, clusters, answers);
  await writeMeta(env, roundId);

  // Queue the second-opinion pass. It runs in a separate invocation (claimed
  // by a later poll, or awaited by the admin rescore route) because scoring
  // usually runs in waitUntil(), whose ~30s budget fits only one model call.
  if (answers.length > 0) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO meta (k, v) VALUES ('review_pending', ?)"
    )
      .bind(String(roundId))
      .run();
  }
}

/** Replace a round's clusters + per-answer points, then mark it scored. */
async function persistClusters(
  env: Env,
  roundId: number,
  clusters: ClusterDraft[],
  answers: Answer[]
): Promise<void> {
  // A cluster's size (and the points it awards) counts DISTINCT players, so a
  // player whose multiple answers get over-merged can't score off themselves.
  const playerOf = new Map(answers.map((a) => [a.id, a.player_id]));
  const sizeOf = (cl: ClusterDraft) =>
    new Set(cl.ids.map((id) => playerOf.get(id))).size;
  clusters.sort((x, y) => sizeOf(y) - sizeOf(x));

  // Persist: wipe any previous result, then clusters, then per-answer
  // cluster assignment + points.
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE answers SET cluster_id = NULL, points = 0 WHERE round_id = ?"
    ).bind(roundId),
    env.DB.prepare("DELETE FROM clusters WHERE round_id = ?").bind(roundId),
  ];
  for (const cl of clusters) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO clusters (round_id, label, size) VALUES (?, ?, ?)"
      ).bind(roundId, cl.label, sizeOf(cl))
    );
  }
  await env.DB.batch(stmts);

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
}

/**
 * If a round is waiting for its second-opinion review, claim it (exactly one
 * caller wins) and run the review. Any failure just leaves the first-pass
 * scoring in place.
 */
export async function runPendingReview(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT v FROM meta WHERE k = 'review_pending'"
  ).first<{ v: string }>();
  if (!row) return;
  const res = await env.DB.prepare(
    "DELETE FROM meta WHERE k = 'review_pending' AND v = ?"
  )
    .bind(row.v)
    .run();
  if ((res.meta.changes ?? 0) === 0) return; // someone else claimed it
  await reviewRound(env, Number(row.v));
}

/** Second-opinion pass over an already-scored round: ask a stronger model to
 * evict cluster members that don't belong, and re-persist if it found any. */
async function reviewRound(env: Env, roundId: number): Promise<void> {
  const round = await env.DB.prepare(
    "SELECT question FROM rounds WHERE id = ? AND status = 'scored'"
  )
    .bind(roundId)
    .first<{ question: string }>();
  if (!round) return;
  const { results: answers } = await env.DB.prepare(
    "SELECT * FROM answers WHERE round_id = ?"
  )
    .bind(roundId)
    .all<Answer>();
  const { results: cls } = await env.DB.prepare(
    "SELECT id, label FROM clusters WHERE round_id = ?"
  )
    .bind(roundId)
    .all<{ id: number; label: string }>();
  if (!cls.length) return;

  // Rebuild drafts from the stored clustering, deduped to one representative
  // answer per distinct text within each cluster (what the reviewer sees).
  const byCluster = new Map<number, Answer[]>();
  for (const a of answers) {
    if (a.cluster_id == null) continue;
    const g = byCluster.get(a.cluster_id);
    if (g) g.push(a);
    else byCluster.set(a.cluster_id, [a]);
  }
  const drafts: ClusterDraft[] = [];
  const reps: Answer[] = [];
  const expand = new Map<number, number[]>();
  for (const cl of cls) {
    const members = byCluster.get(cl.id) ?? [];
    if (!members.length) continue;
    const d = dedupe(members);
    reps.push(...d.reps);
    for (const [k, v] of d.expand) expand.set(k, v);
    drafts.push({ label: cl.label, ids: d.reps.map((a) => a.id) });
  }

  const reviewed = await reviewClusters(env, round.question, drafts, reps);
  if (!reviewed) return; // reviewer approved everything

  const full = reviewed.map((cl) => ({
    label: cl.label,
    ids: cl.ids.flatMap((id) => expand.get(Number(id)) ?? [Number(id)]),
  }));
  await persistClusters(env, roundId, sanitize(full, answers), answers);
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
      "SELECT id, label, size FROM clusters WHERE round_id = ? ORDER BY size DESC, id LIMIT 10"
    )
      .bind(roundId)
      .all<{ id: number; label: string; size: number }>();
    // Top exact strings per cluster (by how often that exact text appeared),
    // so the board can show what people actually typed.
    const { results: texts } = await env.DB.prepare(
      `SELECT cluster_id, text, COUNT(*) AS n FROM answers
       WHERE round_id = ? AND cluster_id IS NOT NULL
       GROUP BY cluster_id, text ORDER BY n DESC, text`
    )
      .bind(roundId)
      .all<{ cluster_id: number; text: string; n: number }>();
    const textsByCluster = new Map<number, string[]>();
    for (const t of texts) {
      const arr = textsByCluster.get(t.cluster_id) ?? [];
      if (arr.length < 6) {
        arr.push(t.text);
        textsByCluster.set(t.cluster_id, arr);
      }
    }
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
          clusters: cls.map((c) => ({
            label: c.label,
            size: c.size,
            texts: textsByCluster.get(c.id) ?? [],
          })),
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
          'NEVER create a catch-all group (e.g. "no match", "other", "misc") — unmatched answers each get their own single-id group. ' +
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

/**
 * Second opinion on proposed clusters: a stronger model can evict members
 * that don't belong in their group (they become their own group) and merge
 * whole groups that refer to the same thing (the first pass sometimes leaves
 * "pilots" and "a pilot" apart). Returns null when nothing changed.
 */
async function reviewClusters(
  env: Env,
  question: string,
  clusters: ClusterDraft[],
  reps: Answer[]
): Promise<ClusterDraft[] | null> {
  if (clusters.length < 2) return null;
  const textOf = new Map(reps.map((a) => [a.id, a.text]));
  const listing = clusters
    .map(
      (cl, i) =>
        `G${i + 1} "${cl.label}": ` +
        cl.ids
          .filter((id) => textOf.has(Number(id)))
          .map((id) => `[${id}: ${textOf.get(Number(id))}]`)
          .join(" ")
    )
    .join("\n");
  const prompt =
    "You are reviewing grouped answers for a party game where players score by giving the same answer. " +
    "A group must contain every answer that refers to the exact same thing, and nothing else — spelling, " +
    "capitalization, abbreviation, plural, typo, or alternate-name variants of one thing belong together. " +
    "Two fixes are available:\n" +
    '1. evict: an answer id whose answer CLEARLY refers to a different thing than the rest of its group — merely related or same-category is not the same thing (e.g. "lost luggage" is not "airplanes").\n' +
    '2. merge: group numbers that refer to the exact same thing and must be one group (e.g. a group "pilots" and a group "a pilot"; "TSA" and "airport security"). NEVER merge groups that are just related or in the same category ("coffee" and "starbucks" stay separate).\n' +
    "Be conservative: borderline judgment calls stay as they are. " +
    'Reply with ONLY this JSON, nothing else: {"evict":[12,34],"merge":[[1,4],[2,7]]} — use empty arrays if nothing needs fixing.\n\n' +
    `Question: ${question}\n\nGroups:\n${listing}`;
  const t0 = Date.now();
  const raw = await runText(env, REVIEW_MODEL, prompt);
  console.log(`cluster review: ${clusters.length} groups in ${Date.now() - t0}ms`);
  // The reply object has no nested braces, so take the last {...} mentioning "evict".
  const matches = raw.match(/\{[^{}]*"evict"[^{}]*\}/g) ?? raw.match(/\{[\s\S]*\}/g);
  if (!matches) throw new Error("no JSON in review output: " + raw.slice(0, 200));
  const parsed = JSON.parse(matches[matches.length - 1]) as {
    evict?: unknown[];
    merge?: unknown[];
  };
  const evict = new Set(
    (Array.isArray(parsed.evict) ? parsed.evict : []).map(Number).filter(Number.isFinite)
  );
  const merges = (Array.isArray(parsed.merge) ? parsed.merge : []).filter(
    (s): s is unknown[] => Array.isArray(s)
  );
  if (!evict.size && !merges.length) return null;

  // Apply evictions: pull the ids out of their groups.
  const work = clusters.map((cl) => ({
    label: cl.label,
    ids: cl.ids.filter((id) => !evict.has(Number(id))),
  }));
  // Apply merges: fold each listed group into the biggest group of its set.
  const absorbed = new Set<number>();
  for (const set of merges) {
    const idxs = [
      ...new Set(
        set
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= work.length)
          .map((n) => n - 1)
      ),
    ].filter((i) => !absorbed.has(i));
    if (idxs.length < 2) continue;
    const target = idxs.reduce((a, b) => (work[a].ids.length >= work[b].ids.length ? a : b));
    for (const i of idxs) {
      if (i === target) continue;
      absorbed.add(i);
      work[target].ids.push(...work[i].ids);
      work[i].ids = [];
    }
  }

  console.log(
    "cluster review:",
    `evicted [${[...evict].map((id) => textOf.get(id) ?? id).join(", ")}],`,
    `merged [${merges.map((s) => s.join("+")).join(" ")}]`
  );
  const out: ClusterDraft[] = work.filter((cl) => cl.ids.length);
  for (const id of evict) {
    if (textOf.has(id)) out.push({ label: textOf.get(id)!, ids: [id] });
  }
  return out;
}

/** Run a plain-text prompt; handles both Workers AI input schemas (gpt-oss
 * models use Responses-style `input`, most others use chat `messages`). */
async function runText(env: Env, model: string, prompt: string): Promise<string> {
  const m = model as Parameters<Ai["run"]>[0];
  try {
    return extractText(await env.AI.run(m, { input: prompt } as never));
  } catch {
    return extractText(
      await env.AI.run(m, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
      } as never)
    );
  }
}

/** Pull the text out of whichever response shape the model returned. */
function extractText(res: unknown): string {
  if (typeof res === "string") return res;
  const r = res as Record<string, unknown>;
  if (typeof r?.response === "string") return r.response;
  // Responses-API shape: output[] items with content[] parts carrying text.
  if (Array.isArray(r?.output)) {
    const texts: string[] = [];
    for (const item of r.output as Array<Record<string, unknown>>) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content as Array<Record<string, unknown>>) {
          if (typeof part?.text === "string") texts.push(part.text);
        }
      }
    }
    if (texts.length) return texts.join("\n");
  }
  throw new Error("no text in model output: " + JSON.stringify(res).slice(0, 300));
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

/** The model sometimes invents a catch-all bucket despite the prompt. Those
 * members didn't actually match anyone, so they must not score as one big
 * cluster (in a 150-person round that catch-all would top the board!). */
const JUNK_LABEL =
  /^(none|n\/?a|nothing|others?|misc(ellaneous)?|unique|singletons?)$|no ?match|unmatched|ungrouped|no group|leftovers?|catch[- ]?all|not the same|unrelated|do(es)? ?n[o']t match/i;

/**
 * Make model output safe: drop unknown/duplicate ids and empty clusters;
 * explode catch-all buckets; group every unassigned answer by exact
 * (normalized) text so identical answers still score together.
 */
function sanitize(clusters: ClusterDraft[], answers: Answer[]): ClusterDraft[] {
  const valid = new Map(answers.map((a) => [a.id, a]));
  const seen = new Set<number>();
  const out: ClusterDraft[] = [];
  const strays: Answer[] = [];
  for (const cl of clusters) {
    const ids = (Array.isArray(cl.ids) ? cl.ids : [])
      .map(Number)
      .filter((id) => valid.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (!ids.length) continue;
    const label = String(cl.label ?? "").trim();
    if (JUNK_LABEL.test(label)) {
      strays.push(...ids.map((id) => valid.get(id)!));
    } else {
      out.push({ label: label || valid.get(ids[0])!.text, ids });
    }
  }
  for (const a of answers) {
    if (!seen.has(a.id)) strays.push(a);
  }
  // Exact-text grouping (not one singleton per answer): eight people who all
  // wrote "bad wifi" should score 8 together even if the model skipped them.
  out.push(...clusterExact(strays));
  out.sort((x, y) => y.ids.length - x.ids.length);
  return out;
}
