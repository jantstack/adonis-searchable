/**
 * Aplicador recursivo de preloads (relaciones anidadas) sobre un query.
 * Deduplica y agrupa por padre para evitar preloads duplicados.
 */

/**
 * Sentinel de opt-in explícito: el cliente puede precargar CUALQUIER relación
 * del modelo. Era el comportamiento implícito hasta 2.0.0 — con él, un
 * `?with=owner` sobre un listado público arrastra el modelo relacionado
 * entero en la respuesta, sin que el service lo haya autorizado.
 * Ver `SearchableService.allowedIncludes`.
 */
export const ALLOW_ALL_INCLUDES = Symbol('searchable:allow-all-includes')

/**
 * Modo por defecto: precargable = lo que el service ya declara en `indexWith`
 * y `showWith`. Es la intención del autor expresada donde ya la escribía, así
 * que el caso normal no necesita ni una línea extra.
 */
export const INCLUDES_FROM_SERVICE = Symbol('searchable:includes-from-service')

/** Lo que se escribe en `allowedIncludes`. */
export type AllowedIncludes =
  | string[]
  | typeof ALLOW_ALL_INCLUDES
  | typeof INCLUDES_FROM_SERVICE

/** Whitelist ya resuelta (lo que recibe `filterIncludes`). */
export type ResolvedIncludes = string[] | typeof ALLOW_ALL_INCLUDES

/**
 * Recorta una lista de relaciones pedidas por el cliente a las permitidas.
 *
 * Un path pedido pasa si está en la whitelist o si es un PREFIJO de alguno de
 * sus paths (pedir `owner` cuando se permite `owner.profile` expone menos, no
 * más). Lo contrario no vale: pedir `owner.profile` cuando solo se permite
 * `owner` es bajar un nivel que nadie autorizó.
 */
export function filterIncludes(requested: string[], allowed: ResolvedIncludes): string[] {
  if (allowed === ALLOW_ALL_INCLUDES) return requested
  return requested.filter((path) =>
    allowed.some((entry) => entry === path || entry.startsWith(`${path}.`))
  )
}

export function applyPreloads(query: any, relations: string[] | undefined): void {
  if (!relations?.length) return

  const normalized = relations
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .map((r) => r.trim())
  if (normalized.length === 0) return

  // Si tenemos `a.b` y `a`, mantenemos solo `a.b` (el preload anidado
  // implica el padre).
  const deduped = normalized.filter((r) => {
    const prefix = `${r}.`
    return !normalized.some((s) => s !== r && s.startsWith(prefix))
  })

  const simple: string[] = []
  const byParent = new Map<string, string[]>()
  for (const relation of deduped) {
    const dotIdx = relation.indexOf('.')
    if (dotIdx === -1) {
      simple.push(relation)
    } else {
      const parent = relation.slice(0, dotIdx)
      const childPath = relation.slice(dotIdx + 1)
      const children = byParent.get(parent) ?? []
      children.push(childPath)
      byParent.set(parent, children)
    }
  }

  for (const rel of simple) query.preload(rel)
  for (const [parent, childrenPaths] of byParent) {
    query.preload(parent, (subQuery: any) => applyPreloads(subQuery, childrenPaths))
  }
}
