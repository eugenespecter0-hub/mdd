const mongoose = require("mongoose");

const AlbumSchema = new mongoose.Schema(
  {
    // Who created the album
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Album name
    name: {
      type: String,
      required: [true, "Album name is required"],
      trim: true,
    },

    // Album thumbnail
    thumbnail: {
      fileName: { type: String, default: "" },
      fileSize: { type: Number, default: 0 },
      fileType: { type: String, default: "" },
      fileUrl: { type: String, default: "" },
      storageKey: { type: String, default: "" },
    },

    // Tracks in the album
    tracks: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Track",
      },
    ],

    // Description (optional)
    description: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

// Index for faster queries
AlbumSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Album", AlbumSchema);
