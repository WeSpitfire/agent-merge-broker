/**
 * Landing page behaviour. Plain DOM and no framework: Landing.vue calls mountLanding() once on the
 * client, so nothing here may import Vue or VitePress.
 *
 *   1. copy buttons for the install and demo commands;
 *   2. the "print" animation on the hero receipt, which only nudges opacity, so the receipt is
 *      readable before, during, and after it plays;
 *   3. Night Shift — a real-time simulation of the claims window. Agents slide receipts onto the
 *      counter, leases tick down, batches integrate and publish, and the forge sometimes goes quiet.
 *      Every rule the game enforces is a rule the real broker enforces, and every refusal code is a
 *      real BrokerError code.
 */
export function mountLanding(root) {
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = "1";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  root.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => {
      const source = root.querySelector("#" + button.dataset.copy);
      if (!source || !source.textContent) return;
      navigator.clipboard.writeText(source.textContent.trim()).then(() => {
        const previous = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => {
          button.textContent = previous;
        }, 1400);
      });
    });
  });

  const receipt = root.querySelector("[data-print]");
  if (receipt && !reduceMotion) {
    const lines = Array.from(receipt.querySelectorAll(".ln"));
    lines.forEach((line, index) => line.style.setProperty("--i", String(index)));
    receipt.classList.add("printing");
  }

  const game = root.querySelector("[data-game]");
  if (game) mountGame(game, reduceMotion);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Night Shift
 * ──────────────────────────────────────────────────────────────────────────── */

const SHIFT_MS = 240_000; // four real minutes from clock-in to dawn
const QUEUE_MAX = 6;
const TRAY_MAX = 3;

const AREAS = [
  { area: "checkout", paths: ["src/checkout/**", "test/checkout/**"] },
  { area: "search", paths: ["src/search/**"] },
  { area: "cart", paths: ["src/cart/**"] },
  { area: "pricing", paths: ["src/pricing/**"] },
  { area: "reports", paths: ["src/reports/**"], dependsOn: "pricing" },
  { area: "customers", paths: ["src/customers/**"] },
  { area: "i18n", paths: ["locales/**"] },
  { area: "billing", paths: ["src/billing/**"] },
  { area: "auth", paths: ["src/auth/**", "test/auth/**"] },
  { area: "docs", paths: ["docs/**"] },
];
const WORKERS = ["claude", "codex", "cursor", "human/mira"];
const FILES = ["index.ts", "rules.ts", "service.ts", "view.ts", "query.ts", "totals.ts", "types.ts"];
const MESSAGES = [
  "add {a} feature",
  "version {a} feature",
  "fix {a} edge case",
  "tests for {a}",
  "tidy {a} types",
  "wire {a} events",
  "{a}: handle empty state",
];
const STRAYS = ["package.json", ".github/workflows/ci.yml", "src/checkout/summary.ts", "src/auth/session.ts", "tsconfig.json"];

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/* ── sound: a stamp, a printer, a chime, an alarm ────────────────────────── */
function makeSound() {
  let ctx = null;
  let muted = false;
  try {
    muted = localStorage.getItem("amb-muted") === "1";
  } catch {
    // Storage may be unavailable.
  }
  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function noise(duration, gain, filterHz) {
    const c = ac();
    if (!c) return;
    const buffer = c.createBuffer(1, Math.floor(c.sampleRate * duration), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterHz;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    src.connect(filter).connect(g).connect(c.destination);
    src.start();
  }
  function tone(freq, duration, gain, type) {
    const c = ac();
    if (!c) return;
    const o = c.createOscillator();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, c.currentTime);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + duration);
  }
  return {
    get muted() {
      return muted;
    },
    toggle() {
      muted = !muted;
      try {
        localStorage.setItem("amb-muted", muted ? "1" : "0");
      } catch {
        // ignore
      }
      return muted;
    },
    thud() {
      if (muted) return;
      tone(70, 0.12, 0.5);
      noise(0.08, 0.35, 900);
    },
    chatter() {
      if (muted) return;
      noise(0.05, 0.12, 2600);
    },
    chime() {
      if (muted) return;
      tone(660, 0.18, 0.12, "triangle");
      window.setTimeout(() => tone(990, 0.22, 0.1, "triangle"), 90);
    },
    alarm() {
      if (muted) return;
      tone(220, 0.25, 0.2, "square");
      window.setTimeout(() => tone(220, 0.25, 0.2, "square"), 320);
    },
    tick() {
      if (muted) return;
      tone(1200, 0.03, 0.05, "square");
    },
  };
}

function mountGame(el, reduceMotion) {
  const $ = (sel) => el.querySelector(sel);
  const ui = {
    clock: $("[data-g-clock]"),
    night: $("[data-g-night]"),
    score: $("[data-g-score]"),
    combo: $("[data-g-combo]"),
    breaks: $("[data-g-breaks]"),
    ci: $("[data-g-ci]"),
    mute: $("[data-g-mute]"),
    queue: $("[data-g-queue]"),
    pressure: $("[data-g-pressure]"),
    focus: $("[data-g-focus]"),
    stamps: $("[data-g-stamps]"),
    board: $("[data-g-board]"),
    tray: $("[data-g-tray]"),
    trayActions: $("[data-g-tray-actions]"),
    log: $("[data-g-log]"),
    overlay: $("[data-g-overlay]"),
    hint: $("[data-g-hint]"),
  };
  const sound = makeSound();

  let rng = Math.random;
  const state = {};
  let raf = 0;
  let lastFrame = 0;

  function resetState(seed) {
    rng = seed ? mulberry32(seed) : Math.random;
    Object.assign(state, {
      seed,
      phase: "intro", // intro | tutorial | running | report
      tutorialStep: 0,
      t: 0, // ms since clock-in
      score: 0,
      combo: 0,
      bestCombo: 0,
      breaks: 0,
      commits: 0,
      landedBatches: 0,
      refusedRight: 0,
      agentsLost: 0,
      dropped: 0,
      ciRedMs: 0,
      main: sha(),
      landedAreas: new Set(),
      queue: [],
      focusId: null,
      tray: [],
      trayState: "open", // open | integrating | prepared | publishing | unknown | reconciling
      trayTimer: 0,
      trayTotal: 0,
      freeze: 0,
      nextSpawn: 4000,
      nextId: 1,
      events: { burst1: false, ttl: false, flaky: false, burst2: false },
      leaseScale: 1,
      forgeTimeout: 0.12,
      log: [],
      pressure: 0,
    });
  }

  function sha() {
    let s = "";
    for (let i = 0; i < 7; i++) s += "0123456789abcdef"[Math.floor(rng() * 16)];
    return s;
  }
  function pick(list) {
    return list[Math.floor(rng() * list.length)];
  }
  function chance(p) {
    return rng() < p;
  }

  function progress() {
    return Math.min(1, state.t / SHIFT_MS);
  }

  /* ── receipts ──────────────────────────────────────────────────────────── */
  function activeAreas() {
    const used = new Set();
    state.queue.forEach((r) => used.add(r.area));
    state.tray.forEach((r) => used.add(r.area));
    return used;
  }

  function makeReceipt(opts = {}) {
    const used = activeAreas();
    const free = AREAS.filter((a) => !used.has(a.area));
    const def = opts.area ? AREAS.find((a) => a.area === opts.area) : free.length ? pick(free) : null;
    if (!def) return null;

    const p = progress();
    let flaw = opts.flaw ?? null;
    if (flaw === null && !opts.clean) {
      const roll = rng();
      const scope = 0.14 + 0.16 * p;
      const nolease = 0.04 + 0.1 * p;
      const expired = 0.04 + 0.08 * p;
      if (roll < scope) flaw = "scope";
      else if (roll < scope + nolease) flaw = "nolease";
      else if (roll < scope + nolease + expired) flaw = "expired";
    }

    const worker = flaw === "nolease" ? "human/andrew" : pick(WORKERS);
    const holder = worker.includes("/") ? worker : worker + "/" + def.area;
    const lock = opts.lock ?? (flaw === null && chance(0.18));
    const paths = def.paths.slice();
    if (lock) paths.push("package-lock.json");

    const n = 1 + Math.floor(rng() * 3);
    const commits = [];
    for (let i = 0; i < n; i++) commits.push([sha(), pick(MESSAGES).replace("{a}", def.area)]);

    const dir = def.paths[0].replace("/**", "");
    const touched = [];
    const files = new Set();
    while (files.size < Math.min(n + 1, 3)) files.add(dir + "/" + pick(FILES));
    files.forEach((f) => touched.push(f));
    if (lock) touched.push("package-lock.json");
    if (flaw === "scope") {
      const stray = pick(STRAYS.filter((s) => !s.startsWith(dir)));
      touched.splice(1 + Math.floor(rng() * touched.length), 0, stray);
    }

    const ttl = (28_000 + rng() * 30_000) * state.leaseScale;
    const lease =
      flaw === "nolease"
        ? null
        : { paths, until: state.t + (flaw === "expired" ? -(2_000 + rng() * 4_000) : ttl), total: ttl };

    return {
      id: state.nextId++,
      area: def.area,
      holder,
      lease,
      commits,
      declared: flaw === "nolease" ? [] : paths,
      touched,
      base: state.main,
      dependsOn: def.dependsOn && !state.landedAreas.has(def.dependsOn) && chance(0.7) ? def.dependsOn : null,
      lock,
      flaw,
      arrived: state.t,
      poisoned: false,
    };
  }

  function isExpired(r) {
    return Boolean(r.lease) && state.t > r.lease.until;
  }
  function invalidCode(r) {
    if (r.flaw === "nolease") return "LEASE_REQUIRED";
    if (r.flaw === "scope") return "UNEXPECTED_PATHS";
    if (isExpired(r)) return "LEASE_EXPIRED";
    return null;
  }

  function spawn(opts) {
    const r = makeReceipt(opts);
    if (!r) return null;
    if (state.queue.length >= QUEUE_MAX) {
      const gone = state.queue.shift();
      state.dropped += 1;
      state.combo = 0;
      addScore(-100);
      log("Counter buried: " + gone.holder + " gave up on " + gone.area + ". Lease lapsed.", "bad");
      if (state.focusId === gone.id) state.focusId = null;
    }
    state.queue.push(r);
    if (state.focusId === null) state.focusId = r.id;
    sound.chatter();
    renderQueue();
    renderBoard();
    if (focused() === r) renderFocus();
    return r;
  }

  function focused() {
    return state.queue.find((r) => r.id === state.focusId) || state.queue[0] || null;
  }

  /* ── scoring & log ─────────────────────────────────────────────────────── */
  function addScore(n) {
    state.score = Math.max(0, state.score + n);
    renderTop();
  }
  function comboMult() {
    return 1 + Math.min(4, Math.floor(state.combo / 3)) * 0.5;
  }
  function good(points) {
    state.combo += 1;
    state.bestCombo = Math.max(state.bestCombo, state.combo);
    addScore(Math.round(points * comboMult()));
  }
  function log(text, kind) {
    state.log.push({ text, kind });
    if (state.log.length > 8) state.log.shift();
    renderLog();
  }

  /* ── decisions ─────────────────────────────────────────────────────────── */
  function decide(choice) {
    if (state.phase !== "running" && state.phase !== "tutorial") return;
    if (state.freeze > 0 || state.busy) return;
    const r = focused();
    if (!r) return;
    if (choice === "batch" && state.trayState !== "open") {
      log("Tray is sealed while a batch is in flight. Hold it or wait.", "muted");
      return;
    }
    if (choice === "batch" && state.tray.length >= TRAY_MAX) {
      log("Tray is full (" + TRAY_MAX + " tasks). Integrate first.", "muted");
      return;
    }
    // Stamp first, apply after the stamp has landed, so the paper is seen being marked.
    sound.thud();
    stampFocus(choice);
    state.busy = true;
    window.setTimeout(() => {
      state.busy = false;
      apply(r, choice);
    }, reduceMotion ? 0 : 380);
  }

  function apply(r, choice) {
    const code = invalidCode(r);
    if (choice === "batch") {
      removeFromQueue(r);
      if (code) {
        r.poisoned = code;
        state.combo = 0;
      } else {
        good(20);
      }
      state.tray.push(r);
      log("Nominated " + r.area + " (" + r.commits.length + " commit(s)). This DOES NOT authorize merging.");
    } else if (choice === "hold") {
      removeFromQueue(r);
      state.queue.push(r);
      log("Held " + r.area + ". Its lease keeps ticking.", "muted");
    } else if (choice === "refuse") {
      removeFromQueue(r);
      if (code) {
        state.refusedRight += 1;
        good(60);
        log(code + ": refused " + r.area + " from " + r.holder + ".", "good");
      } else {
        state.agentsLost += 1;
        state.combo = 0;
        addScore(-50);
        log("Over-cautious: " + r.area + " was clean. " + r.holder + " left.", "bad");
      }
    }
    if (state.phase === "tutorial") tutorialAdvance(choice);
    renderAll();
  }

  function removeFromQueue(r) {
    const i = state.queue.indexOf(r);
    if (i >= 0) state.queue.splice(i, 1);
    if (state.focusId === r.id) state.focusId = state.queue[i] ? state.queue[i].id : state.queue[0] ? state.queue[0].id : null;
  }

  function pullFromTray(id) {
    if (state.trayState !== "open") return;
    const i = state.tray.findIndex((r) => r.id === id);
    if (i < 0) return;
    const r = state.tray.splice(i, 1)[0];
    r.poisoned = false;
    state.queue.unshift(r);
    state.focusId = r.id;
    log("Pulled " + r.area + " back to the counter.", "muted");
    renderAll();
  }

  function integrate() {
    if (state.trayState !== "open" || state.tray.length === 0 || state.freeze > 0) return;
    // The scheduler defers what cannot share this batch: a second serialized file, an unmet dependency.
    let lockSeen = false;
    const keep = [];
    const inTray = new Set(state.tray.map((r) => r.area));
    state.tray.forEach((r) => {
      if (r.lock && lockSeen) {
        defer(r, "serialized package-lock.json already in batch");
        return;
      }
      if (r.dependsOn && !state.landedAreas.has(r.dependsOn) && !inTray.has(r.dependsOn)) {
        defer(r, "depends on " + r.dependsOn + ", not merged");
        return;
      }
      if (r.lock) lockSeen = true;
      keep.push(r);
    });
    state.tray = keep;
    if (keep.length === 0) {
      renderAll();
      return;
    }
    state.trayState = "integrating";
    state.trayTotal = 2200 + 700 * keep.length;
    state.trayTimer = state.trayTotal;
    log("Integrating " + keep.length + " task(s) in a disposable worktree on " + state.main + "…");
    sound.tick();
    renderAll();
  }

  function defer(r, why) {
    r.poisoned = false;
    state.queue.unshift(r);
    log("Deferred " + r.area + ": " + why + ".", "warn");
  }

  function publish() {
    if (state.trayState !== "prepared" || state.freeze > 0) return;
    state.trayState = "publishing";
    state.trayTotal = 1400;
    state.trayTimer = state.trayTotal;
    log("Publishing PR for batch " + state.batchId + "… intent recorded on disk first.");
    sound.tick();
    renderAll();
  }

  function publishAgain() {
    if (state.trayState !== "unknown") return;
    state.combo = 0;
    addScore(-150);
    log("Second publish sent. Two PRs now exist for one candidate; auto-merge armed twice.", "bad");
    state.trayState = "publishing";
    state.trayTotal = 1400;
    state.trayTimer = state.trayTotal;
    renderAll();
  }

  function reconcile() {
    if (state.trayState !== "unknown") return;
    state.trayState = "reconciling";
    state.trayTotal = 1600;
    state.trayTimer = state.trayTotal;
    log("Reconciling: re-reading the forge against the recorded intent…");
    sound.tick();
    renderAll();
  }

  function land() {
    const batch = state.tray;
    const poisoned = batch.filter((r) => r.poisoned);
    const n = batch.reduce((s, r) => s + r.commits.length, 0);
    state.main = sha();
    state.landedBatches += 1;
    batch.forEach((r) => state.landedAreas.add(r.area));
    log("PR merged. Proof " + state.main + " has the batch as second parent. " + n + " commit(s) on main.", "good");
    if (poisoned.length) {
      state.breaks += 1;
      state.combo = 0;
      state.freeze = 3000;
      state.ciRed = true;
      const r = poisoned[0];
      log("CI on main: RED. " + r.holder + "'s " + r.area + " landed with " + r.poisoned + ". Reverting…", "bad");
      sound.alarm();
      shake();
    } else {
      state.commits += n;
      good(100 * n);
      sound.chime();
    }
    state.tray = [];
    state.trayState = "open";
    if (state.phase === "tutorial") tutorialAdvance("landed");
    if (state.breaks >= 3) endShift(false);
    renderAll();
  }

  /* ── tutorial ──────────────────────────────────────────────────────────── */
  const TUTORIAL = [
    { hint: "This receipt is clean: the files Git says it touched all sit inside its lease on the board. Stamp <b>BATCH</b> (key 1).", expect: "batch" },
    { hint: "Look at <b>Paths Git says it touched</b>. One is outside the lease. The agent's own list is not evidence. Stamp <b>REFUSE</b> (key 3).", expect: "refuse" },
    { hint: "Now press <b>INTEGRATE</b> (key I). The tray is cherry-picked into a disposable worktree and validated while the counter keeps filling.", expect: "integrate" },
    { hint: "Validated. Press <b>PUBLISH</b> (key P). If the forge goes quiet, <b>RECONCILE</b>, never publish twice.", expect: "publish" },
    { hint: "Landed, with proof from Git history. Dawn is four minutes away. Keep main green.", expect: "start" },
  ];

  function startTutorial() {
    state.phase = "tutorial";
    state.tutorialStep = 0;
    state.forgeTimeout = 0;
    spawn({ clean: true, area: "checkout" });
    spawn({ flaw: "scope", area: "search" });
    state.focusId = state.queue[0].id;
    showHint();
    renderAll();
  }
  function showHint() {
    const step = TUTORIAL[state.tutorialStep];
    ui.hint.hidden = !step;
    if (step) ui.hint.innerHTML = '<span class="g-hint-tag">Tutorial</span> ' + step.hint;
  }
  function tutorialAdvance(action) {
    const step = TUTORIAL[state.tutorialStep];
    if (!step) return;
    const ok =
      action === step.expect ||
      (step.expect === "publish" && action === "landed");
    if (!ok) return;
    if (step.expect === "publish" && action !== "landed") return;
    state.tutorialStep += 1;
    showHint();
    if (state.tutorialStep >= TUTORIAL.length - 1) {
      ui.hint.innerHTML += ' <button type="button" class="g-link" data-g-clockin>Clock in →</button>';
      ui.hint.querySelector("[data-g-clockin]").addEventListener("click", clockIn);
    }
  }
  function clockIn() {
    state.phase = "running";
    state.forgeTimeout = 0.12;
    state.t = 0;
    state.nextSpawn = 2500;
    ui.hint.hidden = true;
    log("Clocked in. Shift runs until dawn.", "muted");
    renderAll();
  }

  /* ── loop ──────────────────────────────────────────────────────────────── */
  function frame(now) {
    if (!lastFrame) lastFrame = now;
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;
    if (state.phase === "running" || state.phase === "tutorial") step(dt);
    raf = requestAnimationFrame(frame);
  }

  function step(dt) {
    const running = state.phase === "running";
    if (running) state.t += dt;
    if (state.freeze > 0) {
      state.freeze -= dt;
      if (state.freeze <= 0) {
        state.ciRed = false;
        log("Reverted. CI green again.", "muted");
      }
    }
    if (state.ciRed) state.ciRedMs += dt;

    // Batch pipeline timers.
    if (state.trayTimer > 0) {
      state.trayTimer -= dt;
      if (state.trayTimer <= 0) {
        state.trayTimer = 0;
        if (state.trayState === "integrating") {
          state.trayState = "prepared";
          state.batchId = sha();
          log("Batch " + state.batchId + ": prepared. Validators pass. Branch merge-broker/" + state.batchId + ".", "good");
          if (state.phase === "tutorial") tutorialAdvance("integrate");
        } else if (state.trayState === "publishing") {
          if (chance(state.forgeTimeout)) {
            state.trayState = "unknown";
            log("Forge: no response (socket timeout). Auto-merge state: unknown.", "warn");
            sound.alarm();
          } else {
            land();
          }
        } else if (state.trayState === "reconciling") {
          log("Observed: PR exists, auto-merge armed, status MERGED. Fetching for proof…", "muted");
          land();
        }
      }
      renderTray();
    }

    if (running) {
      // Events through the night.
      const t = state.t;
      if (!state.events.burst1 && t > 55_000) {
        state.events.burst1 = true;
        log("17:00 on a Friday. Everyone finishes at once.", "warn");
        for (let i = 0; i < 3; i++) spawn();
      }
      if (!state.events.ttl && t > 110_000) {
        state.events.ttl = true;
        state.leaseScale = 0.6;
        log("Policy change: leases.ttlSeconds lowered. Heartbeats matter now.", "warn");
      }
      if (!state.events.flaky && t > 145_000) {
        state.events.flaky = true;
        state.forgeTimeout = 0.45;
        log("The forge is having a night. Expect lost responses.", "warn");
        window.setTimeout(() => {
          state.forgeTimeout = 0.15;
        }, 40_000);
      }
      if (!state.events.burst2 && t > 195_000) {
        state.events.burst2 = true;
        log("Release cut in five minutes. Four receipts hit the counter.", "warn");
        for (let i = 0; i < 4; i++) spawn();
      }

      state.nextSpawn -= dt;
      if (state.nextSpawn <= 0) {
        spawn();
        const p = progress();
        state.nextSpawn = (7500 - 3800 * p) * (0.75 + rng() * 0.5);
      }
      if (t >= SHIFT_MS) endShift(true);
    }

    state.pressure = state.queue.length / QUEUE_MAX;
    renderTimers();
  }

  function endShift(dawn) {
    state.phase = "report";
    state.dawn = dawn;
    renderAll();
    renderReport();
  }

  /* ── rendering ─────────────────────────────────────────────────────────── */
  function renderTop() {
    const mins = Math.floor((22 * 60 + (state.t / SHIFT_MS) * 8 * 60) % (24 * 60));
    ui.clock.textContent = String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
    ui.night.style.width = (progress() * 100).toFixed(1) + "%";
    ui.score.textContent = String(state.score);
    ui.combo.textContent = comboMult() > 1 ? "×" + comboMult().toFixed(1) : "×1";
    ui.combo.parentElement.classList.toggle("hot", comboMult() > 1);
    ui.breaks.innerHTML = [0, 1, 2].map((i) => '<i class="' + (i < state.breaks ? "on" : "") + '"></i>').join("");
    ui.ci.textContent = state.ciRed ? "CI RED" : "CI GREEN";
    ui.ci.classList.toggle("red", Boolean(state.ciRed));
    ui.mute.textContent = sound.muted ? "Sound off" : "Sound on";
    ui.mute.setAttribute("aria-pressed", sound.muted ? "true" : "false");
  }

  function renderTimers() {
    // Cheap per-frame updates: lease bars, pipeline bar, clock, queue timers.
    renderTop();
    ui.pressure.style.width = (state.pressure * 100).toFixed(0) + "%";
    ui.pressure.parentElement.classList.toggle("hot", state.queue.length >= QUEUE_MAX - 1);
    el.querySelectorAll("[data-lease-for]").forEach((bar) => {
      const r = findReceipt(Number(bar.dataset.leaseFor));
      if (!r || !r.lease) return;
      const left = Math.max(0, r.lease.until - state.t);
      bar.style.width = Math.min(100, (left / r.lease.total) * 100).toFixed(1) + "%";
      const box = bar.closest("[data-lease-box]");
      if (box) {
        box.classList.toggle("expired", left <= 0);
        box.classList.toggle("urgent", left > 0 && left < 8000);
        const label = box.querySelector("[data-lease-left]");
        if (label) label.textContent = left <= 0 ? "expired" : Math.ceil(left / 1000) + "s";
      }
    });
    if (state.trayTimer > 0) {
      const bar = el.querySelector("[data-g-pipe]");
      if (bar) bar.style.width = (100 - (state.trayTimer / state.trayTotal) * 100).toFixed(1) + "%";
    }
  }

  function findReceipt(id) {
    return state.queue.find((r) => r.id === id) || state.tray.find((r) => r.id === id) || null;
  }

  function renderQueue() {
    const f = focused();
    ui.queue.innerHTML = state.queue
      .map(
        (r) =>
          '<button type="button" class="g-slip' + (f && f.id === r.id ? " focus" : "") + '" data-slip="' + r.id + '">' +
          '<span class="g-slip-area">' + esc(r.area) + '</span><span class="g-slip-holder">' + esc(r.holder) + "</span>" +
          '<span class="g-slip-n">' + r.commits.length + " commit" + (r.commits.length > 1 ? "s" : "") + "</span>" +
          (r.lease
            ? '<span class="g-lease-bar" data-lease-box><i data-lease-for="' + r.id + '"></i></span>'
            : '<span class="g-slip-nolease">no lease</span>') +
          "</button>",
      )
      .join("");
    if (state.queue.length === 0) ui.queue.innerHTML = '<p class="g-empty">Counter clear. Enjoy it while it lasts.</p>';
    ui.queue.querySelectorAll("[data-slip]").forEach((b) =>
      b.addEventListener("click", () => {
        state.focusId = Number(b.dataset.slip);
        renderQueue();
        renderFocus();
      }),
    );
  }

  function renderFocus() {
    const r = focused();
    if (!r) {
      ui.focus.innerHTML = '<div class="g-nofocus">No receipt on the counter.</div>';
      ui.stamps.hidden = true;
      return;
    }
    ui.focus.innerHTML =
      '<div class="paper g-paper g-slide" data-paper="' + r.id + '"><div class="paper-head">Agent Merge Broker · Commit receipt</div>' +
      '<dl class="paper-kv">' +
      "<div><dt>task</dt><dd><b>" + esc(r.area) + "</b></dd></div>" +
      "<div><dt>holder</dt><dd>" + esc(r.holder) + "</dd></div>" +
      "<div><dt>base</dt><dd><code>" + esc(r.base) + "</code>" + (r.base !== state.main ? ' <em class="paper-note">main has moved; cherry-pick handles it</em>' : "") + "</dd></div>" +
      (r.dependsOn ? "<div><dt>depends on</dt><dd>" + esc(r.dependsOn) + (state.landedAreas.has(r.dependsOn) ? " (merged)" : " (not merged)") + "</dd></div>" : "") +
      "</dl>" +
      '<div class="paper-sub">Commits (' + r.commits.length + ")</div><ul class='paper-list'>" +
      r.commits.map((k) => "<li><code>" + esc(k[0]) + "</code> " + esc(k[1]) + "</li>").join("") +
      "</ul>" +
      '<div class="paper-sub">Paths the agent declared</div><ul class="paper-list">' +
      (r.declared.length ? r.declared.map((p) => "<li><code>" + esc(p) + "</code></li>").join("") : "<li><em>none</em></li>") +
      "</ul>" +
      '<div class="paper-sub">Paths Git says it touched</div><ul class="paper-list">' +
      r.touched.map((p) => "<li><code>" + esc(p) + "</code></li>").join("") +
      "</ul>" +
      '<div class="paper-foot">This DOES NOT authorize merging.</div></div>';
    ui.stamps.hidden = false;
  }

  function stampFocus(choice) {
    const paper = ui.focus.querySelector(".g-paper");
    if (!paper) return;
    const labels = { batch: "BATCH", hold: "HOLD", refuse: "REFUSE" };
    const mark = document.createElement("div");
    mark.className = "g-mark tone-" + (choice === "batch" ? "good" : choice === "hold" ? "warn" : "bad") + (reduceMotion ? "" : " drop");
    mark.textContent = labels[choice];
    paper.appendChild(mark);
  }

  function renderBoard() {
    const leases = state.queue.concat(state.tray).filter((r) => r.lease);
    let html = '<div class="g-board-head">Repository board</div><dl class="g-kv">';
    html += "<div><dt>main</dt><dd><code>" + esc(state.main) + "</code> · " + state.commits + " commits landed</dd></div>";
    html += "<div><dt>serialized</dt><dd><code>package-lock.json</code> · one per batch</dd></div>";
    html += "<div><dt>tray limit</dt><dd>" + TRAY_MAX + " tasks</dd></div></dl>";
    html += '<div class="g-board-sub">Active leases</div>';
    html += leases.length
      ? '<ul class="g-leases">' +
        leases
          .map(
            (r) =>
              '<li data-lease-box><div class="g-lease-top"><b>' + esc(r.area) + "</b><span>" + esc(r.holder) + "</span></div>" +
              "<div class='g-lease-paths'>" + r.lease.paths.map((p) => "<code>" + esc(p) + "</code>").join("") + "</div>" +
              '<div class="g-lease-meta"><span class="g-lease-bar"><i data-lease-for="' + r.id + '"></i></span><span data-lease-left></span></div></li>',
          )
          .join("") +
        "</ul>"
      : '<p class="g-empty">No active leases.</p>';
    ui.board.innerHTML = html;
  }

  function renderTray() {
    const st = state.trayState;
    const sealed = st !== "open";
    ui.tray.innerHTML =
      '<div class="g-board-sub">Batch tray · ' + state.tray.length + "/" + TRAY_MAX + "</div>" +
      (state.tray.length
        ? '<ul class="g-tray">' +
          state.tray
            .map(
              (r) =>
                '<li><span>' + esc(r.area) + " · " + r.commits.length + " commit(s)" + (r.lock ? " · lockfile" : "") + "</span>" +
                (sealed ? "" : '<button type="button" class="g-link" data-pull="' + r.id + '">pull</button>') + "</li>",
            )
            .join("") +
          "</ul>"
        : '<p class="g-empty">Empty. Stamp BATCH to fill it.</p>') +
      (state.trayTimer > 0 ? '<div class="g-pipe"><i data-g-pipe></i></div>' : "");
    ui.tray.querySelectorAll("[data-pull]").forEach((b) => b.addEventListener("click", () => pullFromTray(Number(b.dataset.pull))));

    const status = {
      open: "",
      integrating: "Integrating in a disposable worktree…",
      prepared: "Validated. Ready to publish.",
      publishing: "Publishing to the forge…",
      unknown: "Forge did not answer. Auto-merge state unknown.",
      reconciling: "Reconciling against recorded intent…",
    }[st];
    let actions = '<div class="g-tray-status ' + (st === "unknown" ? "warn" : "") + '">' + esc(status) + "</div>";
    if (st === "open") actions += '<button type="button" class="btn" data-act="integrate"' + (state.tray.length ? "" : " disabled") + "><kbd>I</kbd> Integrate</button>";
    if (st === "prepared") actions += '<button type="button" class="btn" data-act="publish"><kbd>P</kbd> Publish</button>';
    if (st === "unknown") actions += '<button type="button" class="btn btn-ghost" data-act="again">Publish again</button><button type="button" class="btn" data-act="reconcile"><kbd>R</kbd> Reconcile</button>';
    ui.trayActions.innerHTML = actions;
    ui.trayActions.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
  }

  function act(name) {
    if (name === "integrate") integrate();
    else if (name === "publish") publish();
    else if (name === "again") publishAgain();
    else if (name === "reconcile") reconcile();
  }

  function renderLog() {
    ui.log.innerHTML = state.log.map((l) => '<div class="g-ln ' + (l.kind || "") + '">' + esc(l.text) + "</div>").join("");
  }

  function renderStamps() {
    ui.stamps.innerHTML = [
      ["batch", "BATCH", "good", "1"],
      ["hold", "HOLD", "warn", "2"],
      ["refuse", "REFUSE", "bad", "3"],
    ]
      .map(([id, label, tone, key]) => '<button type="button" class="g-stamp tone-' + tone + '" data-stamp="' + id + '"><span class="g-stamp-key">' + key + "</span>" + label + "</button>")
      .join("");
    ui.stamps.querySelectorAll("[data-stamp]").forEach((b) => b.addEventListener("click", () => decide(b.dataset.stamp)));
  }

  function renderOverlay() {
    if (state.phase === "intro") {
      const seedLabel = state.seed ? "Daily shift · " + String(state.seed).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : "Random shift";
      ui.overlay.hidden = false;
      ui.overlay.innerHTML =
        '<div class="g-intro"><div class="g-brief-eyebrow">' + esc(seedLabel) + "</div><h3>Night shift at the claims window.</h3>" +
        "<p>Agents slide receipts onto the counter. You are the broker's judgment: <b>BATCH</b> clean work into the tray, <b>HOLD</b> what should wait, <b>REFUSE</b> what breaks a rule. Integrate, publish, and when the forge goes quiet, reconcile. Get to dawn without breaking main three times.</p>" +
        '<div class="g-actions"><button type="button" class="btn" data-start="tutorial">Start with the tutorial</button><button type="button" class="btn btn-ghost" data-start="skip">Skip it, clock in</button>' +
        '<button type="button" class="g-link" data-seed-toggle>' + (state.seed ? "Play a random shift instead" : "Play today's daily shift") + "</button></div></div>";
      ui.overlay.querySelectorAll("[data-start]").forEach((b) =>
        b.addEventListener("click", () => {
          sound.tick();
          ui.overlay.hidden = true;
          if (b.dataset.start === "tutorial") startTutorial();
          else clockIn();
          renderAll();
        }),
      );
      ui.overlay.querySelector("[data-seed-toggle]").addEventListener("click", () => {
        resetState(state.seed ? 0 : todayKey());
        renderAll();
      });
    } else if (state.phase !== "report") {
      ui.overlay.hidden = true;
    }
  }

  function renderReport() {
    const total = SHIFT_MS;
    const uptime = Math.max(0, 100 - (state.ciRedMs / Math.max(1, Math.min(state.t, total))) * 100);
    const grade = !state.dawn
      ? "Main broke three times. The forge reverted your shift."
      : state.breaks === 0
        ? state.agentsLost === 0
          ? "Dawn, and main never broke. Nobody was turned away for nothing."
          : "Dawn, and main never broke. A few clean receipts got refused along the way."
        : "Dawn. Main broke " + state.breaks + " time" + (state.breaks > 1 ? "s" : "") + ", but you got there.";
    const rows = [
      ["score", state.score],
      ["commits landed", state.commits],
      ["batches", state.landedBatches],
      ["main uptime", uptime.toFixed(1) + "%"],
      ["correct refusals", state.refusedRight],
      ["agents lost", state.agentsLost + state.dropped],
      ["best combo", "×" + (1 + Math.min(4, Math.floor(state.bestCombo / 3)) * 0.5).toFixed(1)],
      ["pushes by agents", 0],
    ];
    ui.overlay.hidden = false;
    ui.overlay.innerHTML =
      '<div class="g-report"><div class="g-brief-eyebrow">Shift report' + (state.seed ? " · daily " + String(state.seed).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : "") + "</div><h3>" + esc(grade) + "</h3>" +
      '<dl class="g-kv report">' + rows.map(([k, v]) => "<div><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>").join("") + "</dl>" +
      '<div class="g-actions"><button type="button" class="btn" data-again>Work another shift</button><button type="button" class="btn btn-ghost" data-card>Download shift card</button><a class="btn btn-ghost" href="' + esc(el.dataset.docs || "#") + '">How the real one does it</a></div></div>';
    ui.overlay.querySelector("[data-again]").addEventListener("click", () => {
      resetState(state.seed);
      renderAll();
    });
    ui.overlay.querySelector("[data-card]").addEventListener("click", () => downloadCard(rows, grade));
  }

  function downloadCard(rows, grade) {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 630;
    const g = c.getContext("2d");
    g.fillStyle = "#0F1416";
    g.fillRect(0, 0, 1200, 630);
    g.fillStyle = "#FBFAF5";
    g.save();
    g.translate(760, 60);
    g.rotate(0.03);
    g.fillRect(0, 0, 380, 520);
    g.restore();
    g.fillStyle = "#E7ECE9";
    g.font = "900 96px 'Big Shoulders Display', Impact, sans-serif";
    g.fillText("NIGHT SHIFT", 60, 150);
    g.fillStyle = "#FF4A5E";
    g.fillText("REPORT", 60, 240);
    g.fillStyle = "#C3CBC6";
    g.font = "500 22px 'IBM Plex Sans', sans-serif";
    wrap(g, grade, 60, 300, 620, 30);
    g.fillStyle = "#8C978F";
    g.font = "400 18px 'IBM Plex Mono', monospace";
    g.fillText("agentmerge.org · Agent Merge Broker", 60, 580);
    g.fillStyle = "#1A1D1F";
    g.font = "500 17px 'IBM Plex Mono', monospace";
    let y = 120;
    rows.forEach(([k, v]) => {
      g.save();
      g.translate(760, 60);
      g.rotate(0.03);
      g.fillStyle = "#6A6E68";
      g.fillText(String(k).toUpperCase(), 30, y);
      g.fillStyle = "#1A1D1F";
      g.font = "700 26px 'Big Shoulders Display', Impact, sans-serif";
      g.fillText(String(v), 30, y + 30);
      g.font = "500 17px 'IBM Plex Mono', monospace";
      g.restore();
      y += 58;
    });
    const a = document.createElement("a");
    a.download = "agentmerge-night-shift.png";
    a.href = c.toDataURL("image/png");
    a.click();
  }
  function wrap(g, text, x, y, width, lh) {
    const words = text.split(" ");
    let line = "";
    words.forEach((w) => {
      const test = line + w + " ";
      if (g.measureText(test).width > width && line) {
        g.fillText(line, x, y);
        line = w + " ";
        y += lh;
      } else line = test;
    });
    g.fillText(line, x, y);
  }

  function shake() {
    if (reduceMotion) return;
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
  }

  function renderAll() {
    renderTop();
    renderQueue();
    renderFocus();
    renderBoard();
    renderTray();
    renderLog();
    renderOverlay();
  }

  /* ── input ─────────────────────────────────────────────────────────────── */
  el.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea")) return;
    const k = event.key.toLowerCase();
    if (state.phase === "running" || state.phase === "tutorial") {
      if (k === "1") decide("batch");
      else if (k === "2") decide("hold");
      else if (k === "3") decide("refuse");
      else if (k === "i") integrate();
      else if (k === "p") publish();
      else if (k === "r") reconcile();
      else if (k === "arrowright" || k === "arrowleft") {
        const i = state.queue.findIndex((r) => r.id === state.focusId);
        const next = state.queue[(i + (k === "arrowright" ? 1 : -1) + state.queue.length) % state.queue.length];
        if (next) {
          state.focusId = next.id;
          renderQueue();
          renderFocus();
        }
      } else return;
      event.preventDefault();
    }
  });
  ui.mute.addEventListener("click", () => {
    sound.toggle();
    renderTop();
  });

  resetState(todayKey());
  renderStamps();
  renderAll();

  // ?debug exposes the simulation so it can be driven without a visible tab (rAF pauses when hidden).
  const params = new URLSearchParams(window.location.search);
  if (params.has("debug")) {
    window.__ambGame = { state, step, decide, apply, focused, invalidCode, integrate, publish, reconcile, clockIn, startTutorial, resetState, renderAll };
    if (params.has("autoplay")) {
      clockIn();
      spawn({ clean: true, area: "checkout" });
      spawn({ flaw: "scope", area: "search" });
      spawn({ area: "reports", clean: true });
      spawn({ area: "pricing", clean: true, lock: true });
      apply(state.queue[3], "batch");
      state.t = 61_000;
      renderAll();
    }
  }

  // Only run the clock while the game is on screen; a tab in the background should not lose a shift.
  const start = () => {
    if (!raf) {
      lastFrame = 0;
      raf = requestAnimationFrame(frame);
    }
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => entries.forEach((e) => (e.isIntersecting ? start() : stop())), { threshold: 0.1 }).observe(el);
  } else start();
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
}
