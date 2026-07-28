# Changelog

All notable changes to this package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

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
