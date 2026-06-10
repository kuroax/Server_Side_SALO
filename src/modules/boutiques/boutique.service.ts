import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";
import {
  createBoutiqueSchema,
  updateBoutiqueSchema,
  updateBoutiqueCredentialsSchema,
  setModeSchema,
  updateAgentConfigSchema,
} from "#/modules/boutiques/boutique.validation.js";
import type {
  BoutiqueSchemaType,
} from "#/modules/boutiques/boutique.model.js";
import type {
  BoutiqueStatus,
  ConversationMode,
} from "#/modules/boutiques/boutique.types.js";
import { BOUTIQUE_STATUS } from "#/modules/boutiques/boutique.types.js";
import { invalidateBoutiqueCache } from "#/modules/boutiques/boutique.cache.js";
import { logger } from "#/config/logger.js";

// ─── Lean type ────────────────────────────────────────────────────────────────

export type BoutiqueLean = BoutiqueSchemaType & {
  _id: { toString(): string };
  createdAt: Date;
  updatedAt: Date;
};

// ─── Reads ────────────────────────────────────────────────────────────────────

// Used by the WhatsApp webhook handler on every incoming message. Filters by
// status "active" so suspended/inactive tenants do not get bot responses.
export const findBoutiqueByPhoneNumberId = async (
  phoneNumberId: string,
): Promise<BoutiqueLean | null> => {
  return BoutiqueModel.findOne({
    phoneNumberId,
    status: BOUTIQUE_STATUS.ACTIVE,
  }).lean<BoutiqueLean | null>();
};

// Use this instead of findBoutiqueByPhoneNumberId when accessToken is needed.
// Explicitly selects the token — it is select: false by default.
export const findBoutiqueByPhoneNumberIdWithToken = async (
  phoneNumberId: string,
): Promise<BoutiqueLean | null> => {
  return BoutiqueModel.findOne({
    phoneNumberId,
    status: BOUTIQUE_STATUS.ACTIVE,
  })
    .select("+accessToken")
    .lean<BoutiqueLean | null>();
};

export const findBoutiqueById = async (
  id: string,
): Promise<BoutiqueLean | null> => {
  return BoutiqueModel.findById(id).lean<BoutiqueLean | null>();
};

export const listBoutiques = async (): Promise<BoutiqueLean[]> => {
  return BoutiqueModel.find()
    .sort({ createdAt: -1 })
    .lean<BoutiqueLean[]>();
};

// ─── Create ───────────────────────────────────────────────────────────────────

export const createBoutique = async (
  input: unknown,
): Promise<BoutiqueLean> => {
  const data = createBoutiqueSchema.parse(input);

  const doc = await BoutiqueModel.create({
    ...data,
    // Zod outputs string for enum values — Mongoose 9 needs the domain type.
    globalMode: data.globalMode as ConversationMode | undefined,
    status: data.status as BoutiqueStatus | undefined,
  });

  logger.info(
    { boutiqueId: doc._id.toString(), phoneNumberId: doc.phoneNumberId },
    "Boutique created",
  );

  return doc.toObject() as BoutiqueLean;
};

// ─── Update ───────────────────────────────────────────────────────────────────

export const updateBoutique = async (
  id: string,
  input: unknown,
): Promise<BoutiqueLean | null> => {
  const data = updateBoutiqueSchema.parse(input);

  const doc = await BoutiqueModel.findByIdAndUpdate(
    id,
    {
      $set: {
        ...data,
        globalMode: data.globalMode as ConversationMode | undefined,
        status: data.status as BoutiqueStatus | undefined,
      },
    },
    { new: true, runValidators: true },
  ).lean<BoutiqueLean | null>();

  if (doc) {
    // Drop the cached boutique so the next WhatsApp message reads fresh config
    // (businessInfo, bankAccountImageUrl, ownerPhone, etc.) instead of stale.
    invalidateBoutiqueCache(id);
    logger.info({ boutiqueId: id }, "Boutique updated");
  }

  return doc;
};

// ─── Update credentials ───────────────────────────────────────────────────────
// Separate explicit path for credential rotations — keeps regular updates
// from accidentally overwriting Meta credentials.

export const updateBoutiqueCredentials = async (
  id: string,
  input: unknown,
): Promise<BoutiqueLean | null> => {
  const data = updateBoutiqueCredentialsSchema.parse(input);

  const doc = await BoutiqueModel.findByIdAndUpdate(
    id,
    { $set: data },
    { new: true, runValidators: true },
  ).lean<BoutiqueLean | null>();

  if (doc) {
    // Critical: drop the cache so the rotated accessToken / phoneNumberId is
    // used on the very next message. Without this the webhook keeps using the
    // stale token for up to the cache TTL and media downloads / alerts fail.
    invalidateBoutiqueCache(id);
    logger.info(
      { boutiqueId: id, phoneNumberId: doc.phoneNumberId },
      "Boutique credentials updated",
    );
  }

  return doc;
};

// ─── Set global mode ──────────────────────────────────────────────────────────

export const setBoutiqueGlobalMode = async (
  id: string,
  input: unknown,
): Promise<BoutiqueLean | null> => {
  const { mode } = setModeSchema.parse(input);

  const doc = await BoutiqueModel.findByIdAndUpdate(
    id,
    { $set: { globalMode: mode as ConversationMode } },
    { new: true, runValidators: true },
  ).lean<BoutiqueLean | null>();

  if (doc) {
    // Drop the cache so the globalMode kill switch takes effect on the next
    // message instead of after the cache TTL expires.
    invalidateBoutiqueCache(id);
    logger.info({ boutiqueId: id, mode }, "Boutique global mode updated");
  }

  return doc;
};

// ─── Agent config ─────────────────────────────────────────────────────────────
// Owner-app editing of the AI personality. Partial update: only supplied fields
// change; the rest are preserved. Snapshots the prior config into
// previousAgentConfig for one-click rollback and bumps agentConfigVersion.

type AgentConfigDoc = BoutiqueSchemaType["agentConfig"];

export const updateAgentConfig = async (
  boutiqueId: string,
  input: unknown,
  updatedBy: string,
): Promise<BoutiqueLean | null> => {
  const data = updateAgentConfigSchema.parse(input);

  // Load current config to snapshot it and to merge partial updates onto it.
  const current = await BoutiqueModel.findById(boutiqueId).lean<BoutiqueLean | null>();
  if (!current) {
    return null;
  }

  const existing = current.agentConfig;

  // Shallow merge; phrases is merged one level deep so a partial phrases update
  // does not wipe sibling phrase fields.
  const mergedAgentConfig = {
    ...existing,
    ...data,
    phrases:
      data.phrases !== undefined
        ? { ...(existing.phrases ?? {}), ...data.phrases }
        : existing.phrases,
  } as AgentConfigDoc;

  const doc = await BoutiqueModel.findByIdAndUpdate(
    boutiqueId,
    {
      $set: {
        agentConfig: mergedAgentConfig,
        previousAgentConfig: existing,
        agentConfigUpdatedAt: new Date(),
        agentConfigUpdatedBy: updatedBy,
      },
      $inc: { agentConfigVersion: 1 },
    },
    { new: true, runValidators: true },
  ).lean<BoutiqueLean | null>();

  if (doc) {
    logger.info(
      { boutiqueId, agentConfigVersion: doc.agentConfigVersion, updatedBy },
      "agentConfig updated",
    );
  }

  return doc;
};

// Swaps agentConfig ↔ previousAgentConfig and bumps the version. No-op (returns
// the unchanged doc) when there is no snapshot to restore.
export const rollbackAgentConfig = async (
  boutiqueId: string,
  requestedBy: string,
): Promise<BoutiqueLean | null> => {
  const current = await BoutiqueModel.findById(boutiqueId).lean<BoutiqueLean | null>();
  if (!current) {
    return null;
  }

  if (!current.previousAgentConfig) {
    logger.warn(
      { boutiqueId, requestedBy },
      "rollbackAgentConfig — no previous config to restore; returning current",
    );
    return current;
  }

  const doc = await BoutiqueModel.findByIdAndUpdate(
    boutiqueId,
    {
      $set: {
        agentConfig: current.previousAgentConfig as AgentConfigDoc,
        previousAgentConfig: current.agentConfig,
        agentConfigUpdatedAt: new Date(),
        agentConfigUpdatedBy: requestedBy,
      },
      $inc: { agentConfigVersion: 1 },
    },
    { new: true, runValidators: true },
  ).lean<BoutiqueLean | null>();

  if (doc) {
    logger.info(
      { boutiqueId, agentConfigVersion: doc.agentConfigVersion, requestedBy },
      "agentConfig rolled back",
    );
  }

  return doc;
};
