const mongoose = require("mongoose");

const SoundSchema = new mongoose.Schema(
  {
    // Who uploaded the sound
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Basic Metadata
    title: {
      type: String,
      required: [true, "Sound title is required"],
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    category: {
      type: String,
      required: [true, "Category is required"],
      trim: true,
      enum: [
        "orchestral",
        "percussion",
        "ambient",
        "suspense",
        "trailer",
        "piano",
        "electronic",
        "cinematic",
        "other",
      ],
    },

    tags: {
      type: [String],
      default: [],
    },

    // Audio File Storage
    audio: {
      fileName: { type: String, required: true },
      fileSize: { type: Number, required: true }, // bytes
      fileType: { type: String, required: true },
      fileUrl: { type: String, required: true }, // S3 or CDN URL
      storageKey: { type: String, required: true }, // S3 key
      audioHash: { type: String, required: true, unique: true, sparse: true }, // SHA-256 hash for duplicate detection
    },

    // Thumbnail (optional)
    thumbnail: {
      fileName: { type: String, default: "" },
      fileSize: { type: Number, default: 0 },
      fileType: { type: String, default: "" },
      fileUrl: { type: String, default: "" },
      storageKey: { type: String, default: "" },
    },

    // Upload Status
    uploadStatus: {
      type: String,
      enum: ["processing", "ready", "failed"],
      default: "processing",
    },

    // Processing Metadata (optional)
    durationSeconds: {
      type: Number,
      default: null,
    },

    // Approval Status
    approved: {
      type: Boolean,
      default: false,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    approvedAt: {
      type: Date,
      default: null,
    },

    // License Information
    licensePrice: {
      type: Number,
      default: 0,
      min: 0,
    },

    licenseType: {
      type: String,
      enum: ["sync", "master", "performance", "mechanical"],
      default: "sync",
    },

    licenseTerms: {
      type: String,
      default: "",
    },

    // Whether sound is available for licensing
    availableForLicensing: {
      type: Boolean,
      default: true,
    },

    // Story Foundation IP registration
    storyFoundation: {
      storyFoundationId: { type: String, default: "" },
      timestamp: { type: Date, default: null },
      proof: { type: Object, default: {} },
      proofFileUrl: { type: String, default: "" },
      proofStorageKey: { type: String, default: "" },
      proofMimeType: { type: String, default: "" },
      proofSavedAt: { type: Date, default: null },
    },

    // Exclusive licensing lock (MVP)
    exclusiveLicense: {
      isExclusiveSold: { type: Boolean, default: false },
      exclusiveLicenseId: { type: mongoose.Schema.Types.ObjectId, ref: "SoundLicense", default: null },
      exclusiveBuyer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      lockedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// Indexes
SoundSchema.index({ user: 1, createdAt: -1 });
SoundSchema.index({ approved: 1, availableForLicensing: 1 });
SoundSchema.index({ category: 1 });
SoundSchema.index({ title: "text", description: "text", tags: "text" });

module.exports = mongoose.model("Sound", SoundSchema);

