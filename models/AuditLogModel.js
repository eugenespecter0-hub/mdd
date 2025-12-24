const mongoose = require("mongoose");

const AuditLogSchema = new mongoose.Schema(
  {
    // User who performed the action
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Action
    action: {
      type: String,
      required: true,
    },
    // Resource Type
    resourceType: {
      type: String,
      enum: [
        "track",
        "license",
        "purchase",
        "royalty",
        "payout",
        "fingerprint",
        "isrc",
        "user",
        "admin",
        "photo",
        "image",
        "video",
        "script",
        "sound",
      ],
      required: true,
    },
    // Resource ID
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    // Changes (before/after)
    changes: {
      type: Object,
      default: {},
    },
    // IP Address
    ipAddress: {
      type: String,
      default: "",
    },
    // User Agent
    userAgent: {
      type: String,
      default: "",
    },
    // Status
    status: {
      type: String,
      enum: ["success", "failure", "warning"],
      default: "success",
    },
    // Error (if any)
    error: {
      type: String,
      default: "",
    },
    // Metadata
    metadata: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

// Indexes
AuditLogSchema.index({ user: 1, createdAt: -1 });
AuditLogSchema.index({ resourceType: 1, resourceId: 1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AuditLog", AuditLogSchema);
