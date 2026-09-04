import { defineConfig } from "vitepress";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/WeSpitfire/agent-merge-broker";
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
  description:
    "Crash-recoverable repository transactions for code produced by agents and humans, with exact-candidate validation, approval, provenance, and forge reconciliation.",
  // The site is served from a repository subpath on github.io.
  base: "/agent-merge-broker/",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#E8A13A" }],
    ["meta", { property: "og:title", content: "Agent Merge Broker" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Coordinate and reconcile exact code candidates with validation, optional approval and provenance, and durable forge target binding.",
      },
    ],
  ],
  themeConfig: {
    project,
    nav: [
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
