# Contributor guide (humans and agents)

Read first: `docs/spec/design.md` (spec + acceptance criteria), `docs/design-system.md`, `docs/data-model.md`, `docs/spec/plan.md`.

## Ground rules

- **Never commit real family data.** Fixtures are synthetic and live in `fixtures/`. Real exports go in `local-data/` (gitignored). Do not copy names from anyone's real tree into tests, docs, or screenshots.
- **TDD.** Write failing tests from the issue's acceptance criteria first. E2E (Playwright) is the priority for anything user-visible; unit tests (Vitest) for logic.
- **Performance is a requirement.** Respect budgets in design.md section 7. Add a bench when touching a hot path.
- **Design system only.** Use tokens from `apps/web/src/design/tokens.css` and existing components. New components go on the `/design` route.
- **Security.** Treat GEDCOM and uploads as untrusted. No `dangerouslySetInnerHTML`. No runtime third-party network requests.

## Workflow

- One issue per feature, one branch + worktree per issue: `git worktree add ~/repositories/worktrees/open-ancestry-<slug> -b feat/<slug> origin/main`.
- Use `nvm use` (Node 24).
- Commits: atomic, imperative mood, explain why ("Add Ancestry _APID mapping so citations link to records").
- PR title: imperative summary; body: `Closes #N`, AC-to-test mapping, notes, and an `## AI Use` section.
- PRs, issues and review comments written by Claude start with a one-line attribution header noting Claude wrote them.

## Commands

```
npm install
npm run dev          # server + web with HMR
npm run lint
npm run typecheck
npm test             # unit (vitest) with coverage
npm run e2e          # playwright, builds instrumented app
npm run coverage     # merged unit + e2e coverage report
npm run bench        # performance budgets
```
