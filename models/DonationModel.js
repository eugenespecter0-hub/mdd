const mongoose = require("mongoose");

const DonationSchema = new mongoose.Schema(
  {
    // Donor (who made the donation)
    donor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Recipient (artist who receives the donation)
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Amount
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "USD",
    },
    // Stripe
    stripePaymentIntentId: {
      type: String,
      required: true,
      unique: true,
    },
    stripeSessionId: {
      type: String,
    },
    stripeChargeId: {
      type: String,
      default: "",
    },
    // Status
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded"],
      default: "pending",
    },
    // Optional message from donor
    message: {
      type: String,
      default: "",
      trim: true,
    },
    // Metadata
    metadata: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

// Indexes
DonationSchema.index({ donor: 1, createdAt: -1 });
DonationSchema.index({ recipient: 1, createdAt: -1 });
DonationSchema.index({ stripePaymentIntentId: 1 }, { unique: true });
DonationSchema.index({ stripeSessionId: 1 });
DonationSchema.index({ status: 1 });

module.exports = mongoose.model("Donation", DonationSchema);
