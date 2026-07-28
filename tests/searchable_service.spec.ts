/**
 * Suite de contrato de SearchableService/BaseService.
 *
 * Antes vivía en el chasis consumidor (importaba `#models/organization`), lo
 * que dejaba al paquete sin verificación propia. Ahora corre contra modelos
 * de prueba y SQLite en memoria: `npm test` dentro del paquete basta.
 */

import { test } from '@japa/runner'
import { SearchableService } from '../src/searchable_service.js'
import { BaseService } from '../src/base_service.js'
import { ALLOW_ALL_FILTERS } from '../src/helpers/apply_filters.js'
import type { AllowedFilters } from '../src/helpers/apply_filters.js'
import { TestOrg, TestUser, nextUuid, truncateAll } from './helpers/models.js'

class OrgService extends BaseService<typeof TestOrg> {
  protected model = TestOrg
  protected searchableColumns = ['name', 'tax_id']
  protected allowedFilters: AllowedFilters = ['name', 'tax_id']
  // Declarar la relación aquí es lo que autoriza al cliente a pedirla con
  // `?with=createdByUser` (ver allowedIncludes).
  protected showWith = ['createdByUser']
}

/** Sin nada declarado: modo por defecto (FILTERABLE_FROM_MODEL). */
class PlainOrgService extends SearchableService<typeof TestOrg> {
  protected model = TestOrg
}

class NameFilteredOrgService extends SearchableService<typeof TestOrg> {
  protected model = TestOrg
  public asyncMode = false

  constructor(private prefix: string) {
    super()
  }

  protected async applyCustomFilters(query: any) {
    if (this.asyncMode) await Promise.resolve()
    query.whereILike('name', `${this.prefix}%`)
  }
}

async function seedFounder(): Promise<string> {
  const founder = await TestUser.create({
    uuid: nextUuid('user'),
    name: 'Founder',
    email: `founder-${nextUuid('e')}@example.test`,
    password: '$scrypt$secret-hash',
  })
  return founder.uuid
}

test.group('SearchableService — listado', (group) => {
  let founderUuid: string

  group.each.setup(async () => {
    await truncateAll()
    founderUuid = await seedFounder()
  })

  test('index() sin params devuelve PaginatedResult con meta', async ({ assert }) => {
    await TestOrg.create({ uuid: nextUuid('org'), name: 'Org A', createdByUserUuid: founderUuid })
    await TestOrg.create({ uuid: nextUuid('org'), name: 'Org B', createdByUserUuid: founderUuid })

    const result: any = await new OrgService().index({})
    assert.equal(result.meta.total, 2)
    assert.equal(result.data.length, 2)
    assert.equal(result.meta.currentPage, 1)
  })

  test('index() con fulltext search filtra por las columnas declaradas', async ({ assert }) => {
    await TestOrg.create({ uuid: nextUuid('org'), name: 'Acme Corp', createdByUserUuid: founderUuid })
    await TestOrg.create({ uuid: nextUuid('org'), name: 'Beta Inc', createdByUserUuid: founderUuid })

    const result: any = await new OrgService().index({ search: 'acme' })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Acme Corp')
  })

  test('search_columns del cliente se intersecta con searchableColumns', async ({ assert }) => {
    await TestOrg.create({
      uuid: nextUuid('org'),
      name: 'Acme',
      taxId: 'TAX-9',
      createdByUserUuid: founderUuid,
    })
    await TestOrg.create({ uuid: nextUuid('org'), name: 'Beta', createdByUserUuid: founderUuid })

    // `internal_notes` no está en searchableColumns → se descarta; queda tax_id.
    const result: any = await new OrgService().index({
      search: 'TAX-9',
      searchColumns: ['tax_id', 'internal_notes'],
    })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Acme')
  })

  test('index() con filters where aplica condiciones SQL', async ({ assert }) => {
    await TestOrg.create({
      uuid: nextUuid('org'),
      name: 'Test1',
      taxId: 'TAX-1',
      createdByUserUuid: founderUuid,
    })
    await TestOrg.create({
      uuid: nextUuid('org'),
      name: 'Test2',
      taxId: 'TAX-2',
      createdByUserUuid: founderUuid,
    })

    const result: any = await new OrgService().index({
      filters: { where: [{ field: 'tax_id', op: '=', value: 'TAX-2' }] },
    })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Test2')
  })

  test('index() con count=true devuelve solo conteo', async ({ assert }) => {
    for (const n of ['O1', 'O2', 'O3']) {
      await TestOrg.create({ uuid: nextUuid('org'), name: n, createdByUserUuid: founderUuid })
    }

    const result: any = await new OrgService().index({ count: true })
    assert.equal(result.count, 3)
    assert.isUndefined(result.data)
    assert.isUndefined(result.meta)
  })

  test('findOne() con includes precarga la relación', async ({ assert }) => {
    const org = await TestOrg.create({
      uuid: nextUuid('org'),
      name: 'Solo Org',
      createdByUserUuid: founderUuid,
    })

    const found = await new OrgService().findOne(org.uuid, ['createdByUser'])
    assert.exists(found)
    assert.equal(found!.name, 'Solo Org')
    assert.exists(found!.createdByUser)
    assert.equal(found!.createdByUser.uuid, founderUuid)
  })

  test('findOneOrFail() lanza RecordNotFoundError con status 404', async ({ assert }) => {
    await assert.rejects(() => new OrgService().findOneOrFail('no-existe'))
    try {
      await new OrgService().findOneOrFail('no-existe')
    } catch (error: any) {
      assert.equal(error.status, 404)
      assert.equal(error.name, 'RecordNotFoundError')
    }
  })
})

test.group('BaseService — CRUD', (group) => {
  let founderUuid: string

  group.each.setup(async () => {
    await truncateAll()
    founderUuid = await seedFounder()
  })

  test('create() persiste y dispara los hooks', async ({ assert }) => {
    const seen: string[] = []
    class HookedService extends OrgService {
      protected async beforeCreate() {
        seen.push('before')
      }
      protected async afterCreate() {
        seen.push('after')
      }
    }

    const org = await new HookedService().create({
      uuid: nextUuid('org'),
      name: 'Created',
      createdByUserUuid: founderUuid,
    } as any)

    assert.equal(org.name, 'Created')
    assert.deepEqual(seen, ['before', 'after'])
  })

  test('update() persiste cambios', async ({ assert }) => {
    const org = await TestOrg.create({
      uuid: nextUuid('org'),
      name: 'Old Name',
      createdByUserUuid: founderUuid,
    })

    const updated = await new OrgService().update(org.uuid, { name: 'New Name' } as any)
    assert.equal(updated.name, 'New Name')

    const reloaded = await TestOrg.findOrFail(org.uuid)
    assert.equal(reloaded.name, 'New Name')
  })

  test('destroy() elimina el registro', async ({ assert }) => {
    const org = await TestOrg.create({
      uuid: nextUuid('org'),
      name: 'Goner',
      createdByUserUuid: founderUuid,
    })

    await new OrgService().destroy(org.uuid)
    assert.isNull(await TestOrg.find(org.uuid))
  })

  test('update() de un uuid inexistente lanza 404, no 500', async ({ assert }) => {
    await assert.rejects(() => new OrgService().update('no-existe', { name: 'x' } as any))
  })
})

/**
 * Seam `applyCustomFilters`: hook opcional para condiciones que el filtrado
 * declarativo no cubre (jsonb, joins, scoping por tenant), aplicadas dentro
 * del mismo builder y por tanto respetadas por count y paginación.
 */
test.group('SearchableService.applyCustomFilters', (group) => {
  group.each.setup(async () => {
    await truncateAll()
    const founderUuid = await seedFounder()
    for (const n of ['Acme Corp', 'Acme Labs', 'Beta Inc']) {
      await TestOrg.create({ uuid: nextUuid('org'), name: n, createdByUserUuid: founderUuid })
    }
  })

  test('sin hook: comportamiento idéntico al base (no filtra)', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({})
    assert.equal(result.meta.total, 3)
  })

  test('con hook: aplica la condición dentro del mismo builder', async ({ assert }) => {
    const result: any = await new NameFilteredOrgService('Acme').index({})
    assert.equal(result.meta.total, 2)
    assert.deepEqual(result.data.map((o: any) => o.name).sort(), ['Acme Corp', 'Acme Labs'])
  })

  test('el hook también acota el count', async ({ assert }) => {
    const result: any = await new NameFilteredOrgService('Acme').index({ count: true })
    assert.equal(result.count, 2)
  })

  test('hook async se resuelve antes de paginar', async ({ assert }) => {
    const service = new NameFilteredOrgService('Beta')
    service.asyncMode = true
    const result: any = await service.index({})
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Beta Inc')
  })
})

test.group('SearchableService — scopes', (group) => {
  group.each.setup(async () => {
    await truncateAll()
    const founderUuid = await seedFounder()
    await TestOrg.create({
      uuid: nextUuid('org'),
      name: 'Acme',
      taxId: 'TAX-1',
      createdByUserUuid: founderUuid,
    })
    await TestOrg.create({ uuid: nextUuid('org'), name: 'Beta', createdByUserUuid: founderUuid })
  })

  test('un scope no declarado en allowedScopes se ignora', async ({ assert }) => {
    class NoScopesService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
    }
    const result: any = await new NoScopesService().index({ scopes: { withTaxId: true } })
    assert.equal(result.meta.total, 2)
  })

  test('un scope declarado sí se aplica', async ({ assert }) => {
    class ScopedService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected allowedScopes = ['withTaxId']
    }
    const result: any = await new ScopedService().index({ scopes: { withTaxId: true } })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Acme')
  })

  test('un scope declarado que NO existe en el modelo se ignora, no revienta', async ({
    assert,
  }) => {
    class BrokenScopeService extends SearchableService<typeof TestOrg> {
      protected model = TestOrg
      protected allowedScopes = ['scopeQueNoExiste']
    }
    const result: any = await new BrokenScopeService().index({
      scopes: { scopeQueNoExiste: true },
    })
    assert.equal(result.meta.total, 2)
  })
})

export { OrgService, PlainOrgService, ALLOW_ALL_FILTERS }
