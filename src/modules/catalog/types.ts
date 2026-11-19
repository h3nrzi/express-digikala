import type { ProductFamilyStatus } from './domain/status-machine.js';

export type { ProductFamilyStatus } from './domain/status-machine.js';

export interface CategoryAttributeSchema {
  id: string;
  category: string;
  requiredAttributes: string[];
  optionalAttributes: string[];
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryAttributeSchemaRow {
  id: string;
  category: string;
  required_attributes: string[] | string;
  optional_attributes: string[] | string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProductFamily {
  id: string;
  title: string;
  description: string | null;
  category: string;
  attributes: Record<string, unknown>;
  baseAttributes: Record<string, unknown>;
  status: ProductFamilyStatus;
  originalFamilyId: string | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductFamilyRow {
  id: string;
  title: string;
  description: string | null;
  category: string;
  attributes: Record<string, unknown> | string;
  status: ProductFamilyStatus;
  original_family_id: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProductFamilyParams {
  title: string;
  description?: string | null | undefined;
  category: string;
  attributes?: Record<string, unknown> | undefined;
  baseAttributes?: Record<string, unknown> | undefined;
  actorUserId?: string | null | undefined;
}

export interface UpdateProductFamilyParams {
  title?: string | undefined;
  description?: string | null | undefined;
  category?: string | undefined;
  attributes?: Record<string, unknown> | undefined;
  baseAttributes?: Record<string, unknown> | undefined;
  actorUserId?: string | null | undefined;
  reason?: string | null | undefined;
}

export interface ApproveProductFamilyParams {
  actorUserId?: string | null | undefined;
  reason?: string | null | undefined;
}

export interface CreateDraftFromApprovedFamilyParams {
  actorUserId?: string | null | undefined;
  title?: string | undefined;
  description?: string | null | undefined;
  attributes?: Record<string, unknown> | undefined;
  baseAttributes?: Record<string, unknown> | undefined;
  reason?: string | null | undefined;
}

export interface UpsertCategorySchemaParams {
  requiredAttributes: string[];
  optionalAttributes?: string[] | undefined;
  description?: string | null | undefined;
  actorUserId?: string | null | undefined;
}

export interface ListProductFamiliesFilter {
  status?: ProductFamilyStatus | undefined;
  category?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  items: T[];
  data: T[];
  pagination: PaginationMeta;
}
