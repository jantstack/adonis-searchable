# Changelog

All notable changes to this package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-07-29

### Security

- **Preload whitelist (`allowedIncludes`).** `?with=` was the only
  client-controlled surface without one: the client could preload *any*
  relation of the model, pulling related records the endpoint never meant to
  expose and multiplying the queries behind them. Now the client may only ask
  for relations the service already declares (`indexWith` / `showWith`);
  `ALLOW_ALL_INCLUDES` restores the previous behaviour explicitly. The
  service's own default preloads are unaffected.
- **`paginate: false` is bounded.** `limit` came straight from the client with
  no ceiling, so `?paginate=false&limit=10000000` dumped the whole table in one
  response and hydrated every row as a Lucid model. The client's `limit` now
  narrows `maxUnpaginatedLimit` (default 1000) and never widens it.
- **Sorting follows *sortable ⊆ visible*.** `orderBy` was validated against
  every real column, so a hidden column could not be filtered but *could* be
  sorted by — and sorting plus paging reconstructs a value by position. It is
  now intersected with the columns the model serializes.
- **Complexity ceilings on filters** (`filterLimits`): depth 5, 100 applied
  conditions and 500 values per `whereIn`, by default. On `POST`/`PUT` the
  filter tree arrives in a JSON body with no depth limit of its own; unbounded
  recursion blew the stack and thousands of flat conditions generated a
  disproportionate query. The per-`whereIn` ceiling closes the gap the other
  two left open: one `whereIn` carrying 100 000 values still counts as a
  single condition.

### Fixed

- Numeric query params (`page`, `per_page`, `limit`) are validated in the
  parser and re-checked in the service: `?page=abc` produced `NaN`, which
  reached `paginate()` and surfaced as a 500 instead of a normal listing.
- Period-filter bounds must now be real `YYYY-MM-DD` dates. They were always
  passed as bindings (no injection), but a non-date produced an invalid
  literal and the database's error surfaced as a 500 — for a malformed query
  string, which should simply be ignored like every other unrecognized input.
- The `allowedScopes` guard was dead code: Lucid's `withScopes` proxy throws
  when a scope name doesn't exist on the model, before the `typeof` check
  inside the callback could run. Existence is now checked on the model.
- Postgres column introspection now filters by `table_schema =
  current_schema()`. In a multi-schema database, homonymous tables returned
  mixed columns — which also widened the sortable whitelist.

### Added

- The package now has **its own test suite and CI**: 58 tests against
  in-memory SQLite, no host application and no Postgres required
  (`npm test`), run on Node 20/22/24. Previously the suite lived in the
  consumer chassis and could not verify the package on its own.

### Upgrading

Only the preload whitelist can change existing behaviour. If a controller
relies on `?with=` for relations that the service does not list in `indexWith`
or `showWith`, add them to one of those (or to `allowedIncludes`). Everything
else either tightens a bound that legitimate clients don't reach or fixes a
500.

## [1.0.1] — 2026-07-28

### Changed

- Repository, homepage and issue URLs updated to the `JantStack` GitHub
  account (the previous handle no longer applies). Metadata only — no code
  changes.

## [1.0.0] — 2026-07-28

First release, extracted from the [adonis7-base](https://github.com/JantStack/adonis7-base)
chassis where the module had been developed and hardened.

### Added

- `SearchableService`: paginated `index()` with multi-column fulltext search,
  declarative filters, date-range filters, sorting with a column guard,
  preloads and Lucid scopes — all without `HttpContext`.
- `BaseService`: `create` / `update` / `destroy` with optional lifecycle hooks
  and transaction support.
- `applyCustomFilters(query, params)` seam for conditions the declarative
  system doesn't cover (rich `jsonb`, joins, tenant scoping), applied inside
  the same builder so it also constrains `count`.
- `RecordNotFoundError` carrying `status = 404`.

### Security

- **Field whitelist is safe by default** (`filterable ⊆ visible`): without an
  explicit `allowedFilters`, only the columns the model serializes can be
  filtered. Columns marked `@column({ serializeAs: null })` — a password hash,
  for instance — are never filterable, closing a blind exfiltration oracle
  (probe a hidden column with `like`, read the answer from which rows return).
  `ALLOW_ALL_FILTERS` is the explicit opt-in for the permissive behaviour.
- **Operator whitelist**: the `op` of each condition is interpolated raw into
  SQL by Knex, so anything outside the comparison set drops the condition
  instead of injecting it.
- **`orderBy` guard**: sorting is validated against the real table columns.
