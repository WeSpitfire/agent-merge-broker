import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Landing from "./Landing.vue";
import "./custom.css";
import "./landing.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Landing", Landing);
  },
} satisfies Theme;
