import type { Types } from "mongoose";

// Sales-pipeline stage for a WhatsApp lead before it becomes a customer.
export type ProspectStage =
  | "nuevo"
  | "interesado"
  | "cotizado"
  | "agendado"
  | "ganado"
  | "perdido";

export const PROSPECT_STAGES: ProspectStage[] = [
  "nuevo",
  "interesado",
  "cotizado",
  "agendado",
  "ganado",
  "perdido",
];

export interface StageHistoryEntry {
  stage: ProspectStage;
  changedAt: Date;
  note?: string;
}

export interface IProspect {
  boutiqueId: Types.ObjectId;
  customerPhone: string;
  customerName?: string;
  stage: ProspectStage;
  stageHistory: StageHistoryEntry[];
  notes: string[];
  totalMessages: number;
  firstContactAt: Date;
  lastContactAt: Date;
  convertedToCustomerId?: Types.ObjectId;
  estimatedValue?: number;
  tags: string[];
  isArchived: boolean;
}

// Plain (lean) document shape returned from reads.
export interface ProspectLean extends IProspect {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProspectDTO {
  id: string;
  boutiqueId: string;
  customerPhone: string;
  customerName?: string;
  stage: ProspectStage;
  stageHistory: Array<{
    stage: ProspectStage;
    changedAt: string;
    note?: string;
  }>;
  notes: string[];
  totalMessages: number;
  firstContactAt: string;
  lastContactAt: string;
  convertedToCustomerId?: string;
  estimatedValue?: number;
  tags: string[];
  isArchived: boolean;
}

export type PipelineSummary = Record<ProspectStage, number>;
