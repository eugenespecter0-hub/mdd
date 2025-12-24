const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    clerkId: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      required: true,
    },
    userName: String,
    firstName: String,
    lastName: String,
    imageUrl: String,
    creatorType: String,
    additionalCreatorTypes: {
      type: [String],
      default: [],
    },
    country: String,
    bio: String,
    onboardingCompleted: { type: Boolean, default: false },
    // Roles
    role: {
      type: String,
      enum: ["creator", "buyer", "admin"],
      default: "creator",
    },
    admin: {
      type: Boolean,
      default: false,
    },
    // Stripe Connect
    stripeConnectAccountId: {
      type: String,
      default: "",
    },
    stripeConnectOnboardingCompleted: {
      type: Boolean,
      default: false,
    },
    stripeConnectOnboardingUrl: {
      type: String,
      default: "",
    },
    // ISRC Prefix (for creators)
    isrcPrefix: {
      type: String,
      default: "",
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
UserSchema.index({ role: 1 });
UserSchema.index({ stripeConnectAccountId: 1 });
UserSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model("User", UserSchema);
