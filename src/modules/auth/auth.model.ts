import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { IUser } from '#/modules/auth/auth.types.js';

// ─── Document Type ────────────────────────────────────────────────────────────

export type IUserDocument = HydratedDocument<
  IUser & {
    createdAt: Date;
    updatedAt: Date;
  }
>;

// ─── Schema ───────────────────────────────────────────────────────────────────

const userSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      required: true,
      enum: ['owner', 'admin', 'sales', 'inventory', 'support'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Model ────────────────────────────────────────────────────────────────────

export type UserModelType = Model<IUser>;

export const UserModel = mongoose.model<IUser>('User', userSchema);