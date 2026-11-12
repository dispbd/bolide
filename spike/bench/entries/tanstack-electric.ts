import { createCollection, createTransaction } from '@tanstack/db'
import { electricCollectionOptions } from '@tanstack/electric-db-collection'
export const c = createCollection(electricCollectionOptions({ id: 't', shapeOptions: { url: '/' }, getKey: (r: any) => r.id }))
export const t = createTransaction
