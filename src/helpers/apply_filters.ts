/**
 * Aplicador de filtros estructurados sobre un ModelQueryBuilder.
 * Replica la lógica de api-global-data-care/app/traits/controller_helper.ts
 * (función applyFiltersSync) como helper puro reutilizable.
 */

import type { FilterBlock, FilterCondition } from '../types.js'

type Logic = 'and' | 'or'

/**
 * Whitelist de operadores de comparación admitidos en `where`/`orWhere` y
 * `whereJsonLength`. El `op` llega del cliente y Knex lo interpola crudo en el
 * SQL (`col <op> ?`), así que un operador no validado es un vector de inyección
 * (p. ej. `op = "IS NOT NULL OR 1=1 --"`). Cualquier `op` fuera de esta lista
 * hace que la condición se descarte (deny-by-default), en línea con el resto del
 * helper, que ya ignora silenciosamente lo que no reconoce.
 */
const COMPARISON_OPERATORS = new Set([
  '=',
  '!=',
  '<>',
  '>',
  '>=',
  '<',
  '<=',
  'like',
  'ilike',
  'not like',
  'not ilike',
])

/** True si `op` es un operador de comparación seguro (case-insensitive). */
function isSafeOperator(op: string): boolean {
  return COMPARISON_OPERATORS.has(op.trim().toLowerCase())
}

/**
 * Sentinel de opt-in explícito: permite filtrar por CUALQUIER columna del
 * modelo. Solo para servicios internos sobre modelos sin datos sensibles —
 * un filtro `like` sobre una columna secreta es un oráculo de exfiltración.
 * Ver `SearchableService.allowedFilters`.
 */
export const ALLOW_ALL_FILTERS = Symbol('searchable:allow-all-filters')

/**
 * Modo por defecto: filtrable = las columnas que el modelo SERIALIZA
 * (`serializeAs !== null`). Principio *filtrable ⊆ visible* — lo que el API
 * ya devuelve se puede filtrar; lo oculto (password) nunca.
 * Lo resuelve `SearchableService`; `applyFilters` recibe siempre la lista ya
 * materializada o `ALLOW_ALL_FILTERS`.
 */
export const FILTERABLE_FROM_MODEL = Symbol('searchable:filterable-from-model')

/** Whitelist declarada por el service (lo que se escribe en `allowedFilters`). */
export type AllowedFilters = string[] | typeof ALLOW_ALL_FILTERS | typeof FILTERABLE_FROM_MODEL

/** Whitelist ya resuelta (lo que recibe `applyFilters`). */
export type ResolvedFilters = string[] | typeof ALLOW_ALL_FILTERS

/**
 * Profundidad máxima de anidamiento (`orGroup`/`andGroup`) por defecto.
 * En GET el parser `qs` ya acota el nesting, pero en POST/PUT el body JSON no
 * tiene límite: sin techo, un cuerpo con miles de grupos anidados recursa
 * hasta desbordar la pila.
 */
export const MAX_FILTER_DEPTH = 5

/**
 * Número máximo de condiciones aplicadas por petición (por defecto). Acota el
 * tamaño del SQL generado: miles de condiciones planas no desbordan la pila,
 * pero sí producen una query desproporcionada.
 */
export const MAX_FILTER_CONDITIONS = 100

/**
 * Número máximo de valores admitidos en un `whereIn`/`whereNotIn`.
 * El techo de condiciones no bastaba: un solo `whereIn` con 100.000 valores
 * cuenta como UNA condición y genera un SQL desproporcionado (y en Postgres
 * revienta el límite de parámetros por sentencia).
 */
export const MAX_FILTER_IN_VALUES = 500

/** Techos ajustables por el service (ver `SearchableService.filterLimits`). */
export interface FilterLimits {
  maxDepth?: number
  maxConditions?: number
  maxInValues?: number
}

/**
 * Aplica recursivamente un bloque de filtros (o array de bloques) a un query.
 * - allowedColumns: whitelist YA RESUELTA de campos filtrables (el service la
 *   materializa desde `allowedFilters`). Una condición cuyo campo raíz (antes
 *   de `->` en JSON paths) no esté listado se descarta; una lista vacía
 *   descarta todo. `ALLOW_ALL_FILTERS` salta el chequeo por completo.
 * - parentLogic: cuando el padre es un orGroup, los `where` se reescriben como
 *   `orWhere` automáticamente.
 * - limits: techos de profundidad y de número de condiciones. Lo que los
 *   excede se descarta en silencio, igual que el resto del helper.
 */
export function applyFilters(
  query: any,
  filters: FilterBlock | FilterBlock[] | undefined,
  allowedColumns: ResolvedFilters = [],
  parentLogic: Logic = 'and',
  limits: FilterLimits = {}
): void {
  applyFiltersInternal(query, filters, allowedColumns, parentLogic, 0, {
    maxDepth: limits.maxDepth ?? MAX_FILTER_DEPTH,
    left: limits.maxConditions ?? MAX_FILTER_CONDITIONS,
    maxInValues: limits.maxInValues ?? MAX_FILTER_IN_VALUES,
  })
}

/** Presupuesto compartido por toda la recursión de una misma llamada. */
interface Budget {
  maxDepth: number
  left: number
  maxInValues: number
}

function applyFiltersInternal(
  query: any,
  filters: FilterBlock | FilterBlock[] | undefined,
  allowedColumns: ResolvedFilters,
  parentLogic: Logic,
  depth: number,
  budget: Budget
): void {
  if (!filters) return

  if (Array.isArray(filters)) {
    filters.forEach((block) =>
      applyFiltersInternal(query, block, allowedColumns, parentLogic, depth, budget)
    )
    return
  }

  for (const [method, conditions] of Object.entries(filters)) {
    if (method === 'orGroup' || method === 'andGroup') {
      // El techo se comprueba ANTES de abrir el grupo: si se recursara y el
      // cuerpo saliera vacío, Knex generaría un `where ()` inválido.
      if (depth >= budget.maxDepth || budget.left <= 0) continue
      const subLogic: Logic = method === 'orGroup' ? 'or' : 'and'
      const fnName = method === 'orGroup' ? 'orWhere' : 'where'
      for (const group of conditions as FilterBlock[]) {
        query[fnName]((q: any) =>
          applyFiltersInternal(q, group, allowedColumns, subLogic, depth + 1, budget)
        )
      }
      continue
    }

    if (!Array.isArray(conditions)) continue

    for (const cond of conditions as FilterCondition[]) {
      if (budget.left <= 0) return
      if (!cond.field) continue
      // Solo pasan los campos de la whitelist resuelta (por defecto, las
      // columnas que el modelo serializa). ALLOW_ALL_FILTERS es el opt-in
      // explícito para incluir también las ocultas.
      if (allowedColumns !== ALLOW_ALL_FILTERS) {
        const rootField = cond.field.split('->')[0]
        if (!allowedColumns.includes(rootField)) continue
      }

      // Consume presupuesto toda condición que llegue a generar SQL. Lo que
      // ya se descartó arriba no cuenta: no cuesta nada en la base.
      budget.left -= 1

      // Cuando el padre es OR, transformamos `where`→`orWhere`
      const methodName = parentLogic === 'or' && method === 'where' ? 'orWhere' : method

      switch (methodName) {
        case 'where':
        case 'orWhere': {
          const op = cond.op ?? '='
          // Deny-by-default: un operador fuera de la whitelist se descarta para
          // evitar inyección SQL (el op se interpola crudo en el SQL de Knex).
          if (!isSafeOperator(op)) continue
          query[methodName](cond.field, op, cond.value)
          break
        }
        case 'whereIn':
        case 'orWhereIn':
        case 'whereNotIn':
        case 'orWhereNotIn': {
          const vals = cond.values ?? cond.value
          const list = Array.isArray(vals) ? vals : [vals]
          // Se descarta entera, no se recorta: un `whereIn` truncado responde
          // a una pregunta que el cliente no hizo, y en silencio.
          if (list.length > budget.maxInValues) continue
          query[methodName](cond.field, list)
          break
        }
        case 'whereBetween':
        case 'orWhereBetween':
        case 'whereNotBetween':
        case 'orWhereNotBetween': {
          const range = cond.values ?? cond.value
          if (Array.isArray(range) && range.length === 2) {
            query[methodName](cond.field, range)
          }
          break
        }
        case 'whereNull':
        case 'orWhereNull':
        case 'whereNotNull':
        case 'orWhereNotNull':
          query[methodName](cond.field)
          break
        case 'whereJsonContains':
        case 'orWhereJsonContains':
          query[methodName](cond.field, cond.value)
          break
        case 'whereJsonLength':
        case 'orWhereJsonLength':
          if (cond.op) {
            // Mismo guard que where/orWhere: op crudo del cliente → whitelist.
            if (!isSafeOperator(cond.op)) continue
            query[methodName](cond.field, cond.op, cond.value)
          } else {
            query[methodName](cond.field, cond.value)
          }
          break
        default:
          // Ignora métodos no soportados (silencioso por diseño: filtros
          // controlados por entrada externa, no fallar por algo desconocido).
          break
      }
    }
  }
}
