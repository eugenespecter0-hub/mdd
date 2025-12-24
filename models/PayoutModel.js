const mongoose = require("mongoose");

const PayoutSchema = new mongoose.Schema(
  {
    // Creator
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Period
    periodStart: {
      type: Date,
      required: true,
    },
    periodEnd: {
      type: Date,
      required: true,
    },
    // Total Amount
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "USD",
    },
    // Royalty Payments included
    royaltyPayments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "RoyaltyPayment",
      },
    ],
    // Stripe Connect
    stripeConnectAccountId: {
      type: String,
      required: true,
    },
    stripeTransferId: {
      type: String,
      default: "",
    },
    stripePayoutId: {
      type: String,
      default: "",
    },
    // Status
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    // Scheduled Date
    scheduledDate: {
      type: Date,
      required: true,
    },
    // Paid Date
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
PayoutSchema.index({ creator: 1, createdAt: -1 });
PayoutSchema.index({ status: 1 });
PayoutSchema.index({ scheduledDate: 1 });
PayoutSchema.index({ creator: 1, status: 1 });

module.exports = mongoose.model("Payout", PayoutSchema);
