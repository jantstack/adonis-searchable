/**
 * Barreras de seguridad del paquete.
 *
 * Cada grupo corresponde a un vector controlado por el cliente. El criterio
 * es el mismo en todos: lo que el cliente manda es una PETICIÓN, no una orden
 * — si no está permitido se descarta en silencio, nunca se ejecuta a medias.
 */

import { test } from '@japa/runner'
import { SearchableService } from '../src/searchable_service.js'
import { ALLOW_ALL_FILTERS } from '../src/helpers/apply_filters.js'
import type { AllowedFilters } from '../src/helpers/apply_filters.js'
import { ALLOW_ALL_INCLUDES } from '../src/helpers/apply_preloads.js'
import type { AllowedIncludes } from '../src/helpers/apply_preloads.js'
import { TestOrg, TestUser, nextUuid, truncateAll } from './helpers/models.js'

class PlainOrgService extends SearchableService<typeof TestOrg> {
  protected model = TestOrg
}

class PlainUserService extends SearchableService<typeof TestUser> {
  protected model = TestUser
}

class WhitelistedOrgService extends SearchableService<typeof TestOrg> {
  protected model = TestOrg
  protected allowedFilters: AllowedFilters = ['name', 'tax_id']
}

class NoFiltersOrgService extends SearchableService<typeof TestOrg> {
  protected model = TestOrg
  protected allowedFilters: AllowedFilters = []
}

class AllFiltersOrgService extends SearchableService<typeof TestOrg> {
  protected model = TestOrg
  protected allowedFilters: AllowedFilters = ALLOW_ALL_FILTERS
}

async function seed(): Promise<string> {
  const founder = await TestUser.create({
    uuid: nextUuid('user'),
    name: 'Founder',
    email: `founder-${nextUuid('e')}@example.test`,
    password: '$scrypt$secret-hash',
  })
  await TestOrg.create({
    uuid: nextUuid('org'),
    name: 'Acme',
    taxId: 'TAX-1',
    internalNotes: 'confidencial',
    createdByUserUuid: founder.uuid,
  })
  await TestOrg.create({
    uuid: nextUuid('org'),
    name: 'Beta',
    taxId: 'TAX-2',
    internalNotes: 'confidencial',
    createdByUserUuid: founder.uuid,
  })
  return founder.uuid
}

// ============================================================
// 1. Filtros: whitelist de campo y de operador
// ============================================================

test.group('filtros — whitelist de campo', (group) => {
  let founderUuid: string
  group.each.setup(async () => {
    await truncateAll()
    founderUuid = await seed()
  })

  test('default: filtra por columnas visibles sin declarar nada', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      filters: { where: [{ field: 'tax_id', op: '=', value: 'TAX-2' }] },
    })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Beta')
  })

  test('EXFILTRACIÓN: una columna oculta no es filtrable por defecto', async ({ assert }) => {
    // El ataque: sondear el hash carácter a carácter observando qué filas
    // vuelven. Si la condición se descarta, hit y miss son indistinguibles.
    const hit: any = await new PlainUserService().index({
      filters: { where: [{ field: 'password', op: 'like', value: '$scrypt%' }] },
    })
    const miss: any = await new PlainUserService().index({
      filters: { where: [{ field: 'password', op: 'like', value: 'zzzzz%' }] },
    })
    assert.equal(hit.meta.total, miss.meta.total)
    assert.equal(hit.meta.total, 1)
  })

  test('la whitelist también aplica dentro de orGroup', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      filters: {
        orGroup: [{ where: [{ field: 'internal_notes', op: 'like', value: 'confid%' }] }],
      } as any,
    })
    assert.equal(result.meta.total, 2)
  })

  test('whitelist explícita: los campos fuera de ella se descartan', async ({ assert }) => {
    const result: any = await new WhitelistedOrgService().index({
      filters: {
        where: [
          { field: 'name', op: '=', value: 'Acme' },
          { field: 'created_by_user_uuid', op: '=', value: 'no-existe' },
        ],
      },
    })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Acme')
  })

  test('lista VACÍA declarada: deny total de filtros del cliente', async ({ assert }) => {
    const result: any = await new NoFiltersOrgService().index({
      filters: { where: [{ field: 'name', op: '=', value: 'Acme' }] },
    })
    assert.equal(result.meta.total, 2)
  })

  test('ALLOW_ALL_FILTERS: opt-in que sí alcanza las columnas ocultas', async ({ assert }) => {
    const result: any = await new AllFiltersOrgService().index({
      filters: { where: [{ field: 'created_by_user_uuid', op: '=', value: founderUuid }] },
    })
    assert.equal(result.meta.total, 2)
  })
})

test.group('filtros — whitelist de operador', (group) => {
  group.each.setup(async () => {
    await truncateAll()
    await seed()
  })

  test('un op válido sigue filtrando', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      filters: { where: [{ field: 'name', op: '=', value: 'Acme' }] },
    })
    assert.equal(result.meta.total, 1)
  })

  test('un op malicioso se descarta y NO inyecta SQL', async ({ assert }) => {
    // Si el op se interpolara, `name = 'zzz' AND 1=0 --` daría 0 filas.
    // 2 filas confirma que la condición entera se descartó.
    const result: any = await new PlainOrgService().index({
      filters: { where: [{ field: 'name', op: "= 'zzz' AND 1=0 --", value: 'x' }] },
    })
    assert.equal(result.meta.total, 2)
  })
})

// ============================================================
// 2. Techos de complejidad de filtros (DoS)
// ============================================================

test.group('filtros — techos de complejidad', (group) => {
  group.each.setup(async () => {
    await truncateAll()
    await seed()
  })

  test('un anidamiento absurdo no desborda la pila', async ({ assert }) => {
    // El body de un POST no tiene límite de profundidad: sin techo, esto
    // recursa hasta reventar. Con techo, los niveles de más se descartan.
    let deep: any = { where: [{ field: 'name', op: '=', value: 'Acme' }] }
    for (let i = 0; i < 5000; i++) deep = { andGroup: [deep] }

    const result: any = await new PlainOrgService().index({ filters: deep })
    assert.equal(result.meta.total, 2)
  })

  test('miles de condiciones planas se recortan al techo', async ({ assert }) => {
    const many = Array.from({ length: 5000 }, () => ({
      field: 'name',
      op: '=' as const,
      value: 'Acme',
    }))
    const result: any = await new PlainOrgService().index({ filters: { where: many } })
    // Las primeras condiciones sí se aplican (todas equivalentes) → 1 fila.
    assert.equal(result.meta.total, 1)
  })

  test('un whereIn con un array desproporcionado se descarta', async ({ assert }) => {
    // El techo de condiciones no lo cubría: un solo whereIn cuenta como UNA
    // condición y puede llevar cien mil valores.
    const huge = Array.from({ length: 100_000 }, (_, i) => `nombre-${i}`)
    const result: any = await new PlainOrgService().index({
      filters: { whereIn: [{ field: 'name', values: huge }] },
    })
    assert.equal(result.meta.total, 2)
  })

  test('un whereIn de tamaño razonable sigue filtrando', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      filters: { whereIn: [{ field: 'name', values: ['Acme', 'no-existe'] }] },
    })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Acme')
  })

  test('una consulta normal no se ve afectada por los techos', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      filters: {
        orGroup: [
          { where: [{ field: 'name', op: '=', value: 'Acme' }] },
          { where: [{ field: 'name', op: '=', value: 'Beta' }] },
        ],
      },
    })
    assert.equal(result.meta.total, 2)
  })
})

// ============================================================
// 3. Period filters
// ============================================================

test.group('period filters', (group) => {
  group.each.setup(async () => {
    await truncateAll()
    await seed()
  })

  test('un rango válido filtra', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      period: [{ column: 'created_at', start: '2000-01-01', end: '2100-01-01' }],
    })
    assert.equal(result.meta.total, 2)
  })

  test('una columna fuera de periodColumns se descarta', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      period: [{ column: 'name', start: '2000-01-01' }],
    })
    assert.equal(result.meta.total, 2)
  })

  test('una fecha basura se descarta en vez de reventar la query', async ({ assert }) => {
    // Va bindeada (no hay inyección), pero un literal inválido hace que la DB
    // responda con error: un 500 por un query string mal formado.
    const result: any = await new PlainOrgService().index({
      period: [{ column: 'created_at', start: 'no-soy-una-fecha' }],
    })
    assert.equal(result.meta.total, 2)
  })

  test('una fecha con formato válido pero inexistente también se descarta', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      period: [{ column: 'created_at', start: '2026-02-31' }],
    })
    assert.equal(result.meta.total, 2)
  })
})

// ============================================================
// 4. orderBy
// ============================================================

test.group('orderBy', (group) => {
  group.each.setup(async () => {
    await truncateAll()
    await seed()
  })

  test('una columna válida ordena', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      orderBy: 'name',
      orderDirection: 'desc',
    })
    assert.equal(result.data[0].name, 'Beta')
  })

  test('una columna desconocida se ignora (guard anti-inyección)', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({
      orderBy: 'name; drop table test_orgs; --',
    })
    assert.equal(result.meta.total, 2)
  })

  test('ORÁCULO: no se puede ordenar por una columna oculta', async ({ assert }) => {
    // Ordenar por el hash + paginar permite compararlo contra el resto de
    // filas y reconstruirlo por posición. Ordenable debe ser ⊆ visible.
    await TestUser.create({
      uuid: nextUuid('user'),
      name: 'Otro',
      email: `otro-${nextUuid('e')}@example.test`,
      password: '$scrypt$aaaa',
    })

    const asc: any = await new PlainUserService().index({
      orderBy: 'password',
      orderDirection: 'asc',
    })
    const desc: any = await new PlainUserService().index({
      orderBy: 'password',
      orderDirection: 'desc',
    })
    // Si el orderBy se aplicara, asc y desc devolverían el orden invertido.
    assert.deepEqual(
      asc.data.map((u: any) => u.uuid),
      desc.data.map((u: any) => u.uuid)
    )
  })

  test('ALLOW_ALL_FILTERS también habilita ordenar por columnas ocultas', async ({ assert }) => {
    class AllUserService extends SearchableService<typeof TestUser> {
      protected model = TestUser
      protected allowedFilters: AllowedFilters = ALLOW_ALL_FILTERS
    }
    await TestUser.create({
      uuid: nextUuid('user'),
      name: 'Otro',
      email: `otro-${nextUuid('e')}@example.test`,
      password: '$scrypt$aaaa',
    })

    const asc: any = await new AllUserService().index({ orderBy: 'password', orderDirection: 'asc' })
    assert.equal(asc.data[0].password, '$scrypt$aaaa')
  })
})

// ============================================================
// 4. Preloads (?with=)
// ============================================================

test.group('preloads — whitelist de includes', (group) => {
  group.each.setup(async () => {
    await truncateAll()
    await seed()
  })

  test('el cliente NO puede precargar una relación que el service no declara', async ({
    assert,
  }) => {
    // `?with=createdByUser` sobre un listado que no lo declara arrastraría el
    // modelo relacionado entero en la respuesta.
    const result: any = await new PlainOrgService().index({ includes: ['createdByUser'] })
    assert.equal(result.meta.total, 2)
    assert.notExists(result.data[0].createdByUser)
  })

  test('sí puede precargar lo que el service declara en indexWith', async ({ assert }) => {
    class WithUserService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected indexWith = ['createdByUser']
    }
    const result: any = await new WithUserService().index({ includes: ['createdByUser'] })
    assert.exists(result.data[0].createdByUser)
  })

  test('los preloads por defecto del service se aplican sin pedirlos', async ({ assert }) => {
    class WithUserService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected indexWith = ['createdByUser']
    }
    const result: any = await new WithUserService().index({})
    assert.exists(result.data[0].createdByUser)
  })

  test('un path anidado más profundo que lo declarado se descarta', async ({ assert }) => {
    class WithUserService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected indexWith = ['createdByUser']
    }
    const result: any = await new WithUserService().index({
      includes: ['createdByUser.organizations'],
    })
    assert.equal(result.meta.total, 2)
    assert.notExists(result.data[0].createdByUser?.organizations)
  })

  test('lo que solo está en showWith NO abre el listado', async ({ assert }) => {
    // El perfil de exposición no es el mismo: traer la relación de UN registro
    // es proporcionado; traerla de los 25 de una página, no. Por eso la
    // whitelist es por método y no la unión de ambas listas.
    class SplitService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected showWith = ['createdByUser']
    }

    const listado: any = await new SplitService().index({ includes: ['createdByUser'] })
    assert.notExists(listado.data[0].createdByUser)

    const org = await TestOrg.query().firstOrFail()
    const detalle = await new SplitService().findOne(org.uuid, ['createdByUser'])
    assert.exists(detalle!.createdByUser)
  })

  test('allowedIncludes por método abre solo el que se indique', async ({ assert }) => {
    class IndexOnlyService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected allowedIncludes: AllowedIncludes = { index: ['createdByUser'] }
    }

    const listado: any = await new IndexOnlyService().index({ includes: ['createdByUser'] })
    assert.exists(listado.data[0].createdByUser)

    const org = await TestOrg.query().firstOrFail()
    const detalle = await new IndexOnlyService().findOne(org.uuid, ['createdByUser'])
    assert.notExists(detalle!.createdByUser)
  })

  test('allowedIncludes como lista simple aplica a los dos métodos', async ({ assert }) => {
    class BothService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected allowedIncludes: AllowedIncludes = ['createdByUser']
    }

    const listado: any = await new BothService().index({ includes: ['createdByUser'] })
    assert.exists(listado.data[0].createdByUser)

    const org = await TestOrg.query().firstOrFail()
    const detalle = await new BothService().findOne(org.uuid, ['createdByUser'])
    assert.exists(detalle!.createdByUser)
  })

  test('allowedIncludes es aditivo: no anula lo que el método ya precarga', async ({ assert }) => {
    // Declarar un extra no obliga a repetir los defaults del método.
    class AdditiveService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected indexWith = ['createdByUser']
      protected allowedIncludes: AllowedIncludes = { index: ['otraRelacion'] }
    }

    const result: any = await new AdditiveService().index({ includes: ['createdByUser'] })
    assert.exists(result.data[0].createdByUser)
  })

  test('ALLOW_ALL_INCLUDES devuelve el comportamiento permisivo', async ({ assert }) => {
    class OpenService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected allowedIncludes: AllowedIncludes = ALLOW_ALL_INCLUDES
    }
    const result: any = await new OpenService().index({ includes: ['createdByUser'] })
    assert.exists(result.data[0].createdByUser)
  })

  test('findOne aplica la misma whitelist', async ({ assert }) => {
    class ShowService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected showWith = ['createdByUser']
    }
    const org = await TestOrg.query().firstOrFail()

    const allowed = await new ShowService().findOne(org.uuid, ['createdByUser'])
    assert.exists(allowed!.createdByUser)

    class ClosedService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
    }
    const denied = await new ClosedService().findOne(org.uuid, ['createdByUser'])
    assert.notExists(denied!.createdByUser)
  })
})

// ============================================================
// 5. Paginación y límites
// ============================================================

test.group('paginación — límites', (group) => {
  group.each.setup(async () => {
    await truncateAll()
    const founderUuid = await seed()
    for (let i = 0; i < 30; i++) {
      await TestOrg.create({
        uuid: nextUuid('org'),
        name: `Bulk ${i}`,
        createdByUserUuid: founderUuid,
      })
    }
  })

  test('perPage se acota a maxPerPage', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({ perPage: 100000 })
    assert.equal(result.data.length, 32)
    assert.equal(result.meta.perPage, 100)
  })

  test('VOLCADO: paginate=false con limit absurdo se acota', async ({ assert }) => {
    class SmallDumpService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected maxUnpaginatedLimit = 5
    }
    const result: any = await new SmallDumpService().index({ paginate: false, limit: 10_000_000 })
    assert.equal(result.data.length, 5)
  })

  test('paginate=false sin limit usa el techo del service', async ({ assert }) => {
    class SmallDumpService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected maxUnpaginatedLimit = 5
    }
    const result: any = await new SmallDumpService().index({ paginate: false })
    assert.equal(result.data.length, 5)
  })

  test('un limit razonable se respeta tal cual', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({ paginate: false, limit: 3 })
    assert.equal(result.data.length, 3)
  })

  test('page/perPage basura no llegan a la DB', async ({ assert }) => {
    // `Number('abc')` es NaN: sin saneo llega a paginate() y revienta con un
    // error de SQL → 500 donde debería haber un listado normal.
    const result: any = await new PlainOrgService().index({
      page: Number.NaN,
      perPage: Number.NaN,
    })
    assert.equal(result.meta.currentPage, 1)
    assert.equal(result.meta.perPage, 25)
  })

  test('page/perPage negativos se normalizan', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({ page: -5, perPage: -10 })
    assert.equal(result.meta.currentPage, 1)
    assert.isAbove(result.meta.perPage, 0)
  })

  test('limit negativo en paginate=false no rompe', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({ paginate: false, limit: -1 })
    assert.isArray(result.data)
  })
})
