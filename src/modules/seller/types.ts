import type { SellerStatus } from './domain/status-machine.js';

export interface SellerContact {
  phone?: string;
  email?: string;
  address?: string;
  postalCode?: string;
  [key: string]: unknown;
}

export interface Seller {
  id: string;
  name: string;
  taxpayerId: string;
  contact: SellerContact;
  status: SellerStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SellerRow {
  id: string;
  name: string;
  taxpayer_id: string;
  contact: SellerContact;
  status: SellerStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateSellerParams {
  name: string;
  taxpayerId: string;
  contact: SellerContact;
}

export interface TransitionSellerStatusParams {
  sellerId: string;
  newStatus: SellerStatus;
  actorUserId: string;
  reason?: string | null | undefined;
}

export interface ListSellersFilter {
  status?: SellerStatus | undefined;
}
