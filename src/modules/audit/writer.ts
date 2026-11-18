import { ValidationError } from '../../errors.js';
import type { AuditEvent, AuditEventRow, Queryable, RecordAuditEventParams } from './types.js';

export function mapAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: new Date(row.occurred_at),
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    previousValue: row.previous_value,
    newValue: row.new_value,
    reason: row.reason,
    linkedEventId: row.linked_event_id,
  };
}

export async function recordAuditEvent(
  db: Queryable,
  params: RecordAuditEventParams,
): Promise<AuditEvent> {
  const actorType = params.actorType?.trim();
  if (!actorType) {
    throw new ValidationError('actorType is required for recording an audit event');
  }

  const action = params.action?.trim();
  if (!action) {
    throw new ValidationError('action is required for recording an audit event');
  }

  const entityType = params.entityType?.trim();
  if (!entityType) {
    throw new ValidationError('entityType is required for recording an audit event');
  }

  const entityId = params.entityId?.trim();
  if (!entityId) {
    throw new ValidationError('entityId is required for recording an audit event');
  }

  const actorId = params.actorId ?? null;
  const reason = params.reason ?? null;
  const linkedEventId = params.linkedEventId ?? null;

  const previousValueJson =
    params.previousValue !== undefined && params.previousValue !== null
      ? JSON.stringify(params.previousValue)
      : null;

  const newValueJson =
    params.newValue !== undefined && params.newValue !== null
      ? JSON.stringify(params.newValue)
      : null;

  const occurredAt = params.occurredAt ?? null;

  let insertQuery: string;
  let values: unknown[];

  if (occurredAt) {
    insertQuery = `
      INSERT INTO audit_events (
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        previous_value,
        new_value,
        reason,
        linked_event_id,
        occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
    `;
    values = [
      actorType,
      actorId,
      action,
      entityType,
      entityId,
      previousValueJson,
      newValueJson,
      reason,
      linkedEventId,
      occurredAt,
    ];
  } else {
    insertQuery = `
      INSERT INTO audit_events (
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        previous_value,
        new_value,
        reason,
        linked_event_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    values = [
      actorType,
      actorId,
      action,
      entityType,
      entityId,
      previousValueJson,
      newValueJson,
      reason,
      linkedEventId,
    ];
  }

  const result = await db.query<AuditEventRow>(insertQuery, values);
  const row = result.rows[0];

  if (!row) {
    throw new Error('Failed to record audit event: No row returned from database');
  }

  return mapAuditEventRow(row);
}
