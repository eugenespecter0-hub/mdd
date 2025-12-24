const mongoose = require("mongoose");

const DailyTrackingStatsSchema = new mongoose.Schema(
  {
    trackId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    spotify: {
      streams: {
        type: Number,
        default: 0,
      },
      popularity: {
        type: Number,
        default: 0,
      },
      followers: {
        type: Number,
        default: 0,
      },
    },
    apple: {
      rank: {
        type: Number,
        default: null,
      },
      plays: {
        type: Number,
        default: 0,
      },
    },
    youtube: {
      views: {
        type: Number,
        default: 0,
      },
      likes: {
        type: Number,
        default: 0,
      },
      comments: {
        type: Number,
        default: 0,
      },
    },
  },
  { timestamps: true }
);

// Indexes
DailyTrackingStatsSchema.index({ trackId: 1, date: -1 });
DailyTrackingStatsSchema.index({ date: -1 });

module.exports = mongoose.model("DailyTrackingStats", DailyTrackingStatsSchema);

