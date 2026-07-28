# @jantstack/adonis-searchable

Generic service layer for **AdonisJS 7 + Lucid**: paginated listing, fulltext search, declarative filters, period (date-range) filters and preloads — all without touching `HttpContext`, so services stay testable in isolation and reusable from jobs, commands and other services.

```ts
import { BaseService } from '@jantstack/adonis-searchable'
import Product from '#models/product'

export default class ProductsService extends BaseService<typeof Product> {
  protected model = Product
  protected searchableColumns = ['name', 'sku']
  protected indexWith = ['category']
}
```

That's a full CRUD + search service. The controller shrinks to a few lines:

```ts
export default class ProductsController {
  constructor(private service = new ProductsService()) {}

  async index({ request }: HttpContext) {
    return this.service.index(request.qs())
  }
}
```

## What you get

- **`index(params)`** — pagination (`page`, `perPage`), `count: true` for count-only, fulltext search across declared columns, declarative filters, date-range filters, sorting with a column guard, and default preloads.
- **`findOne(uuid, includes?)`**, **`create`**, **`update`**, **`destroy`** (from `BaseService`), with `RecordNotFoundError` carrying `status = 404`.
- **`applyCustomFilters(query, params)`** — an optional hook where a subclass injects conditions the declarative system doesn't cover (rich `jsonb`, joins, tenant scoping). Applied inside the same builder, so it also constrains `count`.

## Filters, safely

Filter conditions arrive from the query string, so the package is deny-by-default in the two places that matter.

**Operators** are whitelisted: an `op` outside the comparison set is dropped, never interpolated into SQL.

**Fields** follow the principle *filterable ⊆ visible*, in three modes:

| `allowedFilters` | Filterable | Use it when |
|---|---|---|
| *(not declared)* | columns the model serializes | internal CRUD, prototypes — safe with zero config |
| `['name', 'status']` | only those | public APIs: the contract stops following the schema |
| `[]` | nothing | endpoints that must not accept filters |
| `ALLOW_ALL_FILTERS` | every column, hidden ones included | internal tooling, no sensitive data |

The default excludes anything marked `@column({ serializeAs: null })` — a password hash, for instance. That matters: a `like` filter over a hidden column is a blind exfiltration oracle (probe character by character, watch which rows come back).

```ts
import { SearchableService, ALLOW_ALL_FILTERS } from '@jantstack/adonis-searchable'
import type { AllowedFilters } from '@jantstack/adonis-searchable'

class InternalAuditService extends SearchableService<typeof AuditRow> {
  protected model = AuditRow
  protected allowedFilters: AllowedFilters = ALLOW_ALL_FILTERS // explicit opt-in
}
```

The `: AllowedFilters` annotation is required — without it TypeScript widens the symbol and the assignment won't compile. Useful side effect: the opt-in is impossible to miss in review.

## Query string shape

```
?page=2&perPage=50
&search=acme&search_columns[]=name
&filters[where][0][field]=status&filters[where][0][op]==&filters[where][0][value]=active
&period_filters[0][column]=created_at&period_filters[0][start]=2026-01-01
&order_by=created_at&order_direction=desc
&includes[]=category
```

Filters support `orGroup`/`andGroup` nesting, `whereIn`, `whereBetween`, `whereNull`, and the `whereJson*` family (JSON paths via `field->key`).

## Install

```bash
npm i @jantstack/adonis-searchable
```

Peer dependencies: `@adonisjs/core` ^7 and `@adonisjs/lucid` ^22. Works with any Lucid-supported engine (Postgres, MySQL, SQLite) — the package issues no engine-specific SQL.

## License

MIT
