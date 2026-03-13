// ─── Enums ────────────────────────────────────────────────────────────────────

export const INVENTORY_OPERATIONS = {
  ADD: 'add',
  REMOVE: 'remove',
} as const;

export type InventoryOperation =
  (typeof INVENTORY_OPERATIONS)[keyof typeof INVENTORY_OPERATIONS];

// ─── Variant Reference ────────────────────────────────────────────────────────

// MVP assumption: within a product, size + color uniquely identifies a variant.
// V2 should replace this with variantId when variant complexity grows.
export type InventoryVariantRef = {
  size: string;
  color: string;
};

// ─── Key Input ────────────────────────────────────────────────────────────────

// Shared base for all inputs that target a specific product variant.
// Exported so service, validation, and resolver layers can reuse this shape.
export type InventoryKeyInput = {
  productId: string;
} & InventoryVariantRef;

// ─── Base + Entity ────────────────────────────────────────────────────────────

export type InventoryBase = InventoryKeyInput & {
  quantity: number;
  lowStockThreshold: number;
};

export type InventoryEntity = InventoryBase & {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
};

// ─── Response ─────────────────────────────────────────────────────────────────

// Note: V2 — isLowStock should be based on quantityAvailable (onHand - reserved)
// once the orders/reservations module is introduced
export type InventoryResponse = Omit<
  InventoryEntity,
  '_id' | 'createdAt' | 'updatedAt'
> & {
  id: string;
  isLowStock: boolean;  // computed: quantity <= lowStockThreshold
  createdAt: string;
  updatedAt: string;
};

// ─── Input Types ──────────────────────────────────────────────────────────────

export type AddStockInput = InventoryKeyInput & {
  quantity: number;
  // Optional on create — defaults to 3 if omitted.
  // If record already exists, only updates threshold when explicitly provided.
  lowStockThreshold?: number;
};

export type RemoveStockInput = InventoryKeyInput & {
  quantity: number;
};

// Returns all inventory records for a product across all variants
export type GetProductInventoryInput = {
  productId: string;
};

export type UpdateThresholdInput = InventoryKeyInput & {
  lowStockThreshold: number;
};