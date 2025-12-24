const mongoose = require("mongoose");

const SoundLicenseSchema = new mongoose.Schema(
  {
    // Buyer (filmmaker)
    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Creator/Sound Owner
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Sound
    sound: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sound",
      required: true,
    },
    // License Type
    licenseType: {
      type: String,
      enum: [
        // legacy
        "sync",
        "master",
        "performance",
        "mechanical",
        // new MVP
        "personal_noncommercial",
        "commercial_online",
        "commercial_film_tv",
        "exclusive_buyout",
      ],
      required: true,
    },
    // Template used (for sound licensing MVP)
    template: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SoundLicenseTemplate",
      default: null,
    },
    // Story reference + hash for chain of custody
    storyFoundationId: { type: String, default: "", index: true },
    soundHash: { type: String, default: "", index: true },
    // Purchase
    purchase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
    },
    // Stripe
    stripePaymentIntentId: {
      type: String,
      default: "",
    },
    stripeSessionId: {
      type: String,
      default: "",
    },
    // License Details
    licenseNumber: {
      type: String,
      required: true,
      unique: true,
    },
    // Price paid
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: { type: String, default: "USD" },
    // Snapshot of terms at time of purchase (court-ready)
    terms: {
      usageRights: { type: Object, default: {} },
      territory: { type: String, default: "worldwide" },
      territoryNotes: { type: String, default: "" },
      durationType: { type: String, default: "perpetual" },
      durationDays: { type: Number, default: null },
      exclusivity: { type: Boolean, default: false },
      attributionRequired: { type: Boolean, default: false },
      resaleAllowed: { type: Boolean, default: false },
      legalText: { type: String, default: "" },
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

    // Story license token tracking (optional)
    buyerWalletAddress: { type: String, default: "" },
    storyLicenseTxHash: { type: String, default: "" },
    storyLicenseTokenIds: { type: [String], default: [] },

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
SoundLicenseSchema.index({ buyer: 1, createdAt: -1 });
SoundLicenseSchema.index({ creator: 1, createdAt: -1 });
SoundLicenseSchema.index({ sound: 1 });
SoundLicenseSchema.index({ licenseNumber: 1 });

module.exports = mongoose.model("SoundLicense", SoundLicenseSchema);

