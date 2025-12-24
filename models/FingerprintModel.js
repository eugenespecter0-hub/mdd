const mongoose = require("mongoose");

const FingerprintSchema = new mongoose.Schema(
  {
    // Track
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
      unique: true,
    },
    // Provider
    provider: {
      type: String,
      enum: ["audible_magic", "acrcloud", "custom"],
      default: "audible_magic",
    },
    // Provider ID
    providerId: {
      type: String,
      default: "",
    },
    // Status
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "conflict"],
      default: "pending",
    },
    // Fingerprint Data
    fingerprintData: {
      type: Object,
      default: {},
    },
    // Conflict Detection
    hasConflict: {
      type: Boolean,
      default: false,
    },
    conflictTracks: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Track",
      },
    ],
    // Error
    error: {
      type: String,
      default: "",
    },
    // Processed At
    processedAt: {
      type: Date,
      default: null,
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
FingerprintSchema.index({ track: 1 });
FingerprintSchema.index({ providerId: 1 });
FingerprintSchema.index({ status: 1 });
FingerprintSchema.index({ hasConflict: 1 });

module.exports = mongoose.model("Fingerprint", FingerprintSchema);
