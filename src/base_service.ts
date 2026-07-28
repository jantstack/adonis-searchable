/**
 * BaseService<TModel> — extiende SearchableService con CRUD + hooks + soporte
 * de transacciones. Las subclases de dominio extienden esto.
 */

import type { BaseModel } from '@adonisjs/lucid/orm'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { SearchableService, RecordNotFoundError } from './searchable_service.js'

export abstract class BaseService<
  TModel extends typeof BaseModel,
> extends SearchableService<TModel> {
  // ============================================================
  // CRUD básico (hookable + transaccional)
  // ============================================================

  async create(
    data: Partial<InstanceType<TModel>>,
    trx?: TransactionClientContract
  ): Promise<InstanceType<TModel>> {
    await this.beforeCreate?.(data)
    const record = (await this.model.create(data as any, { client: trx })) as InstanceType<TModel>
    await this.afterCreate?.(record, trx)
    return record
  }

  async update(
    uuid: string,
    data: Partial<InstanceType<TModel>>,
    trx?: TransactionClientContract
  ): Promise<InstanceType<TModel>> {
    const pk = (this.model.primaryKey as string) || 'id'
    const query = this.model.query({ client: trx }).where(pk, uuid)
    const record = (await query.first()) as InstanceType<TModel> | null
    if (!record) throw new RecordNotFoundError(this.model.table ?? 'unknown', uuid)

    await this.beforeUpdate?.(record, data)
    record.merge(data as any)
    await record.save()
    await this.afterUpdate?.(record, trx)
    return record
  }

  async destroy(uuid: string, trx?: TransactionClientContract): Promise<void> {
    const pk = (this.model.primaryKey as string) || 'id'
    const query = this.model.query({ client: trx }).where(pk, uuid)
    const record = (await query.first()) as InstanceType<TModel> | null
    if (!record) throw new RecordNotFoundError(this.model.table ?? 'unknown', uuid)

    await this.beforeDestroy?.(record)
    await record.delete()
    await this.afterDestroy?.(uuid, trx)
  }

  // ============================================================
  // Hooks opcionales (subclases los sobreescriben)
  // ============================================================

  protected beforeCreate?(data: Partial<InstanceType<TModel>>): Promise<void> | void
  protected afterCreate?(
    record: InstanceType<TModel>,
    trx?: TransactionClientContract
  ): Promise<void> | void
  protected beforeUpdate?(
    record: InstanceType<TModel>,
    data: Partial<InstanceType<TModel>>
  ): Promise<void> | void
  protected afterUpdate?(
    record: InstanceType<TModel>,
    trx?: TransactionClientContract
  ): Promise<void> | void
  protected beforeDestroy?(record: InstanceType<TModel>): Promise<void> | void
  protected afterDestroy?(uuid: string, trx?: TransactionClientContract): Promise<void> | void
}
