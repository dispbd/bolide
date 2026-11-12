import type { RouteInfo } from './http.ts'
import type { StandardSchemaV1 } from './schema.ts'

/** Top-level fields of the document that routes cannot provide. */
export interface OpenApiOptions {
  info: { title: string; version: string; description?: string }
  servers?: { url: string; description?: string }[]
  /** Serve the document at this path from `createApp`. Default `/openapi.json`. */
  path?: string
}

type JsonSchema = Record<string, unknown>
type Converter = { input(o: { target: string }): JsonSchema; output(o: { target: string }): JsonSchema }

/**
 * JSON Schema for a Standard Schema, through the Standard JSON Schema extension
 * (`~standard.jsonSchema`, zod 4.2+, ArkType). Libraries without it give `{}`:
 * the endpoint is still listed, its shape just isn't described.
 */
function toJsonSchema(schema: StandardSchemaV1 | undefined, io: 'input' | 'output'): JsonSchema | undefined {
  if (!schema) return undefined
  const converter = (schema['~standard'] as { jsonSchema?: Converter }).jsonSchema
  if (!converter) return {}
  const { $schema: _, ...rest } = converter[io]({ target: 'draft-2020-12' })
  return rest
}

const errorBody = {
  type: 'object',
  properties: { error: { type: 'string' }, message: { type: 'string' }, details: {} },
  required: ['error'],
}

const validationBody = {
  type: 'object',
  properties: {
    error: { const: 'validation_failed' },
    where: { type: 'string', enum: ['params', 'query', 'body'] },
    issues: {
      type: 'array',
      items: { type: 'object', properties: { message: { type: 'string' }, path: { type: 'string' } }, required: ['message', 'path'] },
    },
  },
  required: ['error', 'where', 'issues'],
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
  for (const { method, path, module, route } of routes) {
    const body = toJsonSchema(route.body, 'input')
    const params = toJsonSchema(route.params, 'input')
    const query = toJsonSchema(route.query, 'input')
    const response = toJsonSchema(route.response, 'output')

    const responses: Record<string, unknown> = {
      [route.status]: { description: 'Success', ...(response ? json(response) : {}) },
    }
    if (route.params || route.query || route.body) responses['400'] = { description: 'Invalid input', ...json(validationBody) }
    if (route.body) {
      responses['413'] = { description: 'Body too large', ...json(errorBody) }
      responses['415'] = { description: 'Body is not JSON', ...json(errorBody) }
    }
    responses['default'] = { description: 'Error', ...json(errorBody) }

    const { summary, description, tags, deprecated } = route.docs
    const operation = {
      operationId: route.docs.operationId ?? operationId(method, path),
      summary,
      description,
      tags: tags ?? [module],
      deprecated,
      parameters: [...parameters('path', params, pathParamNames(path)), ...parameters('query', query, [])],
      requestBody: body ? { required: true, ...json(body) } : undefined,
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
