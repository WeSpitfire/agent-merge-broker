import { defineConfig } from "vitepress";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/WeSpitfire/agent-merge-broker";
const SITE = "https://agentmerge.org";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Release facts shown on the landing page are read from the package itself, so version and
 * dependency changes cannot leave the site stale.
 */
function projectFacts(): { version: string; dependencies: number } {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };

  return { version: manifest.version, dependencies: Object.keys(manifest.dependencies ?? {}).length };
}

const project = projectFacts();

export default defineConfig({
  title: "Agent Merge Broker",
  titleTemplate: ":title · agentmerge.org",
  description:
    "Crash-recoverable repository transactions for code produced by agents and humans, with exact-candidate validation, approval, provenance, and forge reconciliation.",
  // Served from the root of the custom domain (public/CNAME). Set SITE_BASE=/agent-merge-broker/
  // to build for the old github.io subpath instead.
  base: process.env.SITE_BASE ?? "/",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: SITE },
  head: [
    ["meta", { name: "theme-color", content: "#C4122C" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;900&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
    ],
    ["meta", { property: "og:site_name", content: "agentmerge.org" }],
    ["meta", { property: "og:title", content: "Nobody pushes to main." }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Agent Merge Broker: crash-recoverable repository transactions for code written by agents and humans. Play a shift at the claims window.",
      },
    ],
    ["meta", { property: "og:url", content: SITE }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],
  themeConfig: {
    project,
    nav: [
      { text: "Play", link: "/#play" },
      { text: "Docs", link: "/docs/getting-started", activeMatch: "/docs/" },
      { text: "Compatibility", link: "/docs/compatibility" },
      { text: "npm", link: "https://www.npmjs.com/package/agent-merge-broker" },
      { text: "Changelog", link: `${REPO}/blob/main/CHANGELOG.md` },
    ],
    sidebar: {
      "/docs/": [
        {
          text: "Start here",
          items: [{ text: "Getting started", link: "/docs/getting-started" }],
        },
        {
          text: "Reference",
          items: [
            { text: "Architecture", link: "/docs/architecture" },
            { text: "Protocol", link: "/docs/protocol" },
            { text: "Compatibility & limits", link: "/docs/compatibility" },
            { text: "Security", link: "/docs/security" },
            { text: "Releasing", link: "/docs/releasing" },
          ],
        },
        {
          text: "Project",
          items: [
            { text: "Vision", link: "/docs/vision" },
            { text: "Roadmap", link: "/docs/roadmap" },
          ],
        },
        {
          text: "Help",
          items: [{ text: "Support", link: "/docs/support" }],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: REPO }],
    editLink: {
      pattern: ({ filePath }) => {
        const sources: Record<string, string> = {
          "docs/getting-started.md": "docs/GETTING_STARTED.md",
          "docs/architecture.md": "docs/ARCHITECTURE.md",
          "docs/protocol.md": "docs/PROTOCOL.md",
          "docs/security.md": "docs/SECURITY.md",
          "docs/releasing.md": "docs/RELEASING.md",
          "docs/compatibility.md": "docs/COMPATIBILITY.md",
          "docs/vision.md": "VISION.md",
          "docs/roadmap.md": "ROADMAP.md",
          "docs/support.md": "SUPPORT.md",
        };
        // Serialized by VitePress and evaluated in the client: no closure over module constants.
        return `https://github.com/WeSpitfire/agent-merge-broker/edit/main/${sources[filePath] ?? filePath}`;
      },
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Apache-2.0 licensed. Documentation is generated from the repository.",
      copyright: `<a href="${REPO}">github.com/WeSpitfire/agent-merge-broker</a>`,
    },
    search: { provider: "local" },
    outline: [2, 3],
  },
});
