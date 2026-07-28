/**
 * Barrel del "paquete imaginario" Searchable/Base Service.
 * Las subclases del proyecto importan desde aquí.
 */

export { SearchableService, RecordNotFoundError } from './searchable_service.js'
export { BaseService } from './base_service.js'
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
