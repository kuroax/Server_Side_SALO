import { model, Schema } from 'mongoose';

// ─── Counter Model ────────────────────────────────────────────────────────────
// Single-purpose collection for atomic sequential counters.
// Each document represents one named counter (e.g. "orderNumber").
//
// Usage:
//   const doc = await CounterModel.findOneAndUpdate(
//     { _id: 'orderNumber' },
//     { $inc: { seq: 1 } },
//     { new: true, upsert: true },
//   );
//   // doc.seq is the next unique number — atomic under any concurrency.

const counterSchema = new Schema(
  {
    _id: { type: String, required: true }, // e.g. "orderNumber"
    seq: { type: Number, default: 0 },
  },
  {
    collection: 'counters',
    versionKey: false,
  },
);

export const CounterModel = model('Counter', counterSchema);