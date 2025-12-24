const mongoose = require("mongoose");

const ScriptSchema = new mongoose.Schema(
  {
    // Who uploaded the script
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Basic Metadata
    title: {
      type: String,
      required: [true, "Script title is required"],
      trim: true,
    },

    filmmaker: {
      type: String,
      required: [true, "Filmmaker name is required"],
      trim: true,
    },

    project: {
      type: String,
      default: "",
      trim: true,
    },

    category: {
      type: String,
      default: "",
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    // Script File Storage
    script: {
      fileName: { type: String, required: true },
      fileSize: { type: Number, required: true }, // bytes
      fileType: { type: String, required: true },
      fileUrl: { type: String, required: true }, // R2 URL
      storageKey: { type: String, required: true }, // R2 key
      scriptHash: { type: String, required: true, sparse: true }, // SHA-256 hash for duplicate detection
    },

    // Metadata
    uploadStatus: {
      type: String,
      enum: ["ready", "processing", "error"],
      default: "ready",
    },

    released: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Index for faster queries
ScriptSchema.index({ user: 1, createdAt: -1 });
ScriptSchema.index({ "script.scriptHash": 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Script", ScriptSchema);

