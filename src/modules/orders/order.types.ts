// ─── Enums ───────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
] as const;

export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'] as const;

// 'manual' covers in-person / phone orders placed directly by staff
export const ORDER_CHANNELS = ['whatsapp', 'instagram', 'manual'] as const;

export const ORDER_NUMBER_PREFIX = 'ORD';

export type OrderStatus   = (typeof ORDER_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type OrderChannel  = (typeof ORDER_CHANNELS)[number];

export const ORDER_NOTE_KINDS = ['internal', 'system', 'customer_message'] as const;
export type OrderNoteKind = (typeof ORDER_NOTE_KINDS)[number];

// ─── Interfaces ───────────────────────────────────────────────────────────────

// Snapshot — captures product state at order time so renames / deletions
// never corrupt historical order data.
export interface OrderItemSnapshot {
  productId:   string;
  productName: string; // snapshotted — survives product renames
  productSlug: string; // snapshotted — useful for bot deep-links
  size:        string;
  color:       string;
  quantity:    number;
  unitPrice:   number;
  lineTotal:   number; // quantity × unitPrice — computed in service before persistence
}

// Structured note — answers who, when, what, and why without ambiguity.
// 'internal'         = staff-authored note.
// 'system'           = bot/automation-generated event.
// 'customer_message' = verbatim message logged from the customer (WhatsApp/Instagram).
// createdBy is the userId of the author; null for system-generated notes.
export interface OrderNote {
  message:   string;
  createdBy: string | null;
  kind:      OrderNoteKind;
  createdAt: string; // ISO — set server-side, never client-provided
}

export interface SafeOrder {
  id:               string;
  orderNumber:      string;
  customerId:       string | null; // nullable — bot may create order before customer record exists
  channel:          OrderChannel;
  status:           OrderStatus;
  paymentStatus:    PaymentStatus;
  items:            OrderItemSnapshot[];
  notes:            OrderNote[];   // append-only structured history
  subtotal:         number;        // sum of lineTotals (pre-discount)
  total:            number;        // post-discount / post-tax (equals subtotal in V1)
  inventoryApplied: boolean;       // guards against double-decrement; gates V2 reservation logic
  createdAt:        string;
  updatedAt:        string;
}

// Kept here (not in model.ts) to avoid circular dependency:
// types.ts ← model.ts is fine; types.ts → model.ts would be a cycle.
export interface IWithTimestamps {
  createdAt: Date;
  updatedAt: Date;
}