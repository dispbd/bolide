/** A mistake the user can fix; printed without a stack trace. */
export class CliError extends Error {}

/** Wrong command or arguments; printed with the help text. */
export class UsageError extends CliError {}
