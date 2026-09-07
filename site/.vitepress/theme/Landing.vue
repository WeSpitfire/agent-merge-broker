<template>
<div class="amb">

<div class="top">
  <div class="wrap">
    <div class="masthead">
      <a class="brand" href="#top">
        <span class="word">agent<b>merge</b>.org</span>
        <span class="ver">v{{ project.version }}</span>
      </a>
      <nav>
        <a class="opt" href="#play">Play</a>
        <a class="opt" href="#how">How it works</a>
        <a :href="withBase('/docs/getting-started')">Docs</a>
        <a href="https://github.com/WeSpitfire/agent-merge-broker">GitHub&nbsp;↗</a>
      </nav>
    </div>
  </div>
</div>

<div class="wrap" id="top">

<section class="hero plain">
  <div class="hero-grid">
    <div>
      <p class="eyebrow">Agent Merge Broker · open source · Apache-2.0</p>
      <h1><span>Nobody</span><span>pushes</span><span>to <span class="hit">main.</span></span></h1>
      <p class="lede">Agent Merge Broker is a local-first, crash-recoverable transaction coordinator for code written by agents and humans. Workers claim paths, commit, and hand over a receipt. The broker validates one candidate, publishes it, and can pick up after a crash. Your forge still has the last word.</p>
      <div class="actions">
        <a class="btn" href="#play">Play a shift ↓</a>
        <a class="btn btn-ghost" :href="withBase('/docs/getting-started')">Get started</a>
      </div>
      <div class="cmd">
        <span class="sigil">$</span>
        <span class="txt" id="install">npm install --save-dev agent-merge-broker</span>
        <button class="copy" data-copy="install">Copy</button>
      </div>
    </div>

    <div class="receipt-wrap">
      <div class="paper receipt" data-print aria-label="Output of the two-agent demo, printed as a receipt">
        <div class="paper-head">Broker · npm run example</div>
        <span class="ln h">── Two agents claim disjoint scopes</span>
        <span class="ln">   Claimed task checkout until 08:53Z.</span>
        <span class="ln">   Claimed task search until 08:53Z.</span>
        <span class="ln h">── An overlapping third claim is rejected</span>
        <span class="ln hit">   LEASE_CONFLICT: paths overlap active task checkout.</span>
        <span class="ln h">── Each agent commits and nominates</span>
        <span class="ln">   Candidate nominated with 2 commit(s) for checkout.</span>
        <span class="ln">   This DOES NOT authorize merging.</span>
        <span class="ln">   Candidate nominated with 2 commit(s) for search.</span>
        <span class="ln">   This DOES NOT authorize merging.</span>
        <span class="ln h">── The broker plans one batch</span>
        <span class="ln">   Selected 2 task(s), 4 commit(s).</span>
        <span class="ln h">── Cherry-pick, validate, retain one branch</span>
        <span class="ln">   Base:   main @ e934af5</span>
        <span class="ln">   Branch: merge-broker/…-3f5c01</span>
        <span class="ln ok big">Four commits. Two agents. One validated branch. Zero pushes.</span>
      </div>
      <span class="stamp pass big">Validated</span>
    </div>
  </div>
</section>

</div>

<div class="ticker" aria-hidden="true">
  <div class="ticker-track">
    <span>task.claimed checkout · claude/checkout · src/checkout/**</span>
    <span>task.claimed search · codex/search · src/search/**</span>
    <span>lease.refused cart · LEASE_CONFLICT</span>
    <span>candidate.nominated checkout · 2 commits</span>
    <span>candidate.nominated search · 2 commits</span>
    <span>batch.planned 3f5c01 · 2 tasks · 4 commits</span>
    <span>batch.validated 3f5c01 · focused pass · gate pass</span>
    <span>batch.published 3f5c01 · PR #41 · auto-merge armed</span>
    <span>forge.observed PR #41 · MERGED · proof 9a0c1de</span>
    <span>task.claimed checkout · claude/checkout · src/checkout/**</span>
    <span>task.claimed search · codex/search · src/search/**</span>
    <span>lease.refused cart · LEASE_CONFLICT</span>
    <span>candidate.nominated checkout · 2 commits</span>
    <span>candidate.nominated search · 2 commits</span>
    <span>batch.planned 3f5c01 · 2 tasks · 4 commits</span>
    <span>batch.validated 3f5c01 · focused pass · gate pass</span>
    <span>batch.published 3f5c01 · PR #41 · auto-merge armed</span>
    <span>forge.observed PR #41 · MERGED · proof 9a0c1de</span>
  </div>
</div>

<div class="wrap">

<section id="play" class="plain">
  <p class="eyebrow">Night shift</p>
  <h2>Work the claims window until dawn.</h2>
  <p class="col">Agents slide receipts onto the counter in real time. Leases tick down. Batches take time to integrate, and the forge sometimes forgets to answer. Every stamp is a rule the real broker enforces, and every refusal code is real. Keys 1 to 3 stamp, I integrates, P publishes, R reconciles, arrows pick a receipt.</p>
  <div class="game" data-game tabindex="0" :data-docs="withBase('/docs/architecture')">
    <div class="g-top">
      <span class="g-clock"><b data-g-clock>22:00</b><span class="g-night"><i data-g-night></i></span></span>
      <span>Score <b data-g-score>0</b></span>
      <span>Combo <b data-g-combo>×1</b></span>
      <span>Main broke <span class="g-breaks" data-g-breaks></span></span>
      <span class="g-ci" data-g-ci>CI GREEN</span>
      <button type="button" class="g-mute" data-g-mute aria-pressed="false">Sound on</button>
    </div>
    <div class="g-stage">
      <div class="g-counter">
        <div>
          <div class="g-board-head">Counter <span class="g-pressure"><i data-g-pressure></i></span></div>
          <div class="g-queue" data-g-queue></div>
        </div>
        <div class="g-hint" data-g-hint hidden></div>
        <div class="g-focus" data-g-focus></div>
        <div class="g-stamps" data-g-stamps hidden></div>
      </div>
      <aside class="g-board-col" aria-label="Repository board">
        <div class="g-board" data-g-board></div>
        <div class="g-trayblock"><div data-g-tray></div><div class="g-tray-actions" data-g-tray-actions></div></div>
        <div class="g-log" data-g-log aria-live="polite"></div>
      </aside>
      <div class="g-overlay" data-g-overlay hidden></div>
    </div>
  </div>
</section>

<section id="problem">
  <div class="split">
    <div>
      <p class="eyebrow">The problem</p>
      <h2>Four agents finish at once.</h2>
      <p class="col">Testing four branches on their own proves nothing about what they do together. Somebody has to order the work, refuse the overlaps early, validate compatible commits as one candidate, and keep merge authority away from the workers. That somebody should not get tired, and should not take an agent's word for anything.</p>
      <p class="col">Agents and orchestrators decide how code gets produced. The broker gives them one transaction contract for the boundary in front of the protected branch, and the forge still decides when that branch moves.</p>
    </div>
    <div class="form">
      <div class="form-head"><span>Incident · 16:42</span><span>Repository: shop</span></div>
      <ol>
        <li><div><b>Two agents edited the same file.</b>Both diffs apply cleanly on their own. Together, one overwrites the other.</div></li>
        <li><div><b>One started from a base that already moved.</b>Its tests passed against a main that no longer exists.</div></li>
        <li><div><b>Every agent regenerated the lockfile.</b>Four package-lock.json files, four different answers.</div></li>
        <li><div><b>All four have push access.</b>Whoever finishes last wins, and CI finds out afterwards.</div></li>
      </ol>
      <span class="stamp">Refused</span>
    </div>
  </div>
</section>

<section id="how">
  <p class="eyebrow">Coordinate mode · shipping in v{{ project.version }}</p>
  <h2>One receipt, eight stops.</h2>
  <p class="col">Implementation stays distributed. Ordering, batching, validation, publication, and recovery do not. Claude, Codex, Cursor, a CI job, a human with a terminal: every participant speaks the same small commit-receipt protocol.</p>
  <ol class="life">
    <li><div class="step">Claim <small>01</small></div><p>A worker takes a lease on the paths it intends to touch. Overlapping claims are refused before a line is edited.</p></li>
    <li><div class="step">Lease <small>02</small></div><p>Leases expire and cross worktrees. Heartbeat to keep one; go quiet and it lapses.</p></li>
    <li><div class="step">Commit <small>03</small></div><p>The worker commits focused work and stops. It never pushes, rebases, or administers a branch.</p></li>
    <li><div class="step">Nominate <small>04</small></div><p>A receipt names immutable commit IDs. The broker derives the changed paths from Git, not from the receipt.</p></li>
    <li><div class="step">Batch <small>05</small></div><p>A deterministic scheduler forms one bounded, non-conflicting batch, honoring dependencies and serialized files.</p></li>
    <li><div class="step">Validate <small>06</small></div><p>Real cherry-picks in a disposable worktree, focused checks per task, then the complete gate.</p></li>
    <li><div class="step">Publish <small>07</small></div><p>One branch or one pull request, bound to the recorded remote and target, optionally carrying signed provenance.</p></li>
    <li><div class="step">Reconcile <small>08</small></div><p>Durable intents survive a crash or a lost forge response. Done means the merge is provable in Git history.</p></li>
  </ol>
</section>

<section id="nots">
  <p class="eyebrow">Non-goals</p>
  <h2>Things it will not do, no matter how nicely you ask.</h2>
  <div class="nots">
    <div class="not"><span class="stamp">Not an agent runner</span><p>It does not spawn, schedule, or prompt agents. Bring your own.</p></div>
    <div class="not"><span class="stamp">Not an AI judge</span><p>Gate reads protected-base policy; Coordinate uses the controlled checkout. No model decides what merges.</p></div>
    <div class="not"><span class="stamp">Not your CI</span><p>It runs your validators and records the evidence. It does not replace them.</p></div>
    <div class="not"><span class="stamp">Not a merge queue</span><p>The forge, branch protection, and review keep the final say on the protected branch.</p></div>
    <div class="not"><span class="stamp">Not a conflict resolver</span><p>Automatic conflict resolution is not a security boundary. Conflicts fail the task, narrowly.</p></div>
    <div class="not"><span class="stamp">Not a hosted service</span><p>Filesystem-backed, inspectable, self-hosted. Publication uses your configured Git and forge credentials.</p></div>
  </div>
</section>

<section id="modes">
  <p class="eyebrow">Product direction</p>
  <h2>Coordinate ships. Gate intake has begun. Gate authority comes next.</h2>
  <div class="modes">
    <div class="mode">
      <span class="stamp pass">Shipped · v{{ project.version }}</span>
      <h3>Coordinate</h3>
      <p>Claim, lease, nominate, batch, validate, publish, and recover through one local authority. This is the game above.</p>
      <a :href="withBase('/docs/getting-started')">Getting started →</a>
    </div>
    <div class="mode">
      <span class="stamp warn">v0.14.0 · validation evidence</span>
      <h3>Gate</h3>
      <p>Pin and validate a trusted local Git ref, inspect its history, and export signed evidence. Approval, publication, and merge authority remain planned.</p>
      <a :href="withBase('/docs/roadmap')">Roadmap →</a>
    </div>
    <div class="mode">
      <span class="stamp warn">Planned</span>
      <h3>Verify</h3>
      <p>A lightweight admission check for policy and attestation claims from a wider set of workflows. Today's verifier is narrower.</p>
      <a :href="withBase('/docs/vision')">Vision →</a>
    </div>
  </div>
</section>

<section id="demo">
  <p class="eyebrow">The real thing</p>
  <h2>Sixty seconds, no forge, no network.</h2>
  <p class="col">Two workers race on a throwaway repository, a third is turned away for claiming ground someone else leased, and four commits land as one branch. It is also the project's acceptance test in CI: if this demo stops telling the truth, the build goes red.</p>
  <div class="cmd">
    <span class="sigil">$</span>
    <span class="txt" id="demo-install">git clone https://github.com/WeSpitfire/agent-merge-broker && cd agent-merge-broker && npm install && npm run build && npm run example</span>
    <button class="copy" data-copy="demo-install">Copy</button>
  </div>
  <div class="term">
<pre><span class="c-mut">──</span> Two agents claim disjoint scopes in separate worktrees
   Claimed task <span class="c-sig">checkout</span> until 2026-09-04T08:53:34.518Z.
   Claimed task <span class="c-sig">search</span> until 2026-09-04T08:53:35.044Z.

<span class="c-mut">──</span> An overlapping third claim is rejected
   <span class="c-sig">LEASE_CONFLICT</span>: Expected paths overlap active task checkout, leased by agent-checkout.

<span class="c-mut">──</span> Each agent commits and nominates its immutable candidate
   Candidate nominated with 2 commit(s) for checkout.
   This DOES NOT authorize merging.
   Candidate nominated with 2 commit(s) for search.
   This DOES NOT authorize merging.

<span class="c-mut">──</span> The broker plans one non-conflicting batch
   Selected 2 task(s), 4 commit(s):
     + checkout (2 commit(s))
     + search (2 commit(s))

<span class="c-mut">──</span> Integrating: cherry-pick, validate, and retain one branch
   Batch 20260904T082338767Z-3f5c01: <span class="c-ok">prepared</span>
   Validation authority: broker
   Base: main @ e934af5e9fbce7d0e3253a152c98aae3d0409f09
   Branch: merge-broker/20260904T082338767Z-3f5c01

<span class="c-ok">Four commits from two agents became one validated branch, with no agent pushing anything.</span></pre>
  </div>
</section>

<section id="facts">
  <p class="eyebrow">Operating envelope</p>
  <h2>Portable where it matters. Explicit where it stops.</h2>
  <dl class="facts">
    <div class="fact"><dt>Hosts</dt><dd>Win · Mac · Linux</dd></div>
    <div class="fact"><dt>Requires</dt><dd>Node 22 · Git 2.31</dd></div>
    <div class="fact"><dt>Agent access</dt><dd>CLI · Node · MCP</dd></div>
    <div class="fact"><dt>PR forge</dt><dd>GitHub via gh</dd></div>
    <div class="fact"><dt>Runtime deps</dt><dd>{{ project.dependencies }}</dd></div>
    <div class="fact"><dt>Supply chain</dt><dd>SLSA provenance</dd></div>
    <div class="fact"><dt>License</dt><dd>Apache-2.0</dd></div>
    <div class="fact"><dt>Formats</dt><dd>Versioned · pre-1.0</dd></div>
  </dl>
  <p class="col muted" style="margin-top:1.5rem">Independent clones do not silently share leases, and on-disk formats may migrate before 1.0. <a :href="withBase('/docs/compatibility')">Read the compatibility matrix and current limits →</a></p>
</section>

<section id="docs">
  <p class="eyebrow">Documentation</p>
  <h2>Wire it into a repository.</h2>
  <div class="docs">
    <a class="doc" :href="withBase('/docs/getting-started')"><h3>Getting started <span class="arrow">→</span></h3><p>Install, validate, publish, supervise, and recover your first repository.</p></a>
    <a class="doc" :href="withBase('/docs/architecture')"><h3>Architecture <span class="arrow">→</span></h3><p>Invariants, state model, scheduling, and the integration transaction.</p></a>
    <a class="doc" :href="withBase('/docs/protocol')"><h3>Protocol <span class="arrow">→</span></h3><p>The task lifecycle, error codes, and the contract every adapter implements.</p></a>
    <a class="doc" :href="withBase('/docs/security')"><h3>Security <span class="arrow">→</span></h3><p>Trust boundaries, what configuration can execute, and hardening.</p></a>
    <a class="doc" :href="withBase('/docs/compatibility')"><h3>Compatibility <span class="arrow">→</span></h3><p>Platform matrix, Windows behavior, integrations, and current limits.</p></a>
    <a class="doc" :href="withBase('/docs/support')"><h3>Support <span class="arrow">→</span></h3><p>Create a redacted diagnostic bundle and pick the right channel.</p></a>
    <a class="doc" :href="withBase('/docs/vision')"><h3>Vision <span class="arrow">→</span></h3><p>The durable repository boundary, product modes, principles, and non-goals.</p></a>
    <a class="doc" :href="withBase('/docs/roadmap')"><h3>Roadmap <span class="arrow">→</span></h3><p>What exists now, Gate merge authority next, and the later horizons.</p></a>
  </div>
</section>

</div>

<div class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="#top"><span class="word">agent<b>merge</b>.org</span></a>
        <p class="colophon">Crash-recoverable repository transactions for code-producing agents and humans. Not an agent framework, and not a replacement for protected branches.</p>
      </div>
      <div class="foot-links">
        <ul>
          <li class="head">Project</li>
          <li><a href="https://github.com/WeSpitfire/agent-merge-broker">GitHub</a></li>
          <li><a href="https://www.npmjs.com/package/agent-merge-broker">npm</a></li>
          <li><a href="https://github.com/WeSpitfire/agent-merge-broker/blob/main/CHANGELOG.md">Changelog</a></li>
        </ul>
        <ul>
          <li class="head">Requires</li>
          <li>Node 22+</li>
          <li>Git 2.31+</li>
          <li>gh (PR mode only)</li>
        </ul>
        <ul>
          <li class="head">Supported</li>
          <li>Windows</li>
          <li>macOS</li>
          <li>Linux</li>
        </ul>
      </div>
    </div>
  </div>
</div>

</div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useData, withBase } from "vitepress";
import { mountLanding } from "./landing-client.js";

// Read from package.json at build time; see projectFacts in config.mts.
const { theme } = useData();
const project = computed(() => theme.value.project as { version: string; dependencies: number });

onMounted(() => {
  // VitePress only ever adds the `dark` class. Mirror an explicit light choice so the
  // prefers-color-scheme fallback in landing.css cannot override it.
  try {
    if (localStorage.getItem("vitepress-theme-appearance") === "light") {
      document.documentElement.classList.add("light");
    }
  } catch {
    // Storage may be unavailable; the OS preference applies.
  }
  mountLanding(document.querySelector<HTMLElement>(".amb"));
});
</script>
