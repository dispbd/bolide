import * as z from 'zod/mini'
export const s = z.object({ id: z.uuid(), title: z.string().check(z.minLength(1), z.maxLength(200)) })
