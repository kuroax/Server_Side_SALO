import { Types } from "mongoose";
import { ProspectModel } from "./prospect.model.js";
import {
  PROSPECT_STAGES,
  type PipelineSummary,
  type ProspectDTO,
  type ProspectLean,
  type ProspectStage,
  type StageHistoryEntry,
} from "./prospect.types.js";
import { NotFoundError } from "#/shared/errors/index.js";

// ─── Mapper ───────────────────────────────────────────────────────────────────

const toDTO = (doc: ProspectLean): ProspectDTO => ({
  id: doc._id.toString(),
  boutiqueId: doc.boutiqueId.toString(),
  customerPhone: doc.customerPhone,
  customerName: doc.customerName,
  stage: doc.stage,
  stageHistory: (doc.stageHistory ?? []).map((h) => ({
    stage: h.stage,
    changedAt: h.changedAt.toISOString(),
    note: h.note,
  })),
  notes: doc.notes ?? [],
  totalMessages: doc.totalMessages,
  firstContactAt: doc.firstContactAt.toISOString(),
  lastContactAt: doc.lastContactAt.toISOString(),
  convertedToCustomerId: doc.convertedToCustomerId?.toString(),
  estimatedValue: doc.estimatedValue,
  tags: doc.tags ?? [],
  isArchived: doc.isArchived,
});

// ─── Register / update ──────────────────────────────────────────────────────

// Called on every inbound message. Creates the prospect on first contact,
// otherwise bumps the message counter and lastContactAt. Returns isNew so the
// caller can fire a "new prospect" owner alert exactly once.
export const registerOrUpdateProspect = async (
  boutiqueId: string,
  customerPhone: string,
  customerName?: string,
): Promise<{ prospect: ProspectDTO; isNew: boolean }> => {
  const existing = await ProspectModel.findOne({
    boutiqueId,
    customerPhone,
  }).lean<ProspectLean | null>();

  if (existing) {
    const set: Record<string, unknown> = { lastContactAt: new Date() };
    if (!existing.customerName && customerName) {
      set.customerName = customerName;
    }

    const updated = await ProspectModel.findOneAndUpdate(
      { boutiqueId, customerPhone },
      { $inc: { totalMessages: 1 }, $set: set },
      { new: true },
    ).lean<ProspectLean | null>();

    if (!updated) {
      throw new NotFoundError("Prospect not found");
    }

    return { prospect: toDTO(updated), isNew: false };
  }

  const now = new Date();
  const created = await ProspectModel.create({
    boutiqueId: new Types.ObjectId(boutiqueId),
    customerPhone,
    customerName,
    stage: "nuevo",
    stageHistory: [{ stage: "nuevo", changedAt: now }],
    totalMessages: 1,
    firstContactAt: now,
    lastContactAt: now,
  });

  return {
    prospect: toDTO(created.toObject() as unknown as ProspectLean),
    isNew: true,
  };
};

// ─── Stage transitions ────────────────────────────────────────────────────────

export const advanceProspectStage = async (
  boutiqueId: string,
  customerPhone: string,
  stage: ProspectStage,
  note?: string,
): Promise<ProspectDTO> => {
  const now = new Date();
  const entry: StageHistoryEntry = { stage, changedAt: now };
  if (note) {
    entry.note = note;
  }

  const updated = await ProspectModel.findOneAndUpdate(
    { boutiqueId, customerPhone },
    { $set: { stage, lastContactAt: now }, $push: { stageHistory: entry } },
    { new: true },
  ).lean<ProspectLean | null>();

  if (!updated) {
    throw new NotFoundError("Prospect not found");
  }

  return toDTO(updated);
};

export const addNoteToProspect = async (
  boutiqueId: string,
  customerPhone: string,
  note: string,
): Promise<ProspectDTO> => {
  const updated = await ProspectModel.findOneAndUpdate(
    { boutiqueId, customerPhone },
    { $push: { notes: note } },
    { new: true },
  ).lean<ProspectLean | null>();

  if (!updated) {
    throw new NotFoundError("Prospect not found");
  }

  return toDTO(updated);
};

export const convertProspectToCustomer = async (
  boutiqueId: string,
  customerPhone: string,
  customerId: string,
): Promise<ProspectDTO> => {
  await advanceProspectStage(boutiqueId, customerPhone, "ganado");

  const updated = await ProspectModel.findOneAndUpdate(
    { boutiqueId, customerPhone },
    { $set: { convertedToCustomerId: new Types.ObjectId(customerId) } },
    { new: true },
  ).lean<ProspectLean | null>();

  if (!updated) {
    throw new NotFoundError("Prospect not found");
  }

  return toDTO(updated);
};

// ─── Reads ────────────────────────────────────────────────────────────────────

export const getProspectsByBoutique = async (
  boutiqueId: string,
  stage?: ProspectStage,
): Promise<ProspectDTO[]> => {
  const filter: Record<string, unknown> = { boutiqueId, isArchived: false };
  if (stage) {
    filter.stage = stage;
  }

  const docs = await ProspectModel.find(filter)
    .sort({ lastContactAt: -1 })
    .lean<ProspectLean[]>();

  return docs.map(toDTO);
};

export const getProspectByPhone = async (
  boutiqueId: string,
  customerPhone: string,
): Promise<ProspectDTO | null> => {
  const doc = await ProspectModel.findOne({
    boutiqueId,
    customerPhone,
  }).lean<ProspectLean | null>();

  return doc ? toDTO(doc) : null;
};

// Counts active prospects grouped by stage. Every stage is present in the
// result, defaulting to 0, so the pipeline board never has missing columns.
export const getPipelineSummary = async (
  boutiqueId: string,
): Promise<PipelineSummary> => {
  const rows = await ProspectModel.aggregate<{
    _id: ProspectStage;
    count: number;
  }>([
    {
      $match: {
        boutiqueId: new Types.ObjectId(boutiqueId),
        isArchived: false,
      },
    },
    { $group: { _id: "$stage", count: { $sum: 1 } } },
  ]);

  const summary = PROSPECT_STAGES.reduce((acc, stage) => {
    acc[stage] = 0;
    return acc;
  }, {} as PipelineSummary);

  for (const row of rows) {
    summary[row._id] = row.count;
  }

  return summary;
};
