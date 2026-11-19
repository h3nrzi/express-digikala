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

export interface SuspendSellerParams {
  sellerId: string;
  actorUserId: string;
  reason: string;
}

export interface SuspendSellerResult {
  seller: Seller;
  affectedOffersCount: number;
}

export interface ReinstateSellerParams {
  sellerId: string;
  actorUserId: string;
  reason?: string | null | undefined;
}

export interface ReinstateSellerResult {
  seller: Seller;
  affectedOffersCount: number;
}

export interface Offer {
  id: string;
  sellerId: string;
  variantId: string;
  price: number;
  status: 'active' | 'deactivated' | 'pending-inventory' | 'held-for-review';
  isPurchasable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicCatalogOffer {
  id: string;
  variantId: string;
  price: number;
  seller: {
    id: string;
    name: string;
  };
}

export interface CreateOfferParams {
  sellerId: string;
  variantId: string;
  price: number;
  status?: 'active' | 'deactivated' | 'pending-inventory' | 'held-for-review';
  isPurchasable?: boolean;
}

export interface ListSellersFilter {
  status?: SellerStatus | undefined;
}
