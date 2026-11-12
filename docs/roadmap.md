# Roadmap

Estimates assume one developer working evenings.

| Phase | Estimate | Goal |
|---|---|---|
| 0. Research and spikes | 2–3 weeks | Prototype an isomorphic mutator on Hono + TanStack DB + Electric. Measure latency and bundle size. Decide whether to write our own core or build on Hono. |
| 1. Core | 1–2 months | Router on Web standards, `defineModule`, DI with type inference, lifecycle, config, validation through Standard Schema, OpenAPI, CLI `create`/`dev`. |
| 2. Batteries | 1–2 months | Auth, cache, queues and cron, mail, files, i18n, logging and tracing. |
| 3. Data layer and optimistic UI | 2–3 months | Shared schema and mutator format, typed client, Electric/Zero adapters, mutation queue with rollback, React and Vue adapters. |
| 4. Own sync engine (optional) | 2–4 months | Own CDC transport for Postgres, read permissions for live queries, offline mode. |
| 5. Ecosystem | ongoing | Docs, starters, Svelte/Solid adapters, Vite plugin, deployment recipes. |
