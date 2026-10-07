# 🐝 Hive Mind

Party game for events: everyone answers a question with what they think *most
people* will say; you score points equal to the number of players whose answer
matched yours (an AI model clusters "NYC" / "new york" / "New York City" into
one answer).

Cloudflare Worker (Hono + TypeScript) + D1 (SQLite) + Workers AI — same stack
and account as fuse.

## Pages

| URL            | Who      | What |
|----------------|----------|------|
| `/`            | everyone | Landing page with links |
| `/welcome`     | everyone | Big QR code to join + how-to-play instructions |
| `/suggest`     | everyone | Submit question ideas (go into the admin queue) |
| `/play`        | players  | Join with a name, answer live questions, see your score |
| `/results`     | everyone | Top answers + counts per question; auto-refreshes (projector-friendly) |
| `/leaderboard` | everyone | Total points; auto-refreshes |
| `/admin`       | host     | Password-gated (see `ADMIN_PASSWORD` in `wrangler.toml`) |

## How a round works

Questions always have the form **“Name N things”** (e.g. “Name 3 important NLP
researchers”); the suggest and admin forms have separate fields for the number
and the thing, and players get N answer boxes.

1. Admin picks a question from the suggestion queue (or types their own) and
   sets a timer (default 2 min, or no timer).
2. Players on `/play` see the question instantly (pages poll every ~2.5 s) and
   type their free-form answers (must all be different). They can edit them
   until the round closes.
3. The round closes when the timer runs out, every active player has answered
   (players active = polled in the last 45 s; needs ≥2 active and the round to
   be ≥20 s old), or the admin clicks **Close & score now**.
4. Scoring sends all answers to Workers AI
   (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) to cluster equivalent answers.
   If the model call fails, scoring falls back to exact-match grouping (case /
   punctuation insensitive) so the game never stalls. Each answer earns points equal to its
   cluster's size, and a player's round score is the sum over their answers.
   Admin can **Rescore** any round to re-run the clustering.

## Develop

```sh
npm install
npm run migrate:local   # once, creates the local D1 database
npm run dev             # http://localhost:8787
```

Note: the Workers AI binding talks to Cloudflare even in local dev, so local
dev needs `wrangler login`. Without it, comment out the `[ai]` block in
`wrangler.toml` and scoring uses the exact-match fallback.

## Deploy (first time)

```sh
npx wrangler login
npx wrangler d1 create hive-mind-db   # paste printed database_id into wrangler.toml
npm run migrate:remote
npm run deploy
```

After that, just `npm run deploy`.
