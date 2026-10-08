#!/usr/bin/env python3
"""Full-scale load simulation: 150 players playing two rounds.

Drives the production deployment exactly like real phones do:
  - every player polls GET /api/state every 2.5s (the page's reload mechanism)
  - players suggest questions and vote on them while waiting
  - admin opens rounds; players answer with realistic staggered timing
  - a few "phones fall asleep" mid-round (stop polling, never answer) to
    exercise the active-player auto-close logic
  - AI scoring runs for real; we measure the turnaround

Usage:
  ./.venv/bin/python tools/simulate_load.py [base_url]

Prints a timeline + latency/error report. Does NOT reset the DB afterwards —
run the admin reset yourself (or pass --reset) once you've looked at /board.
"""

import random
import statistics
import sys
import threading
import time

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "https://hive-mind.jrfinkel.workers.dev"
RESET_AFTER = "--reset" in sys.argv
ADMIN_PW = "lundard-boss"
N_PLAYERS = 150
POLL_S = 2.5
N_SLEEPERS = 6          # stop polling mid-round-1, never answer it
N_WAKERS = 3            # of the sleepers, how many come back for round 2

T0 = time.time()
def ts() -> str:
    return f"[{time.time() - T0:6.1f}s]"

def log(msg: str) -> None:
    print(f"{ts()} {msg}", flush=True)

# --- answer pools: canonical entity -> surface variants (exercises clustering)
R1_POOL = {
    "manning": ["Chris Manning", "chris manning", "manning", "C. Manning", "Christopher Manning"],
    "jurafsky": ["Dan Jurafsky", "jurafsky", "dan jurafsky"],
    "liang": ["Percy Liang", "percy liang", "liang"],
    "chomsky": ["Noam Chomsky", "chomsky", "noam chomsky"],
    "hinton": ["Geoff Hinton", "Geoffrey Hinton", "hinton"],
    "bengio": ["Yoshua Bengio", "bengio"],
    "lecun": ["Yann LeCun", "yann lecun", "lecun"],
    "collins": ["Michael Collins", "collins"],
    "jelinek": ["Fred Jelinek", "jelinek"],
    "koehn": ["Philipp Koehn", "koehn"],
    "knight": ["Kevin Knight", "kevin knight"],
    "smith": ["Noah Smith", "noah smith"],
    "klein": ["Dan Klein", "dan klein", "klein"],
    "ng": ["Andrew Ng", "andrew ng"],
    "potts": ["Chris Potts", "potts"],
}
R2_POOL = {
    "security": ["security line", "TSA", "tsa line", "airport security"],
    "delays": ["delays", "flight delays", "a delayed flight"],
    "food": ["overpriced food", "expensive food", "$8 water"],
    "baggage": ["baggage claim", "luggage carousel", "lost luggage"],
    "gates": ["gates", "the gate", "gate C7"],
    "planes": ["planes", "airplanes", "a plane"],
    "coffee": ["coffee", "espresso stand", "starbucks"],
    "wifi": ["free wifi", "bad wifi", "wifi"],
    "giftshop": ["gift shop", "souvenir shop"],
    "seats": ["uncomfortable seats", "seats by the window"],
    "pilots": ["pilots", "a pilot"],
    "announcements": ["boarding announcements", "loudspeaker announcements"],
}
R3_POOL = {
    # deliberate clustering traps: variants that must merge, neighbors that must not
    "hotdogs": ["hot dogs", "hotdogs", "hot dog"],
    "burgers": ["hamburgers", "burgers", "a burger", "hamburger"],
    "corn": ["corn on the cob", "corn"],
    "watermelon": ["watermelon", "water melon", "watermelon slices"],
    "potatosalad": ["potato salad"],
    "coleslaw": ["coleslaw", "cole slaw"],
    "grill": ["the grill", "a grill", "charcoal grill"],
    "ketchup": ["ketchup", "catsup"],
    "mustard": ["mustard"],
    "beer": ["beer", "cold beer"],
    "lemonade": ["lemonade"],
    "paperplates": ["paper plates"],
    "ribs": ["ribs", "bbq ribs"],
    "frisbee": ["frisbee"],
}
SUGGESTIONS = [
    (3, "parsing algorithms"), (2, "reasons to retire"), (4, "Stanford buildings"),
    (3, "linguistics terms"), (2, "things Chris says in lecture"), (3, "conference venues"),
    (1, "best NLP paper ever"), (3, "mountain towns"), (2, "programming languages"),
    (3, "ski resorts"), (2, "kinds of parser"), (3, "deep learning frameworks"),
]

def pick_answers(pool: dict, k: int) -> list[str]:
    ents = random.sample(list(pool), k)
    return [random.choice(pool[e]) for e in ents]

# --- shared stats ------------------------------------------------------------
lock = threading.Lock()
lat: dict[str, list[float]] = {"state": [], "answer": [], "other": []}
errors: list[str] = []
events: list[str] = []

def rec(kind: str, dt: float) -> None:
    with lock:
        lat[kind].append(dt)

def err(msg: str) -> None:
    with lock:
        errors.append(msg)
        if len(errors) <= 12:
            log(f"ERR {msg}")

def timed(sess, method, path, kind="other", **kw):
    t = time.time()
    try:
        r = sess.request(method, BASE + path, timeout=15, **kw)
        rec(kind, time.time() - t)
        if r.status_code >= 500:
            err(f"{path} -> {r.status_code}")
        return r
    except Exception as e:
        rec(kind, time.time() - t)
        err(f"{path} -> {type(e).__name__}")
        return None

# --- player bot --------------------------------------------------------------
class Bot(threading.Thread):
    def __init__(self, i: int):
        super().__init__(daemon=True)
        self.i = i
        self.sess = requests.Session()
        self.pid: str | None = None
        self.sleeper = i < N_SLEEPERS           # bots 0..5 fall asleep in round 1
        self.waker = i < N_WAKERS               # bots 0..2 come back for round 2
        self.answered_rounds: set[int] = set()
        self.saw: set[str] = set()              # observed view states
        self.saw_place = False
        self.last_total: int | None = None
        self.answer_at: float | None = None
        self.sleep_at: float | None = None
        self.suggested = False

    def run(self):
        time.sleep(random.uniform(0, 15))       # arrivals trickle in
        r = timed(self.sess, "POST", "/api/join", json={"name": f"Sim{self.i:03d}"})
        if not r or r.status_code != 200:
            err(f"join failed for bot {self.i}")
            return
        self.pid = r.json()["player_id"]
        with lock:
            joined.append(self.pid)
        time.sleep(random.uniform(0, POLL_S))
        while not stop_flag.is_set():
            phase_sleep = self.maybe_sleep()
            if phase_sleep:
                time.sleep(1)
                continue
            t = time.time()
            r = timed(self.sess, "GET", f"/api/state?player={self.pid}", kind="state")
            if r is not None and r.status_code == 200:
                self.react(r.json())
            elapsed = time.time() - t
            time.sleep(max(0.2, POLL_S - elapsed + random.uniform(-0.3, 0.3)))

    def maybe_sleep(self) -> bool:
        """Sleepers stop polling shortly after round 1 opens; wakers resume for round 2."""
        if not self.sleeper or round_open_t[1] is None:
            return False
        if self.sleep_at is None:
            self.sleep_at = round_open_t[1] + random.uniform(6, 14)
        if time.time() < self.sleep_at:
            return False
        if self.waker and round_open_t[2] is not None:
            return False                         # woke up for round 2
        return True

    def react(self, s: dict):
        status = s.get("status")
        rnd = s.get("round")
        if status == "open" and rnd:
            self.saw.add("open")
            rid = rnd["id"]
            if rid not in self.answered_rounds and not s.get("answered"):
                if self.answer_at is None:
                    self.answer_at = time.time() + random.uniform(4, 42)
                if time.time() >= self.answer_at:
                    q = (rnd.get("question") or "").lower()
                    pool = R1_POOL if "nlp" in q else R2_POOL if "airport" in q else R3_POOL
                    texts = pick_answers(pool, rnd["num"])
                    r = timed(self.sess, "POST", "/api/answer", kind="answer",
                              json={"player_id": self.pid, "round_id": rid, "texts": texts})
                    if r is not None and r.status_code == 200:
                        self.answered_rounds.add(rid)
                        with lock:
                            answers_in.append(time.time())
                    elif r is not None and r.status_code == 409:
                        self.answered_rounds.add(rid)   # closed under us — fine
                    self.answer_at = None
            elif s.get("answered"):
                self.saw.add("answered-waiting")
        elif status == "scoring":
            self.saw.add("scoring")
        else:
            self.saw.add("idle")
            last = s.get("last")
            if last and isinstance(last, dict) and last.get("your"):
                self.saw.add("results")
                self.last_total = last["your"]["total"]
            if s.get("your_place"):
                self.saw_place = True
            # idle chatter: suggest/vote like a waiting crowd would
            if not self.suggested and random.random() < 0.004:
                num, thing = random.choice(SUGGESTIONS)
                timed(self.sess, "POST", "/api/suggest",
                      json={"player_id": self.pid, "num": num, "thing": thing})
                self.suggested = True
            elif random.random() < 0.01 and s.get("suggestions"):
                g = random.choice(s["suggestions"])
                timed(self.sess, "POST", "/api/vote",
                      json={"player_id": self.pid, "suggestion_id": g["id"],
                            "vote": 1 if random.random() < 0.8 else -1})

# --- coordinator -------------------------------------------------------------
joined: list[str] = []
answers_in: list[float] = []
round_ids: list[int] = []
round_open_t: dict[int, float | None] = {1: None, 2: None, 3: None}
stop_flag = threading.Event()

def admin_session():
    s = requests.Session()
    r = s.post(BASE + "/admin/login", data={"password": ADMIN_PW}, timeout=15)
    assert "hm_admin" in s.cookies, "admin login failed"
    return s

def wait_for(pred, timeout, what, sess):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = timed(sess, "GET", "/api/state")
        if r is not None and r.status_code == 200 and pred(r.json()):
            return r.json()
        time.sleep(2)
    raise TimeoutError(f"timed out waiting for {what}")

def run_round(adm, n: int, num: int, thing: str, minutes: int):
    global answers_in
    answers_in = []
    r = timed(adm, "POST", "/admin/open", data={"num": num, "thing": thing, "minutes": minutes})
    s = wait_for(lambda x: x.get("status") == "open", 30, "round open", adm)
    rid = s["round"]["id"]
    round_ids.append(rid)
    round_open_t[n] = time.time()
    log(f"ROUND {n} OPEN (id={rid}, 'Name {num} {thing}', timer {minutes}m)")
    s = wait_for(lambda x: x.get("status") != "open", minutes * 60 + 60, "round close", adm)
    t_close = time.time()
    log(f"ROUND {n} CLOSED after {t_close - round_open_t[n]:.0f}s "
        f"(timer was {minutes * 60}s) — {len(answers_in)} answer submissions, "
        f"last one {t_close - max(answers_in):.0f}s before close" if answers_in else "no answers?!")
    s = wait_for(lambda x: x.get("status") == "idle" and (x.get("last") or {}).get("id") == rid,
                 120, "scoring results", adm)
    log(f"ROUND {n} SCORED {time.time() - t_close:.1f}s after close — "
        f"{s['last']['total_answers']} answers in {len(s['last']['clusters'])} clusters; "
        f"top: {[(c['label'], c['size']) for c in s['last']['clusters'][:4]]}")
    return s

def pct(v, p):
    return statistics.quantiles(v, n=100)[p - 1] if len(v) >= 20 else max(v, default=0)

def main():
    log(f"target: {BASE} — spinning up {N_PLAYERS} players "
        f"({N_SLEEPERS} will doze off mid-round-1, {N_WAKERS} of those return for round 2)")
    adm = admin_session()
    bots = [Bot(i) for i in range(N_PLAYERS)]
    for b in bots:
        b.start()
    time.sleep(20)
    log(f"{len(joined)}/{N_PLAYERS} joined; idle suggest/vote phase (20s)")
    time.sleep(20)
    r = timed(adm, "GET", "/api/state")
    if r is not None and r.status_code == 200:
        s = r.json()
        log(f"active_count={s.get('active_count')}, suggestions in queue={len(s.get('suggestions') or [])}")

    run_round(adm, 1, 3, "NLP researchers", 2)
    log("between rounds: players looking at results / voting (15s)")
    time.sleep(15)
    run_round(adm, 2, 2, "things you find at an airport", 2)
    log("between rounds: players looking at results / voting (15s)")
    time.sleep(15)
    s3 = run_round(adm, 3, 3, "things at a backyard barbecue", 2)

    time.sleep(8)  # let every poller see the final results
    stop_flag.set()
    time.sleep(3)

    # --- verification + report ----------------------------------------------
    lb = s3.get("leaderboard", [])
    log(f"leaderboard top 5: {[(r['name'], r['pts']) for r in lb[:5]]}")
    pollers = [b for b in bots if b.pid]
    awake = [b for b in pollers if not b.sleeper]
    saw_open = sum(1 for b in pollers if "open" in b.saw)
    saw_results = sum(1 for b in pollers if "results" in b.saw)
    saw_place = sum(1 for b in pollers if b.saw_place)
    both = sum(1 for b in awake if len(b.answered_rounds) == 3)
    r2_only_wakers = sum(1 for b in pollers if b.sleeper and b.waker and len(b.answered_rounds) == 2)
    print()
    log("=== VERIFICATION ===")
    log(f"joined: {len(joined)}/{N_PLAYERS}")
    log(f"saw an open question: {saw_open}/{len(pollers)}")
    log(f"awake players who answered all 3 rounds: {both}/{len(awake)}")
    log(f"sleepers who woke and answered rounds 2+3: {r2_only_wakers}/{N_WAKERS}")
    log(f"saw their own results page data: {saw_results}/{len(pollers)}")
    log(f"saw personal rank stats: {saw_place}/{len(pollers)}")
    log(f"errors: {len(errors)}" + (f" (first: {errors[:5]})" if errors else ""))
    print()
    log("=== LATENCY (seconds) ===")
    for k, v in lat.items():
        if v:
            log(f"{k:7s} n={len(v):6d}  p50={pct(v,50):.2f}  p95={pct(v,95):.2f}  "
                f"p99={pct(v,99):.2f}  max={max(v):.2f}")
    if RESET_AFTER:
        timed(adm, "POST", "/admin/reset")
        log("admin reset done — DB wiped clean")

if __name__ == "__main__":
    main()
