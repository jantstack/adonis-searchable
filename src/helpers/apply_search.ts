/**
 * Aplicador de fulltext search multi-columna, driver-aware.
 * Replica la lógica de api-global-data-care/app/traits/controller_helper.ts
 * (sección dentro de `find()`) como helper puro.
 */

import { resolveColumnTypes, getConnectionAndDriver } from './column_types.js'

const STRING_TYPES = ['character varying', 'varchar', 'char', 'text', 'string']
const NUMBER_TYPES = [
  'integer',
  'int',
  'bigint',
  'smallint',
  'mediumint',
  'tinyint',
  'numeric',
  'float',
  'decimal',
  'double',
  'real',
]
const DATE_TYPES = [
  'date',
  'datetime',
  'timestamp',
  'timestamp without time zone',
  'timestamp with time zone',
]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/

const isPotentialUuid = (s: string) => UUID_RE.test(s)
const isPotentialDate = (s: string) => DATE_PREFIX_RE.test(s)

/**
 * Aplica búsqueda fulltext sobre un query.
 *
 * - En Postgres usa `CAST(col AS TEXT) ILIKE` (cubre cualquier columna).
 * - En otros drivers segmenta por tipo: LIKE en strings, equality en uuids/numbers,
 *   DATE(col) = ? en fechas.
 *
 * Side-effect: modifica el query con `.where(builder => ...)`.
 */
export async function applyFulltextSearch(
  query: any,
  searchInput: string,
  table: string,
  searchableColumns: string[]
): Promise<void> {
  if (!searchInput || !searchableColumns.length) return

  const { driver } = getConnectionAndDriver(query)
  const types = await resolveColumnTypes(table, searchableColumns, query)

  query.where((builder: any) => {
    if (driver === 'pg') {
      // En Postgres podemos castear cualquier tipo a TEXT y aplicar ILIKE.
      // Es la opción más amplia y consistente.
      searchableColumns.forEach((column) => {
        const value = `%${searchInput.toLowerCase()}%`
        builder.orWhereRaw(`CAST(${column} AS TEXT) ILIKE ?`, [value])
      })
      return
    }

    // Drivers no-PG: segmentar por tipo
    const stringFields = searchableColumns.filter((c) =>
      STRING_TYPES.includes(types[c]?.toLowerCase() ?? '')
    )
    const numberFields = searchableColumns.filter((c) =>
      NUMBER_TYPES.includes(types[c]?.toLowerCase() ?? '')
    )
    const dateFields = searchableColumns.filter((c) =>
      DATE_TYPES.includes(types[c]?.toLowerCase() ?? '')
    )
    const uuidFields = searchableColumns.filter((c) =>
      (types[c] ?? '').toLowerCase().includes('uuid')
    )

    stringFields.forEach((column) => {
      const value = `%${searchInput.toLowerCase()}%`
      switch (driver) {
        case 'sqlite':
          builder.orWhereRaw(`LOWER(${column}) LIKE ?`, [value])
          break
        case 'mssql':
          builder.orWhereRaw(`LOWER(CAST(${column} AS NVARCHAR)) LIKE ?`, [value])
          break
        default:
          builder.orWhereRaw(`LOWER(${column}) LIKE ?`, [value])
      }
    })

    uuidFields.forEach((column) => {
      if (isPotentialUuid(searchInput)) builder.orWhere(column, searchInput)
    })

    numberFields.forEach((column) => {
      if (!Number.isNaN(Number(searchInput))) builder.orWhere(column, Number(searchInput))
    })

    dateFields.forEach((column) => {
      if (isPotentialDate(searchInput)) builder.orWhereRaw(`DATE(${column}) = ?`, [searchInput])
    })
  })
}
