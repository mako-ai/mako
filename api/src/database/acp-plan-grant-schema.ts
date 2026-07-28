import mongoose, { Schema, type Document, type Types } from "mongoose";
import type { CapabilityGrant } from "@mako/agent-tools";

export interface IAcpPlanGrant extends Document {
  _id: Types.ObjectId;
  workspaceId: string;
  userId: string;
  agentSessionId: string;
  planDigest: string;
  grants: CapabilityGrant[];
  status: "approved" | "revoked";
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AcpPlanGrantSchema = new Schema<IAcpPlanGrant>(
  {
    workspaceId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    agentSessionId: { type: String, required: true, unique: true },
    planDigest: { type: String, required: true },
    grants: { type: [String], required: true },
    status: {
      type: String,
      enum: ["approved", "revoked"],
      required: true,
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

AcpPlanGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AcpPlanGrant = mongoose.model<IAcpPlanGrant>(
  "AcpPlanGrant",
  AcpPlanGrantSchema,
);
