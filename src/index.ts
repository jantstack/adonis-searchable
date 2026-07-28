/**
 * Entrada pública del paquete.
 *
 *   import { BaseService, parseQueryParams } from '@jantstack/adonis-searchable'
 */

export { SearchableService, RecordNotFoundError } from './searchable_service.js'
export { BaseService } from './base_service.js'

/**
 * Adaptador HTTP → QueryParams: el único punto del paquete que conoce el
 * `HttpContext` de Adonis. Traduce las convenciones del query string
 * (`search_columns[]`, `per_page`, `order_by`, `filters[...]`) al objeto que
 * consume `index()`. Para otro transporte (GraphQL, gRPC) se escribe otro
 * adaptador: los services no cambian.
 */
export { parseQueryParams } from './parse_query_params.js'

// Modos de `allowedFilters`: por defecto se filtran las columnas que el
// modelo serializa (FILTERABLE_FROM_MODEL); ALLOW_ALL_FILTERS es el opt-in
// para incluir también las ocultas.
export { ALLOW_ALL_FILTERS, FILTERABLE_FROM_MODEL } from './helpers/apply_filters.js'
export type { AllowedFilters } from './helpers/apply_filters.js'

export type {
  QueryParams,
  PaginatedResult,
  PaginationMeta,
  PeriodFilter,
  FilterBlock,
  FilterCondition,
  FilterMethod,
  SearchableServiceConfig,
} from './types.js'
