export const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  );

export function layout(o: {
  title: string;
  body: string;
  script?: string;
  nav?: boolean;
}): string {
  const nav =
    o.nav === false
      ? ""
      : `<nav>
      <a href="/" class="brand">🐝 Hive Mind</a>
      <a href="/play">Play</a>
      <a href="/results">Results</a>
      <a href="/leaderboard">Leaderboard</a>
      <a href="/suggest">Suggest</a>
    </nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · Hive Mind</title>
<style>${CSS}</style>
</head>
<body>
${nav}
<main id="content">${o.body}</main>
${o.script ? `<script>${o.script}</script>` : ""}
</body>
</html>`;
}

export const CSS = `
:root {
  --bg: #16130d;
  --panel: #241f15;
  --panel2: #2e2819;
  --ink: #f4ecd8;
  --muted: #a89c7e;
  --honey: #f5b82e;
  --honey-dark: #c98f10;
  --good: #7ec46a;
  --bad: #e06c5a;
  --radius: 14px;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
nav {
  display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  padding: 12px 18px; background: var(--panel); border-bottom: 2px solid var(--honey-dark);
}
nav a { color: var(--muted); text-decoration: none; font-weight: 600; }
nav a:hover { color: var(--honey); }
nav .brand { color: var(--honey); font-size: 1.15em; margin-right: 6px; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 60px; }
h1 { color: var(--honey); margin: 0.4em 0; }
h2 { margin: 1.2em 0 0.4em; }
.card {
  background: var(--panel); border: 1px solid #3a3322; border-radius: var(--radius);
  padding: 18px 20px; margin: 14px 0;
}
.muted { color: var(--muted); }
.small { font-size: 0.85em; }
.big { font-size: 1.5em; }
.center { text-align: center; }
label { display: block; font-weight: 600; margin: 12px 0 4px; }
input[type=text], input[type=password], textarea, select {
  width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #4a4028;
  background: var(--panel2); color: var(--ink); font: inherit;
}
textarea { min-height: 90px; resize: vertical; }
.btn {
  display: inline-block; padding: 10px 22px; border: none; border-radius: 999px;
  background: var(--honey); color: #241a00; font-weight: 800; font-size: 1em;
  cursor: pointer; text-decoration: none;
}
.btn:hover { background: #ffd056; }
.btn.secondary { background: var(--panel2); color: var(--ink); border: 1px solid #4a4028; }
.btn.danger { background: var(--bad); color: #fff; }
.btn.sm { padding: 5px 14px; font-size: 0.85em; }
.btn-row { margin-top: 14px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.flash { padding: 10px 14px; border-radius: 10px; margin: 10px 0; }
.flash.ok { background: #2c3d24; color: var(--good); }
.flash.err { background: #46231d; color: var(--bad); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #3a3322; }
th { color: var(--muted); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; }
tr.me td { color: var(--honey); font-weight: 700; }
.question {
  font-size: 1.45em; font-weight: 700; line-height: 1.3;
  padding: 18px 20px; background: var(--panel2); border-left: 4px solid var(--honey);
  border-radius: var(--radius); margin: 14px 0;
}
.cluster {
  display: flex; align-items: baseline; gap: 12px; padding: 9px 12px;
  border-bottom: 1px solid #3a3322;
}
.cluster:last-child { border-bottom: none; }
.cluster .count {
  min-width: 2.4em; text-align: center; background: var(--honey); color: #241a00;
  border-radius: 8px; font-weight: 800; padding: 2px 6px;
}
.cluster .members { color: var(--muted); font-size: 0.82em; }
.countdown { font-variant-numeric: tabular-nums; color: var(--honey); font-weight: 800; }
.pill {
  display: inline-block; padding: 2px 11px; border-radius: 999px; font-size: 0.78em;
  font-weight: 700; background: var(--panel2); color: var(--muted);
}
.pill.live { background: #2c3d24; color: var(--good); }
.suggestion-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px solid #3a3322; }
.suggestion-row .text { flex: 1 1 280px; }
.statgrid { display: flex; gap: 14px; flex-wrap: wrap; }
.stat { background: var(--panel2); border-radius: 10px; padding: 10px 18px; text-align: center; }
.stat .n { font-size: 1.6em; font-weight: 800; color: var(--honey); }
.stat .l { font-size: 0.75em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
`;
