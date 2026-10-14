# open-ancestry: Implementation Plan

Spec: [design.md](design.md). Design system: [../design-system.md](../design-system.md).

Work is split into waves. Features within a wave are independent and are built in parallel, each in its own worktree and PR. A wave starts when the PRs it depends on have merged.

```
Wave 0  F1 foundation (scaffold, CI, coverage, fixtures generator)
          |
Wave 1  F2 db schema      F3 dates/names      F4 gedcom parser      F8 design system + shell
          |                  |                   |                     |
Wave 2  F5 import + Ancestry adapter (F2,F3,F4)   F6 server/API (F2)   layout engine in core (F3)
          |                                         |                    |
Wave 3  F7 search (F2,F6)   F9 family tree view (F6,F8,layout)   F11 person page (F6,F8)   import UI (F5,F6,F8)
          |
Wave 4  F10 other views   F12 editing   F13 relationship calc   F14 export   media + gallery
          |
Wave 5  F15 stretch: tags/list/checker/merge/re-import
          |
Wave 6  QA pass, adversarial review, security review, perf audit -> issues -> fixes
```

## Per-feature loop

1. Issue exists with acceptance criteria checklist (from design.md section 5).
2. Implementer: create worktree `~/repositories/worktrees/open-ancestry-<slug>` on branch `feat/<slug>`.
3. Write failing tests first. E2E for anything user-visible, unit for logic. Commit tests.
4. Implement in small commits until green. Run `npm run lint typecheck test e2e`.
5. Open PR `Closes #N`, with acceptance criteria mapped to tests, coverage delta, perf numbers if relevant, and an "AI Use" section.
6. Reviewer agent posts a review (correctness, AC coverage, tests, perf, security, design-system adherence).
7. Implementer addresses every comment (fix or reasoned reply), pushes.
8. Orchestrator squash-merges when CI is green and review is resolved; deletes branch and worktree.

## Definition of done (every PR)

- All acceptance criteria in the issue have a test that would fail without the change.
- CI green: lint, typecheck, unit, e2e (Chromium + WebKit), coverage thresholds, bench budgets where applicable.
- No real genealogy data committed; fixtures are synthetic.
- Docs updated (`docs/data-model.md` for schema changes, design system doc for new components).
