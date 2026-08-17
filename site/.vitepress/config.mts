import { defineConfig } from "vitepress";

const REPO = "https://github.com/WeSpitfire/agent-merge-broker";

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
    nav: [
      { text: "Docs", link: "/docs/architecture", activeMatch: "/docs/" },
      { text: "npm", link: "https://www.npmjs.com/package/agent-merge-broker" },
      { text: "Changelog", link: `${REPO}/blob/main/CHANGELOG.md` },
    ],
    sidebar: {
      "/docs/": [
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
      pattern: `${REPO}/edit/main/docs/:path`,
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
