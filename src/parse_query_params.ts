/**
 * Helper único de adaptación HTTP → QueryParams.
 * Es el ÚNICO punto donde la capa de servicios toca HttpContext.
 * Si en el futuro hay otro adapter (GraphQL, gRPC), se escribe otro `parse_*`.
 */

import type { HttpContext } from '@adonisjs/core/http'
import type { QueryParams, PeriodFilter, FilterBlock } from './types.js'

type Request = HttpContext['request']

/**
 * Parsea los query strings + body de un request y devuelve un QueryParams
 * estructurado, listo para `SearchableService.index()`.
 *
 * Convenciones soportadas (las mismas que ya usabas en api-global-data-care):
 *   ?search=foo
 *   ?search_input=foo                       (alias legacy)
 *   ?search_columns[]=name&search_columns[]=email
 *   ?page=2&per_page=50
 *   ?order_by=created_at&order_direction=desc
 *   ?with=profile,wallets                   (preloads CSV)
 *   ?with[]=profile&with[]=wallets          (preloads array)
 *   ?period_filters[0][column]=created_at&period_filters[0][start]=2026-01-01
 *   ?filters[where][0][field]=status&filters[where][0][value]=active
 *   ?scopes[withStatus]=delivered
 *   ?count=true                             (devuelve solo conteo)
 *   ?paginate=false&limit=500               (devuelve data plana)
 */
export function parseQueryParams(request: Request): QueryParams {
  // Para GET usamos qs (parsea nested brackets); para POST/PUT, el body es JSON
  // ya parseado por el body parser de Adonis. Usamos request.all() como fallback.
  const isGet = request.method() === 'GET'
  const raw: any = isGet ? request.qs() : { ...request.qs(), ...request.all() }

  const params: QueryParams = {}

  // Search
  const search = raw.search ?? raw.search_input
  if (typeof search === 'string' && search.trim() !== '') params.search = search.trim()

  if (raw.search_columns) {
    params.searchColumns = Array.isArray(raw.search_columns)
      ? raw.search_columns
      : [raw.search_columns]
  }

  // Filters (estructura nested)
  if (raw.filters) {
    params.filters = raw.filters as FilterBlock | FilterBlock[]
  }

  // Period filters
  if (raw.period_filters && Array.isArray(raw.period_filters)) {
    params.period = raw.period_filters as PeriodFilter[]
  }

  // Pagination + sort. `Number('abc')` es NaN y `Number([])` es 0: se
  // descartan aquí para que nunca lleguen a la capa de servicios. El techo
  // real lo pone igualmente el service (maxPerPage/maxUnpaginatedLimit).
  const page = toPositiveInt(raw.page)
  if (page !== undefined) params.page = page
  const perPage = toPositiveInt(raw.per_page)
  if (perPage !== undefined) params.perPage = perPage
  const limit = toPositiveInt(raw.limit)
  if (limit !== undefined) params.limit = limit
  if (typeof raw.order_by === 'string') params.orderBy = raw.order_by
  if (raw.order_direction === 'asc' || raw.order_direction === 'desc') {
    params.orderDirection = raw.order_direction
  }

  // Flags
  if (raw.count !== undefined) params.count = parseBool(raw.count)
  if (raw.paginate !== undefined) params.paginate = parseBool(raw.paginate)

  // Includes / preloads (acepta `with` CSV o array; alias también `include`/`includes`)
  const includes = parseIncludes(raw.with ?? raw.include ?? raw.includes)
  if (includes.length) params.includes = includes

  // Scopes Lucid
  if (raw.scopes && typeof raw.scopes === 'object') {
    params.scopes = raw.scopes as Record<string, unknown>
  }

  // Base URL para construir links de paginación
  if (isGet) {
    params.paginationBaseUrl = request.url()
    const qsCopy = { ...raw }
    delete qsCopy.page
    params.paginationExtraQs = qsCopy
  }

  return params
}

/** Entero >= 1 o undefined. Un valor basura se ignora, no se propaga. */
function toPositiveInt(v: any): number | undefined {
  if (v === undefined || v === null || v === '' || Array.isArray(v)) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.floor(n)
}

function parseBool(v: any): boolean {
  if (typeof v === 'boolean') return v
  return v === 'true' || v === '1' || v === 1
}

function parseIncludes(raw: any): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string')
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  return []
}
