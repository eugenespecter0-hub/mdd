const mongoose = require("mongoose");

const PhotoSchema = new mongoose.Schema(
  {
    // Who uploaded the photo
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Basic Metadata
    title: {
      type: String,
      required: [true, "Photo title is required"],
      trim: true,
    },

    photographer: {
      type: String,
      required: [true, "Photographer name is required"],
      trim: true,
    },

    photoCollection: {
      type: String,
      default: "",
      trim: true,
    },

    category: {
      type: String,
      required: [true, "Category is required"],
      trim: true,
      enum: [
        "portrait",
        "landscape",
        "nature",
        "urban",
        "fashion",
        "wedding",
        "event",
        "product",
        "artistic",
        "other",
      ],
    },

    captureDate: {
      type: Date,
      default: null,
    },

    location: {
      type: String,
      default: "",
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    // Image File Storage
    image: {
      fileName: { type: String, required: true },
      fileSize: { type: Number, required: true }, // bytes
      fileType: { type: String, required: true },
      fileUrl: { type: String, required: true }, // S3 or CDN URL
      storageKey: { type: String, required: true }, // S3 key
      imageHash: { type: String, required: true, unique: true, sparse: true }, // SHA-256 hash
    },

    // Metadata
    width: {
      type: Number,
      default: null,
    },

    height: {
      type: Number,
      default: null,
    },

    camera: {
      type: String,
      default: "",
    },

    settings: {
      iso: { type: Number, default: null },
      aperture: { type: String, default: "" },
      shutterSpeed: { type: String, default: "" },
      focalLength: { type: String, default: "" },
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

module.exports = mongoose.model("Photo", PhotoSchema);

