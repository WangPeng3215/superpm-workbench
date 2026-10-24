<script setup lang="ts">
import { dark, toggleTheme } from "../theme";
</script>

<template>
  <button
    class="theme-switch"
    :class="{ 'is-dark': dark }"
    type="button"
    :aria-label="dark ? '切换到浅色模式' : '切换到深色模式'"
    :title="dark ? '切换到浅色模式' : '切换到深色模式'"
    @click="toggleTheme"
  >
    <span class="theme-switch__track" aria-hidden="true">
      <span class="theme-switch__icon theme-switch__icon--sun">
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <path
            d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <span class="theme-switch__icon theme-switch__icon--moon">
        <svg viewBox="0 0 24 24" fill="none">
          <path
            d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span class="theme-switch__thumb" />
    </span>
  </button>
</template>

<style scoped>
.theme-switch {
  display: inline-flex;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
}
.theme-switch__track {
  --track-w: 46px;
  --track-h: 22px;
  --pad: 2px;
  position: relative;
  display: block;
  width: var(--track-w);
  height: var(--track-h);
  border-radius: 999px;
  background: var(--theme-switch-track);
  transition: background var(--duration-normal) var(--ease-standard);
}
.theme-switch.is-dark .theme-switch__track {
  background: var(--theme-switch-track-active);
}
.theme-switch:focus-visible {
  outline: none;
}
.theme-switch:focus-visible .theme-switch__track {
  box-shadow: 0 0 0 3px var(--brand-ring);
}
.theme-switch__thumb {
  position: absolute;
  top: var(--pad);
  left: var(--pad);
  width: calc(var(--track-h) - var(--pad) * 2);
  height: calc(var(--track-h) - var(--pad) * 2);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgb(15 23 42 / 28%);
  transform: translateX(0);
  transition: transform 220ms var(--ease-standard);
}
.theme-switch.is-dark .theme-switch__thumb {
  transform: translateX(calc(var(--track-w) - var(--track-h)));
}
.theme-switch__icon {
  position: absolute;
  top: 0;
  display: grid;
  place-items: center;
  width: var(--track-h);
  height: var(--track-h);
  color: #fff;
  transition:
    opacity var(--duration-fast) var(--ease-standard),
    transform 220ms var(--ease-standard);
}
.theme-switch__icon svg {
  width: 13px;
  height: 13px;
}
.theme-switch__icon--sun {
  right: 0;
}
.theme-switch__icon--moon {
  left: 0;
  opacity: 0;
  transform: scale(0.6);
}
.theme-switch.is-dark .theme-switch__icon--sun {
  opacity: 0;
  transform: scale(0.6);
}
.theme-switch.is-dark .theme-switch__icon--moon {
  opacity: 1;
  transform: scale(1);
}
@media (pointer: coarse) {
  .theme-switch__track::before {
    content: "";
    position: absolute;
    inset: -11px -3px;
  }
}
</style>
