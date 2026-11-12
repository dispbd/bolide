import { z } from 'zod'
export const s = z.object({ id: z.uuid(), title: z.string().min(1).max(200) })
