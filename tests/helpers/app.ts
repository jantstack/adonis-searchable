/**
 * Arranque autónomo de AdonisJS + Lucid para los tests del PAQUETE.
 *
 * El paquete depende de `@adonisjs/lucid/services/db` (un singleton que se
 * resuelve del contenedor), así que necesita una app booteada — pero no un
 * proyecto Adonis completo. Aquí se monta lo mínimo: contenedor, Database
 * sobre SQLite en memoria y emitter. Con esto la suite corre en CI sin
 * Postgres, sin migraciones y sin depender del chasis consumidor.
 *
 * Orden importante: `setApp()` ANTES de importar `services/db.js` — ese
 * módulo hace `await app.booted(...)` en su top-level.
 */

import { AppFactory } from '@adonisjs/core/factories/app'
import { setApp } from '@adonisjs/core/services/app'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import { BaseModel } from '@adonisjs/lucid/orm'
import { LoggerFactory } from '@adonisjs/core/factories/logger'

export async function bootApp(): Promise<Database> {
  const app = new AppFactory().create(new URL('../../', import.meta.url), () => {}) as any
  await app.init()
  setApp(app)

  const logger = new LoggerFactory().create()
  const emitter = new Emitter(app)

  const db = new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
          // SQLite en memoria vive dentro de UNA conexión: con pool > 1 cada
          // conexión vería su propia base vacía.
          pool: { min: 1, max: 1 },
        },
      },
    } as any,
    logger,
    emitter as any
  )

  app.container.singleton(Database, () => db)
  await app.boot()

  BaseModel.useAdapter(db.modelAdapter())

  return db
}
