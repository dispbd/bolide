import { createHash, randomBytes } from 'node:crypto'
import {
  bind,
  BolideError,
  CurrentRequest,
  defineGuard,
  defineMiddleware,
  defineModule,
  defineService,
  HttpError,
  toMs,
  type Duration,
  type Module,
  type Service,
} from '@bolide/core'
import { SessionStore } from './store.ts'

export type SessionData = Record<string, unknown>

/** The current request's session. Inject `CurrentSession` (request-scoped). */
export interface Session {
  /** The signed-in user, or undefined. */
  readonly userId: string | undefined
  /** Extra values kept with the session (JSON). */
  readonly data: Readonly<SessionData>
  /** Signs `userId` in. Always issues a new token, so a token planted before login is useless. */
  login(userId: string, data?: SessionData): Promise<void>
  /** Ends the session and clears the cookie. */
  logout(): Promise<void>
  /** Changes one value of `data`. Needs a signed-in session. */
  set(key: string, value: unknown): Promise<void>
}

export interface CookieOptions {
  /** Default `sid`. */
  name?: string
  /** Default true. Browsers accept Secure cookies on http://localhost too. */
  secure?: boolean
  /** Default `Lax`, which keeps the cookie off cross-site POSTs (CSRF). */
  sameSite?: 'Lax' | 'Strict' | 'None'
  domain?: string
  /** Default `/`. */
  path?: string
}

export interface AuthSettings {
  cookie: Required<Omit<CookieOptions, 'domain'>> & { domain?: string }
  /** Session lifetime in ms. Sessions in use are extended once half of it has passed. */
  ttl: number
  /**
   * Origins allowed to send unsafe requests (POST, PUT, PATCH, DELETE) with a session cookie,
   * besides the app's own. Requests whose `Origin` is elsewhere get 403.
   */
  trustedOrigins: readonly string[]
}

const defaults: AuthSettings = { cookie: { name: 'sid', secure: true, sameSite: 'Lax', path: '/' }, ttl: toMs('30d'), trustedOrigins: [] }

/** Session settings. `authModule()` sets them. */
export const AuthSettings = defineService<AuthSettings>({ name: 'AuthSettings', factory: () => defaults })

interface Stored {
  userId: string
  data: SessionData
  expiresAt: number
}

/** Per-request bookkeeping shared by the `Sessions` middleware and `CurrentSession`. */
class SessionState {
  middleware = false
  /** The Set-Cookie header to send, if the session changed. */
  cookie: string | undefined
}

const State = defineService({ name: 'SessionState', scope: 'request', factory: () => new SessionState() })

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url')

function readCookie(header: string | null, name: string) {
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

function cookieHeader(s: AuthSettings, value: string, maxAge: number) {
  const c = s.cookie
  return [
    `${c.name}=${value}`,
    `Path=${c.path}`,
    `Max-Age=${Math.floor(maxAge / 1000)}`,
    'HttpOnly',
    `SameSite=${c.sameSite}`,
    ...(c.secure ? ['Secure'] : []),
    ...(c.domain ? [`Domain=${c.domain}`] : []),
  ].join('; ')
}

/** The current request's session, loaded from the cookie on first use. */
export const CurrentSession = defineService({
  name: 'CurrentSession',
  scope: 'request',
  inject: { request: CurrentRequest, store: SessionStore, settings: AuthSettings, state: State },
  factory: async ({ request, store, settings, state }): Promise<Session> => {
    if (!state.middleware) {
      throw new BolideError('CurrentSession needs the Sessions middleware: createApp({ use: [Sessions], modules: [authModule(), ...] }).')
    }
    const token = readCookie(request.headers.get('cookie'), settings.cookie.name)
    let key = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashToken(token) : undefined
    let stored: Stored | undefined
    if (key) {
      const text = await store.get(key)
      stored = text ? (JSON.parse(text) as Stored) : undefined
      if (stored && stored.expiresAt <= Date.now()) stored = undefined
    }
    // The browser sent a token we don't know (expired or logged out elsewhere): drop the cookie.
    if (token && !stored) state.cookie = cookieHeader(settings, '', 0)
    if (stored && key && stored.expiresAt - Date.now() < settings.ttl / 2) {
      // Rolling expiry: active users stay signed in.
      stored = { ...stored, expiresAt: Date.now() + settings.ttl }
      await store.set(key, JSON.stringify(stored), settings.ttl)
      state.cookie = cookieHeader(settings, token!, settings.ttl)
    }

    const save = async () => {
      await store.set(key!, JSON.stringify(stored), stored!.expiresAt - Date.now())
    }
    return {
      get userId() {
        return stored?.userId
      },
      get data() {
        return stored?.data ?? {}
      },
      async login(userId, data = {}) {
        if (typeof userId !== 'string' || !userId) throw new BolideError('login() needs a non-empty user id string.')
        if (key) await store.delete(key)
        const fresh = randomBytes(32).toString('base64url')
        key = hashToken(fresh)
        stored = { userId, data, expiresAt: Date.now() + settings.ttl }
        await save()
        state.cookie = cookieHeader(settings, fresh, settings.ttl)
      },
      async logout() {
        if (key) await store.delete(key)
        key = undefined
        stored = undefined
        state.cookie = cookieHeader(settings, '', 0)
      },
      async set(k, value) {
        if (!stored) throw new HttpError(401, 'not signed in')
        stored = { ...stored, data: { ...stored.data, [k]: value } }
        await save()
      },
    }
  },
})

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Hosts, not origins: behind a TLS-terminating proxy the app sees http:// while the browser says https://. */
function sameHost(origin: string, url: string) {
  try {
    return new URL(origin).host === new URL(url).host
  } catch {
    // `Origin: null` (sandboxed frames, some redirects) or garbage.
    return false
  }
}

/**
 * Loads sessions and writes their cookie. Add it app-wide: `createApp({ use: [Sessions] })`.
 * It also rejects unsafe requests from other origins (CSRF), unless they are in `trustedOrigins`.
 */
export const Sessions = defineMiddleware({
  name: 'Sessions',
  inject: { state: State, settings: AuthSettings },
  handle: async ({ request }, next, { state, settings }) => {
    state.middleware = true
    const origin = request.headers.get('origin')
    if (unsafeMethods.has(request.method)) {
      // Without Origin, a browser's Sec-Fetch-Site still tells a cross-site request apart.
      const crossSite = origin ? !sameHost(origin, request.url) && !settings.trustedOrigins.includes(origin) : request.headers.get('sec-fetch-site') === 'cross-site'
      if (crossSite) throw new HttpError(403, `cross-origin ${request.method} from ${origin ?? 'another site'} is not allowed`, undefined, 'cross_origin')
    }
    let res = await next()
    if (state.cookie) {
      try {
        res.headers.append('set-cookie', state.cookie)
      } catch {
        // Immutable headers (a fetch() or Response.redirect() result): copy, unless it can't be copied.
        if (res.status >= 200 && !res.bodyUsed) {
          res = new Response(res.body, res)
          res.headers.append('set-cookie', state.cookie)
        }
      }
      // Never let a shared cache keep a response that carries a session.
      if (!res.headers.has('cache-control')) {
        try {
          res.headers.set('cache-control', 'no-store')
        } catch {}
      }
    }
    return res
  },
})

/** Lets signed-in users through; others get 401. */
export const authenticated = defineGuard({
  name: 'authenticated',
  inject: { session: CurrentSession },
  check: (_ctx, { session }) => {
    if (session.userId === undefined) throw new HttpError(401, 'sign in first')
    return true
  },
})

export interface AuthModuleOptions {
  /** A store, or a service that builds one. Default: `memorySessionStore()`. */
  store?: SessionStore | Service<SessionStore, any>
  cookie?: CookieOptions
  /** Default 30d. */
  ttl?: Duration
  trustedOrigins?: readonly string[]
  /** Modules whose exports a `store` service needs. */
  imports?: readonly Module[]
}

/**
 * A global module for sessions: provides `CurrentSession`, `SessionStore` and `AuthSettings`.
 * Also add the `Sessions` middleware to the app.
 */
export function authModule(options: AuthModuleOptions = {}): Module {
  const ttl = toMs(options.ttl ?? '30d', 'authModule ttl')
  if (ttl < 60_000) throw new BolideError(`authModule ttl must be at least a minute, got ${ttl}ms.`)
  const cookie = { ...defaults.cookie, ...options.cookie }
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)) throw new BolideError(`cookie name "${cookie.name}" is not a valid cookie name.`)
  if (cookie.sameSite === 'None' && !cookie.secure) throw new BolideError('cookie.sameSite "None" requires cookie.secure: browsers drop such cookies otherwise.')
  for (const o of options.trustedOrigins ?? []) {
    if (o !== new URL(o).origin) throw new BolideError(`trustedOrigins takes origins like "https://app.example.com", got "${o}".`)
  }
  const settings: AuthSettings = { cookie, ttl, trustedOrigins: options.trustedOrigins ?? [] }
  const store = options.store
  const storeProvider =
    store === undefined
      ? SessionStore
      : bind(SessionStore, typeof store === 'object' && (store as { kind?: unknown }).kind === 'service' ? { useService: store as Service<SessionStore, any> } : { useValue: store as SessionStore })
  return defineModule({
    name: 'auth',
    global: true,
    imports: options.imports,
    providers: [storeProvider, bind(AuthSettings, { useValue: settings }), State, CurrentSession],
    exports: [CurrentSession, SessionStore, AuthSettings, State],
  })
}
