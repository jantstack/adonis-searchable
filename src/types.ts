/**
 * Tipos públicos de SearchableService / BaseService.
 *
 * Esta carpeta (app/services/base/) está diseñada como un "paquete imaginario":
 * cero imports a `#config/*` o `#models/*`. Cuando madure, se extrae a un repo
 * separado y se publica como `adonis-searchable-service` (o equivalente).
 */

import type { BaseModel } from '@adonisjs/lucid/orm'

/** Operadores SQL admitidos por el aplicador de filtros. */
export type FilterMethod =
  | 'where'
  | 'orWhere'
  | 'whereIn'
  | 'orWhereIn'
  | 'whereNotIn'
  | 'orWhereNotIn'
  | 'whereBetween'
  | 'orWhereBetween'
  | 'whereNotBetween'
  | 'orWhereNotBetween'
  | 'whereNull'
  | 'orWhereNull'
  | 'whereNotNull'
  | 'orWhereNotNull'
  | 'whereJsonContains'
  | 'orWhereJsonContains'
  | 'whereJsonLength'
  | 'orWhereJsonLength'

/** Condición simple: { field: 'status', op: '=', value: 'active' } */
export interface FilterCondition {
  field: string
  op?: string
  value?: any
  values?: any[]
}

/**
 * Bloque de filtros con métodos como llaves:
 * { where: [{...}, {...}], whereIn: [{...}] }
 *
 * Para agrupar con OR / AND anidados:
 * { orGroup: [ {where: [...]}, {where: [...]} ] }
 */
export type FilterBlock = {
  [k in FilterMethod]?: FilterCondition[]
} & {
  orGroup?: FilterBlock[]
  andGroup?: FilterBlock[]
}

/** Filtro por rango de fechas en una columna específica. */
export interface PeriodFilter {
  column: string
  start?: string | null
  end?: string | null
}

/** Parámetros declarativos de búsqueda — el objeto que recibe `index()`. */
export interface QueryParams {
  /** Cadena para fulltext search multi-columna. */
  search?: string | null
  /** Subconjunto de columnas sobre las que aplicar el search (defaults a todas las searchable). */
  searchColumns?: string[]
  /** Filtros estructurados: un bloque o array de bloques. */
  filters?: FilterBlock | FilterBlock[]
  /** Filtros de periodo: rango por columna fecha. */
  period?: PeriodFilter[]

  /** Paginación. */
  page?: number
  perPage?: number
  /** Si true, solo devuelve `{ count }`. */
  count?: boolean
  /** Si false, devuelve `{ data }` sin paginación (límite por `limit`). */
  paginate?: boolean
  limit?: number

  /** Sort. */
  orderBy?: string
  orderDirection?: 'asc' | 'desc'

  /** Relations a precargar (relaciones anidadas vía dot notation: `profile.wallets`). */
  includes?: string[]

  /**
   * Scopes Lucid a aplicar:
   *   { withStatus: 'delivered', forNetwork: 'pontusx_testnet' }
   * El service base los pasa a `.withScopes((s) => s.withStatus(...))`.
   */
  scopes?: Record<string, unknown>

  /**
   * URL base para construir los links de paginación (firstPageUrl, etc.).
   * Si no se especifica, los meta links salen null. El controller la pasa
   * desde HttpContext.request.url().
   */
  paginationBaseUrl?: string
  /** Query params adicionales a preservar en los links de paginación. */
  paginationExtraQs?: Record<string, any>
}

/** Resultado de paginación Lucid + meta extendido. */
export interface PaginationMeta {
  total: number
  perPage: number
  currentPage: number
  lastPage: number
  firstPage: number
  firstPageUrl?: string | null
  lastPageUrl?: string | null
  nextPageUrl?: string | null
  previousPageUrl?: string | null
}

export interface PaginatedResult<T> {
  data: T[]
  meta: PaginationMeta
}

/**
 * Configuración del SearchableService por subclase.
 * El subclass-author declara estas propiedades como atributos `protected`.
 */
export interface SearchableServiceConfig {
  searchableColumns?: string[]
  periodColumns?: string[]
  /** Whitelist de campos filtrables (deny-by-default; ver ALLOW_ALL_FILTERS). */
  allowedFilters?: string[] | symbol
  indexWith?: string[]
  showWith?: string[]
  allowedScopes?: string[]
  defaultPerPage?: number
  maxPerPage?: number
}

/**
 * Helper type para inferir la instancia del modelo desde su clase.
 * Permite que SearchableService<typeof Organization> infiera Organization.
 */
export type ModelInstance<M extends typeof BaseModel> = InstanceType<M>
