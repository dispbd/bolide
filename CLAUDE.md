# Bolide

An experimental Node.js/TypeScript framework: the structure of Nest.js, the built-in features and optimistic UI of Meteor.js, and the lightness of Total.js. See README.md and docs/roadmap.md.

## Conventions

- Everything in the repository is in English: code, comments, docs, commit messages, PRs.
- Branches: one `phase-N` branch per roadmap phase; heavy sub-tasks of a phase go in `phase-N-<task>` and merge into the phase branch with `--no-ff`. A finished phase is merged into `main` through a pull request.
- Match the surrounding code: small modules, comments only where they explain why, no new dependencies without a reason in the PR.

## Principles (packages/core)

- No mandatory decorators. A definition (`defineService`, `defineModule`, `defineRoute`, `defineConfig`) is a plain object and is its own token.
- Types flow from definitions: injected deps, route input and config are inferred, never declared twice. Avoid `any` in public types.
- Mistakes fail at boot with a message that says how to fix them, not at request time.
- Hono is an implementation detail behind `buildHttp` (docs/adr/0001-core-on-hono.md). User code sees only `Request`, `Response` and Bolide types.
- Validation goes through Standard Schema, so any schema library works.
- Minimal dependencies; keep the core small.

## Commands

```bash
npm ci
npm run typecheck   # tsc, including packages/core/test/types.check.ts
npm test            # builds, then unit tests (node:test via tsx, sources via the bolide-source condition)
npm run build       # tsc -> packages/*/dist (what npm consumers get)
npm run pack:check  # packs the packages, installs them into a fresh `bolide create` project, typechecks and tests it
npm run db:up && npm run test:int   # spike integration tests: Postgres + Electric in Docker
```

Packages export `dist/` to consumers and `src/` under the `bolide-source` condition, which the repo's tsconfig and test scripts enable. Relative imports use `.ts` extensions; the build rewrites them.

Compile-time behavior is tested in `packages/core/test/types.check.ts` with `@ts-expect-error`; add a case there when you change public types.
