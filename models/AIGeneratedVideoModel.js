const mongoose = require("mongoose");

const AIGeneratedVideoSchema = new mongoose.Schema(
  {
    // Who created the video
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Generation details
    prompt: {
      type: String,
      required: [true, "Prompt is required"],
      trim: true,
    },

    // Reference images (if any)
    referenceImages: [
      {
        fileName: { type: String, default: "" },
        fileSize: { type: Number, default: 0 },
        fileType: { type: String, default: "" },
        fileUrl: { type: String, default: "" },
        storageKey: { type: String, default: "" },
      },
    ],

    // Luma API details
    lumaGenerationId: {
      type: String,
      default: "",
    },

    // Model used/requested for generation (e.g. ray-2, ray-flash-2, ray-1-6)
    model: {
      type: String,
      default: "",
      trim: true,
    },

    // Video file storage (once generation is complete)
    video: {
      fileName: { type: String, default: "" },
      fileSize: { type: Number, default: 0 },
      fileType: { type: String, default: "" },
      fileUrl: { type: String, default: "" }, // URL from Luma API or our storage
      storageKey: { type: String, default: "" },
      thumbnailUrl: { type: String, default: "" },
    },

    // Generation status
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },

    // Error message if failed
    errorMessage: {
      type: String,
      default: "",
    },

    // Metadata
    duration: {
      type: Number, // in seconds
      default: null,
    },

    title: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

// Index for faster queries
AIGeneratedVideoSchema.index({ user: 1, createdAt: -1 });
AIGeneratedVideoSchema.index({ lumaGenerationId: 1 }, { sparse: true });
AIGeneratedVideoSchema.index({ status: 1 });

module.exports = mongoose.model("AIGeneratedVideo", AIGeneratedVideoSchema);

