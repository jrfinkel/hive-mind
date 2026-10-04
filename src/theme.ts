// ---------------------------------------------------------------------------
// Themes. One codebase serves two deployments ("hive-mind" and "bear-plane");
// the THEME var in wrangler.toml picks the skin. Everything visual that
// differs between them lives here — functional code never branches on theme.
// ---------------------------------------------------------------------------

import { BANNER } from "./ui";

export type Theme = {
  key: "hive" | "bearplane";
  /** Site name, used as the <title> suffix. */
  title: string;
  /** Big title mark shown on the landing page and the board. */
  bannerHtml: string;
  /** Example text for the "suggest a question" inputs. */
  suggestPlaceholder: string;
  /** Extra tags for <head> (font links etc.). */
  headExtra: string;
  /** Theme override CSS, appended after the base stylesheet. */
  cssExtra: string;
  /** Background scatter images (drawn by faceLayer in ui.ts). */
  bgImages: string[];
  /** Width multiplier applied to the scatter spot sizes. */
  bgScale: number;
};

const HIVE: Theme = {
  key: "hive",
  title: "HIVE MIND",
  bannerHtml: `<pre class="banner" style="display:inline-block;text-align:left">${BANNER}</pre>`,
  suggestPlaceholder: "NLP researchers",
  headExtra: "",
  cssExtra: "",
  bgImages: Array.from({ length: 37 }, (_, i) => `/faces/star${i}.png`),
  bgScale: 1,
};

// Named "bear-plane" only in the URL/worker; the game is still HIVE MIND.
const BEARPLANE: Theme = {
  key: "bearplane",
  title: "HIVE MIND",
  // Title sits over a panorama of the view from the BZN gate windows
  // (Bridger range across the tarmac).
  bannerHtml: `<div class="bpbanner"><div class="bpmark" aria-label="Hive Mind"><span class="bpword">HIVE</span><span class="bpicon">✈</span><span class="bpword alt">MIND</span></div></div>`,
  suggestPlaceholder: "mountain towns",
  headExtra:
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Cabin:wght@400;700&display=swap" rel="stylesheet">`,
  bgImages: [
    // Bear/plane posters (bp2/bp4/bp6/bp9 retired in favor of airport views)
    ...[0, 1, 3, 5, 7, 8].map((i) => `/bearplane/bp${i}.jpg`),
    "/bearplane/bp10.png",
    "/bearplane/bp11.jpg",
    // Views from the terminal: gate windows, tarmac + windsock, dawn runway
    ...[1, 2, 3].map((i) => `/bearplane/bpview${i}.jpg`),
    // Sandblasted wooden signboards, like the ones by BZN baggage claim
    // (styled without the poster frame — CSS matches "bpsign" in the src).
    ...Array.from({ length: 6 }, (_, i) => `/bearplane/bpsign${i}.jpg`),
  ],
  bgScale: 1.3,
  // Kitschy mountain-lodge reskin (think Bozeman Yellowstone airport decor):
  // parchment + timber + rust, slab-serif signage, framed vintage posters on
  // the walls instead of phosphor glow and scanlines.
  cssExtra: `
:root {
  --bg: #f3ead7; --panel: #fdf7e7; --panel2: #f0e4c9;
  --ink: #3d2f22; --muted: #7a6a52;
  --honey: #b5542d; --honey-dark: #8a3d1e;
  --good: #2e5d3b; --bad: #a03426;
}
body {
  font: 16px/1.55 Cabin, "Trebuchet MS", Verdana, sans-serif;
  text-shadow: none;
}
/* Faint lumberjack plaid wash instead of CRT scanlines */
body::before {
  background:
    repeating-linear-gradient(0deg, rgba(166,88,44,0.045) 0 3px, transparent 3px 26px),
    repeating-linear-gradient(90deg, rgba(46,93,59,0.045) 0 3px, transparent 3px 26px);
}
h1, h2, h3, .btn, .qcompose .qword {
  font-family: "Alfa Slab One", "Rockwell", serif; font-weight: 400;
}
h1 { color: var(--good); text-shadow: none; letter-spacing: 0.04em; }
h1::before, h2::before { content: ""; }
h2 { color: var(--honey-dark); }
a { color: var(--good); }
.card, .board .bpanel {
  border: 2px solid #c6b087; border-radius: 12px;
  box-shadow: 0 3px 8px rgba(80, 55, 25, 0.12);
}
input[type=text], input[type=password], input[type=number], textarea, select {
  background: #fffdf4; border: 2px solid #c6b087; border-radius: 8px;
}
input:focus, textarea:focus, select:focus { border-color: var(--honey); }
.btn {
  background: var(--honey); border: 2px solid var(--honey-dark); border-radius: 10px;
  color: #fdf7e7; letter-spacing: 0.06em;
}
.btn:hover { background: var(--honey-dark); color: #fdf7e7; }
.btn.secondary { background: #fdf7e7; color: var(--good); border-color: var(--good); }
.btn.secondary:hover { background: var(--good); color: #fdf7e7; }
.btn.danger { background: #fdf7e7; }
.flash { background: #fffdf4; border-radius: 8px; }
.question, .board .bq {
  background: #fffdf4; border: 4px solid #6b4a2b; border-radius: 14px;
  box-shadow: 0 4px 0 rgba(80, 55, 25, 0.25);
}
.blink::after { content: "…"; }
.countdown, .board .bcd { text-shadow: none; }
.cluster .count, .board .bcluster .count { border-radius: 999px; color: #fdf7e7; }
.stat { background: #fdf7e7; border: 2px solid #c6b087; border-radius: 10px; }
.namebadge {
  background: #fdf7e7; border: 2px solid var(--honey); border-radius: 999px;
  box-shadow: 0 2px 5px rgba(80, 55, 25, 0.2);
}
.namebadge:hover { background: var(--panel2); }
.votebtn { background: #fffdf4; border-radius: 8px; }
.votebtn.active { color: #fdf7e7; }
.votebtn.down.active { color: #fdf7e7; }
.board .bfinal { text-shadow: none; color: var(--good); }
.board .pspot { background: #fdf7e7; border-radius: 12px; }
.board .pspot.first {
  border: 4px solid var(--honey); box-shadow: 0 6px 16px rgba(181, 84, 45, 0.3);
}
.board .pspot.first .pname { text-shadow: none; }
.board .bjoin strong { text-shadow: none; }
/* Background posters hang like framed airport-wall art */
.facestars img {
  opacity: 0.35; border: 7px solid #fffdf4; border-radius: 4px;
  box-shadow: 0 5px 14px rgba(60, 40, 20, 0.4); background: #fffdf4;
}
/* Cream veil over the content column so text on top of posters stays
   readable; posters near the edges keep their punch. */
.facestars::after {
  content: ""; position: absolute; inset: 0;
  background: radial-gradient(ellipse 55% 90% at 50% 45%,
    rgba(243, 234, 215, 0.85) 0%, rgba(243, 234, 215, 0.35) 58%,
    rgba(243, 234, 215, 0) 78%);
}
.facestars img[src$=".png"] {
  border: none; background: transparent; border-radius: 50%; box-shadow: none;
}
.facestars img:nth-child(4n)   { transform: rotate(-3deg); }
.facestars img:nth-child(4n+1) { transform: rotate(2.5deg); }
.facestars img:nth-child(4n+2) { transform: rotate(-1.5deg); }
.facestars img:nth-child(4n+3) { transform: rotate(3deg); }
/* Carved wooden signboards hang as-is — no poster frame, deeper shadow */
.facestars img[src*="bpsign"] {
  border: none; background: transparent; border-radius: 10px;
  box-shadow: 0 6px 16px rgba(60, 40, 20, 0.5); opacity: 0.45;
}
/* Title mark over the gate-window panorama */
.bpbanner {
  display: inline-block; max-width: 100%; padding: 44px 64px 52px;
  background: url('/bearplane/bpbanner.jpg') center 30% / cover no-repeat;
  border: 5px solid #6b4a2b; border-radius: 16px;
  box-shadow: 0 6px 18px rgba(60, 40, 20, 0.4);
}
@media (max-width: 700px) { .bpbanner { padding: 24px 22px 30px; } }
.bpmark {
  display: inline-flex; align-items: center; gap: 0.35em;
  font-family: "Alfa Slab One", "Rockwell", serif;
  font-size: clamp(34px, 7vw, 72px); line-height: 1.1;
  transform: rotate(-2deg); margin: 0;
}
.bpmark .bpword {
  color: var(--good);
  text-shadow: -2px -2px 0 #fdf7e7, 2px -2px 0 #fdf7e7, -2px 2px 0 #fdf7e7,
    2px 2px 0 #fdf7e7, 5px 5px 0 rgba(80, 55, 25, 0.45);
}
.bpmark .bpword.alt { color: var(--honey); }
.bpmark .bpicon {
  color: #6b4a2b; font-size: 0.8em; transform: rotate(-12deg);
  text-shadow: 1px 1px 0 #fdf7e7;
}
`,
};

export function getTheme(env: { THEME?: string }): Theme {
  return env.THEME === "bearplane" ? BEARPLANE : HIVE;
}
