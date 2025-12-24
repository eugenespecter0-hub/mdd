const mongoose = require("mongoose");

const SettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    description: {
      type: String,
      default: "",
    },
    category: {
      type: String,
      default: "general",
      enum: ["general", "pricing", "payment", "feature"],
    },
  },
  { timestamps: true }
);

// Index
SettingsSchema.index({ key: 1 }, { unique: true });

// Ensure only one document exists per key
SettingsSchema.statics.getSetting = async function (key, defaultValue = null) {
  const setting = await this.findOne({ key });
  return setting ? setting.value : defaultValue;
};

SettingsSchema.statics.setSetting = async function (key, value, description = "", category = "general") {
  return await this.findOneAndUpdate(
    { key },
    { key, value, description, category },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model("Settings", SettingsSchema);

