import { mapAuditEventRow } from './writer.js';
import type { AuditEvent, AuditEventRow, Queryable } from './types.js';

export async function findAuditEventById(db: Queryable, id: string): Promise<AuditEvent | null> {
  const query = `
    SELECT *
    FROM audit_events
    WHERE id = $1
    LIMIT 1;
  `;

  const result = await db.query<AuditEventRow>(query, [id]);
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return mapAuditEventRow(row);
}

export async function findAuditEventsByEntity(
  db: Queryable,
  entityType: string,
  entityId: string,
): Promise<AuditEvent[]> {
  const query = `
    SELECT *
    FROM audit_events
    WHERE entity_type = $1 AND entity_id = $2
    ORDER BY occurred_at ASC, id ASC;
  `;

  const result = await db.query<AuditEventRow>(query, [entityType, entityId]);
  return result.rows.map(mapAuditEventRow);
}
