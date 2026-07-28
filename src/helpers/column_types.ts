/**
 * Helpers para descubrir tipos de columna desde el motor de BD, con caché
 * por (connection, table). Necesario para validar tipo-aware los valores
 * de filtros y para hacer fulltext search casteando correctamente.
 *
 * Diseño "paquete imaginario": NO importa `#config/database`. El driver
 * se descubre desde el query/model o se pasa por opciones del service.
 */

import db from '@adonisjs/lucid/services/db'

type Driver = 'pg' | 'mysql' | 'sqlite' | 'mssql'

/** Cache global de tipos por `${connection}:${table}`. */
const TYPES_CACHE: Record<string, Record<string, string>> = {}

export function normalizeDriver(client: string | undefined): Driver {
  const c = String(client ?? 'mysql').toLowerCase()
  if (/pg|postgres/.test(c)) return 'pg'
  if (/mysql/.test(c)) return 'mysql'
  if (/sqlite/.test(c)) return 'sqlite'
  if (/mssql|sqlsrv/.test(c)) return 'mssql'
  return 'mysql'
}

/**
 * Resuelve el connection name + driver desde un query/model.
 * No depende de un archivo de config específico del host.
 */
export function getConnectionAndDriver(queryOrModel: any): {
  connectionName: string
  driver: Driver
} {
  const connectionName =
    queryOrModel?.connectionName ||
    queryOrModel?.client?.connectionName ||
    queryOrModel?.$options?.connection ||
    db.primaryConnectionName

  const connection = db.connection(connectionName)
  // Lucid expone el dialecto vía `connection.dialect.name`
  // ('postgres' | 'mysql' | 'sqlite3' | 'mssql' | ...).
  const dialectName = (connection as any)?.dialect?.name
  const driver = normalizeDriver(typeof dialectName === 'string' ? dialectName : 'mysql')
  return { connectionName, driver }
}

/**
 * Tipo de una columna (lowercase, sin paréntesis). null si no se puede determinar.
 */
export async function getColumnType(
  table: string,
  column: string,
  queryOrModel: any
): Promise<string | null> {
  const { connectionName, driver } = getConnectionAndDriver(queryOrModel)

  if (driver === 'pg') {
    const result = await db
      .connection(connectionName)
      .from('information_schema.columns')
      .select('data_type')
      .where('table_name', table)
      .andWhere('column_name', column)
      .first()
    return (result?.data_type ?? null)?.toLowerCase() ?? null
  }

  if (driver === 'mysql') {
    const rows = await db.connection(connectionName).rawQuery(
      `SELECT DATA_TYPE AS data_type
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    )
    const row = Array.isArray(rows) ? rows[0] : rows?.[0]
    const raw = row?.data_type ?? row?.DATA_TYPE
    return raw ? String(raw).toLowerCase() : null
  }

  if (driver === 'sqlite') {
    const results = await db.connection(connectionName).rawQuery(`PRAGMA table_info('${table}')`)
    const c = results.find((r: any) => r.name === column)
    const rawType: string | undefined = c?.type
    return rawType ? rawType.toLowerCase().replace(/\(.*\)/, '') : null
  }

  return null
}

/**
 * Columnas que el modelo PUBLICA en su serialización, es decir las que no
 * están marcadas `@column({ serializeAs: null })`.
 *
 * Es la base del modo de filtrado por defecto: *filtrable ⊆ visible*. Si una
 * columna ya viaja en la respuesta del API, poder filtrar por ella no revela
 * nada nuevo; las ocultas (un hash de password) quedan fuera automáticamente,
 * que es justo donde un `like` sería un oráculo de exfiltración.
 *
 * Lee la metadata del modelo (no el esquema), así que no toca la DB.
 */
export function getSerializableColumns(model: any): string[] {
  const definitions = model?.$columnsDefinitions
  if (!definitions?.forEach) return []

  const columns: string[] = []
  definitions.forEach((definition: any) => {
    if (definition?.serializeAs !== null && definition?.columnName) {
      columns.push(definition.columnName)
    }
  })
  return columns
}

/** Lista de columnas de la tabla del modelo (orden de declaración). */
export async function getColumns(model: any): Promise<string[]> {
  const table = typeof model.table === 'function' ? model.table() : model.table
  if (!table) throw new Error('No se pudo detectar la tabla del modelo')

  const { connectionName, driver } = getConnectionAndDriver(model)

  if (driver === 'pg') {
    const rows = await db
      .connection(connectionName)
      .from('information_schema.columns')
      .select('column_name')
      .where('table_name', table)
    return rows.map((r: any) => r.column_name)
  }
  if (driver === 'mysql') {
    const rows = await db.connection(connectionName).rawQuery(`SHOW COLUMNS FROM \`${table}\``)
    return rows.map((row: any) => row.Field)
  }
  if (driver === 'sqlite') {
    const rows = await db.connection(connectionName).rawQuery(`PRAGMA table_info('${table}')`)
    return rows.map((row: any) => row.name)
  }
  throw new Error(`Driver no soportado: ${driver}`)
}

/**
 * Resuelve los tipos de un conjunto de columnas, usando cache para evitar
 * golpear information_schema repetidamente.
 */
export async function resolveColumnTypes(
  table: string,
  columns: string[],
  queryOrModel: any
): Promise<Record<string, string>> {
  const { connectionName, driver } = getConnectionAndDriver(queryOrModel)
  const cacheKey = `${connectionName}:${table}:${driver}`
  const cached = TYPES_CACHE[cacheKey] ?? {}

  const missing = columns.filter((c) => !(c in cached))
  if (missing.length > 0) {
    const types = await Promise.all(missing.map((c) => getColumnType(table, c, queryOrModel)))
    missing.forEach((c, i) => {
      cached[c] = types[i] ?? 'unknown'
    })
    TYPES_CACHE[cacheKey] = cached
  }

  const out: Record<string, string> = {}
  for (const c of columns) out[c] = cached[c] ?? 'unknown'
  return out
}

/** Devuelve la tabla del modelo o query, o null si no se pudo determinar. */
export function getTableNameFromQuery(query: any): string | null {
  if (query && typeof query === 'object') {
    if (
      query.model &&
      (typeof query.model.table === 'string' || typeof query.model.table === 'function')
    ) {
      if (typeof query.model.table === 'string') return query.model.table
      if (typeof query.model.table === 'function') return query.model.table()
    }
    if (typeof query.table === 'string') return query.table
    if (typeof query.table === 'function') return query.table()
  }
  return null
}

export const TYPES_CACHE_INTERNAL = TYPES_CACHE
