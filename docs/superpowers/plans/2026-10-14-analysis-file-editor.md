# Analysis File Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a selected analysis Markdown file in the existing editor and safely save edits back to that file.

**Architecture:** Keep the existing disk-backed content API and database metadata. Track the active file in `RequirementAnalysisPanel`, serialize saves before file changes, and remount the editor between files to isolate undo state.

**Tech Stack:** Vue 3, TypeScript, Element Plus, Tiptap, marked, Playwright, Fastify, SQLite.

---

### Task 1: Add browser regression coverage

**Files:**
- Create: `tests/e2e/analysis-files.spec.ts`

- [x] Create a requirement through the real API, load its default analysis file, and upload Markdown and plain-text attachments. Open the requirement's “需求进展” tab.
- [x] Assert that a Markdown filename is a button and opens its rendered content without sending a content write. Verify the filename uses the actual extension even after changing the display name.

```typescript
const fileButton = page.getByRole("button", { name: markdownFile.name, exact: true });
await expect(fileButton).toBeVisible();
await fileButton.click();
await expect(page.locator(".md-panel .rich-document")).toContainText("文件内的分析方案");
await expect(fileButton).toHaveAttribute("aria-pressed", "true");
```

- [x] Test editing the selected file, switching before the debounce expires, and checking both files through the content API.
- [x] Use Playwright routes to hold a save request and to return save/read failures. Assert that no next-file read occurs before the save completes and that failures retain the current content.
- [x] Cover renaming and deleting the active attachment plus preservation of non-Markdown preview links.
- [x] Run `npm run test:e2e -- tests/e2e/analysis-files.spec.ts --grep "opens Markdown"`; expect failure because the filename is not a button yet.
- [x] Add failing cases for leaving the stage during an in-flight save, failed navigation saves, late image uploads, and failed post-delete list refreshes; confirm all four fail before fixing them.

### Task 2: Implement active-file editing

**Files:**
- Modify: `apps/web/src/features/requirements/RequirementAnalysisPanel.vue`
- Modify: `apps/web/src/features/requirements/InlineRichTextEditor.vue`
- Modify: `apps/web/src/pages/RequirementDetailPage.vue`

- [x] Replace the fixed file ID with a `RequirementFile` ref; derive the save target from that file, never from a later-changing requirement prop.

```typescript
const recordFile = ref<RequirementFile>();
const opening = ref(false);
const isMarkdown = (file: RequirementFile) => /\.(md|markdown)$/i.test(file.fileName);
```

- [x] Let `loadEditor` accept the selected file. Wait for pending image uploads and saves before reading it and before replacing the source content; retain current data on any failure and ignore results after unmount.
- [x] Return a success boolean from a shared save promise. Repeatedly save the latest HTML until it matches `savedHtml`; stop on failure and keep the unsaved draft.
- [x] Clear debounce timers on save, file deletion and unmount. Expose `flush`, await it in stage changes and router guards, and reuse the save promise on unmount.
- [x] Add filename buttons, pressed/selected states, current filename, and a loading/inert state. Preserve existing preview links and style conventions.
- [x] Key the inline editor by selected file ID and the analysis panel by requirement ID.

```vue
<RequirementAnalysisPanel
  v-if="viewingStage === 'analysis'"
  :key="item.id"
  :requirement-id="item.id"
/>
```

- [x] Update selected metadata on rename/confirmation without reloading its body. When deleting it, wait for pending uploads/writes, remove it, then open the default record; retain fallback intent if the list refresh fails.
- [x] Run `npm run test:e2e -- tests/e2e/analysis-files.spec.ts`; all 11 new browser tests pass.

### Task 3: Verify and document

**Files:**
- Modify: `README.md`

- [x] Document the disk-backed source, clickable Markdown files and unchanged rich-text serialization.
- [x] Run `npm test`, `npm run typecheck`, and targeted browser tests. The older stage-workspace browser cases remain outside this targeted run and are unchanged.
- [x] Check formatting only for changed code files and run `git diff --check`.
- [x] Report the behavior and storage split without claiming a new Markdown serializer or changes to placeholder stages. Do not create branches or commits.

## Verification results

- `npm test`: 17 tests pass.
- `npm run typecheck`: all workspaces pass.
- `npm run test:e2e -- tests/e2e/analysis-files.spec.ts`: frontend build succeeds and 11 browser tests pass.
- Targeted Prettier check and `git diff --check`: pass.
- The initial sandboxed browser run reached the expected failing assertion but timed out during teardown; subsequent browser runs completed outside the sandbox.
