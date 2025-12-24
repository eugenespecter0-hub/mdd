const mongoose = require("mongoose");

const ISRCRegistrySchema = new mongoose.Schema(
  {
    // ISRC Code (full ISRC)
    isrc: {
      type: String,
      required: true,
      uppercase: true,
    },
    // Track
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
    },
    // ISRC Components
    countryCode: {
      type: String,
      required: true,
      length: 2,
      uppercase: true,
    },
    registrantCode: {
      type: String,
      required: true,
      length: 3,
      uppercase: true,
    },
    year: {
      type: String,
      required: true,
      length: 2,
    },
    designationCode: {
      type: String,
      required: true,
      length: 5,
    },
    // Prefix (from env)
    prefix: {
      type: String,
      required: true,
    },
    // Status
    status: {
      type: String,
      enum: ["assigned", "registered", "released"],
      default: "assigned",
    },
    // Registered At (with IFPI)
    registeredAt: {
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
ISRCRegistrySchema.index({ isrc: 1 }, { unique: true });
ISRCRegistrySchema.index({ track: 1 }, { unique: true });
ISRCRegistrySchema.index({ prefix: 1, year: 1, designationCode: 1 });

module.exports = mongoose.model("ISRCRegistry", ISRCRegistrySchema);
