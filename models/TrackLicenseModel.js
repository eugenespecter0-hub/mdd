const mongoose = require("mongoose");

const trackLicenseSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
    },
    licenseType: {
      type: String,
      enum: ["sync", "master", "performance", "mechanical"],
      required: true,
    },
    terms: {
      type: String,
      default: "",
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    duration: {
      type: Number,
      required: true,
      min: 1,
      default: 1, // in years
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
trackLicenseSchema.index({ user: 1, createdAt: -1 });
trackLicenseSchema.index({ track: 1 });

module.exports = mongoose.model("TrackLicense", trackLicenseSchema);

