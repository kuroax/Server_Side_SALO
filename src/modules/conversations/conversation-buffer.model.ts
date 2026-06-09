import mongoose, { Schema, type Document } from 'mongoose';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IBufferedMessage {
  text:         string;
  messageId:    string | null;
  messageType:  string;
  imageMediaId: string | null;
  imageCaption: string;
  contactName:  string;
  timestamp:    string | number | null;
  executionId:  string;
}

export interface IConversationBuffer extends Document {
  from:             string;
  // Multi-tenant scoping: the boutique's WhatsApp phoneNumberId. Two boutiques
  // can receive messages from the same customer phone (`from`); without this,
  // those bursts collide on a single buffer document and lose messages.
  phoneNumberId:    string;
  messages:         IBufferedMessage[];
  lastSeen:         Date;
  ownerExecutionId: string;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const bufferedMessageSchema = new Schema<IBufferedMessage>(
  {
    text:         { type: String,             default: ''        },
    messageId:    { type: String,             default: null      },
    messageType:  { type: String,             default: 'text'    },
    imageMediaId: { type: String,             default: null      },
    imageCaption: { type: String,             default: ''        },
    contactName:  { type: String,             default: 'Cliente' },
    timestamp:    { type: Schema.Types.Mixed, default: null      },
    executionId:  { type: String,             default: ''        },
  },
  { _id: false },
);

const conversationBufferSchema = new Schema<IConversationBuffer>(
  {
    // Uniqueness is NO LONGER on this field alone — it is enforced by the
    // compound { from, phoneNumberId } index below (multi-tenant scoping).
    // MIGRATION: the old standalone "from_1" unique index must be dropped in
    // MongoDB Atlas BEFORE deploying this version, otherwise two boutiques
    // sharing a customer phone will still collide on the stale unique index.
    from:             { type: String, required: true                },
    // Boutique WhatsApp phoneNumberId — scopes the buffer per tenant.
    // required: false + default '' keeps pre-existing single-tenant buffer
    // documents (which expire via the TTL index) valid during the transition.
    phoneNumberId:    { type: String, required: false, default: ''  },
    messages:         { type: [bufferedMessageSchema], default: [] },
    lastSeen:         { type: Date,   required: true               },
    ownerExecutionId: { type: String, required: true               },
  },
  { timestamps: true, autoIndex: true },
);

// Multi-tenant uniqueness: one buffer per (customer phone, boutique phoneNumberId).
// Replaces the old standalone unique index on `from`. The old "from_1" index
// must be dropped in Atlas before this deploys (see field comment above).
conversationBufferSchema.index(
  { from: 1, phoneNumberId: 1 },
  { unique: true, name: 'from_phoneNumberId_unique' },
);

// Auto-delete buffer documents 24 hours after lastSeen —
// prevents stale buffers accumulating from abandoned conversations.
// TTL index also created manually in Atlas via:
// db.conversationbuffers.createIndex({ lastSeen: 1 }, { expireAfterSeconds: 86400, name: 'lastSeen_ttl_24h' })
conversationBufferSchema.index(
  { lastSeen: 1 },
  { expireAfterSeconds: 86400, name: 'lastSeen_ttl_24h' },
);

export const ConversationBufferModel = mongoose.model<IConversationBuffer>(
  'ConversationBuffer',
  conversationBufferSchema,
);