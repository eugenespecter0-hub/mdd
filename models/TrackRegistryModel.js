const mongoose = require("mongoose");

const TrackRegistrySchema = new mongoose.Schema(
  {
    trackId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
      unique: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    artist: {
      type: String,
      required: true,
      trim: true,
    },
    isrc: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    spotify: {
      id: {
        type: String,
        default: "",
        trim: true,
      },
      name: {
        type: String,
        default: "",
      },
      album: {
        type: String,
        default: "",
      },
      popularity: {
        type: Number,
        default: 0,
      },
      externalUrl: {
        type: String,
        default: "",
      },
      lastUpdated: {
        type: Date,
        default: null,
      },
    },
    apple: {
      id: {
        type: String,
        default: "",
        trim: true,
      },
      albumId: {
        type: String,
        default: "",
        trim: true,
      },
      name: {
        type: String,
        default: "",
      },
      albumName: {
        type: String,
        default: "",
      },
      externalUrl: {
        type: String,
        default: "",
      },
      lastUpdated: {
        type: Date,
        default: null,
      },
    },
    youtube: {
      id: {
        type: String,
        default: "",
        trim: true,
      },
      title: {
        type: String,
        default: "",
      },
      channelTitle: {
        type: String,
        default: "",
      },
      externalUrl: {
        type: String,
        default: "",
      },
      lastUpdated: {
        type: Date,
        default: null,
      },
    },
    mlcWorkId: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

// Indexes
TrackRegistrySchema.index({ trackId: 1 }, { unique: true });
TrackRegistrySchema.index({ isrc: 1 });
TrackRegistrySchema.index({ creator: 1 });
TrackRegistrySchema.index({ "spotify.id": 1 });
TrackRegistrySchema.index({ "apple.id": 1 });
TrackRegistrySchema.index({ "youtube.id": 1 });

module.exports = mongoose.model("TrackRegistry", TrackRegistrySchema);

