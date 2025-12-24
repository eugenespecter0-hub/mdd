const mongoose = require("mongoose");

const MusicGroupIntakeSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    stageName: { type: String, default: "" },
    email: { type: String, required: true, index: true },
    country: { type: String, default: "" },
    links: { type: String, default: "" },
    goals: { type: String, default: "" },
    status: { type: String, enum: ["new", "reviewed", "closed"], default: "new" },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true }
);

MusicGroupIntakeSchema.index({ createdAt: -1 });

module.exports = mongoose.model("MusicGroupIntake", MusicGroupIntakeSchema);


