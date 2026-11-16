/**
 * A decoder for Postgres's `pgoutput` logical replication messages (protocol version 1, text values).
 * Only what `replicationSync` needs: transactions with their xid, relations, row changes and truncates.
 * https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html
 */

export interface Relation {
  id: number
  schema: string
  name: string
  columns: { name: string; type: number }[]
}

/** A row as text values by column name; `null` is SQL null. Unchanged TOAST values are left out. */
export type TextRow = Record<string, string | null>

export type PgOutputMessage =
  | { tag: 'begin'; lsn: bigint; xid: number }
  | { tag: 'commit'; lsn: bigint; end: bigint }
  | { tag: 'relation'; relation: Relation }
  | { tag: 'insert'; relation: number; new: TextRow }
  | { tag: 'update'; relation: number; old?: TextRow; new: TextRow }
  | { tag: 'delete'; relation: number; old: TextRow }
  | { tag: 'truncate'; relations: number[] }
  | { tag: 'other' }

/** Decodes one pgoutput message. `columns` gives each relation's column names for the tuples. */
export function decodePgOutput(buf: Uint8Array, columns: (relation: number) => Relation['columns'] | undefined): PgOutputMessage {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let at = 1
  const u8 = () => view.getUint8(at++)
  const i16 = () => ((at += 2), view.getInt16(at - 2))
  const i32 = () => ((at += 4), view.getInt32(at - 4))
  const u32 = () => ((at += 4), view.getUint32(at - 4))
  const u64 = () => ((at += 8), view.getBigUint64(at - 8))
  const text = new TextDecoder()
  const str = () => {
    const end = buf.indexOf(0, at)
    const s = text.decode(buf.subarray(at, end))
    at = end + 1
    return s
  }
  const tuple = (relation: number): TextRow => {
    const cols = columns(relation)
    if (!cols) throw new Error(`pgoutput: a row of relation ${relation} came before its description`)
    const n = i16()
    const row: TextRow = {}
    for (let i = 0; i < n; i++) {
      const kind = String.fromCharCode(u8())
      const name = cols[i]!.name
      if (kind === 'n') row[name] = null
      else if (kind === 't') {
        const len = i32()
        row[name] = text.decode(buf.subarray(at, at + len))
        at += len
      } else if (kind !== 'u') throw new Error(`pgoutput: unexpected column kind "${kind}"`)
    }
    return row
  }

  switch (String.fromCharCode(buf[0]!)) {
    case 'B': {
      const lsn = u64()
      at += 8 // commit time
      return { tag: 'begin', lsn, xid: u32() }
    }
    case 'C': {
      at += 1 // flags
      const lsn = u64()
      return { tag: 'commit', lsn, end: u64() }
    }
    case 'R': {
      const id = u32()
      const schema = str()
      const name = str()
      at += 1 // replica identity
      const n = i16()
      const cols: Relation['columns'] = []
      for (let i = 0; i < n; i++) {
        at += 1 // flags
        const col = str()
        cols.push({ name: col, type: u32() })
        at += 4 // type modifier
      }
      return { tag: 'relation', relation: { id, schema, name, columns: cols } }
    }
    case 'I': {
      const relation = u32()
      at += 1 // 'N'
      return { tag: 'insert', relation, new: tuple(relation) }
    }
    case 'U': {
      const relation = u32()
      let kind = String.fromCharCode(u8())
      let old: TextRow | undefined
      if (kind === 'K' || kind === 'O') {
        old = tuple(relation)
        kind = String.fromCharCode(u8())
      }
      const row = tuple(relation)
      // An unchanged TOAST value is only in the old row (with REPLICA IDENTITY FULL).
      if (old) for (const [k, v] of Object.entries(old)) if (!(k in row)) row[k] = v
      return { tag: 'update', relation, ...(old ? { old } : {}), new: row }
    }
    case 'D': {
      const relation = u32()
      at += 1 // 'K' or 'O'
      return { tag: 'delete', relation, old: tuple(relation) }
    }
    case 'T': {
      const n = i32()
      at += 1 // options
      const relations: number[] = []
      for (let i = 0; i < n; i++) relations.push(u32())
      return { tag: 'truncate', relations }
    }
    default:
      return { tag: 'other' }
  }
}

/** `0/16B3748` → 23803720n */
export const parseLsn = (lsn: string): bigint => {
  const [hi, lo] = lsn.split('/')
  return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`)
}
export const formatLsn = (lsn: bigint): string => `${(lsn >> 32n).toString(16).toUpperCase()}/${(lsn & 0xffffffffn).toString(16).toUpperCase()}`
