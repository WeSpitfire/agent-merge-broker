<template>
<div class="amb-landing">

<div class="top">
  <div class="wrap">
    <div class="masthead">
      <a class="brand" href="#top">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 5h7c3 0 3 7 6 7M3 12h7M3 19h7c3 0 3-7 6-7" stroke="var(--rail)" stroke-width="1.6" stroke-linecap="round"/>
          <circle cx="19.5" cy="12" r="2.5" fill="var(--signal)"/>
        </svg>
        <span>Agent Merge Broker <span class="ver">v{{ project.version }}</span></span>
      </a>
      <nav>
        <a class="opt" href="#how">How it works</a>
        <a class="opt" href="#direction">Direction</a>
        <a href="/agent-merge-broker/docs/getting-started">Docs</a>
        <a href="https://github.com/WeSpitfire/agent-merge-broker">GitHub&nbsp;↗</a>
      </nav>
    </div>
  </div>
</div>

<div class="wrap" id="top">

<section class="hero">
  <div class="rail">
    <p class="eyebrow">Local-first · Crash-recoverable · Apache-2.0</p>
    <h1>Many producers. One repository contract.</h1>
    <p class="lede">Agent Merge Broker coordinates participating agents and humans through receipts naming immutable commits, validates their combined candidate, and keeps publication bound to the recorded repository target. Optional policy ties evidence and approval to the exact candidate before the broker authorizes auto-merge.</p>
    <div class="actions">
      <a class="btn" href="/agent-merge-broker/docs/getting-started">Get started</a>
      <a class="btn btn-ghost" href="#how">How it works</a>
    </div>
    <div class="cmd">
      <span class="sigil">$</span>
      <span class="txt" id="install">npm install --save-dev agent-merge-broker</span>
      <button class="copy" data-copy="install">Copy</button>
    </div>
  </div>

  <div class="frame">
    <div class="frame-bar"><span>One batch</span><span>4 commits · 2 workers</span></div>
    <div class="frame-body">
      <svg class="diagram" viewBox="0 0 720 190" role="img" aria-label="Four commits from two workers converging into one validated integration branch">
        <g fill="none" stroke-width="1.75" stroke-linecap="round">
          <path class="lane" style="--delay:0.30s" pathLength="1" stroke="var(--rail)" d="M40 28 H300 C360 28 360 95 420 95"/>
          <path class="lane" style="--delay:0.38s" pathLength="1" stroke="var(--rail)" d="M40 72 H300 C360 72 360 95 420 95"/>
          <path class="lane" style="--delay:0.46s" pathLength="1" stroke="var(--rail)" d="M40 118 H300 C360 118 360 95 420 95"/>
          <path class="lane" style="--delay:0.54s" pathLength="1" stroke="var(--rail)" d="M40 162 H300 C360 162 360 95 420 95"/>
          <path class="out" pathLength="1" stroke="var(--signal)" stroke-width="2.5" d="M420 95 H688"/>
        </g>
        <circle class="pulse" cx="420" cy="95" r="6.5" fill="none" stroke="var(--signal)" stroke-width="1.5" style="transform-origin:420px 95px"/>
        <g fill="var(--rail)">
          <circle class="fade" style="--delay:0s" cx="40" cy="28" r="4.5"/>
          <circle class="fade" style="--delay:0.08s" cx="40" cy="72" r="4.5"/>
          <circle class="fade" style="--delay:0.16s" cx="40" cy="118" r="4.5"/>
          <circle class="fade" style="--delay:0.24s" cx="40" cy="162" r="4.5"/>
        </g>
        <circle class="fade" style="--delay:1.30s" cx="420" cy="95" r="6.5" fill="var(--surface)" stroke="var(--signal)" stroke-width="2.5"/>
        <circle class="fade" style="--delay:2.55s" cx="688" cy="95" r="5.5" fill="var(--pass)"/>
        <g font-family="ui-monospace, monospace" font-size="11.5" fill="var(--muted)">
          <text class="fade" style="--delay:0.10s" x="56" y="32">checkout · add feature</text>
          <text class="fade" style="--delay:0.18s" x="56" y="76">checkout · version</text>
          <text class="fade" style="--delay:0.26s" x="56" y="122">search · add feature</text>
          <text class="fade" style="--delay:0.34s" x="56" y="166">search · version</text>
          <text class="fade" style="--delay:1.42s" x="420" y="68" text-anchor="middle" fill="var(--signal-ink)">broker</text>
          <text class="fade" style="--delay:2.62s" x="688" y="68" text-anchor="end" fill="var(--pass)">validated branch</text>
        </g>
      </svg>
    </div>
    <p class="frame-note">Coordinate mode today: four commits, two workers, one validated branch — and no worker ever pushed.</p>
  </div>
</section>

<section>
  <div class="rail col">
    <p class="eyebrow">The repository boundary</p>
    <h2>The producer can disappear. The transaction still has to recover.</h2>
    <p>Which bytes were validated? Which base and policy governed them? Was approval for this exact candidate? Did a lost forge response leave auto-merge active? Did the accepted history actually contain the approved work?</p>
    <p>Agents and orchestrators decide how code is produced. Agent Merge Broker gives participating workers one transaction contract and reconciles uncertain publication state before dependent work moves forward.</p>
  </div>
</section>

<section id="how">
  <div class="rail">
    <p class="eyebrow">Available in v{{ project.version }}</p>
    <h2>Coordinate mode: one integration authority</h2>
    <p class="col">Implementation stays distributed. Ordering, batching, validation, publication, and recovery do not. Every participating worker — Claude, Codex, Cursor, a CI job, a human — speaks the same commit-receipt protocol.</p>
    <ol class="seq">
      <li><span class="step">01</span><div><h3>Claim</h3><p>A worker takes an expiring lease on the paths it intends to touch. Overlapping claims are refused before a line is edited, not discovered at merge time.</p></div></li>
      <li><span class="step">02</span><div><h3>Commit</h3><p>The worker commits its focused change and stops. It never pushes, rebases, or administers a branch.</p></div></li>
      <li><span class="step">03</span><div><h3>Submit a receipt</h3><p>Immutable commit IDs, the paths they actually changed, and any declared dependencies. Implementation is now separate from integration authority.</p></div></li>
      <li><span class="step">04</span><div><h3>Batch and validate</h3><p>A deterministic scheduler forms one non-conflicting batch, cherry-picks it into a disposable worktree, and runs your validators against the combination — not four times against four branches.</p></div></li>
      <li><span class="step">05</span><div><h3>Land</h3><p>One branch or one pull request can carry signed provenance for exactly what was assembled and what passed. Automatic completion waits until the accepted Git history proves the batch merged.</p></div></li>
    </ol>
  </div>
</section>

<section id="direction">
  <div class="rail">
    <p class="eyebrow">Product direction</p>
    <h2>Coordinate ships. Gate validation is available. Verify is planned.</h2>
    <p class="col">The current package coordinates workers through its claim and receipt protocol, and can retain and validate one trusted repository-local Git ref without fabricated coordination history.</p>
    <div class="docs">
      <a class="doc" href="/agent-merge-broker/docs/getting-started">
        <h3>Coordinate <span class="arrow">Available →</span></h3>
        <p>Claim, lease, nominate, batch, validate, publish, and recover through one local authority.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/roadmap">
        <h3>Gate <span class="arrow">Validation available →</span></h3>
        <p>Retain and validate a trusted-source immutable Git ref without requiring its producer to use path leases.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/roadmap">
        <h3>Verify <span class="arrow">Planned →</span></h3>
        <p>Evaluate wider policy and attestation claims as a lightweight protected-workflow check.</p>
      </a>
    </div>
    <p class="col boundary">Gate intake is trusted-local and validation-only. It does not yet create approval, provenance, publication, or merge authority. Read the <a href="/agent-merge-broker/docs/vision">vision</a> and <a href="/agent-merge-broker/docs/roadmap">capability roadmap</a>.</p>
  </div>
</section>

<section id="demo">
  <div class="rail">
    <p class="eyebrow">See it work</p>
    <h2>Watch it in one minute</h2>
    <p class="col">Two workers race on a throwaway repository, a third is turned away for claiming ground someone else leased, and four commits land as one branch. No forge, no network, no credentials. It is also the project's acceptance test in CI — if the demo stops telling the truth, the build goes red.</p>
    <div class="cmd">
      <span class="sigil">$</span>
      <span class="txt" id="demo-install">git clone https://github.com/WeSpitfire/agent-merge-broker && cd agent-merge-broker && npm install && npm run build && npm run example</span>
      <button class="copy" data-copy="demo-install">Copy</button>
    </div>
    <div class="frame">
      <div class="frame-bar"><span>Source checkout · npm run example</span><span>~60s</span></div>
      <div class="term">
<pre><span class="c-mut">──</span> Two workers claim non-overlapping scope
   Claimed task <span class="c-sig">checkout</span> until 2026-08-17T04:12:55Z
   Claimed task <span class="c-sig">search</span>   until 2026-08-17T04:12:55Z
   <span class="c-mut">✗ refused</span> third worker: paths overlap active task <span class="c-sig">checkout</span>

<span class="c-mut">──</span> The broker plans one non-conflicting batch
   Selected 2 task(s), 4 commit(s):
     + checkout (2 commit(s))
     + search   (2 commit(s))

<span class="c-mut">──</span> Integrating: cherry-pick, validate, retain one branch
   Batch 20260815T043542882Z-01abf5: <span class="c-ok">prepared</span>
   Base:   main @ d5df783
   Branch: merge-broker/20260815T043542882Z-01abf5

<span class="c-ok">Four commits from two agents became one validated branch,
with no agent pushing anything.</span></pre>
      </div>
    </div>
  </div>
</section>

<section id="platforms">
  <div class="rail">
    <p class="eyebrow">Operating envelope</p>
    <h2>Portable where it matters, explicit where it stops</h2>
    <p class="col">The CLI, Node API, JSON protocol, stdio MCP server, integration worktrees, and per-user background loop run on Windows, macOS, and Linux. Repository validators use non-profile PowerShell on Windows and <code>/bin/sh</code> on macOS and Linux.</p>
    <dl class="facts">
      <div class="fact"><dt>Hosts</dt><dd>Windows · macOS · Linux</dd></div>
      <div class="fact"><dt>Agent access</dt><dd>CLI · Node · MCP stdio</dd></div>
      <div class="fact"><dt>Supervision</dt><dd>Task Scheduler · launchd · systemd</dd></div>
      <div class="fact"><dt>Built-in PR forge</dt><dd>GitHub via gh</dd></div>
    </dl>
    <p class="col boundary">It is not a hosted dashboard, distributed database, remote HTTP MCP service, agent runner, or automatic conflict resolver. Independent clones do not silently share leases. <a href="/agent-merge-broker/docs/compatibility">Read the full compatibility matrix and current limits →</a></p>
    <p class="col release-note">This site documents <code>main</code>. Planned capabilities are labeled explicitly and are not part of the npm package until a release says otherwise.</p>
  </div>
</section>

<section>
  <div class="rail">
    <p class="eyebrow">Verification</p>
    <h2>Built to be checked, not trusted</h2>
    <p class="col">When provenance is enabled, a published batch carries a manifest binding it to its base commit, task receipts, and validation results. <code>verify-provenance</code> checks that structure and rejects a commit pushed onto the branch afterwards; requiring a trusted signature additionally authenticates the broker identity.</p>
    <dl class="facts">
      <div class="fact"><dt>CI</dt><dd>Linux · macOS · Windows</dd></div>
      <div class="fact"><dt>Supply chain</dt><dd>SLSA provenance</dd></div>
      <div class="fact"><dt>Runtime deps</dt><dd>{{ project.dependencies }}</dd></div>
      <div class="fact"><dt>License</dt><dd>Apache-2.0</dd></div>
    </dl>
  </div>
</section>

<section id="docs">
  <div class="rail">
    <p class="eyebrow">Documentation</p>
    <h2>Wire it into your repository</h2>
    <div class="docs">
      <a class="doc" href="/agent-merge-broker/docs/getting-started">
        <h3>Getting started <span class="arrow">→</span></h3>
        <p>Install, validate, publish, supervise, and recover your first repository.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/architecture">
        <h3>Architecture <span class="arrow">→</span></h3>
        <p>Invariants, state model, scheduling, and the integration transaction.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/protocol">
        <h3>Protocol <span class="arrow">→</span></h3>
        <p>The task lifecycle and the contract every adapter implements.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/security">
        <h3>Security <span class="arrow">→</span></h3>
        <p>Trust boundaries, what configuration can execute, and hardening.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/compatibility">
        <h3>Compatibility <span class="arrow">→</span></h3>
        <p>Platform matrix, Windows behavior, integrations, and current limits.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/support">
        <h3>Support <span class="arrow">→</span></h3>
        <p>Create a safe diagnostic bundle and choose the right support channel.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/vision">
        <h3>Vision <span class="arrow">→</span></h3>
        <p>The durable repository boundary, product modes, principles, and non-goals.</p>
      </a>
      <a class="doc" href="/agent-merge-broker/docs/roadmap">
        <h3>Roadmap <span class="arrow">→</span></h3>
        <p>What exists now, Gate merge authority next, and later capability horizons.</p>
      </a>
    </div>
  </div>
</section>

</div>

<div class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="#top">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 5h7c3 0 3 7 6 7M3 12h7M3 19h7c3 0 3-7 6-7" stroke="var(--rail)" stroke-width="1.6" stroke-linecap="round"/>
            <circle cx="19.5" cy="12" r="2.5" fill="var(--signal)"/>
          </svg>
          <span>Agent Merge Broker</span>
        </a>
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
          <li>Node 20.12+</li>
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
import { useData } from "vitepress";

// Read from package.json at build time; see projectFacts in config.mts.
const { theme } = useData();
const project = computed(
  () => theme.value.project as { version: string; dependencies: number },
);

/**
 * The markup above is authored in its finished state, so a reader without JavaScript still sees the
 * completed graph. This only arms the animation and plays it once the figure is actually on screen —
 * a 2.6 second sequence is worth nothing if it runs while the reader is still on the headline.
 */
onMounted(() => {
  const diagram = document.querySelector<SVGSVGElement>(".amb-landing .diagram");

  if (diagram) {
    diagram.classList.add("armed");
    const play = (): void => diagram.classList.add("playing");

    if (!("IntersectionObserver" in window)) {
      play();
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            play();
            observer.disconnect();
          }
        },
        { threshold: 0.35 },
      );
      observer.observe(diagram);
    }
  }

  document.querySelectorAll<HTMLButtonElement>(".amb-landing .copy").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.copy;
      const source = target ? document.getElementById(target) : null;
      if (!source?.textContent) return;

      void navigator.clipboard.writeText(source.textContent.trim()).then(() => {
        const previous = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => {
          button.textContent = previous;
        }, 1600);
      });
    });
  });
});
</script>
