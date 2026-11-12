import { createApp, defineModule, type AppOptions } from '@bolide/core'
import { dataModule, electric, postgresSync, type ListeningSqlClient } from '@bolide/data/server'
import { ServerConfig } from './config.ts'
import { mutators, myTodos, todos } from './shared/schema.ts'
import { UserId } from './user.ts'
import { WebModule } from './web.ts'

export interface TodosOptions {
  /** A postgres.js client. */
  sql: ListeningSqlClient
  /** Electric's URL. Without it, shapes are served from Postgres alone (`postgresSync`), which suits development. */
  electricUrl?: string
}

/** Builds the app; tests pass their own database and env. */
export function buildApp({ sql, electricUrl }: TodosOptions, options: Partial<AppOptions> = {}) {
  const AppModule = defineModule({
    name: 'app',
    imports: [
      defineModule({ name: 'user', global: true, providers: [UserId], exports: [UserId] }),
      dataModule({
        sql,
        tables: [todos],
        mutators,
        shapes: [myTodos],
        sync: electricUrl ? electric({ url: electricUrl }) : postgresSync(sql),
        userId: UserId,
      }),
      WebModule,
    ],
    providers: [ServerConfig],
  })
  return createApp({ modules: [AppModule], ...options })
}
