import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";
import {
  createBoutiqueSchema,
  updateBoutiqueSchema,
  updateBoutiqueCredentialsSchema,
  setModeSchema,
} from "#/modules/boutiques/boutique.validation.js";
import type {
  BoutiqueSchemaType,
} from "#/modules/boutiques/boutique.model.js";
import type {
  BoutiqueStatus,
  ConversationMode,
} from "#/modules/boutiques/boutique.types.js";
import { BOUTIQUE_STATUS } from "#/modules/boutiques/boutique.types.js";
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
    logger.info({ boutiqueId: id, mode }, "Boutique global mode updated");
  }

  return doc;
};
