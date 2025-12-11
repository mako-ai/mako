import mongoose, { Schema, Document } from "mongoose";
import { v4 as uuidv4 } from "uuid";

/**
 * User model interface
 */
export interface IUser extends Document {
  _id: string;
  email: string;
  hashedPassword?: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Email verification model interface
 */
export interface IEmailVerification extends Document {
  _id: string;
  email: string;
  code: string;
  type: "registration" | "link_password" | "password_reset";
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Session model interface for Lucia
 */
export interface ISession extends Document {
  _id: string;
  userId: string;
  expiresAt: Date;
  activeWorkspaceId?: string;
}

/**
 * OAuth Account model interface
 */
export interface IOAuthAccount extends Document {
  userId: string;
  provider: "google" | "github";
  providerUserId: string;
  email?: string;
  createdAt: Date;
}

/**
 * User Schema
 */
const UserSchema = new Schema<IUser>(
  {
    _id: {
      type: String,
      default: () => uuidv4(),
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    hashedPassword: {
      type: String,
      required: false,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Email Verification Schema
 */
const EmailVerificationSchema = new Schema<IEmailVerification>(
  {
    _id: {
      type: String,
      default: () => uuidv4(),
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["registration", "link_password", "password_reset"],
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Indexes for email verification
EmailVerificationSchema.index({ email: 1, type: 1 });
EmailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Session Schema for Lucia
 */
const SessionSchema = new Schema<ISession>({
  _id: {
    type: String,
    default: () => uuidv4(),
  },
  userId: {
    type: String,
    required: true,
    ref: "User",
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  activeWorkspaceId: {
    type: String,
    required: false,
    ref: "Workspace",
  },
});

// Index for session cleanup
SessionSchema.index({ expiresAt: 1 });

/**
 * OAuth Account Schema
 */
const OAuthAccountSchema = new Schema<IOAuthAccount>(
  {
    userId: {
      type: String,
      required: true,
      ref: "User",
    },
    provider: {
      type: String,
      required: true,
      enum: ["google", "github"],
    },
    providerUserId: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Compound index to ensure unique provider accounts
OAuthAccountSchema.index({ provider: 1, providerUserId: 1 }, { unique: true });
OAuthAccountSchema.index({ userId: 1 });

// Models - use existing model if already compiled (prevents hot reload issues)
export const User =
  (mongoose.models.User as mongoose.Model<IUser>) ||
  mongoose.model<IUser>("User", UserSchema);

export const Session =
  (mongoose.models.Session as mongoose.Model<ISession>) ||
  mongoose.model<ISession>("Session", SessionSchema);

export const OAuthAccount =
  (mongoose.models.OAuthAccount as mongoose.Model<IOAuthAccount>) ||
  mongoose.model<IOAuthAccount>("OAuthAccount", OAuthAccountSchema);

export const EmailVerification =
  (mongoose.models.EmailVerification as mongoose.Model<IEmailVerification>) ||
  mongoose.model<IEmailVerification>("EmailVerification", EmailVerificationSchema);

/**
 * Database connection helper
 */
export async function connectDatabase(): Promise<void> {
  const mongoUri = process.env.DATABASE_URL;
  if (!mongoUri) {
    throw new Error("DATABASE_URL is not set");
  }

  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    throw error;
  }
}
