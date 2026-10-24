<template>
  <div class="t-classic">
    <!-- 背景光斑 -->
    <div class="t-classic__bg" aria-hidden="true">
      <span class="blob blob--1" />
      <span class="blob blob--2" />
      <span class="blob blob--3" />
      <span class="grid" />
    </div>

    <!-- 主卡片 -->
    <div class="t-classic__card">
      <!-- 左侧品牌区 -->
      <div class="t-classic__brand">
        <div class="brand-rings" aria-hidden="true">
          <span
            v-for="i in 5"
            :key="i"
            class="brand-ring"
            :class="`brand-ring--${i}`"
          />
        </div>
        <div class="brand-body">
          <div class="brand-logo">
            <img :src="logoUrl" alt="superPM" />
          </div>
          <h1 class="brand-title">superPM</h1>
          <p class="brand-desc">本地优先的需求管理工作台</p>
          <ul class="brand-features">
            <li v-for="f in features" :key="f">
              <CheckCircleFilled
                class="brand-feature-icon"
                aria-hidden="true"
              />
              {{ f }}
            </li>
          </ul>
        </div>
        <div class="brand-footer">
          <span>© 2026 superPM workbench</span>
          <span>v{{ appVersion }}</span>
        </div>
      </div>

      <!-- 右侧表单区 -->
      <div class="t-classic__form-area">
        <div class="form-header">
          <h2 class="form-title">欢迎回来</h2>
          <p class="form-sub">请登录您的账号以继续使用</p>
        </div>

        <!-- ========== 登录表单（内联） ========== -->
        <form class="classic-form" @submit.prevent="handleSubmit">
          <div class="cf-field">
            <label class="cf-label" for="classic-username">账号</label>
            <div class="cf-input-wrap">
              <UserOutlined class="cf-input-icon" aria-hidden="true" />
              <input
                id="classic-username"
                v-model="form.username"
                type="text"
                class="cf-input"
                placeholder="请输入账号"
                autocomplete="username"
              />
            </div>
          </div>

          <div class="cf-field">
            <label class="cf-label" for="classic-password">密码</label>
            <div class="cf-input-wrap">
              <LockOutlined class="cf-input-icon" aria-hidden="true" />
              <input
                id="classic-password"
                v-model="form.password"
                :type="showPwd ? 'text' : 'password'"
                class="cf-input cf-input--pwd"
                placeholder="请输入密码"
                autocomplete="current-password"
              />
              <button
                type="button"
                class="cf-toggle"
                :aria-label="showPwd ? '隐藏密码' : '显示密码'"
                :title="showPwd ? '隐藏密码' : '显示密码'"
                @click="showPwd = !showPwd"
              >
                <EyeInvisibleOutlined v-if="showPwd" aria-hidden="true" />
                <EyeOutlined v-else aria-hidden="true" />
              </button>
            </div>
          </div>

          <div v-if="error" class="cf-error">
            <ExclamationCircleFilled class="cf-error-icon" aria-hidden="true" />
            {{ error }}
          </div>

          <button
            type="submit"
            class="cf-btn"
            :disabled="loading || !form.username || !form.password"
          >
            <span class="cf-btn-shimmer" />
            <span v-if="loading" class="cf-btn-spinner">
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
              <span class="cf-btn-text">立即登录</span>
              <span class="cf-btn-arrow">
                <ArrowRightOutlined aria-hidden="true" />
              </span>
            </template>
            <span v-if="loading" class="cf-btn-text">验证中...</span>
          </button>

          <!-- 默认账号提示 -->
          <div class="cf-hint">
            <InfoCircleOutlined class="cf-hint-icon" aria-hidden="true" />
            默认账号：admin · 密码：admin123（首次登录后请修改）
          </div>
        </form>
      </div>
    </div>

    <!-- 全局底部版权 -->
    <footer class="classic-page-footer">
      <span>© 2026 superPM workbench</span>
      <span class="footer-dot">·</span>
      <span>数据保存在这台电脑</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import {
  ArrowRightOutlined,
  CheckCircleFilled,
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

const features = [
  "需求全生命周期管理",
  "阶段工作区与产物沉淀",
  "问题、决策与跟进闭环",
];
const showPwd = ref(false);
const form = reactive({ username: "", password: "" });

function handleSubmit() {
  if (form.username && form.password) {
    emit("submit", { username: form.username, password: form.password });
  }
}
</script>

<style scoped lang="scss">
.t-classic {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg-page);
  padding: 52px 20px 0;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
  font-family: var(--font-sans);
}

/* 背景 */
.t-classic__bg {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}

.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.6;

  &--1 {
    width: 600px;
    height: 600px;
    background: rgba(79, 110, 247, 0.14);
    top: -200px;
    right: -100px;
    animation: fa 20s ease-in-out infinite;
  }
  &--2 {
    width: 400px;
    height: 400px;
    background: rgba(124, 58, 237, 0.1);
    bottom: -150px;
    left: -100px;
    animation: fb 25s ease-in-out infinite;
  }
  &--3 {
    width: 300px;
    height: 300px;
    background: rgba(56, 189, 248, 0.08);
    top: 50%;
    left: 40%;
    animation: fc 18s ease-in-out infinite;
  }
}

@keyframes fa {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(-40px, 30px);
  }
}
@keyframes fb {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(30px, -40px);
  }
}
@keyframes fc {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.2);
  }
}

.grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(79, 110, 247, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(79, 110, 247, 0.03) 1px, transparent 1px);
  background-size: 60px 60px;
}

/* 主卡片 */
.t-classic__card {
  display: flex;
  flex-shrink: 0;
  width: 100%;
  max-width: 920px;
  min-height: 540px;
  margin: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-base);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 20px 50px -24px rgb(31 35 41 / 0.22);
  position: relative;
  z-index: 1;
  animation: rise 0.35s var(--ease-standard);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(28px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 左侧品牌 */
.t-classic__brand {
  width: 380px;
  flex-shrink: 0;
  background: linear-gradient(
    155deg,
    var(--brand) 0%,
    var(--brand-strong) 100%
  );
  display: flex;
  flex-direction: column;
  padding: 48px 36px 32px;
  position: relative;
  overflow: hidden;
}

.brand-rings {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.brand-ring {
  position: absolute;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.07);
  &--1 {
    width: 300px;
    height: 300px;
    top: -70px;
    right: -70px;
  }
  &--2 {
    width: 200px;
    height: 200px;
    top: -10px;
    right: -10px;
    border-color: rgba(255, 255, 255, 0.04);
  }
  &--3 {
    width: 160px;
    height: 160px;
    bottom: 80px;
    left: -40px;
  }
  &--4 {
    width: 90px;
    height: 90px;
    bottom: 120px;
    left: 0;
    border-color: rgba(255, 255, 255, 0.04);
  }
  &--5 {
    width: 70px;
    height: 70px;
    top: 55%;
    right: 20%;
    background: rgba(255, 255, 255, 0.04);
    border: none;
  }
}

.brand-body {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.brand-logo {
  width: 60px;
  height: 60px;
  margin-bottom: 24px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  img {
    width: 44px;
    height: 44px;
    object-fit: contain;
  }
}

.brand-title {
  font-size: 28px;
  font-weight: 800;
  color: #fff;
  letter-spacing: 2px;
  margin: 0 0 10px;
}
.brand-desc {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  margin: 0 0 28px;
  line-height: 1.7;
}

.brand-features {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.85);
    .brand-feature-icon {
      color: rgba(255, 255, 255, 0.6);
      font-size: 15px;
      flex-shrink: 0;
    }
  }
}

.brand-footer {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  margin-top: auto;
}

/* 右侧表单 */
.t-classic__form-area {
  flex: 1;
  padding: 52px 48px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.form-header {
  margin-bottom: 32px;
}
.form-title {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0 0 7px;
}
.form-sub {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
}

/* ========== 内联表单样式 ========== */
.classic-form {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.cf-field {
  margin-bottom: 18px;
}

.cf-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 8px;
}

.cf-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.cf-input-icon {
  position: absolute;
  left: 14px;
  font-size: 16px;
  color: #9ca3af;
  pointer-events: none;
}

.cf-input {
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
    box-shadow var(--duration-fast),
    background var(--duration-fast);

  &::placeholder {
    color: var(--text-faint);
  }

  &:focus {
    border-color: var(--brand);
    background: var(--bg-surface);
    box-shadow: 0 0 0 3px var(--bg-brand-soft);
  }
}

.cf-input--pwd {
  padding-right: 44px;
}

.cf-toggle {
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
  color: #9ca3af;
  border-radius: 6px;
  transition: color 0.2s;
  &:hover {
    color: #6b7280;
  }
}

.cf-error {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #ef4444;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 16px;
  animation: shake 0.4s ease;

  .cf-error-icon {
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
.cf-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 44px;
  margin-top: 12px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 1px;
  position: relative;
  overflow: hidden;
  color: #fff;
  background: var(--brand);
  transition:
    transform var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast),
    opacity var(--duration-fast);
  box-shadow: none;

  .cf-btn-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      105deg,
      transparent 30%,
      rgba(255, 255, 255, 0.22) 50%,
      transparent 70%
    );
    transform: translateX(-100%);
    pointer-events: none;
  }

  .cf-btn-arrow {
    display: flex;
    align-items: center;
    font-size: 17px;
    opacity: 0;
    transform: translateX(-6px);
    transition:
      opacity 0.25s,
      transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .cf-btn-text {
    transition: letter-spacing 0.25s;
    position: relative;
    z-index: 1;
  }

  .cf-btn-spinner {
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

    .cf-btn-arrow {
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
    opacity: 0.4;
    cursor: not-allowed;
    transform: none;
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 默认账号提示 */
.cf-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 12px;
  font-size: 11px;
  color: #9ca3af;

  .cf-hint-icon {
    font-size: 12px;
    flex: none;
  }
}

/* 全局底部版权 */
.classic-page-footer {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 12px;
  font-size: 11px;
  color: #9ca3af;
  z-index: 10;
  .footer-dot {
    color: #d1d5db;
  }
}

@media (max-width: 768px) {
  .t-classic__brand {
    display: none;
  }
  .t-classic__card {
    max-width: 440px;
    min-height: auto;
  }
  .t-classic__form-area {
    padding: 40px 28px;
  }
}
</style>
