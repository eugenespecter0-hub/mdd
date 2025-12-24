const mongoose = require("mongoose");

const RoyaltyPaymentSchema = new mongoose.Schema(
  {
    // Recipient
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Purchase
    purchase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      required: true,
    },
    // Track
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
    },
    // Royalty Split
    royaltySplit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoyaltySplit",
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
    // Status
    status: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
    },
    // Stripe Transfer ID (if paid via Stripe Connect)
    stripeTransferId: {
      type: String,
      default: "",
    },
    // Payment Date
    paidAt: {
      type: Date,
      default: null,
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
RoyaltyPaymentSchema.index({ recipient: 1, createdAt: -1 });
RoyaltyPaymentSchema.index({ purchase: 1 });
RoyaltyPaymentSchema.index({ track: 1 });
RoyaltyPaymentSchema.index({ status: 1 });
RoyaltyPaymentSchema.index({ recipient: 1, status: 1 });

module.exports = mongoose.model("RoyaltyPayment", RoyaltyPaymentSchema);
