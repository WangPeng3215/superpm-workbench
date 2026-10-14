# Native Markdown Editor Implementation Plan

> **For agentic workers:** Execute the following focused tasks in the current workspace. Do not commit or modify user data.

**Goal:** Replace the analysis rich-text editor with a real Markdown source editor and make newly uploaded Markdown files reliably visible and openable.

**Architecture:** Add a reusable `MarkdownEditor.vue` backed by CodeMirror. Keep the disk-backed file API and existing save/navigation coordination, but track raw content instead of rendered HTML. Use marked and DOMPurify only for preview.

**Tech Stack:** Vue 3, CodeMirror 6, marked, DOMPurify, Element Plus, Playwright.

## Tasks

- [ ] Add `tests/e2e/markdown-editor.spec.ts`: real file-input upload, full information-area clicks, source roundtrip, syntax tools, safe preview and legacy HTML preservation. Observe upload/row-click failures before fixing.
- [ ] Install CodeMirror core, state, view, commands and Markdown language support in `apps/web`.
- [ ] Add `apps/web/src/features/requirements/MarkdownEditor.vue` with source/split/preview modes, local image upload, `update:modelValue` and `waitForUpload`.
- [ ] Update `RequirementAnalysisPanel.vue` to read/write raw content, open uploaded drafts, and enlarge the file-open target without changing destructive actions.
- [ ] Adapt `tests/e2e/analysis-files.spec.ts` to Markdown syntax and retain all concurrency checks.
- [ ] Update README and mark the earlier rich-text design superseded for analysis files.
- [ ] Run `npm run test:e2e -- tests/e2e/analysis-files.spec.ts tests/e2e/markdown-editor.spec.ts`, `npm run typecheck`, `npm test`, and targeted formatting/diff checks.

## Storage contract

```typescript
const recordContent = ref("");
const savedContent = ref("");
recordContent.value = result.content;
savedContent.value = result.content;
```

The content PUT sends `recordContent` unchanged; preview HTML never enters the persistence path. Legacy HTML remains untouched unless the user edits it.
