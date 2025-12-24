const mongoose = require("mongoose");

const LicenseSchema = new mongoose.Schema(
  {
    // Buyer
    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Creator/Track Owner
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Track
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
    },
    // License Type
    licenseType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LicenseType",
      required: true,
    },
    // Purchase
    purchase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      required: true,
    },
    // Stripe
    stripePaymentIntentId: {
      type: String,
      required: true,
    },
    stripeSessionId: {
      type: String,
    },
    // License Details
    licenseNumber: {
      type: String,
      required: true,
    },
    // License JSON (stored on IPFS/nft.storage)
    licenseJson: {
      type: Object,
      default: {},
    },
    licenseJsonCid: {
      type: String,
      default: "",
    },
    // PDF
    licensePdfUrl: {
      type: String,
      default: "",
    },
    licensePdfStorageKey: {
      type: String,
      default: "",
    },
    // Status
    status: {
      type: String,
      enum: ["pending", "active", "revoked", "expired"],
      default: "pending",
    },
    // Expiration (if applicable)
    expiresAt: {
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
LicenseSchema.index({ buyer: 1, createdAt: -1 });
LicenseSchema.index({ creator: 1, createdAt: -1 });
LicenseSchema.index({ track: 1 });
LicenseSchema.index({ licenseNumber: 1 }, { unique: true });
LicenseSchema.index({ stripePaymentIntentId: 1 });

module.exports = mongoose.model("License", LicenseSchema);
