import { defineConfig } from "vitepress";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/WeSpitfire/agent-merge-broker";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Figures the landing page states about the package are read from the package itself, so a release
 * cannot leave the site claiming a version or a test count that is no longer true.
 */
function projectFacts(): { version: string; tests: number; dependencies: number } {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };

  const src = path.join(repoRoot, "src");
  const tests = readdirSync(src)
    .filter((file) => file.endsWith(".test.ts"))
    .reduce((total, file) => {
      const contents = readFileSync(path.join(src, file), "utf8");
      return total + (contents.match(/^test\(/gmu)?.length ?? 0);
    }, 0);

  if (tests === 0) throw new Error("Counted no tests: the declaration pattern has drifted.");

  return { version: manifest.version, tests, dependencies: Object.keys(manifest.dependencies ?? {}).length };
}

const project = projectFacts();

export default defineConfig({
  title: "Agent Merge Broker",
  description:
    "A transaction coordinator for parallel code-producing agents and humans. Workers submit commits; the broker batches, validates, and lands them.",
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
          "Four agents just finished at the same time. Who merges first? The broker decides what can safely go together, validates it, and lands one branch.",
      },
    ],
  ],
  themeConfig: {
    project,
    nav: [
      { text: "Docs", link: "/docs/getting-started", activeMatch: "/docs/" },
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
            { text: "Security", link: "/docs/security" },
            { text: "Releasing", link: "/docs/releasing" },
          ],
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
