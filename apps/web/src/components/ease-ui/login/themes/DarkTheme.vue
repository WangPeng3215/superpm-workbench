<template>
  <div class="t-dark">
    <canvas ref="canvasRef" class="t-dark__canvas" aria-hidden="true" />

    <div class="t-dark__center">
      <!-- 左侧装饰线 -->
      <div class="side-lines side-lines--left" aria-hidden="true">
        <span
          v-for="i in 5"
          :key="i"
          class="side-line"
          :style="`animation-delay:${i * 0.28}s;width:${[110, 70, 90, 55, 80][i - 1]}px`"
        />
      </div>

      <!-- 主卡片 -->
      <div class="t-dark__card">
        <div class="card-glow" aria-hidden="true" />
        <div class="scan-line" aria-hidden="true" />

        <div class="t-dark__logo">
          <img :src="logoUrl" alt="superPM" />
          <div class="logo-ring" />
        </div>

        <h1 class="t-dark__title">superPM 需求工作台</h1>
        <p class="t-dark__sub">SUPERPM WORKBENCH</p>

        <!-- 状态指示器 -->
        <div class="status-bar">
          <span class="status-dot" />
          <span class="status-text">本地数据 · 保存在这台电脑</span>
          <span class="status-value">v{{ appVersion }}</span>
        </div>

        <!-- ========== 登录表单（内联） ========== -->
        <form class="dark-form" @submit.prevent="handleSubmit">
          <div class="df-field">
            <label class="df-label" for="dark-username">账号</label>
            <div class="df-input-wrap">
              <UserOutlined class="df-input-icon" aria-hidden="true" />
              <input
                id="dark-username"
                v-model="form.username"
                type="text"
                class="df-input"
                placeholder="请输入账号"
                autocomplete="username"
              />
            </div>
          </div>

          <div class="df-field">
            <label class="df-label" for="dark-password">密码</label>
            <div class="df-input-wrap">
              <LockOutlined class="df-input-icon" aria-hidden="true" />
              <input
                id="dark-password"
                v-model="form.password"
                :type="showPwd ? 'text' : 'password'"
                class="df-input df-input--pwd"
                placeholder="请输入密码"
                autocomplete="current-password"
              />
              <button
                type="button"
                class="df-toggle"
                :aria-label="showPwd ? '隐藏密码' : '显示密码'"
                :title="showPwd ? '隐藏密码' : '显示密码'"
                @click="showPwd = !showPwd"
              >
                <EyeInvisibleOutlined v-if="showPwd" aria-hidden="true" />
                <EyeOutlined v-else aria-hidden="true" />
              </button>
            </div>
          </div>

          <div v-if="error" class="df-error">
            <ExclamationCircleFilled class="df-error-icon" aria-hidden="true" />
            {{ error }}
          </div>

          <button
            type="submit"
            class="df-btn"
            :disabled="loading || !form.username || !form.password"
          >
            <span class="df-btn-shimmer" />
            <span v-if="loading" class="df-btn-spinner">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
            </span>
            <template v-else>
              <span class="df-btn-text">立即登录</span>
              <span class="df-btn-arrow">
                <ArrowRightOutlined aria-hidden="true" />
              </span>
            </template>
            <span v-if="loading" class="df-btn-text">验证中...</span>
          </button>

          <!-- 默认账号提示 -->
          <div class="df-hint">
            <InfoCircleOutlined class="df-hint-icon" aria-hidden="true" />
            默认账号：admin · 密码：admin123（首次登录后请修改）
          </div>
        </form>
      </div>

      <!-- 右侧装饰线 -->
      <div class="side-lines side-lines--right" aria-hidden="true">
        <span
          v-for="i in 5"
          :key="i"
          class="side-line"
          :style="`animation-delay:${i * 0.28 + 0.14}s;width:${[110, 70, 90, 55, 80][i - 1]}px`"
        />
      </div>
    </div>

    <footer class="dark-page-footer">
      <span>© 2026 superPM workbench</span>
      <span class="footer-dot">·</span>
      <span>数据保存在这台电脑</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from "vue";
import {
  ArrowRightOutlined,
  ExclamationCircleFilled,
  EyeInvisibleOutlined,
  EyeOutlined,
  InfoCircleOutlined,
  LockOutlined,
  UserOutlined,
} from "@ant-design/icons-vue";

// 项目 logo：复用 public/logo-mark.png
const logoUrl = "/logo-mark.png";
const appVersion = __APP_VERSION__;

defineProps<{ loading?: boolean; error?: string }>();
const emit = defineEmits<{
  submit: [form: { username: string; password: string }];
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let animId = 0;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
}
let pts: Particle[] = [];

function initCanvas() {
  const c = canvasRef.value;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;

  c.width = window.innerWidth;
  c.height = window.innerHeight;

  pts = Array.from({ length: 90 }, () => ({
    x: Math.random() * c.width,
    y: Math.random() * c.height,
    vx: (Math.random() - 0.5) * 0.5,
    vy: (Math.random() - 0.5) * 0.5,
    r: Math.random() * 1.6 + 0.3,
    a: Math.random() * 0.6 + 0.2,
  }));

  cancelAnimationFrame(animId);
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const draw = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    pts.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > c.width) p.vx *= -1;
      if (p.y < 0 || p.y > c.height) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(107,134,255,${p.a * 0.5})`;
      ctx.fill();
    });
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x,
          dy = pts[i].y - pts[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 110) {
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[j].x, pts[j].y);
          ctx.strokeStyle = `rgba(107,134,255,${(1 - d / 110) * 0.18})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
    if (!reduceMotion) animId = requestAnimationFrame(draw);
  };
  draw();
}

onMounted(() => initCanvas());
onUnmounted(() => cancelAnimationFrame(animId));

const showPwd = ref(false);
const form = reactive({ username: "", password: "" });

function handleSubmit() {
  if (form.username && form.password) {
    emit("submit", { username: form.username, password: form.password });
  }
}
</script>

<style scoped lang="scss">
.t-dark {
  min-height: 100dvh;
  background: var(--bg-page);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 52px 20px 0;
  font-family: var(--font-sans);
}

.t-dark__canvas {
  position: fixed;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
}

.t-dark__center {
  position: relative;
  z-index: 1;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 28px;
  margin: auto;
}

/* 主卡片 */
.t-dark__card {
  width: 420px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-base);
  border-radius: 16px;
  padding: 40px;
  position: relative;
  overflow: hidden;
  box-shadow: 0 24px 60px -24px rgb(0 0 0 / 0.55);
  animation: rise-up 0.35s var(--ease-standard);
}
@keyframes rise-up {
  from {
    opacity: 0;
    transform: translateY(24px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.card-glow {
  position: absolute;
  top: -80px;
  left: 50%;
  transform: translateX(-50%);
  width: 260px;
  height: 260px;
  background: radial-gradient(
    circle,
    rgba(107, 134, 255, 0.16),
    transparent 70%
  );
  pointer-events: none;
  animation: glow-pulse 4s ease-in-out infinite;
}
@keyframes glow-pulse {
  0%,
  100% {
    opacity: 0.5;
    transform: translateX(-50%) scale(1);
  }
  50% {
    opacity: 1;
    transform: translateX(-50%) scale(1.25);
  }
}

.scan-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(107, 134, 255, 0.6),
    transparent
  );
  animation: scan 3s ease-in-out infinite;
}
@keyframes scan {
  0% {
    top: 0;
    opacity: 1;
  }
  100% {
    top: 100%;
    opacity: 0;
  }
}

/* logo */
.t-dark__logo {
  width: 60px;
  height: 60px;
  margin: 0 auto 20px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(
    135deg,
    rgba(107, 134, 255, 0.25),
    rgba(124, 58, 237, 0.25)
  );
  border: 1px solid rgba(107, 134, 255, 0.35);
  border-radius: 18px;
  img {
    width: 42px;
    height: 42px;
    object-fit: contain;
  }
}

.logo-ring {
  position: absolute;
  inset: -6px;
  border-radius: 24px;
  border: 1px solid rgba(107, 134, 255, 0.2);
  animation: ring-pulse 3s ease-in-out infinite;
}
@keyframes ring-pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(1);
  }
  50% {
    opacity: 0.8;
    transform: scale(1.05);
  }
}

.t-dark__title {
  font-size: 19px;
  font-weight: 700;
  color: var(--text-heading);
  text-align: center;
  margin: 0 0 6px;
  letter-spacing: 2px;
}
.t-dark__sub {
  font-size: 11px;
  color: rgba(110, 150, 255, 0.45);
  text-align: center;
  margin: 0 0 20px;
  letter-spacing: 3px;
}

/* 状态条 */
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 8px;
  padding: 7px 12px;
  margin-bottom: 20px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.6);
  animation: dot-blink 2s ease-in-out infinite;
}
@keyframes dot-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
.status-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  flex: 1;
}
.status-value {
  font-size: 12px;
  color: #10b981;
  font-weight: 600;
}

/* ========== 内联表单样式 ========== */
.dark-form {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.df-field {
  margin-bottom: 16px;
}

.df-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: rgba(110, 150, 255, 0.6);
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.df-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.df-input-icon {
  position: absolute;
  left: 14px;
  font-size: 16px;
  color: rgba(107, 134, 255, 0.5);
  pointer-events: none;
}

.df-input {
  width: 100%;
  height: 44px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  padding: 0 14px 0 42px;
  font-size: 14px;
  color: var(--text-heading);
  outline: none;
  transition:
    border-color var(--duration-fast),
    background var(--duration-fast),
    box-shadow var(--duration-fast);

  &::placeholder {
    color: var(--text-faint);
  }

  &:focus {
    border-color: var(--brand);
    background: var(--bg-surface);
    box-shadow: 0 0 0 3px var(--bg-brand-soft);
  }
}

.df-input--pwd {
  padding-right: 44px;
}

.df-toggle {
  position: absolute;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: 16px;
  background: none;
  border: none;
  cursor: pointer;
  color: rgba(107, 134, 255, 0.45);
  border-radius: 6px;
  transition: color 0.2s;
  &:hover {
    color: rgba(107, 134, 255, 0.8);
  }
}

.df-error {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #f87171;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.2);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 16px;
  animation: shake 0.4s ease;

  .df-error-icon {
    font-size: 14px;
    flex: none;
  }
}
@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20%,
  60% {
    transform: translateX(-4px);
  }
  40%,
  80% {
    transform: translateX(4px);
  }
}

/* 登录按钮 */
.df-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 44px;
  margin-top: 8px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 1px;
  position: relative;
  overflow: hidden;
  color: #0f131b;
  background: var(--brand);
  transition:
    transform var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast),
    opacity var(--duration-fast);
  box-shadow: none;

  .df-btn-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      105deg,
      transparent 30%,
      rgba(255, 255, 255, 0.18) 50%,
      transparent 70%
    );
    transform: translateX(-100%);
    pointer-events: none;
  }

  .df-btn-arrow {
    display: flex;
    align-items: center;
    font-size: 17px;
    opacity: 0;
    transform: translateX(-6px);
    transition:
      opacity 0.25s,
      transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .df-btn-text {
    transition: letter-spacing 0.25s;
    position: relative;
    z-index: 1;
  }

  .df-btn-spinner {
    display: flex;
    align-items: center;
    svg {
      width: 18px;
      height: 18px;
      animation: spin 0.75s linear infinite;
    }
  }

  &:hover:not(:disabled) {
    background: var(--brand-strong);
    transform: translateY(-1px);

    .df-btn-arrow {
      opacity: 1;
      transform: translateX(0);
    }
  }

  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 3px;
  }
  &:active:not(:disabled) {
    transform: translateY(0);
  }
  &:disabled {
    opacity: 0.38;
    cursor: not-allowed;
    transform: none;
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 侧边装饰线 */
.side-lines {
  display: flex;
  flex-direction: column;
  gap: 14px;
  &--left {
    align-items: flex-end;
  }
  &--right {
    align-items: flex-start;
  }
}
.side-line {
  display: block;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(107, 134, 255, 0.55),
    transparent
  );
  animation: line-flash 2.5s ease-in-out infinite;
}
@keyframes line-flash {
  0%,
  100% {
    opacity: 0.2;
  }
  50% {
    opacity: 0.9;
  }
}

/* 默认账号提示 */
.df-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 12px;
  font-size: 11px;
  color: rgba(107, 134, 255, 0.4);

  .df-hint-icon {
    font-size: 12px;
    flex: none;
  }
}

/* 全局底部版权 */
.dark-page-footer {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 12px;
  font-size: 11px;
  color: rgba(107, 134, 255, 0.28);
  z-index: 10;
  .footer-dot {
    color: rgba(107, 134, 255, 0.18);
  }
}

@media (max-width: 768px) {
  .side-lines {
    display: none;
  }
  .t-dark__card {
    width: 90%;
    max-width: 380px;
    padding: 36px 26px;
  }
}
</style>
