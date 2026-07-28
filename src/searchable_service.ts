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
import type { AllowedFilters, ResolvedFilters } from './helpers/apply_filters.js'
import { applyFulltextSearch } from './helpers/apply_search.js'
import { applyPreloads } from './helpers/apply_preloads.js'
import { getColumns, getSerializableColumns } from './helpers/column_types.js'

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

  /** Scopes Lucid permitidos: claves que pueden venir en `params.scopes`. */
  protected allowedScopes: string[] = []

  protected defaultPerPage: number = 25
  protected maxPerPage: number = 100

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
      applyPreloads(query, params.includes ?? this.indexWith)
    }
    return this.paginate(query, params)
  }

  async findOne(uuid: string, includes?: string[]): Promise<InstanceType<TModel> | null> {
    const pk = (this.model.primaryKey as string) || 'id'
    const query = this.model.query() as ModelQueryBuilderContract<TModel, InstanceType<TModel>>
    applyPreloads(query, includes ?? this.showWith)
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
        ;(query as any).withScopes((s: any) => {
          if (typeof s[scopeName] === 'function') s[scopeName](scopeArg)
        })
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
      query.where((qb: any) => applyFilters(qb, params.filters, allowed))
    }

    // 6. Sort
    if (params.orderBy) {
      // Solo aceptamos columnas conocidas — guard contra SQL injection vía orderBy.
      const cols = await this.getModelColumns()
      if (cols.includes(params.orderBy)) {
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
      const limit = params.limit ?? 1000
      const rows = (await query.limit(limit).exec()) as unknown as InstanceType<TModel>[]
      return { data: rows }
    }

    const perPage = Math.min(params.perPage ?? this.defaultPerPage, this.maxPerPage)
    const page = params.page ?? 1
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
      if (!this._allowedFiltersCache) {
        this._allowedFiltersCache = getSerializableColumns(this.model)
      }
      return this._allowedFiltersCache
    }
    return this.allowedFilters as string[]
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
