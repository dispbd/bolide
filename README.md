# Bolide

An experimental Node.js/TypeScript framework that combines:

- **the structure of Nest.js**: modules, services and dependency injection, built on plain functions with no mandatory decorators;
- **the built-in features of Meteor.js**: auth, data and reactivity, and above all optimistic UI through isomorphic mutators;
- **the lightness of Total.js**: a small core on Web standards, minimal dependencies and a single typed config.

## Branches

| Branch | Contents |
|---|---|
| `main` | Stable state. Each phase is merged here when it is finished. |
| `phase-N` | Work on phase N of the roadmap, one branch per phase. |
| `phase-N-<task>` | Heavy sub-tasks of a phase, merged into the phase branch. They use a dash because git does not allow `phase-N/...` next to a `phase-N` branch. |

## Roadmap

See [docs/roadmap.md](docs/roadmap.md).

## Running the phase 0 prototype

You need Node 22+, Docker and Postgres 16 (binaries in `/usr/lib/postgresql/16/bin`, or set `PGBIN`).

```bash
npm install
npm run db:up        # Postgres :54321 (wal_level=logical) + Electric :3000
npm test             # mutator unit tests
npm run test:int     # two clients through a real Electric instance
npm run bench        # optimistic / confirmation latency
npm run bundle-size  # bundle sizes
npm run db:down
```

Phase 0 results: [docs/phase-0/results.md](docs/phase-0/results.md). Core decision: [docs/adr/0001-core-on-hono.md](docs/adr/0001-core-on-hono.md).
