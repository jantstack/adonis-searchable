/**
 * El adaptador HTTP → QueryParams es puro: no necesita base ni HttpContext
 * real, solo un objeto con la forma que consume (`method/qs/all/url`).
 */

import { test } from '@japa/runner'
import { parseQueryParams } from '../src/parse_query_params.js'

function fakeRequest(qs: Record<string, any>, body?: Record<string, any>) {
  return {
    method: () => (body ? 'POST' : 'GET'),
    qs: () => qs,
    all: () => ({ ...qs, ...(body ?? {}) }),
    url: () => '/resources',
  } as any
}

test.group('parseQueryParams', () => {
  test('mapea las convenciones del query string', ({ assert }) => {
    const params = parseQueryParams(
      fakeRequest({
        search: '  acme  ',
        search_columns: ['name', 'tax_id'],
        page: '2',
        per_page: '50',
        order_by: 'created_at',
        order_direction: 'desc',
        with: 'owner,owner.profile',
        count: 'true',
      })
    )

    assert.equal(params.search, 'acme')
    assert.deepEqual(params.searchColumns, ['name', 'tax_id'])
    assert.equal(params.page, 2)
    assert.equal(params.perPage, 50)
    assert.equal(params.orderBy, 'created_at')
    assert.equal(params.orderDirection, 'desc')
    assert.deepEqual(params.includes, ['owner', 'owner.profile'])
    assert.isTrue(params.count)
  })

  test('order_direction fuera de asc/desc se descarta', ({ assert }) => {
    const params = parseQueryParams(fakeRequest({ order_direction: 'desc; drop table x' }))
    assert.isUndefined(params.orderDirection)
  })

  test('page/per_page/limit basura no se propagan', ({ assert }) => {
    const params = parseQueryParams(
      fakeRequest({ page: 'abc', per_page: '-3', limit: ['1', '2'] })
    )
    assert.isUndefined(params.page)
    assert.isUndefined(params.perPage)
    assert.isUndefined(params.limit)
  })

  test('valores numéricos válidos se truncan a entero', ({ assert }) => {
    const params = parseQueryParams(fakeRequest({ page: '2.9', limit: '10.5' }))
    assert.equal(params.page, 2)
    assert.equal(params.limit, 10)
  })

  test('en POST el body se mezcla con el query string', ({ assert }) => {
    const params = parseQueryParams(
      fakeRequest({}, { filters: { where: [{ field: 'name', value: 'x' }] } })
    )
    assert.deepEqual(params.filters, { where: [{ field: 'name', value: 'x' }] } as any)
    // Sin base URL en POST: los links de paginación solo aplican a GET.
    assert.isUndefined(params.paginationBaseUrl)
  })

  test('search vacío no genera condición', ({ assert }) => {
    assert.isUndefined(parseQueryParams(fakeRequest({ search: '   ' })).search)
  })
})
