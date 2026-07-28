/**
 * Modelos y esquema de prueba del paquete. Deliberadamente mínimos, pero con
 * las dos propiedades que la suite necesita ejercitar:
 *
 *  - una columna OCULTA (`password`, `serializeAs: null`) para probar que lo
 *    invisible tampoco es filtrable ni ordenable;
 *  - relaciones (belongsTo/hasMany) para probar los preloads y su whitelist.
 */

import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, hasMany, scope } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import type { Database } from '@adonisjs/lucid/database'

export class TestUser extends BaseModel {
  static table = 'test_users'
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare uuid: string

  @column()
  declare name: string

  @column()
  declare email: string

  /** Oculta en la serialización: el objetivo de los tests de exfiltración. */
  @column({ serializeAs: null })
  declare password: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => TestOrg, { foreignKey: 'createdByUserUuid' })
  declare organizations: HasMany<typeof TestOrg>
}

export class TestOrg extends BaseModel {
  static table = 'test_orgs'
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare uuid: string

  @column()
  declare name: string

  @column()
  declare taxId: string | null

  @column()
  declare createdByUserUuid: string

  /** Segunda columna oculta, esta vez sobre la tabla que más se lista. */
  @column({ serializeAs: null })
  declare internalNotes: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => TestUser, { foreignKey: 'createdByUserUuid' })
  declare createdByUser: BelongsTo<typeof TestUser>

  /** Scope real, para probar la whitelist `allowedScopes`. */
  static withTaxId = scope((query, value: boolean) => {
    if (value) query.whereNotNull('tax_id')
  })
}

export async function createSchema(db: Database): Promise<void> {
  const schema = db.connection().schema

  await schema.createTableIfNotExists('test_users', (table) => {
    table.string('uuid').primary()
    table.string('name').notNullable()
    table.string('email').notNullable()
    table.string('password').notNullable()
    table.timestamp('created_at')
    table.timestamp('updated_at')
  })

  await schema.createTableIfNotExists('test_orgs', (table) => {
    table.string('uuid').primary()
    table.string('name').notNullable()
    table.string('tax_id').nullable()
    table.string('created_by_user_uuid').notNullable()
    table.string('internal_notes').nullable()
    table.timestamp('created_at')
    table.timestamp('updated_at')
  })
}

export async function truncateAll(): Promise<void> {
  await TestOrg.query().delete()
  await TestUser.query().delete()
}

let counter = 0
/** Ids estables y ordenables, sin depender de un generador externo. */
export function nextUuid(prefix = 'id'): string {
  counter += 1
  return `${prefix}-${String(counter).padStart(6, '0')}`
}
