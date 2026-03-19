import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { IUser } from '#/modules/auth/auth.types.js';

// ─── Timestamp augmentation ───────────────────────────────────────────────────

type IUserWithTimestamps = IUser & {
  createdAt: Date;
  updatedAt: Date;
};

// ─── Document Type ────────────────────────────────────────────────────────────

export type IUserDocument = HydratedDocument<IUserWithTimestamps>;

// ─── Schema ───────────────────────────────────────────────────────────────────

const userSchema = new Schema<IUserWithTimestamps>(
  {
    username: {
      type:      String,
      required:  true,
      unique:    true,
      trim:      true,
      lowercase: true,
    },
    email: {
      type:      String,
      trim:      true,
      lowercase: true,
      sparse:    true,
    },
    password: {
      type:     String,
      required: true,
      select:   false,
    },
    role: {
      type:     String,
      required: true,
      enum:     ['owner', 'admin', 'sales', 'inventory', 'support'],
    },
    isActive: {
      type:    Boolean,
      default: true,
    },
    // Incremented on logout and password change.
    // select: false — never returned to clients in any query.
    tokenVersion: {
      type:    Number,
      default: 0,
      select:  false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Model ────────────────────────────────────────────────────────────────────

export type UserModelType = Model<IUserWithTimestamps>;

export const UserModel = mongoose.model<IUserWithTimestamps>('User', userSchema);