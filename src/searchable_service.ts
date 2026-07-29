/**
 * SearchableService<TModel>
 *
 * Abstract class que reemplaza al mixin `withControllerFind` de api-global-data-care.
 * Las subclases solo declaran `model` + configuración por defecto y heredan:
 *   - index(params)  → listado paginado con filtros, fulltext, periods, scopes y preloads
 *   - findOne(uuid)  → single record con preloads
 *
 * Diseño "paquete imaginario": cero imports a `#config/*` o `#models/*`.
 * Solo depende de @adonisjs/lucid, @adonisjs/core, @vinejs/vine, qs.
 */

import qs from 'qs'
import type { BaseModel } from '@adonisjs/lucid/orm'
import type { ModelQueryBuilderContract } from '@adonisjs/lucid/types/model'

import type { QueryParams, PaginatedResult, PaginationMeta } from './types.js'
import { applyFilters, ALLOW_ALL_FILTERS, FILTERABLE_FROM_MODEL } from './helpers/apply_filters.js'
import type { AllowedFilters, ResolvedFilters, FilterLimits } from './helpers/apply_filters.js'
import { applyFulltextSearch } from './helpers/apply_search.js'
import {
  applyPreloads,
  filterIncludes,
  ALLOW_ALL_INCLUDES,
  INCLUDES_FROM_SERVICE,
} from './helpers/apply_preloads.js'
import type {
  AllowedIncludes,
  AllowedIncludesByMethod,
  IncludesMethod,
  ResolvedIncludes,
} from './helpers/apply_preloads.js'
import { getColumns, getSerializableColumns } from './helpers/column_types.js'

/**
 * Normaliza un entero recibido del exterior. `Number('abc')` es NaN y, sin
 * esto, NaN llega hasta `paginate()` y revienta como error de SQL — un 500
 * donde debería haber un listado normal.
 */
function toPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/**
 * `YYYY-MM-DD` (o un ISO que empiece así) y que además sea una fecha real:
 * `2026-02-31` casa el patrón pero no existe, y la DB la rechazaría.
 * `undefined` pasa: un period con solo `start` o solo `end` es válido.
 */
function isIsoDate(value: string | null | undefined): boolean {
  if (value === undefined || value === null || value === '') return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return false
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  )
}

export abstract class SearchableService<TModel extends typeof BaseModel> {
  /** Modelo Lucid sobre el que opera el service. Subclases lo declaran. */
  protected abstract model: TModel

  /** Columnas habilitadas para fulltext search (search_input). */
  protected searchableColumns: string[] = []

  /** Columnas habilitadas para period filters (rango de fechas). */
  protected periodColumns: string[] = ['created_at', 'updated_at']

  /**
   * Columnas habilitadas como `field` de filters (query string del cliente).
   * Tres modos:
   *
   *  - **default** (`FILTERABLE_FROM_MODEL`): filtrable = las columnas que el
   *    modelo serializa. Principio *filtrable ⊆ visible*: lo que el API ya
   *    devuelve se puede filtrar; lo marcado `@column({ serializeAs: null })`
   *    (un hash de password) queda fuera — que es donde un `like` sería un
   *    oráculo de exfiltración a ciegas. Un service sin personalizar funciona
   *    y es seguro sin escribir una línea.
   *  - **whitelist explícita** (`['name', 'status']`): recomendado en APIs
   *    públicas — el contrato de filtrado deja de seguir al esquema. Una lista
   *    VACÍA es deny total (ningún filtro del cliente se aplica).
   *  - **`ALLOW_ALL_FILTERS`**: cualquier columna, incluidas las ocultas.
   *    Solo para servicios internos sobre modelos sin datos sensibles.
   */
  protected allowedFilters: AllowedFilters = FILTERABLE_FROM_MODEL

  /** Relaciones a precargar por defecto en index(). */
  protected indexWith: string[] = []

  /** Relaciones a precargar por defecto en findOne(). */
  protected showWith: string[] = []

  /**
   * Lo que el CLIENTE puede pedir de más con `?with=`.
   *
   * El reparto: `indexWith`/`showWith` dicen *qué carga el service* (y se
   * aplican siempre, los pida el cliente o no); esto dice *qué deja pedir
   * además*. Cuatro modos:
   *
   *  - **default** (`INCLUDES_FROM_SERVICE`): nada de más — el cliente solo
   *    puede pedir lo que ESE método ya precarga. Granularidad por método sin
   *    escribir una línea: lo que está solo en `showWith` no abre el listado.
   *  - **por método** (`{ index: ['tags'], show: ['tags', 'audit'] }`): abre
   *    el listado sin abrir el detalle, o al revés.
   *  - **lista simple** (`['tags']`): lo mismo en los dos métodos.
   *  - **`ALLOW_ALL_INCLUDES`**: cualquier relación del modelo — el
   *    comportamiento implícito hasta 2.0.0. Solo para servicios internos:
   *    una relación no prevista viaja entera en la respuesta.
   *
   * Los tres primeros son aditivos sobre los defaults del método: no hace
   * falta repetir en `allowedIncludes` lo que ya está en `indexWith`.
   */
  protected allowedIncludes: AllowedIncludes = INCLUDES_FROM_SERVICE

  /** Scopes Lucid permitidos: claves que pueden venir en `params.scopes`. */
  protected allowedScopes: string[] = []

  protected defaultPerPage: number = 25
  protected maxPerPage: number = 100

  /**
   * Techo de filas para `paginate=false`. Sin él, `?paginate=false&limit=1e7`
   * vacía la tabla en una sola respuesta y carga cada fila como modelo Lucid.
   */
  protected maxUnpaginatedLimit: number = 1000

  /** Techos de complejidad de los filtros del cliente (profundidad/cantidad). */
  protected filterLimits: FilterLimits = {}

  // ============================================================
  // API pública: index, findOne
  // ============================================================

  async index(
    params: QueryParams = {}
  ): Promise<
    PaginatedResult<InstanceType<TModel>> | { count: number } | { data: InstanceType<TModel>[] }
  > {
    const { query } = await this.buildQuery(params)
    // Preloads se aplican solo cuando vamos a devolver registros reales.
    // En count=true los preloads tirarían errores sobre filas vacías.
    if (params.count !== true) {
      applyPreloads(query, this.resolveIncludes(params.includes, this.indexWith, 'index'))
    }
    return this.paginate(query, params)
  }

  async findOne(uuid: string, includes?: string[]): Promise<InstanceType<TModel> | null> {
    const pk = (this.model.primaryKey as string) || 'id'
    const query = this.model.query() as ModelQueryBuilderContract<TModel, InstanceType<TModel>>
    applyPreloads(query, this.resolveIncludes(includes, this.showWith, 'show'))
    const record = await query.where(pk, uuid).first()
    return (record as InstanceType<TModel> | null) ?? null
  }

  async findOneOrFail(uuid: string, includes?: string[]): Promise<InstanceType<TModel>> {
    const r = await this.findOne(uuid, includes)
    if (!r) throw new RecordNotFoundError(this.model.table ?? 'unknown', uuid)
    return r
  }

  // ============================================================
  // API protegida: las subclases la usan para queries custom
  // ============================================================

  /**
   * Seam de escape para las subclases: añade condiciones que el sistema de
   * filtros declarativo no cubre (jsonb Postgres, joins, subqueries, scoping
   * por tenant/proyecto). Opcional: si no se define, buildQuery no hace nada.
   * Mantiene el paquete agnóstico de DB — el SQL específico vive en el consumer.
   */
  protected applyCustomFilters?(
    query: ModelQueryBuilderContract<TModel, InstanceType<TModel>>,
    params: QueryParams
  ): void | Promise<void>

  /**
   * Construye un query con todos los filtros aplicados.
   *
   * NOTA: devuelve `{ query }` envuelto en objeto porque ModelQueryBuilder es
   * un Thenable (awaiting un MQB ejecuta la query y devuelve rows). El wrapper
   * permite que las subclases puedan: `const { query } = await this.buildQuery(...)`
   * y agregar condiciones propias antes de paginar.
   */
  protected async buildQuery(
    params: QueryParams
  ): Promise<{ query: ModelQueryBuilderContract<TModel, InstanceType<TModel>> }> {
    const query = this.model.query() as ModelQueryBuilderContract<TModel, InstanceType<TModel>>

    // NOTA: los preloads NO se aplican aquí — los aplica index() solo cuando
    // vamos a devolver registros reales (no en count). Esto permite contar sin
    // ejecutar preloads (que fallarían en cloned count queries).

    // 2. Scopes Lucid (declarados como `Model.withStatus`, etc.)
    if (params.scopes) {
      for (const [scopeName, scopeArg] of Object.entries(params.scopes)) {
        if (!this.allowedScopes.includes(scopeName)) continue
        // La existencia se comprueba en el MODELO, no dentro del callback: el
        // proxy de `withScopes` lanza al acceder a un scope inexistente, así
        // que un `typeof s[scopeName]` allí dentro nunca llega a evaluarse.
        if (typeof (this.model as any)[scopeName] !== 'function') continue
        ;(query as any).withScopes((s: any) => s[scopeName](scopeArg))
      }
    }

    // 3. Fulltext search
    if (params.search) {
      const searchCols =
        (params.searchColumns?.length
          ? params.searchColumns.filter((c) => this.searchableColumns.includes(c))
          : this.searchableColumns) ?? []
      if (searchCols.length) {
        const table = this.getTable()
        await applyFulltextSearch(query, params.search, table, searchCols)
      }
    }

    // 4. Period filters
    if (params.period?.length) {
      for (const p of params.period) {
        if (!this.periodColumns.includes(p.column)) continue
        // Los valores se concatenan a ' 00:00:00' y viajan bindeados (no hay
        // inyección), pero un valor que no sea una fecha produce un literal
        // inválido y la DB responde con un error → 500 por un query string
        // mal formado. Se descarta, como el resto de entrada no reconocida.
        if (!isIsoDate(p.start) || !isIsoDate(p.end)) continue
        if (p.start && p.end) {
          query.whereBetween(p.column, [`${p.start} 00:00:00`, `${p.end} 23:59:59`])
        } else if (p.start) {
          query.where(p.column, '>=', `${p.start} 00:00:00`)
        } else if (p.end) {
          query.where(p.column, '<=', `${p.end} 23:59:59`)
        }
      }
    }

    // 5. Filtros estructurados (ver los tres modos de `allowedFilters`)
    if (params.filters) {
      const allowed = this.resolveAllowedFilters()
      query.where((qb: any) => applyFilters(qb, params.filters, allowed, 'and', this.filterLimits))
    }

    // 6. Sort
    if (params.orderBy) {
      const sortable = await this.getSortableColumns()
      if (sortable.includes(params.orderBy)) {
        query.orderBy(params.orderBy, params.orderDirection ?? 'asc')
      }
    }

    // 7. Custom filters (seam del consumer — jsonb, joins, scoping)
    if (this.applyCustomFilters) {
      await this.applyCustomFilters(query, params)
    }

    return { query }
  }

  /**
   * Pagina un query construido, o devuelve count/data según los flags.
   */
  protected async paginate(
    query: ModelQueryBuilderContract<TModel, InstanceType<TModel>>,
    params: QueryParams
  ): Promise<
    PaginatedResult<InstanceType<TModel>> | { count: number } | { data: InstanceType<TModel>[] }
  > {
    if (params.count === true) {
      const row = (await query.clone().count('* as total').first()) as any
      const total = row?.$extras?.total ?? row?.total ?? 0
      return { count: Number(total) }
    }

    const paginateFlag = params.paginate !== false
    if (!paginateFlag) {
      // El `limit` del cliente NUNCA amplía el techo del service: sin este
      // Math.min, `?paginate=false&limit=1e7` devuelve la tabla entera.
      const limit = Math.min(
        toPositiveInt(params.limit, this.maxUnpaginatedLimit),
        this.maxUnpaginatedLimit
      )
      const rows = (await query.limit(limit).exec()) as unknown as InstanceType<TModel>[]
      return { data: rows }
    }

    const perPage = Math.min(toPositiveInt(params.perPage, this.defaultPerPage), this.maxPerPage)
    const page = toPositiveInt(params.page, 1)
    const pageObj = await query.paginate(page, perPage)

    const meta: PaginationMeta = {
      total: pageObj.total,
      perPage: pageObj.perPage,
      currentPage: pageObj.currentPage,
      lastPage: pageObj.lastPage,
      firstPage: pageObj.firstPage,
      firstPageUrl: null,
      lastPageUrl: null,
      nextPageUrl: null,
      previousPageUrl: null,
    }

    if (params.paginationBaseUrl) {
      const baseQs = { ...(params.paginationExtraQs ?? {}) }
      const makeUrl = (n: number) =>
        `${params.paginationBaseUrl}?${qs.stringify({ ...baseQs, page: n }, { arrayFormat: 'indices' })}`
      meta.firstPageUrl = makeUrl(1)
      meta.lastPageUrl = makeUrl(meta.lastPage)
      meta.nextPageUrl = meta.currentPage < meta.lastPage ? makeUrl(meta.currentPage + 1) : null
      meta.previousPageUrl = meta.currentPage > 1 ? makeUrl(meta.currentPage - 1) : null
    }

    return { data: pageObj.all() as unknown as InstanceType<TModel>[], meta }
  }

  // ============================================================
  // Helpers reutilizables por subclases
  // ============================================================

  protected getTable(): string {
    const t = (this.model as any).table
    if (typeof t === 'function') return t()
    if (typeof t === 'string') return t
    throw new Error(`No se pudo detectar la tabla del modelo ${this.model.name}`)
  }

  /** Cache de columnas por instancia del service. */
  private _columnsCache?: string[]
  protected async getModelColumns(): Promise<string[]> {
    if (!this._columnsCache) this._columnsCache = await getColumns(this.model)
    return this._columnsCache
  }

  /**
   * Materializa `allowedFilters` a la lista que consume `applyFilters`:
   * el modo por modelo se resuelve leyendo la metadata de columnas (sin
   * tocar la DB) y se cachea por instancia.
   */
  private _allowedFiltersCache?: string[]
  protected resolveAllowedFilters(): ResolvedFilters {
    if (this.allowedFilters === ALLOW_ALL_FILTERS) return ALLOW_ALL_FILTERS
    if (this.allowedFilters === FILTERABLE_FROM_MODEL) {
      return (this._allowedFiltersCache ??= getSerializableColumns(this.model))
    }
    return this.allowedFilters as string[]
  }

  /**
   * Columnas por las que se puede ordenar: las reales de la tabla que ADEMÁS
   * el modelo serializa.
   *
   * Restringir solo a "columnas reales" evitaba la inyección pero dejaba un
   * oráculo: ordenar por un hash y paginar permite compararlo contra el resto
   * de filas y reconstruirlo por posición. Igual que en los filtros, el
   * criterio es *ordenable ⊆ visible*; `ALLOW_ALL_FILTERS` es el opt-in que
   * también levanta esta restricción.
   */
  private _sortableCache?: string[]
  protected async getSortableColumns(): Promise<string[]> {
    if (this._sortableCache) return this._sortableCache
    const cols = await this.getModelColumns()
    if (this.allowedFilters === ALLOW_ALL_FILTERS) {
      this._sortableCache = cols
    } else {
      const visible = getSerializableColumns(this.model)
      this._sortableCache = cols.filter((c) => visible.includes(c))
    }
    return this._sortableCache
  }

  /**
   * Resuelve los preloads efectivos de un método. `requested` es lo que llega
   * del cliente (`?with=`) y pasa por la whitelist; si no pide nada, se usan
   * los del service tal cual (esos son decisión suya, no del cliente).
   */
  protected resolveIncludes(
    requested: string[] | undefined,
    defaults: string[],
    method: IncludesMethod
  ): string[] {
    if (!requested) return defaults
    return filterIncludes(requested, this.resolveAllowedIncludes(defaults, method))
  }

  /**
   * Lo permitido en un método = lo que ese método ya precarga + lo que
   * `allowedIncludes` abra para él.
   *
   * Es ADITIVO a propósito: una relación que se precarga por defecto viaja en
   * la respuesta la pida el cliente o no, así que "prohibirla" no querría
   * decir nada. Y es POR MÉTODO porque el perfil de exposición no es el mismo:
   * traer las invitaciones de UNA organización es proporcionado; traer las de
   * las 25 de una página, con los emails de todos los invitados, es otra cosa.
   */
  private _allowedIncludesCache: Partial<Record<IncludesMethod, string[]>> = {}
  protected resolveAllowedIncludes(
    defaults: string[],
    method: IncludesMethod
  ): ResolvedIncludes {
    if (this.allowedIncludes === ALLOW_ALL_INCLUDES) return ALLOW_ALL_INCLUDES
    if (this.allowedIncludes === INCLUDES_FROM_SERVICE) return defaults

    const cached = this._allowedIncludesCache[method]
    if (cached) return cached

    const extra = Array.isArray(this.allowedIncludes)
      ? this.allowedIncludes
      : ((this.allowedIncludes as AllowedIncludesByMethod)[method] ?? [])

    return (this._allowedIncludesCache[method] = [...new Set([...defaults, ...extra])])
  }
}

export class RecordNotFoundError extends Error {
  /** El handler HTTP lo mapea a 404 (getStatus lee `status`); sin esto caía a 500. */
  public status = 404

  constructor(
    public table: string,
    public uuid: string
  ) {
    super(`Registro no encontrado en ${table} con uuid=${uuid}`)
    this.name = 'RecordNotFoundError'
  }
}
