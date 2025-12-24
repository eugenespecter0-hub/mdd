const mongoose = require("mongoose");

const AIGeneratedImageSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    prompt: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      trim: true,
      default: "",
    },
    model: {
      type: String,
      trim: true,
      default: "photon-flash-1",
    },
    aspectRatio: {
      type: String,
      trim: true,
      default: "1:1",
    },
    referenceImages: [
      {
        fileName: { type: String, default: "" },
        fileSize: { type: Number, default: 0 },
        fileType: { type: String, default: "" },
        fileUrl: { type: String, default: "" },
        storageKey: { type: String, default: "" },
      },
    ],
    lumaGenerationId: {
      type: String,
      default: "",
      index: true,
    },
    image: {
      fileUrl: { type: String, default: "" },
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    errorMessage: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

AIGeneratedImageSchema.index({ user: 1, createdAt: -1 });
AIGeneratedImageSchema.index({ status: 1 });

module.exports = mongoose.model("AIGeneratedImage", AIGeneratedImageSchema);

