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

/** Throw from a route handler to send a specific status. */
export class HttpError extends BolideError {
  override name = 'HttpError'
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}
