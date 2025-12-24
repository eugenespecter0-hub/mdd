const mongoose = require("mongoose");

const ReleaseSchema = new mongoose.Schema(
  {
    // Creator
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Release Name
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Release Type
    type: {
      type: String,
      enum: ["single", "ep", "album", "compilation"],
      default: "single",
    },
    // Tracks
    tracks: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Track",
      },
    ],
    // Release Date
    releaseDate: {
      type: Date,
      required: true,
    },
    // Artwork
    artwork: {
      fileName: { type: String, default: "" },
      fileSize: { type: Number, default: 0 },
      fileType: { type: String, default: "" },
      fileUrl: { type: String, default: "" },
      storageKey: { type: String, default: "" },
    },
    // Description
    description: {
      type: String,
      trim: true,
      default: "",
    },
    // Status
    status: {
      type: String,
      enum: ["draft", "scheduled", "released", "archived"],
      default: "draft",
    },
    // Distribution
    distributionChannels: [String],
    // Metadata
    metadata: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

// Indexes
ReleaseSchema.index({ creator: 1, createdAt: -1 });
ReleaseSchema.index({ status: 1 });
ReleaseSchema.index({ releaseDate: 1 });

module.exports = mongoose.model("Release", ReleaseSchema);
