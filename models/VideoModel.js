const mongoose = require("mongoose");

const VideoSchema = new mongoose.Schema(
  {
    // Who uploaded the video
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Basic Metadata
    title: {
      type: String,
      required: [true, "Video title is required"],
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
      required: [true, "Category is required"],
      trim: true,
      enum: [
        "short-film",
        "documentary",
        "commercial",
        "music-video",
        "corporate",
        "wedding",
        "event",
        "tutorial",
        "vlog",
        "other",
      ],
    },

    releaseDate: {
      type: Date,
      default: null,
    },

    duration: {
      type: String,
      default: "",
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    // Video File Storage
    video: {
      fileName: { type: String, required: true },
      fileSize: { type: Number, required: true }, // bytes
      fileType: { type: String, required: true },
      fileUrl: { type: String, required: true }, // S3 or CDN URL
      storageKey: { type: String, required: true }, // S3 key
      videoHash: { type: String, required: true, unique: true, sparse: true }, // SHA-256 hash
    },

    // Thumbnail (optional)
    thumbnail: {
      fileName: { type: String, default: "" },
      fileSize: { type: Number, default: 0 },
      fileType: { type: String, default: "" },
      fileUrl: { type: String, default: "" },
      storageKey: { type: String, default: "" },
    },

    // Metadata
    durationSeconds: {
      type: Number,
      default: null,
    },

    resolution: {
      width: { type: Number, default: null },
      height: { type: Number, default: null },
    },

    // Release Status
    released: {
      type: Boolean,
      default: false,
    },

    // Upload Status
    uploadStatus: {
      type: String,
      enum: ["processing", "ready", "failed"],
      default: "processing",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Video", VideoSchema);

