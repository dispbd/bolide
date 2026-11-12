import { BolideError } from './errors.ts'
import type { RouteInfo } from './http.ts'
import type { StandardSchemaV1 } from './schema.ts'

/** Top-level fields of the document that routes cannot provide. */
export interface OpenApiOptions {
  info: { title: string; version: string; description?: string }
  servers?: { url: string; description?: string }[]
  /**
   * Serve the document at this path from `createApp`. Default `/openapi.json`.
   * It takes precedence over param routes that would also match it.
   */
  path?: string
}

type JsonSchema = Record<string, unknown>
type Converter = { input(o: { target: string }): JsonSchema; output(o: { target: string }): JsonSchema }

/**
 * JSON Schema for a Standard Schema, through the Standard JSON Schema extension
 * (`~standard.jsonSchema`, zod 4.2+, ArkType). Libraries without it give `{}`:
 * the endpoint is still listed, its shape just isn't described.
 */
function toJsonSchema(schema: StandardSchemaV1 | undefined, where: string): JsonSchema | undefined {
  if (!schema) return undefined
  const converter = (schema['~standard'] as { jsonSchema?: Converter }).jsonSchema
  if (!converter) return {}
  // Always the input side: requests are parsed from it, and responses are sent unparsed,
  // so the handler's return value (typed by InferInput) is exactly what goes over the wire.
  try {
    const { $schema: _, ...rest } = converter.input({ target: 'draft-2020-12' })
    return rest
  } catch (e) {
    throw new BolideError(
      `OpenAPI: the ${where} schema can't be expressed as JSON Schema (${(e as Error).message}). ` +
        'Use JSON-representable types (e.g. an ISO string instead of a Date), or leave this route out of openApiDocument.',
    )
  }
}

/** True when the schema accepts a missing value, so the body is optional. Async validators count as required. */
function acceptsUndefined(schema: StandardSchemaV1) {
  const result = schema['~standard'].validate(undefined)
  return !(result instanceof Promise) && !result.issues
}

const errorBody = {
  type: 'object',
  properties: { error: { type: 'string' }, message: { type: 'string' }, details: {} },
  required: ['error', 'message'],
}

const validationBody = {
  type: 'object',
  properties: {
    error: { const: 'validation_failed' },
    message: { type: 'string' },
    where: { type: 'string', enum: ['params', 'query', 'body'] },
    issues: {
      type: 'array',
      items: { type: 'object', properties: { message: { type: 'string' }, path: { type: 'string' } }, required: ['message', 'path'] },
    },
  },
  required: ['error', 'message', 'where', 'issues'],
}

const json = (schema: JsonSchema) => ({ content: { 'application/json': { schema } } })

/** `/users/:id` becomes `/users/{id}`; Hono regex suffixes like `:id{[0-9]+}` are dropped. */
function toOpenApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g, '{$1}')
}

function pathParamNames(path: string) {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!)
}

function operationId(method: string, path: string) {
  const words = path
    .split('/')
    .filter(Boolean)
    .map((part) => (part.startsWith(':') ? `By ${part.slice(1).replace(/\{.*$/, '')}` : part))
    .join(' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  return method.toLowerCase() + words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')
}

/** Parameters from an object schema's properties, or plain strings for unnamed path params. */
function parameters(where: 'path' | 'query', schema: JsonSchema | undefined, names: string[]) {
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set((schema?.required ?? []) as string[])
  const keys = where === 'path' ? names : Object.keys(props)
  return keys.map((name) => ({
    name,
    in: where,
    required: where === 'path' || required.has(name),
    schema: props[name] ?? { type: 'string' },
  }))
}

/** Builds an OpenAPI 3.1 document from the app's routes. */
export function openApiDocument(routes: readonly RouteInfo[], options: OpenApiOptions) {
  const paths: Record<string, Record<string, unknown>> = {}
  const ids = new Map<string, string>()
  for (const { method, path, module, route } of routes) {
    const name = `${method} ${path}`
    const body = toJsonSchema(route.body, `body of ${name}`)
    const params = toJsonSchema(route.params, `params of ${name}`)
    const query = toJsonSchema(route.query, `query of ${name}`)
    const response = toJsonSchema(route.response, `response of ${name}`)

    const id = route.docs.operationId ?? operationId(method, path)
    const other = ids.get(id)
    if (other) throw new BolideError(`OpenAPI: ${name} and ${other} both have operationId "${id}". Set operationId on one of them.`)
    ids.set(id, name)

    const responses: Record<string, unknown> = {
      [route.status]: { description: 'Success', ...(response ? json(response) : {}) },
    }
    if (route.params || route.query || route.body) {
      // A body route can also answer 400 for malformed JSON, with the plain error shape.
      const invalid = route.body ? { oneOf: [validationBody, errorBody] } : validationBody
      responses['400'] = { description: 'Invalid input', ...json(invalid) }
    }
    if (route.body) {
      responses['413'] = { description: 'Body too large', ...json(errorBody) }
      responses['415'] = { description: 'Body is not JSON', ...json(errorBody) }
    }
    responses['default'] = { description: 'Error', ...json(errorBody) }

    const { summary, description, tags, deprecated } = route.docs
    const operation = {
      operationId: id,
      summary,
      description,
      tags: tags ?? [module],
      deprecated,
      parameters: [...parameters('path', params, pathParamNames(path)), ...parameters('query', query, [])],
      requestBody: body ? { required: !acceptsUndefined(route.body!), ...json(body) } : undefined,
      responses,
    }
    // Drop undefined fields and empty parameter lists so the document stays readable.
    const clean = Object.fromEntries(
      Object.entries(operation).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
    )
    ;(paths[toOpenApiPath(path)] ??= {})[method.toLowerCase()] = clean
  }
  return {
    openapi: '3.1.0',
    info: options.info,
    ...(options.servers ? { servers: options.servers } : {}),
    paths,
  }
}
