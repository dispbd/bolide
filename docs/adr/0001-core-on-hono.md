# ADR 0001: HTTP core on Hono; build only what sets the framework apart

Status: accepted (phase 0). Date: 2026-10-23.

## Context

We need to decide whether to write our own HTTP core or build on an existing one. Requirements: Web standards (`Request`/`Response`), running on Node, Bun, Deno and the edge, minimal dependencies, and types.

## Decision

1. **HTTP layer: Hono.** Zero dependencies, Web standards, every runtime. In the prototype the server plus our code is 8.3 KB gzipped. Our own core would give the same features at the cost of months of work.
2. **Ours: modules, DI, mutators, config, CLI.** This is what sets the framework apart from Hono, and it is the scope of phase 1. Hono stays behind our own API (`defineModule`, `defineRoute`) so it can be replaced if needed.
3. **Sync in phase 3: Electric + TanStack DB behind our own transport interface.** The interface is the one already in the prototype: apply operations locally, send them, wait for confirmation by txid. This keeps the door open to Zero or our own engine (phase 4).
4. **Validation through Standard Schema, with a light library by default** (`zod/mini` or Valibot). Full `zod` adds about 90 KB gzipped to the client.

## Consequences

- Phase 1 starts with the module system and DI, not with the router.
- The Hono dependency must stay behind an adapter so it does not leak into user code.
- TanStack DB is still 0.x, so updates may break things; versions are pinned.
