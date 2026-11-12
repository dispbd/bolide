/** Base class for every error Bolide throws on purpose. */
export class BolideError extends Error {
  override name = 'BolideError'
}

/** The module graph or a provider's dependencies are wrong. Thrown at boot, never at request time. */
export class DependencyError extends BolideError {
  override name = 'DependencyError'
}

export interface Issue {
  message: string
  path: string
}

/** Input did not match a schema. Becomes a 400 response when thrown from a route. */
export class ValidationError extends BolideError {
  override name = 'ValidationError'
  constructor(
    readonly where: string,
    readonly issues: Issue[],
  ) {
    super(`invalid ${where}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`)
  }
}

/** Configuration did not match its schema. Thrown at boot. */
export class ConfigError extends BolideError {
  override name = 'ConfigError'
  constructor(
    readonly config: string,
    readonly issues: Issue[],
  ) {
    super(`config "${config}" is invalid:\n${issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n')}`)
  }
}

const codes: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
  500: 'internal_error',
  503: 'service_unavailable',
}

/**
 * Throw from a route handler to send an error status. The client gets
 * `{ error: code, message, details? }`, where `code` defaults to a name for the status.
 */
export class HttpError extends BolideError {
  override name = 'HttpError'
  readonly code: string
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    code?: string,
  ) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`HttpError status must be 400-599, got ${status}. Return a Response for other statuses.`)
    }
    super(message)
    this.code = code ?? codes[status] ?? `http_${status}`
  }
}
