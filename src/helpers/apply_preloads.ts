/**
 * Aplicador recursivo de preloads (relaciones anidadas) sobre un query.
 * Deduplica y agrupa por padre para evitar preloads duplicados.
 */

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
