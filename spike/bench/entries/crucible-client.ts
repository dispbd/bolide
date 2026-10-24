import { createCrucibleClient } from '../../core/client.ts'
import { mutators } from '../../app/mutators.ts'
export const client = createCrucibleClient({ baseUrl: '/', userId: 'u', tables: ['todos'], mutators })
