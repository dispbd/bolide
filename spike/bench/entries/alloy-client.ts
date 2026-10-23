import { createAlloyClient } from '../../core/client.ts'
import { mutators } from '../../app/mutators.ts'
export const client = createAlloyClient({ baseUrl: '/', userId: 'u', tables: ['todos'], mutators })
