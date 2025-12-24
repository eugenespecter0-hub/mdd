const mongoose = require("mongoose");

const RoyaltySplitSchema = new mongoose.Schema(
  {
    // Track
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
    },
    // Split Recipient
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Percentage (0-100)
    percentage: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    // Role (e.g., "producer", "writer", "performer", "publisher")
    role: {
      type: String,
      default: "creator",
    },
    // Is this the primary creator?
    isPrimary: {
      type: Boolean,
      default: false,
    },
    // Is active
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Indexes
RoyaltySplitSchema.index({ recipient: 1 });
RoyaltySplitSchema.index({ track: 1, recipient: 1 }, { unique: true });
// Note: track queries are covered by the compound index above

// Validation: Total splits for a track should not exceed 100%
RoyaltySplitSchema.pre("save", async function (next) {
  if (this.isNew || this.isModified("percentage")) {
    const splits = await mongoose
      .model("RoyaltySplit")
      .find({ track: this.track, isActive: true });
    const total = splits.reduce((sum, split) => {
      if (split._id.toString() !== this._id.toString()) {
        return sum + split.percentage;
      }
      return sum;
    }, 0);
    if (total + this.percentage > 100) {
      return next(
        new Error(
          `Total royalty splits cannot exceed 100%. Current total: ${total}%, adding: ${this.percentage}%`
        )
      );
    }
  }
  next();
});

module.exports = mongoose.model("RoyaltySplit", RoyaltySplitSchema);
