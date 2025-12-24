const mongoose = require("mongoose");

const SoundLicenseTemplateSchema = new mongoose.Schema(
  {
    sound: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sound",
      required: true,
      index: true,
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    storyFoundationId: {
      type: String,
      default: "",
      index: true,
    },

    licenseType: {
      type: String,
      enum: [
        "personal_noncommercial",
        "commercial_online",
        "commercial_film_tv",
        "exclusive_buyout",
      ],
      required: true,
    },

    // Commercial terms
    usageRights: { type: Object, default: {} },
    territory: {
      type: String,
      enum: ["worldwide", "restricted"],
      default: "worldwide",
    },
    territoryNotes: { type: String, default: "" },
    durationType: {
      type: String,
      enum: ["perpetual", "time_based"],
      default: "perpetual",
    },
    durationDays: { type: Number, default: null },

    exclusivity: { type: Boolean, default: false },
    attributionRequired: { type: Boolean, default: false },
    resaleAllowed: { type: Boolean, default: false }, // always false for MVP

    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "USD" },

    legalText: { type: String, default: "" },

    // Story on-chain licensing (optional)
    storyLicenseTermsId: { type: String, default: "", index: true },
    storyPilFlavor: { type: String, default: "" },
    storyTermsUri: { type: String, default: "" },
    storyLicenseAttached: { type: Boolean, default: false, index: true },
    storyAttachTxHash: { type: String, default: "" },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

SoundLicenseTemplateSchema.index({ sound: 1, licenseType: 1 }, { unique: true });

module.exports = mongoose.model("SoundLicenseTemplate", SoundLicenseTemplateSchema);

