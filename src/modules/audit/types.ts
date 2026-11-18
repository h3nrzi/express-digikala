import type pg from 'pg';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow, I extends unknown[] = unknown[]>(
    queryTextOrConfig: string | pg.QueryConfig<I>,
    values?: I,
  ): Promise<pg.QueryResult<R>>;
}

export type ActorType = 'system' | 'user';

export interface RecordAuditEventParams {
  actorType: ActorType;
  actorId?: string | null | undefined;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: Record<string, unknown> | unknown[] | null | undefined;
  newValue?: Record<string, unknown> | unknown[] | null | undefined;
  reason?: string | null | undefined;
  linkedEventId?: string | null | undefined;
}

export interface AuditEvent {
  id: string;
  occurredAt: Date;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  previousValue: Record<string, unknown> | unknown[] | null;
  newValue: Record<string, unknown> | unknown[] | null;
  reason: string | null;
  linkedEventId: string | null;
}

export interface AuditEventRow {
  id: string;
  occurred_at: Date;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  previous_value: Record<string, unknown> | unknown[] | null;
  new_value: Record<string, unknown> | unknown[] | null;
  reason: string | null;
  linked_event_id: string | null;
}
