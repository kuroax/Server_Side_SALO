import mongoose, { Schema, type Document } from "mongoose";

export interface IPendingPayment extends Document {
  boutiqueId: mongoose.Types.ObjectId;
  customerPhone: string;
  customerName: string | null;
  cart: Array<{
    productNameHint: string;
    size: string;
    color: string;
    quantity: number;
  }>;
  createdAt: Date;
  expiresAt: Date;
}

const pendingPaymentSchema = new Schema<IPendingPayment>(
  {
    boutiqueId: { type: Schema.Types.ObjectId, required: true, index: true },
    customerPhone: { type: String, required: true },
    customerName: { type: String, default: null },
    cart: [
      {
        productNameHint: { type: String, required: true },
        size: { type: String, required: true },
        color: { type: String, required: true },
        quantity: { type: Number, required: true, default: 1 },
      },
    ],
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

pendingPaymentSchema.index(
  { boutiqueId: 1, customerPhone: 1 },
  { unique: true },
);

export const PendingPaymentModel = mongoose.model<IPendingPayment>(
  "PendingPayment",
  pendingPaymentSchema,
);
