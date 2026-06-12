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
    boutiqueId: {
      type: Schema.Types.ObjectId,
      ref: 'Boutique',
      required: [true, 'Boutique ID is required'],
    },
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
    notificationsEnabled: {
      type: Boolean,
      default: true,
    },
    // Internal device push tokens — select:false so they never ride along on a
    // user read (same treatment as `password`). Never mapped into SafeUser/SDL.
    pushTokens: {
      type: [
        {
          _id: false,
          token: { type: String, required: true },
          platform: { type: String, enum: ['ios', 'android'], required: true },
          updatedAt: { type: Date, default: Date.now },
        },
      ],
      select: false,
      default: [],
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