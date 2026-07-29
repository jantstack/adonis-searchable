# @jantstack/adonis-searchable

Generic **service layer for AdonisJS 7 + Lucid ORM**: paginated listing, multi-column fulltext search, declarative filters with a safe-by-default whitelist, date-range filters, sorting, preloads and Lucid scopes — all driven from the query string, none of it touching `HttpContext`.

Services stay testable in isolation and reusable from jobs, commands and other services. Controllers shrink to a few lines.

```ts
import { BaseService } from '@jantstack/adonis-searchable'
import Product from '#models/product'

export default class ProductsService extends BaseService<typeof Product> {
  protected model = Product
  protected searchableColumns = ['name', 'sku']
  protected allowedFilters = ['status', 'category_id', 'created_at']
  protected indexWith = ['category']
}
```

```ts
import { parseQueryParams } from '@jantstack/adonis-searchable'

export default class ProductsController {
  constructor(private service = new ProductsService()) {}

  async index({ request }: HttpContext) {
    return this.service.index(parseQueryParams(request))
  }
}
```

That's a full listing endpoint with pagination, search, filters and preloads.

---

## Table of contents

- [Install](#install)
- [Configuring a service](#configuring-a-service)
- [`index()` and the query string](#index-and-the-query-string)
- [Filters](#filters)
  - [Filter methods](#filter-methods)
  - [Field whitelist (safe by default)](#field-whitelist-safe-by-default)
  - [Operator whitelist](#operator-whitelist)
  - [Nesting with `orGroup` / `andGroup`](#nesting-with-orgroup--andgroup)
  - [JSON columns](#json-columns)
  - [Complexity ceilings](#complexity-ceilings)
- [Preload whitelist](#preload-whitelist)
- [Sorting](#sorting)
- [CRUD and lifecycle hooks](#crud-and-lifecycle-hooks)
- [Escape hatch: `applyCustomFilters`](#escape-hatch-applycustomfilters)
- [API reference](#api-reference)
- [Design notes](#design-notes)
- [Compatibility](#compatibility)

---

## Install

```bash
npm i @jantstack/adonis-searchable
```

Peer dependencies: `@adonisjs/core` ^7 and `@adonisjs/lucid` ^22. No provider to register and no config file — you extend a class and you're done.

Engine-agnostic: the package emits no engine-specific SQL, so Postgres, MySQL and SQLite all work. (Fulltext search uses `ILIKE` on Postgres and `LIKE` elsewhere; column introspection uses each engine's standard catalog.)

---

## Configuring a service

Every knob is a protected property on the subclass:

| Property | Default | What it does |
|---|---|---|
| `model` | *(required)* | The Lucid model the service operates on. |
| `searchableColumns` | `[]` | Columns scanned by `search`. Empty = search does nothing. |
| `allowedFilters` | serialized columns | Fields the client may filter by — see [below](#field-whitelist-safe-by-default). |
| `periodColumns` | `['created_at', 'updated_at']` | Columns allowed in date-range filters. |
| `indexWith` | `[]` | Relations preloaded by default in `index()`. |
| `showWith` | `[]` | Relations preloaded by default in `findOne()`. |
| `allowedIncludes` | per method: what that method preloads | What the *client* may request on top — see [below](#preload-whitelist). |
| `defaultPerPage` | `25` | Page size when the client doesn't send one. |
| `maxPerPage` | `100` | Ceiling for `perPage` — protects against `?perPage=100000`. |
| `maxUnpaginatedLimit` | `1000` | Row ceiling for `paginate: false` — the client's `limit` narrows it, never widens it. |
| `filterLimits` | depth 5, 100 conditions, 500 `whereIn` values | Complexity ceilings for client-supplied filters. |

---

## `index()` and the query string

`index(params)` accepts a `QueryParams` object. `parseQueryParams(request)` builds it from the HTTP request — it is the only piece of the package that knows about `HttpContext`, so services stay transport-agnostic (write another adapter for GraphQL or gRPC and nothing else changes). It reads the query string on `GET` and merges the body on `POST`/`PUT`, supporting these conventions:

```
?page=2&per_page=50
&search=acme&search_columns[]=name&search_columns[]=sku
&filters[where][0][field]=status&filters[where][0][op]==&filters[where][0][value]=active
&period_filters[0][column]=created_at&period_filters[0][start]=2026-01-01&period_filters[0][end]=2026-03-31
&order_by=created_at&order_direction=desc
&with=category,category.parent
&scopes[withStatus]=delivered
&count=true
&paginate=false&limit=500
```

Query-string key → `QueryParams` property: `per_page` → `perPage`, `search_columns[]` → `searchColumns`, `order_by`/`order_direction` → `orderBy`/`orderDirection`, `with` (CSV or array) → `includes`, `period_filters` → `period`. `search_input` is accepted as a legacy alias of `search`.

| Param | Type | Notes |
|---|---|---|
| `page` / `perPage` | number | `perPage` is clamped to `maxPerPage`. |
| `count` | boolean | Returns `{ count }` only — no rows, no meta. |
| `paginate` | boolean | `false` returns `{ data }` unpaginated (bounded by `limit`). |
| `limit` | number | Row cap when `paginate: false`. |
| `search` | string | Fulltext across `searchableColumns`. |
| `searchColumns` | string[] | Narrows the search to a subset (intersected with the whitelist). |
| `filters` | object \| object[] | See [Filters](#filters). |
| `period` | object[] | `{ column, start?, end? }`; `column` must be in `periodColumns` and the dates must be real `YYYY-MM-DD`. |
| `orderBy` / `orderDirection` | string | `orderBy` must be a real **and visible** column — see [Sorting](#sorting). |
| `includes` | string[] | Relations to preload; dot notation for nested (`profile.wallets`). Filtered by `allowedIncludes`. |
| `scopes` | object | Lucid scopes to apply: `{ withStatus: 'delivered' }`. |
| `paginationBaseUrl` / `paginationExtraQs` | string / object | Build absolute pagination links in `meta`. |

**Return shape:**

```ts
// default
{ data: Model[], meta: { total, perPage, currentPage, lastPage, firstPage, ...links } }
// count: true
{ count: number }
// paginate: false
{ data: Model[] }
```

---

## Filters

Filters are declarative and arrive from the client, so the package is **deny-by-default** in the two places that matter: which *fields* can be filtered, and which *operators* are allowed.

### Filter methods

Each key of a filter block is a method, each value an array of conditions:

| Family | Methods |
|---|---|
| Comparison | `where`, `orWhere` |
| Sets | `whereIn`, `orWhereIn`, `whereNotIn`, `orWhereNotIn` |
| Ranges | `whereBetween`, `orWhereBetween`, `whereNotBetween`, `orWhereNotBetween` |
| Nullability | `whereNull`, `orWhereNull`, `whereNotNull`, `orWhereNotNull` |
| JSON | `whereJsonContains`, `orWhereJsonContains`, `whereJsonLength`, `orWhereJsonLength` |

A condition is `{ field, op?, value?, values? }`. Anything unrecognized is skipped silently — by design, since the input is untrusted.

```ts
await service.index({
  filters: {
    where: [{ field: 'status', op: '=', value: 'active' }],
    whereIn: [{ field: 'category_id', values: [1, 2, 3] }],
    whereNotNull: [{ field: 'published_at' }],
  },
})
```

### Field whitelist (safe by default)

The guiding principle is **filterable ⊆ visible**: if a column already travels in the API response, filtering by it reveals nothing new.

| `allowedFilters` | Filterable | Use it when |
|---|---|---|
| *(not declared)* | columns the model serializes | internal CRUD, prototypes — safe with zero config |
| `['name', 'status']` | only those | public APIs: the filter contract stops following the schema |
| `[]` | nothing | endpoints that must not accept filters at all |
| `ALLOW_ALL_FILTERS` | every column, hidden ones included | internal tooling over non-sensitive models |

The default excludes anything marked `@column({ serializeAs: null })` — a password hash, for instance. **This matters**: a `like` filter over a hidden column is a blind exfiltration oracle. An attacker probes character by character (`$scrypt$a%`, `$scrypt$b%`…) and reads the answer from which rows come back. Excluding non-serialized columns closes that without any configuration on your part.

```ts
import { SearchableService, ALLOW_ALL_FILTERS } from '@jantstack/adonis-searchable'
import type { AllowedFilters } from '@jantstack/adonis-searchable'

class InternalAuditService extends SearchableService<typeof AuditRow> {
  protected model = AuditRow
  protected allowedFilters: AllowedFilters = ALLOW_ALL_FILTERS // explicit opt-in
}
```

The `: AllowedFilters` annotation is required — without it TypeScript widens the symbol and the assignment won't compile. Useful side effect: the opt-in is impossible to miss in code review.

### Operator whitelist

The `op` of a condition is interpolated raw into SQL by Knex, so only these pass: `=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `like`, `ilike`, `not like`, `not ilike`. Anything else (`op = "IS NULL OR 1=1 --"`) drops the condition instead of injecting it.

### Nesting with `orGroup` / `andGroup`

```ts
await service.index({
  filters: {
    where: [{ field: 'status', op: '=', value: 'active' }],
    orGroup: [
      { where: [{ field: 'priority', op: '>=', value: 8 }] },
      { where: [{ field: 'flagged', op: '=', value: true }] },
    ],
  },
})
// WHERE status = 'active' AND (priority >= 8 OR flagged = true)
```

Inside an `orGroup`, `where` conditions are rewritten to `orWhere` automatically. Nesting is recursive, and the field whitelist applies at every level.

### JSON columns

Use `->` to reach into a JSON path; the whitelist checks the **root** field:

```ts
{ where: [{ field: 'metadata->plan', op: '=', value: 'pro' }] }   // needs 'metadata' allowed
{ whereJsonLength: [{ field: 'tags', op: '>', value: 3 }] }
```

### Complexity ceilings

Filters are recursive and, on `POST`/`PUT`, they arrive in a JSON body with no depth limit of its own. Three ceilings bound the damage: **depth 5**, **100 applied conditions** per request, and **500 values** in a single `whereIn` (a condition count alone doesn't help — one `whereIn` with 100 000 values is still one condition). What exceeds them is dropped silently, like everything else in the filter pipeline. Raise or lower them per service:

```ts
protected filterLimits = { maxDepth: 8, maxConditions: 250, maxInValues: 1000 }
```

An oversized `whereIn` is dropped whole rather than truncated: a truncated set answers a question the client didn't ask, and does it silently.

---

## Preload whitelist

`?with=` is client input, so it gets the same treatment as filters. Two properties split the job:

- **`indexWith` / `showWith` say what the service loads.** They always apply — whether the client asks or not.
- **`allowedIncludes` says what the client may ask for on top.** Per method, and additive.

| `allowedIncludes` | Client may preload | Use it when |
|---|---|---|
| *(not declared)* | exactly what **that method** preloads | the common case — zero extra config |
| `{ index: ['tags'], show: ['tags', 'audit'] }` | that, plus the method's own preloads | opening the listing without opening the detail, or the reverse |
| `['tags']` | that, on both methods | the same extra everywhere |
| `ALLOW_ALL_INCLUDES` | any relation on the model | internal tooling; this was the implicit behaviour before 2.0.0 |

The default is **per method on purpose**. A relation listed only in `showWith` doesn't become requestable on the listing: fetching one organization's invitations is proportionate; fetching them for the 25 rows of a page — every invited person's email — is a different thing. Nothing stops you from opening it, but opening it has to be something you wrote.

The explicit forms are **additive**: you never repeat in `allowedIncludes` what is already in `indexWith` or `showWith`. A relation preloaded by default travels in the response whether the client asks for it or not, so "denying" it would mean nothing.

A requested path also passes if it is a **prefix** of an allowed one (`owner` when `owner.profile` is allowed) — asking for less is always fine. The reverse is not: `owner.profile` when only `owner` is allowed is one level deeper than anyone authorized.

Without any of this, `?with=owner` on a public listing pulls the entire related model into the response — including whatever that model serializes — and nested paths multiply the queries behind it.

---

## Sorting

`orderBy` must name a column that exists **and** that the model serializes. The first half is the SQL-injection guard; the second closes an oracle: sorting by a hidden column and paging through the results lets an attacker compare that value across rows and reconstruct it by position. Same principle as filters — *sortable ⊆ visible* — and `ALLOW_ALL_FILTERS` lifts both restrictions together.

`orderDirection` only ever reaches Knex as `asc` or `desc`.

---

## CRUD and lifecycle hooks

`BaseService` adds `create`, `update` and `destroy` on top of `SearchableService`, each with optional hooks and transaction support:

```ts
export default class OrdersService extends BaseService<typeof Order> {
  protected model = Order

  protected async beforeCreate(data: Partial<Order>) {
    data.reference ??= generateReference()
  }

  protected async afterCreate(record: Order, trx?: TransactionClientContract) {
    await this.notify(record, trx)
  }
}
```

Available hooks: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDestroy`, `afterDestroy`. All optional, all awaited, all receiving the transaction when one is passed.

`findOne(uuid, includes?)` returns `null` when the row doesn't exist; `findOneOrFail`, `update` and `destroy` throw `RecordNotFoundError` instead. It carries `status = 404`, so a standard AdonisJS exception handler maps it without extra wiring.

---

## Escape hatch: `applyCustomFilters`

For conditions the declarative system can't express — rich `jsonb`, joins, subqueries, tenant scoping — override the hook. It runs inside the same query builder, so it also constrains `count` and pagination:

```ts
export default class OrdersService extends BaseService<typeof Order> {
  protected model = Order

  protected async applyCustomFilters(query: ModelQueryBuilder, params: QueryParams) {
    query.whereRaw("metadata @> ?", [JSON.stringify({ region: this.region })])
  }
}
```

This is *your* code, not client input, so the field whitelist doesn't apply here — that's the point of the hatch. Keep any client-supplied value parameterized.

---

## API reference

```ts
// Functions
function parseQueryParams(request: HttpContext['request']): QueryParams

// Classes
class SearchableService<TModel> {
  index(params?: QueryParams): Promise<PaginatedResult<TModel> | { count: number } | { data: [] }>
  findOne(uuid: string, includes?: string[]): Promise<InstanceType<TModel> | null>
  findOneOrFail(uuid: string, includes?: string[]): Promise<InstanceType<TModel>>
  protected buildQuery(params: QueryParams): Promise<{ query: ModelQueryBuilder }>
  protected applyCustomFilters?(query, params): void | Promise<void>
}

class BaseService<TModel> extends SearchableService<TModel> {
  create(data, trx?): Promise<InstanceType<TModel>>
  update(uuid, data, trx?): Promise<InstanceType<TModel>>
  destroy(uuid, trx?): Promise<void>
}

class RecordNotFoundError extends Error { status = 404 }

// Sentinels
const ALLOW_ALL_FILTERS: unique symbol
const FILTERABLE_FROM_MODEL: unique symbol   // the default for allowedFilters
const ALLOW_ALL_INCLUDES: unique symbol
const INCLUDES_FROM_SERVICE: unique symbol   // the default for allowedIncludes

// Constants
const MAX_FILTER_DEPTH = 5
const MAX_FILTER_CONDITIONS = 100
const MAX_FILTER_IN_VALUES = 500

// Types
type AllowedFilters, AllowedIncludes, AllowedIncludesByMethod, IncludesMethod,
     FilterLimits, QueryParams, PaginatedResult, PaginationMeta, PeriodFilter,
     FilterBlock, FilterCondition, FilterMethod
```

---

## Design notes

**No `HttpContext`.** The service takes a plain object, so the same code serves an HTTP endpoint, a queue job, an `ace` command or another service. It's also what makes it testable without booting a server.

**Silent skipping over errors.** Unknown filter methods, non-whitelisted fields and unsafe operators are dropped, not rejected. Filters come from untrusted input; failing loudly turns every bad-faith query string into a 500. If your API needs explicit feedback, validate at the controller/validator layer.

**Column introspection is cached** per service instance: the `orderBy` guard reads the real table columns once; the default filter whitelist reads the model's own metadata and never touches the database.

**Every client-controlled surface has a whitelist.** Fields, operators, sort columns, preloads, scopes, search columns and every numeric bound. That symmetry is the point: a gap in one of them is worth more to an attacker than hardening the others further.

**The package tests itself.** `npm test` runs the full suite against in-memory SQLite — no Postgres, no migrations, no host application. CI runs it on Node 20, 22 and 24 before anything ships.

---

## Compatibility

| | |
|---|---|
| Node | ≥ 20.6 |
| AdonisJS | ^7 (peer) |
| Lucid | ^22 (peer) |
| Databases | PostgreSQL, MySQL, SQLite |
| Module format | ESM only |

---

## Scope and maintenance

Extracted from the [adonis7-base](https://github.com/JantStack/adonis7-base) chassis, where it runs in production-shaped projects. It is maintained according to that chassis's needs: bug fixes and small additions are welcome, larger feature requests may not fit the roadmap.

## License

MIT
