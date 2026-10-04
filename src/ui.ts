export const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  );

/** FIGlet-style banner. String.raw keeps the backslashes intact. */
export const BANNER = String.raw`
 _   _ _____     _____   __  __ ___ _   _ ____
| | | |_ _\ \   / / ____||  \/  |_ _| \ | |  _ \
| |_| || | \ \ / /|  _|  | |\/| || ||  \| | | | |
|  _  || |  \ V / | |___ | |  | || || |\  | |_| |
|_| |_|___|  \_/  |_____||_|  |_|___|_| \_|____/
`.replace(/^\n/, "");

/**
 * Fixed background layer of star-cropped faces (public/faces/star*.png).
 * Spots mostly hug the viewport edges so the centered content column stays
 * readable; opaque cards hide whatever sits under them. There are more face
 * images than spots, so each page load samples a random subset.
 */
const FACE_COUNT = 37;
// Jittered 7x4 grid over the whole viewport; center spots sit behind the
// opaque cards/panels, so they only peek out around the content.
const FACE_SPOTS: Array<[pos: string, top: string, w: number]> = [
  ["left:-2%", "top:2%", 185],
  ["left:12%", "top:7%", 140],
  ["left:27%", "top:1%", 160],
  ["left:42%", "top:6%", 125],
  ["left:56%", "top:2%", 155],
  ["left:71%", "top:8%", 135],
  ["left:86%", "top:3%", 180],
  ["left:4%", "top:28%", 155],
  ["left:18%", "top:33%", 170],
  ["left:33%", "top:27%", 130],
  ["left:48%", "top:32%", 150],
  ["left:62%", "top:26%", 165],
  ["left:77%", "top:31%", 135],
  ["left:91%", "top:27%", 155],
  ["left:-1%", "top:54%", 165],
  ["left:14%", "top:58%", 130],
  ["left:29%", "top:52%", 155],
  ["left:44%", "top:57%", 140],
  ["left:58%", "top:53%", 170],
  ["left:73%", "top:58%", 125],
  ["left:88%", "top:52%", 160],
  ["left:7%", "top:80%", 140],
  ["left:22%", "top:84%", 160],
  ["left:37%", "top:79%", 135],
  ["left:52%", "top:84%", 155],
  ["left:66%", "top:78%", 180],
  ["left:81%", "top:83%", 130],
  ["left:94%", "top:79%", 150],
];
function faceLayer(): string {
  const ids = Array.from({ length: FACE_COUNT }, (_, i) => i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return (
    `<div class="facestars" aria-hidden="true">` +
    FACE_SPOTS.map(
      ([pos, top, w], i) =>
        `<img src="/faces/star${ids[i]}.png" alt="" style="${pos};${top};width:${w}px">`
    ).join("") +
    `</div>`
  );
}

export function layout(o: {
  title: string;
  body: string;
  script?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · HIVE MIND</title>
<style>${CSS}</style>
</head>
<body>
${faceLayer()}
<main id="content">${o.body}</main>
${o.script ? `<script>${o.script}</script>` : ""}
</body>
</html>`;
}

export const CSS = `
:root {
  --bg: #030503;
  --panel: #060c06;
  --panel2: #0b150b;
  --ink: #2bff6f;
  --muted: #1c9448;
  --honey: #ffb000;
  --honey-dark: #b87d00;
  --good: #2bff6f;
  --bad: #ff4b4b;
  --radius: 0;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-monospace, Menlo, Monaco, "Cascadia Mono", "Courier New", monospace;
  text-shadow: 0 0 6px rgba(43, 255, 111, 0.28);
  overflow-x: hidden;
}
/* CRT scanlines */
body::before {
  content: ""; position: fixed; inset: 0; z-index: 9999; pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.22) 2px 4px);
}
/* Star-cropped face scatter behind everything */
.facestars { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.facestars img { position: absolute; opacity: 0.18; }
/* Phones: the desktop scatter overlaps badly at ~400px wide — keep every
   third star and shrink them. */
@media (max-width: 700px) {
  .facestars img { width: 100px !important; }
  .facestars img:nth-child(3n+1), .facestars img:nth-child(3n) { display: none; }
}
main, .namebadge { position: relative; z-index: 1; }
a { color: var(--ink); }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 60px; }
h1 {
  color: var(--honey); margin: 0.4em 0; text-transform: uppercase;
  letter-spacing: 0.12em; text-shadow: 0 0 8px rgba(255,176,0,0.4);
}
h1::before { content: ">> "; color: var(--honey-dark); }
h2 { margin: 1.2em 0 0.4em; text-transform: uppercase; letter-spacing: 0.08em; }
h2::before { content: ":: "; color: var(--muted); }
h3 { text-transform: uppercase; letter-spacing: 0.06em; }
.banner {
  color: var(--honey); font-size: clamp(7px, 2.4vw, 14px); line-height: 1.12;
  overflow-x: auto; margin: 12px 0; text-shadow: 0 0 8px rgba(255,176,0,0.35);
}
.blink::after { content: "█"; margin-left: 3px; animation: blink 1.1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.card {
  background: var(--panel); border: 1px solid var(--muted); border-radius: 0;
  padding: 18px 20px; margin: 14px 0;
}
.muted { color: var(--muted); }
.small { font-size: 0.85em; }
.big { font-size: 1.4em; }
.center { text-align: center; }
label { display: block; font-weight: 700; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.9em; }
input[type=text], input[type=password], input[type=number], textarea, select {
  width: 100%; padding: 10px 12px; border-radius: 0; border: 1px solid var(--muted);
  background: #000; color: var(--ink); font: inherit; caret-color: var(--ink);
  font-size: 16px; /* <16px makes iOS Safari zoom in on focus and stay zoomed */
}
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--honey); }
textarea { min-height: 90px; resize: vertical; }
.btn {
  display: inline-block; padding: 9px 20px; border: 1px solid var(--honey); border-radius: 0;
  background: var(--honey); color: #000; font: inherit; font-weight: 800;
  text-transform: uppercase; letter-spacing: 0.08em; cursor: pointer;
  text-decoration: none; text-shadow: none;
}
.btn:hover { background: #000; color: var(--honey); }
.btn.secondary { background: transparent; color: var(--ink); border-color: var(--muted); }
.btn.secondary:hover { background: var(--ink); color: #000; }
.btn.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
.btn.danger:hover { background: var(--bad); color: #000; }
.btn.sm { padding: 4px 12px; font-size: 0.85em; }
.btn-row { margin-top: 14px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.flash { padding: 10px 14px; border-radius: 0; margin: 10px 0; background: #000; }
.flash.ok { border: 1px solid var(--good); color: var(--good); }
.flash.err { border: 1px solid var(--bad); color: var(--bad); text-shadow: none; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px dashed var(--muted); }
th { color: var(--muted); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; }
tr.me td { color: var(--honey); font-weight: 700; }
.question {
  font-size: 1.35em; font-weight: 700; line-height: 1.35;
  padding: 18px 20px; background: #000; border: 3px double var(--honey);
  border-radius: 0; margin: 14px 0; color: var(--ink);
}
.cluster {
  display: flex; align-items: baseline; gap: 12px; padding: 9px 12px;
  border-bottom: 1px dashed var(--muted);
}
.cluster:last-child { border-bottom: none; }
.cluster .count {
  min-width: 2.4em; text-align: center; background: var(--honey); color: #000;
  border-radius: 0; font-weight: 800; padding: 2px 6px; text-shadow: none;
}
.cluster .members { color: var(--muted); font-size: 0.82em; }
.twocol { display: flex; gap: 10px; align-items: flex-start; }
.twocol > .card { flex: 1; min-width: 0; }
.twocol .cluster { overflow-wrap: anywhere; padding: 7px 6px; gap: 8px; }
.countdown { font-variant-numeric: tabular-nums; color: var(--honey); font-weight: 800; text-shadow: 0 0 8px rgba(255,176,0,0.4); }
.pill {
  display: inline-block; font-size: 0.82em; font-weight: 700;
  background: transparent; color: var(--muted); letter-spacing: 0.05em;
}
.pill::before { content: "[ "; }
.pill::after { content: " ]"; }
.pill.live { color: var(--good); }
.suggestion-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--muted); }
.suggestion-row .text { flex: 1 1 280px; }
.sugrow { display: flex; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px dashed var(--muted); }
.sugrow:last-of-type { border-bottom: none; }
.sugrow .sugtext { flex: 1; margin-left: 8px; }
.sugscore { min-width: 1.8em; text-align: center; font-weight: 800; color: var(--honey); font-variant-numeric: tabular-nums; }
.votebtn {
  background: #000; color: var(--ink); border: 1px solid var(--muted);
  border-radius: 0; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 0.95em;
}
.votebtn:hover { border-color: var(--ink); }
.votebtn.active { background: var(--honey); color: #000; border-color: var(--honey); font-weight: 800; text-shadow: none; }
.votebtn.down.active { background: var(--bad); color: #000; border-color: var(--bad); }
.namebadge {
  position: fixed; top: 10px; right: 14px; z-index: 10;
  background: #000; border: 1px solid var(--honey); border-radius: 0;
  padding: 5px 14px; font-weight: 700; color: var(--honey); cursor: pointer;
  font-size: 0.9em;
}
.namebadge:hover { background: var(--panel2); }
.namebadge.leave {
  top: 48px; color: var(--muted); border-color: var(--muted);
  font-size: 0.75em; padding: 3px 10px;
}
.statgrid { display: flex; gap: 14px; flex-wrap: wrap; }
.stat { background: #000; border: 1px solid var(--muted); border-radius: 0; padding: 10px 18px; text-align: center; }
.stat .n { font-size: 1.6em; font-weight: 800; color: var(--honey); }
.stat .l { font-size: 0.75em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.qcompose { display: flex; gap: 8px; align-items: center; }
.qcompose input { min-width: 0; }
.qcompose .qword { font-weight: 800; color: var(--honey); font-size: 1.1em; text-transform: uppercase; }
.qcompose .qnum { width: 74px; flex: none; }
.qcompose .qthing { flex: 1; }

/* Big-screen board (/board) */
.board { text-align: center; padding-top: 0; }
.board .banner { font-size: clamp(7px, 1.2vw, 12px); display: inline-block; text-align: left; margin: 6px 0; }
.board .bq {
  font-size: clamp(1.4em, 3.4vh, 2.4em); font-weight: 800; line-height: 1.3; margin: 14px auto;
  padding: 18px 26px; background: #000; border: 3px double var(--honey);
  max-width: 1000px; text-align: left; color: var(--ink);
}
.board .bcd { font-size: 4.5em; font-weight: 800; color: var(--honey); font-variant-numeric: tabular-nums; text-shadow: 0 0 14px rgba(255,176,0,0.5); }
.board .bstats { display: flex; gap: 20px; justify-content: center; margin: 20px 0; }
.board .bstats .stat { padding: 16px 34px; }
.board .bstats .n { font-size: 2.6em; }
.board .bstats .l { font-size: 1em; }
.board .bjoinrow { display: flex; gap: 22px; align-items: center; justify-content: center; margin-top: 14px; }
.board .bjoin { color: var(--muted); font-size: 1.1em; margin: 0; text-transform: uppercase; letter-spacing: 0.06em; }
.board .bqr svg { width: 128px; height: 128px; display: block; }
.board .bjoin a { text-decoration: none; }
.board .bjoin strong { color: var(--honey); text-shadow: 0 0 8px rgba(255,176,0,0.4); text-transform: none; }
.board .bcols { display: flex; gap: 14px; justify-content: center; align-items: flex-start; flex-wrap: wrap; }
.board .bpanel {
  background: var(--panel); border: 1px solid var(--muted);
  padding: 12px 18px; flex: 1 1 290px; max-width: 480px; text-align: left;
  min-width: 0; /* let panels shrink below content width so all fit one row */
}
.board .bpanel h2 { margin-top: 0; color: var(--honey); font-size: 1.05em; }
.board .bcluster { display: flex; gap: 12px; align-items: center; font-size: 1.2em; padding: 5px 0; }
.board .bcluster .count {
  min-width: 2em; text-align: center; background: var(--honey); color: #000;
  border-radius: 0; font-weight: 800; padding: 2px 6px; font-size: 0.9em; text-shadow: none;
}
.board .btable { font-size: 1.1em; }
.board .btable td { border-bottom: 1px dashed var(--muted); padding: 4px 10px; }
.board .bfinal {
  color: var(--honey); font-size: 2.2em; font-weight: 800; margin: 10px 0 0;
  text-transform: uppercase; letter-spacing: 0.18em; text-shadow: 0 0 14px rgba(255,176,0,0.5);
}
.board .podium { display: flex; gap: 22px; justify-content: center; align-items: flex-end; margin: 26px 0 22px; }
.board .pspot { background: #000; border: 2px solid var(--muted); padding: 16px 30px; min-width: 190px; }
.board .pspot .pmedal { color: var(--muted); font-weight: 800; letter-spacing: 0.14em; }
.board .pspot .pname { font-size: 1.8em; font-weight: 800; color: var(--ink); margin: 4px 0; overflow-wrap: anywhere; }
.board .pspot .ppts { font-size: 1.2em; color: var(--honey); font-weight: 800; }
.board .pspot.first {
  border: 3px double var(--honey); padding: 26px 40px; min-width: 240px;
  box-shadow: 0 0 26px rgba(255,176,0,0.35);
}
.board .pspot.first .pmedal { color: var(--honey); font-size: 1.3em; }
.board .pspot.first .pname { font-size: 2.6em; color: var(--honey); text-shadow: 0 0 10px rgba(255,176,0,0.45); }
.board .pspot.first .ppts { font-size: 1.5em; }
`;
