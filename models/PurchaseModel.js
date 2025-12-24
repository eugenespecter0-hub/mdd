const mongoose = require("mongoose");

const PurchaseSchema = new mongoose.Schema(
  {
    // Buyer
    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Track
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Track",
      required: true,
    },
    // License Type
    licenseType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LicenseType",
      required: true,
    },
    // Pricing
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
    },
    stripeSessionId: {
      type: String,
    },
    stripeConnectAccountId: {
      type: String,
    },
    // Status
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded"],
      default: "pending",
    },
    // Platform fee
    platformFee: {
      type: Number,
      required: true,
      min: 0,
    },
    // Creator payout amount
    creatorAmount: {
      type: Number,
      required: true,
      min: 0,
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
PurchaseSchema.index({ buyer: 1, createdAt: -1 });
PurchaseSchema.index({ track: 1 });
PurchaseSchema.index({ stripePaymentIntentId: 1 }, { unique: true });
PurchaseSchema.index({ status: 1 });

module.exports = mongoose.model("Purchase", PurchaseSchema);
