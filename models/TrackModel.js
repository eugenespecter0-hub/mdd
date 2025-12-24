const mongoose = require("mongoose");

const TrackSchema = new mongoose.Schema(
  {
    // Who uploaded the track
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Basic Metadata
    title: {
      type: String,
      required: [true, "Track title is required"],
      trim: true,
    },

    artist: {
      type: String,
      required: [true, "Artist name is required"],
      trim: true,
    },

    album: {
      type: String,
      default: "",
      trim: true,
    },

    genre: {
      type: String,
      required: [true, "Genre is required"],
      trim: true,
      enum: [
        "pop",
        "rock",
        "hip-hop",
        "electronic",
        "jazz",
        "classical",
        "country",
        "r&b",
        "indie",
        "other",
      ],
    },

    releaseDate: {
      type: Date,
      default: null,
    },

    // Codes
    isrc: {
      type: String,
      default: "",
      trim: true,
      unique: false, // change to true IF you plan to enforce ISRC uniqueness
    },

    // Description
    description: {
      type: String,
      trim: true,
      default: "",
    },

    // Lyrics
    lyrics: {
      type: String,
      trim: true,
      default: "",
    },

    // Audio File Storage
    audio: {
      fileName: { type: String, required: true },
      fileSize: { type: Number, required: true }, // bytes
      fileType: { type: String, required: true },
      fileUrl: { type: String, required: true }, // S3 or CDN URL
      storageKey: { type: String, required: true }, // S3 key
      audioHash: { type: String, required: true, unique: true, sparse: true }, // SHA-256 hash for duplicate detection - unique index
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

    waveformData: {
      type: Array,
      default: [],
    },

    // Release Status
    released: {
      type: Boolean,
      default: false,
    },

    // Approval Status
    approved: {
      type: Boolean,
      default: false,
    },

    // Platform Tracking IDs
    tracking: {
      isrc: {
        type: String,
        default: "",
        trim: true,
      },
      spotifyId: {
        type: String,
        default: "",
        trim: true,
      },
      appleId: {
        type: String,
        default: "",
        trim: true,
      },
      youtubeId: {
        type: String,
        default: "",
        trim: true,
      },
      mlcWorkId: {
        type: String,
        default: "",
        trim: true,
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Track", TrackSchema);
