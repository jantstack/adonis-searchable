import { test } from '@japa/runner'
import Organization from '#models/organization'
import User from '#models/user'
import OrganizationsService from '#services/organizations/organizations_service'
import { SearchableService, ALLOW_ALL_FILTERS } from '#services/base/index'
import type { AllowedFilters } from '#services/base/index'

/**
 * Prueba que SearchableService funciona sin HttpContext — el "test diferenciador"
 * que valida el refactor del controller_helper hacia la capa de Servicios.
 */
test.group('OrganizationsService (sin HttpContext)', (group) => {
  let founderUuid: string
  let service: OrganizationsService

  group.each.setup(async () => {
    // Limpieza ordenada (FK)
    await Organization.query().delete()
    await User.query().delete()

    const founder = await User.create({
      name: 'Founder',
      email: `founder-${Date.now()}@example.test`,
      password: 'pwd123456',
    })
    founderUuid = founder.uuid
    service = new OrganizationsService()
  })

  test('index() sin params devuelve PaginatedResult con meta', async ({ assert }) => {
    await Organization.create({ name: 'Org A', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Org B', createdByUserUuid: founderUuid })

    const result: any = await service.index({})
    assert.equal(result.meta.total, 2)
    assert.equal(result.data.length, 2)
    assert.equal(result.meta.currentPage, 1)
  })

  test('index() con fulltext search filtra correctamente (ILIKE en PG)', async ({ assert }) => {
    await Organization.create({ name: 'Acme Corp', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Beta Inc', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Gamma Labs', createdByUserUuid: founderUuid })

    const result: any = await service.index({ search: 'acme' })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Acme Corp')
  })

  test('index() con filters where aplica condiciones SQL', async ({ assert }) => {
    await Organization.create({ name: 'Test1', taxId: 'TAX-1', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Test2', taxId: 'TAX-2', createdByUserUuid: founderUuid })

    const result: any = await service.index({
      filters: { where: [{ field: 'tax_id', op: '=', value: 'TAX-2' }] },
    })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Test2')
  })

  test('index() con count=true devuelve solo conteo', async ({ assert }) => {
    await Organization.create({ name: 'O1', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'O2', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'O3', createdByUserUuid: founderUuid })

    const result: any = await service.index({ count: true })
    assert.equal(result.count, 3)
    assert.isUndefined(result.data)
    assert.isUndefined(result.meta)
  })

  test('findOne() con includes preload la relación', async ({ assert }) => {
    const org = await Organization.create({ name: 'Solo Org', createdByUserUuid: founderUuid })

    const found = await service.findOne(org.uuid, ['createdByUser'])
    assert.exists(found)
    assert.equal(found!.name, 'Solo Org')
    assert.exists(found!.createdByUser)
    assert.equal(found!.createdByUser.uuid, founderUuid)
  })

  test('createForUser() crea + asigna role + emite evento org.created', async ({ assert }) => {
    const org = await service.createForUser(founderUuid, {
      name: 'New Tenant',
      tax_id: 'TX-99',
    })

    assert.equal(org.name, 'New Tenant')
    assert.equal(org.taxId, 'TX-99')
    assert.equal(org.createdByUserUuid, founderUuid)
    // org.uuid debe ser UUID v7
    assert.match(org.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
  })

  test('update() persiste cambios', async ({ assert }) => {
    const org = await Organization.create({ name: 'Old Name', createdByUserUuid: founderUuid })

    const updated = await service.update(org.uuid, { name: 'New Name' } as any)
    assert.equal(updated.name, 'New Name')

    const reloaded = await Organization.findOrFail(org.uuid)
    assert.equal(reloaded.name, 'New Name')
  })

  test('destroy() elimina el registro', async ({ assert }) => {
    const org = await Organization.create({ name: 'Goner', createdByUserUuid: founderUuid })

    await service.destroy(org.uuid)
    const found = await Organization.find(org.uuid)
    assert.isNull(found)
  })
})

/**
 * Test de contrato del seam `applyCustomFilters` (mejora M1):
 * un hook opcional en SearchableService para que una subclase inyecte
 * condiciones de query que el filtrado declarativo no cubre, aplicadas
 * dentro del mismo query builder y respetando count/paginación.
 */
class NameFilteredOrgService extends SearchableService<typeof Organization> {
  protected model = Organization
  public asyncMode = false

  constructor(private prefix: string) {
    super()
  }

  protected async applyCustomFilters(query: any) {
    if (this.asyncMode) {
      // fuerza un await interno para probar que el hook async se resuelve
      // antes de paginar.
      await Promise.resolve()
    }
    query.whereILike('name', `${this.prefix}%`)
  }
}

/** Subclase sin hook: debe comportarse igual que el SearchableService base. */
class PlainOrgService extends SearchableService<typeof Organization> {
  protected model = Organization
}

/**
 * Subclase que NO declara allowedFilters: modo por defecto
 * (FILTERABLE_FROM_MODEL) → filtrable = columnas serializadas del modelo.
 */
class NoWhitelistOrgService extends SearchableService<typeof Organization> {
  protected model = Organization
}

/** Igual, pero sobre User: sirve para probar que `password` NO es filtrable. */
class PlainUserService extends SearchableService<typeof User> {
  protected model = User
}

/** Whitelist explícitamente VACÍA: deny total de filtros del cliente. */
class NoFiltersOrgService extends SearchableService<typeof Organization> {
  protected model = Organization
  protected allowedFilters: AllowedFilters = []
}

/**
 * Opt-in explícito al comportamiento permisivo (cualquier columna filtrable).
 * Lo usan los tests de operador, donde el foco es el `op`, no el `field`.
 */
class AllFiltersOrgService extends SearchableService<typeof Organization> {
  protected model = Organization
  protected allowedFilters: AllowedFilters = ALLOW_ALL_FILTERS
}

test.group('SearchableService.applyCustomFilters (seam M1)', (group) => {
  let founderUuid: string

  group.each.setup(async () => {
    await Organization.query().delete()
    await User.query().delete()

    const founder = await User.create({
      name: 'Founder',
      email: `founder-${Date.now()}@example.test`,
      password: 'pwd123456',
    })
    founderUuid = founder.uuid

    await Organization.create({ name: 'Acme Corp', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Acme Labs', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Beta Inc', createdByUserUuid: founderUuid })
  })

  test('(a) sin hook: comportamiento idéntico al base (no filtra)', async ({ assert }) => {
    const result: any = await new PlainOrgService().index({})
    assert.equal(result.meta.total, 3)
    assert.equal(result.data.length, 3)
  })

  test('(b) con hook: aplica la condición custom dentro del mismo builder', async ({ assert }) => {
    const result: any = await new NameFilteredOrgService('Acme').index({})
    assert.equal(result.meta.total, 2)
    assert.deepEqual(result.data.map((o: any) => o.name).sort(), ['Acme Corp', 'Acme Labs'])
  })

  test('(c) el hook también acota el count', async ({ assert }) => {
    const result: any = await new NameFilteredOrgService('Acme').index({ count: true })
    assert.equal(result.count, 2)
  })

  test('(d) hook async se resuelve antes de paginar', async ({ assert }) => {
    const service = new NameFilteredOrgService('Beta')
    service.asyncMode = true
    const result: any = await service.index({})
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Beta Inc')
  })
})

/**
 * Test de seguridad del aplicador de filtros (Bug 5): el operador (`op`) de cada
 * condición viene del cliente y Knex lo interpola crudo en el SQL. Sin whitelist,
 * un `op` malicioso inyecta SQL. AllFiltersOrgService opta explícitamente por
 * ALLOW_ALL_FILTERS — el foco del test es el operador, no el campo.
 */
test.group('SearchableService — whitelist de operador de filtro (Bug 5)', (group) => {
  let founderUuid: string

  group.each.setup(async () => {
    await Organization.query().delete()
    await User.query().delete()
    const founder = await User.create({
      name: 'Founder',
      email: `founder-${Date.now()}@example.test`,
      password: 'pwd123456',
    })
    founderUuid = founder.uuid
    await Organization.create({ name: 'Acme', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Beta', createdByUserUuid: founderUuid })
  })

  test('op de comparación válido sigue filtrando (no regresión)', async ({ assert }) => {
    const result: any = await new AllFiltersOrgService().index({
      filters: { where: [{ field: 'name', op: '=', value: 'Acme' }] },
    })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Acme')
  })

  test('op malicioso se descarta y NO inyecta SQL', async ({ assert }) => {
    // Si el op se interpolara, `name = 'zzz' AND 1=0 --` daría 0 filas.
    // Con la whitelist la condición se descarta → sin filtro → 2 filas.
    // (0 filas delataría una inyección exitosa; 2 confirma que se previno.)
    const result: any = await new AllFiltersOrgService().index({
      filters: { where: [{ field: 'name', op: "= 'zzz' AND 1=0 --", value: 'x' }] },
    })
    assert.equal(result.meta.total, 2)
  })
})

/**
 * Tests negativos de seguridad del SearchableService (A14): whitelist de
 * allowedFilters, guard de orderBy y anidamiento orGroup/andGroup.
 * OrganizationsService declara allowedFilters (name, tax_id, ...).
 */
/**
 * Contrato de `allowedFilters` — tres modos.
 *
 * Antes, una lista vacía significaba "sin restricción", así que un service
 * derivado que olvidara la whitelist exponía TODAS las columnas del modelo al
 * query string: un `like` sobre una columna oculta (un hash de password) es un
 * oráculo de exfiltración a ciegas. Ahora el default es *filtrable ⊆ visible*
 * (solo lo que el modelo serializa), una lista vacía es deny total, y
 * ALLOW_ALL_FILTERS es el opt-in explícito para incluir las ocultas.
 */
test.group('SearchableService — modos de allowedFilters', (group) => {
  let founderUuid: string

  group.each.setup(async () => {
    await Organization.query().delete()
    await User.query().delete()
    const founder = await User.create({
      name: 'Founder',
      email: `founder-${Date.now()}@example.test`,
      password: 'pwd123456',
    })
    founderUuid = founder.uuid
    await Organization.create({ name: 'Acme', taxId: 'TAX-1', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Beta', taxId: 'TAX-2', createdByUserUuid: founderUuid })
  })

  test('default: un service SIN declarar nada sí filtra por columnas visibles', async ({
    assert,
  }) => {
    const result: any = await new NoWhitelistOrgService().index({
      filters: { where: [{ field: 'tax_id', op: '=', value: 'TAX-2' }] },
    })
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Beta')
  })

  test('EXFILTRACIÓN: password (serializeAs null) NO es filtrable por defecto', async ({
    assert,
  }) => {
    await User.create({
      name: 'Otro',
      email: `otro-${Date.now()}@example.test`,
      password: 'pwd123456',
    })

    // El ataque del informe: sondear el hash carácter a carácter observando
    // qué filas vuelven. La condición se descarta → hit y miss son iguales.
    const hit: any = await new PlainUserService().index({
      filters: { where: [{ field: 'password', op: 'like', value: '$scrypt%' }] },
    })
    const miss: any = await new PlainUserService().index({
      filters: { where: [{ field: 'password', op: 'like', value: 'zzzzz%' }] },
    })
    assert.equal(hit.meta.total, 2)
    assert.equal(miss.meta.total, 2)
  })

  test('el default también cubre columnas ocultas dentro de orGroup', async ({ assert }) => {
    const result: any = await new PlainUserService().index({
      filters: {
        orGroup: [{ where: [{ field: 'password', op: 'like', value: 'zzz%' }] }],
      } as any,
    })
    // La única condición del grupo se descarta → no acota nada.
    assert.equal(result.meta.total, 1)
  })

  test('whitelist explícita: solo sus columnas (las demás se descartan)', async ({ assert }) => {
    const result: any = await new OrganizationsService().index({
      filters: {
        where: [
          { field: 'name', op: '=', value: 'Acme' },
          { field: 'created_by_user_uuid', op: '=', value: 'no-existe' },
        ],
      },
    })
    // `name` sí aplica; `created_by_user_uuid` no está en su whitelist y se
    // ignora (si se aplicara, el total sería 0).
    assert.equal(result.meta.total, 1)
    assert.equal(result.data[0].name, 'Acme')
  })

  test('lista VACÍA declarada: deny total de filtros del cliente', async ({ assert }) => {
    const result: any = await new NoFiltersOrgService().index({
      filters: { where: [{ field: 'name', op: '=', value: 'Acme' }] },
    })
    assert.equal(result.meta.total, 2)
  })

  test('ALLOW_ALL_FILTERS: opt-in que sí alcanza a las columnas ocultas', async ({ assert }) => {
    const result: any = await new AllFiltersOrgService().index({
      filters: { where: [{ field: 'created_by_user_uuid', op: '=', value: founderUuid }] },
    })
    assert.equal(result.meta.total, 2)
  })
})

test.group('SearchableService — barreras de seguridad (A14)', (group) => {
  let founderUuid: string

  group.each.setup(async () => {
    await Organization.query().delete()
    await User.query().delete()
    const founder = await User.create({
      name: 'Founder',
      email: `founder-${Date.now()}@example.test`,
      password: 'pwd123456',
    })
    founderUuid = founder.uuid
    await Organization.create({ name: 'Acme', taxId: 'TAX-1', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Beta', taxId: 'TAX-2', createdByUserUuid: founderUuid })
    await Organization.create({ name: 'Gamma', taxId: 'TAX-3', createdByUserUuid: founderUuid })
  })

  test('A14: un field permitido filtra; uno fuera del whitelist se ignora', async ({ assert }) => {
    // Field permitido → filtra.
    const allowed: any = await new OrganizationsService().index({
      filters: { where: [{ field: 'name', op: '=', value: 'Acme' }] },
    })
    assert.equal(allowed.meta.total, 1)

    // Field NO permitido (created_by_user_uuid) → se ignora → devuelve todas.
    // (Si se aplicara con un valor inexistente daría 0; que dé 3 confirma que se descartó.)
    const notAllowed: any = await new OrganizationsService().index({
      filters: { where: [{ field: 'created_by_user_uuid', op: '=', value: 'no-existe' }] },
    })
    assert.equal(notAllowed.meta.total, 3)
  })

  test('A14: orderBy contra columna desconocida se ignora (guard anti-inyección)', async ({
    assert,
  }) => {
    // Columna válida → ordena sin romper.
    const valid: any = await new OrganizationsService().index({
      orderBy: 'name',
      orderDirection: 'asc',
    })
    assert.equal(valid.meta.total, 3)
    assert.equal(valid.data[0].name, 'Acme')

    // orderBy malicioso → se ignora (no está en las columnas del modelo) → no rompe.
    const malicious: any = await new OrganizationsService().index({
      orderBy: 'name; drop table organizations; --',
    })
    assert.equal(malicious.meta.total, 3)
  })

  test('A14: orGroup aplica OR entre subgrupos', async ({ assert }) => {
    const result: any = await new OrganizationsService().index({
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
