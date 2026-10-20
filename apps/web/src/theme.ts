import { ref, watch } from "vue";

// 全局主题状态：记忆过的偏好优先，首次访问跟随系统。
// 深色模式通过 html.dark 类生效（styles.css 语义化 CSS 变量自动适配），
// 供主布局顶栏与登录页共用，保证两处切换互相同步。
const THEME_KEY = "superpm-theme";
const stored = localStorage.getItem(THEME_KEY);
export const dark = ref(
  stored === null
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : stored === "dark",
);
watch(
  dark,
  (value) => {
    document.documentElement.classList.toggle("dark", value);
    localStorage.setItem(THEME_KEY, value ? "dark" : "light");
  },
  { immediate: true },
);
export function toggleTheme() {
  dark.value = !dark.value;
}
