# Native Markdown Storage Implementation Plan

> **For agentic workers:** Execute the following focused tasks in the current workspace. Do not commit or modify user data.

**Goal:** Persist requirement documents as native Markdown while keeping the existing WYSIWYG editor, so files on disk stay readable and diff-friendly.

**Architecture:** Keep the disk-backed content API and the Tiptap editor. Convert in the browser: Markdown → editor HTML on load, editor HTML → Markdown on save. Image references stay relative to the document directory and are swapped to a preview URL only inside the editor.

**Tech Stack:** Vue 3, Tiptap 3, turndown + turndown-plugin-gfm, marked, Element Plus, Fastify, Playwright, vitest.

## Decision

A CodeMirror source editor was considered and explicitly rejected by the user: the editor stays WYSIWYG and the conversion happens on read/save. Structural loss (loose lists collapse to tight, underline stays inline HTML) is accepted.

## Tasks

- [x] Add `apps/web/src/features/requirements/doc-markdown.ts`: `markdownToHtml`, `htmlToMarkdown`, `documentToEditorHtml`, `isLegacyHtmlContent`, plus `apps/web/src/types/turndown-plugin-gfm.d.ts` for typings.
- [x] Use a custom `Marked` instance so task lists render the Tiptap DOM shape (`<ul data-type="taskList"><li data-type="taskItem" data-checked>`), and custom turndown rules for list indentation, ordered-list `start`, task items, tables (Tiptap emits `colgroup`), strikethrough and underline.
- [x] Keep image path conversion in `doc-images.ts`; convert display URLs back to relative paths before serialization.
- [x] Switch `DocTabEditor.vue` to Markdown storage.
- [x] Switch the issue body in `RequirementIssuesPanel.vue` to Markdown storage.
- [x] Register the Tiptap table extensions so Markdown tables survive an edit round-trip.
- [x] Rewrite image references inside descendant documents when a folder is renamed or moved.
- [x] Add `apps/web/tests/doc-markdown.test.ts` and include `apps/web/tests` in the vitest workspace config.
- [x] Update README and the browser tests that asserted stored HTML.

## Storage contract

```typescript
const stored = htmlToMarkdown(toStoredHtml(html.value, requirementId));
await artifactApi.saveContent(node.id, stored);
```

Only Markdown reaches the content API. Legacy HTML files are displayed as-is and rewritten to Markdown on their first save.

## Verification results

- `npm test`: 113 tests pass (9 files).
- `npm run typecheck`: all workspaces pass.
- `npm run test:e2e`: 34 browser tests pass, including the new Markdown table round-trip case.
- Removed unused CodeMirror dependencies from `apps/web`.
