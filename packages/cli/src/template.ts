export interface TemplateOptions {
  name: string
  /** Dependency spec for @bolide/core and @bolide/cli, e.g. `latest` or `file:../bolide/packages/core`. */
  core: string
  cli: string
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

/** The package.json fields a Bolide project needs; also printed when `--force` keeps an existing one. */
export function packageFields({ core, cli }: Pick<TemplateOptions, 'core' | 'cli'>) {
  return {
    scripts: {
      dev: 'bolide dev',
      start: 'tsx src/main.ts',
      test: 'tsx --test test/*.test.ts',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@bolide/core': core,
      '@hono/node-server': '^2.1.5',
      zod: '^4.6.7',
    },
    devDependencies: {
      '@bolide/cli': cli,
      '@types/node': '^22.20.5',
      tsx: '^4.23.15',
      typescript: '^5.9.0',
    },
  }
}

/** Every file of a new project, by relative path. */
export function template({ name, core, cli }: TemplateOptions): Record<string, string> {
  return {
    'package.json': json({ name, private: true, type: 'module', ...packageFields({ core, cli }) }),

    'tsconfig.json': json({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        lib: ['ES2022', 'DOM'],
        types: ['node'],
      },
      include: ['src', 'test'],
    }),

    '.gitignore': 'node_modules/\ndist/\n.env\n',

    'README.md': `# ${name}

A [Bolide](https://github.com/dispbd/bolide) app.

\`\`\`bash
npm install
npm run dev        # restarts on changes; OpenAPI at http://localhost:3000/openapi.json
npm test
npm run typecheck
\`\`\`

- \`src/app.ts\` lists the modules and builds the app.
- \`src/users/\` is an example module: a service and its routes.
- \`src/config.ts\` reads typed settings from the environment.
`,

    'src/config.ts': `import { defineConfig } from '@bolide/core'
import { z } from 'zod'

/** Typed settings, read from the environment and checked at boot. */
export const ServerConfig = defineConfig({
  name: 'ServerConfig',
  schema: z.object({ port: z.coerce.number().int().default(3000) }),
  load: (env) => ({ port: env.PORT }),
})
`,

    'src/users/users.service.ts': `import { defineService } from '@bolide/core'

export interface User {
  id: string
  name: string
}

/** In-memory store; swap it for a database-backed service later. */
export const Users = defineService({
  name: 'Users',
  factory: () => {
    const rows = new Map<string, User>()
    return {
      list: () => [...rows.values()],
      find: (id: string) => rows.get(id),
      add: (name: string) => {
        const user = { id: crypto.randomUUID(), name }
        rows.set(user.id, user)
        return user
      },
    }
  },
})
`,

    'src/users/users.module.ts': `import { defineModule, defineRoute, HttpError } from '@bolide/core'
import { z } from 'zod'
import { Users } from './users.service.ts'

const User = z.object({ id: z.uuid(), name: z.string() })

const list = defineRoute({
  method: 'GET',
  path: '/',
  summary: 'List users',
  response: z.array(User),
  inject: { users: Users },
  handler: (_ctx, { users }) => users.list(),
})

const get = defineRoute({
  method: 'GET',
  path: '/:id',
  summary: 'Get a user',
  params: z.object({ id: z.uuid() }),
  response: User,
  inject: { users: Users },
  handler: ({ params }, { users }) => {
    const user = users.find(params.id)
    if (!user) throw new HttpError(404, 'user not found')
    return user
  },
})

const create = defineRoute({
  method: 'POST',
  path: '/',
  summary: 'Create a user',
  body: z.object({ name: z.string().min(1) }),
  response: User,
  status: 201,
  inject: { users: Users },
  handler: ({ body }, { users }) => users.add(body.name),
})

export const UsersModule = defineModule({
  name: 'users',
  prefix: '/users',
  providers: [Users],
  exports: [Users],
  routes: [list, get, create],
})
`,

    'src/app.ts': `import { createApp, defineModule, type AppOptions } from '@bolide/core'
import { ServerConfig } from './config.ts'
import { UsersModule } from './users/users.module.ts'

export const AppModule = defineModule({
  name: 'app',
  imports: [UsersModule],
  providers: [ServerConfig],
})

/** Builds the app; tests pass overrides and env. */
export function buildApp(options: Partial<AppOptions> = {}) {
  return createApp({
    modules: [AppModule],
    openapi: { info: { title: '${name}', version: '0.1.0' } },
    ...options,
  })
}
`,

    'src/main.ts': `import { listen } from '@bolide/core/node'
import { buildApp } from './app.ts'
import { ServerConfig } from './config.ts'

const app = await buildApp()
// Logs "listening on …"; LOG_LEVEL and LOG_FORMAT tune the output.
await listen(app, { port: app.get(ServerConfig).port })
`,

    'test/users.test.ts': `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApp } from '../src/app.ts'

test('create and fetch a user', async () => {
  const app = await buildApp({ env: { LOG_LEVEL: 'warn' } })
  try {
    const created = await app.fetch(
      new Request('http://test/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ann' }),
      }),
    )
    assert.equal(created.status, 201)
    const user = await created.json()
    const fetched = await app.fetch(new Request(\`http://test/users/\${user.id}\`))
    assert.deepEqual(await fetched.json(), user)
  } finally {
    await app.close()
  }
})
`,
  }
}
