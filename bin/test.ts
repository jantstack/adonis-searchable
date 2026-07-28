/**
 * Entrypoint de la suite del paquete. Corre sin proyecto Adonis y sin
 * Postgres: SQLite en memoria (ver tests/helpers/app.ts). Esto es lo que
 * permite que el paquete tenga CI propio en vez de depender de que alguien
 * se acuerde de correr la suite del chasis consumidor.
 *
 *   npm test
 */

import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'
import type { Database } from '@adonisjs/lucid/database'
import { bootApp } from '../tests/helpers/app.js'
import { createSchema } from '../tests/helpers/models.js'

processCLIArgs(process.argv.slice(2))

let db: Database

configure({
  files: ['tests/**/*.spec.ts'],
  plugins: [assert()],
  setup: [
    async () => {
      db = await bootApp()
      await createSchema(db)
    },
  ],
  // Sin esto el pool de SQLite mantiene vivo el event loop y el proceso no
  // termina nunca (la suite pasa, pero el job de CI se queda colgado).
  teardown: [async () => db?.manager.closeAll()],
})

// El teardown de Japa no llega a correr si un .spec.ts falla al importarse, y
// el pool abierto dejaría el job de CI colgado en vez de fallar. Este cierre
// es el cinturón sobre los tirantes.
run().finally(async () => {
  await db?.manager.closeAll()
})
