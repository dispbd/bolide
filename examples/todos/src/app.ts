import { createApp, defineModule, type AppOptions } from '@bolide/core'
import { dataModule, postgresSync, replicationSync, type ListeningSqlClient, type SyncSource } from '@bolide/data/server'
import { ServerConfig } from './config.ts'
import { lists, members, mutators, myLists, myTodos, todos } from './shared/schema.ts'
import { UserId } from './user.ts'
import { WebModule } from './web.ts'

export interface TodosOptions {
  /** A postgres.js client. */
  sql: ListeningSqlClient
  /**
   * The database URL, for logical replication (`replicationSync`). Without it, or when Postgres doesn't have
   * `wal_level=logical`, shapes come from a trigger and a change log (`postgresSync`), which suits development.
   */
  url?: string
}

/** Builds the app; tests pass their own database and env. */
export function buildApp({ sql, url }: TodosOptions, options: Partial<AppOptions> = {}) {
  const AppModule = defineModule({
    name: 'app',
    imports: [
      defineModule({ name: 'user', global: true, providers: [UserId], exports: [UserId] }),
      dataModule({ sql, tables: [lists, members, todos], mutators, shapes: [myLists, myTodos], sync: pickSync(sql, url), userId: UserId }),
      WebModule,
    ],
    providers: [ServerConfig],
  })
  return createApp({ modules: [AppModule], ...options })
}

/** Logical replication when Postgres has it, else the trigger-based source; decided at boot. */
function pickSync(sql: ListeningSqlClient, url: string | undefined): SyncSource {
  let source: SyncSource | undefined
  return {
    subqueries: true,
    async start(tables) {
      const [{ wal_level }] = (await sql.unsafe('show wal_level')) as [{ wal_level: string }]
      source = url && wal_level === 'logical' ? replicationSync(sql, { url }) : postgresSync(sql)
      await source.start?.(tables)
    },
    fetchShape: (request) => source!.fetchShape(request),
    close: async () => source?.close?.(),
  }
}
