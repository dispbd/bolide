import { CurrentRequest, defineService } from '@bolide/core'

const COOKIE = 'uid'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Who is asking. To keep the example small, each browser is an anonymous user with a random id in a cookie,
 * set when the page loads. A real app would use sessions from @bolide/auth here; nothing else changes.
 */
export const UserId = defineService({
  name: 'UserId',
  scope: 'request',
  inject: { request: CurrentRequest },
  factory: ({ request }) => userIdFrom(request),
})

export function userIdFrom(request: Request): string | undefined {
  const cookie = request.headers.get('cookie') ?? ''
  const value = /(?:^|;\s*)uid=([^;]*)/.exec(cookie)?.[1]
  return value && uuid.test(value) ? value : undefined
}

/** The Set-Cookie header for a new anonymous user. */
export function newUserCookie(id: string, secure: boolean) {
  return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`
}
