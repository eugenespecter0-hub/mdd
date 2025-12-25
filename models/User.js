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
    // Streaming Platform Links
    streamingLinks: {
      type: {
        spotify: { type: String, default: "" },
        appleMusic: { type: String, default: "" },
        youtubeMusic: { type: String, default: "" },
        tidal: { type: String, default: "" },
        amazonMusic: { type: String, default: "" },
        pandora: { type: String, default: "" },
        deezer: { type: String, default: "" },
        iHeartRadio: { type: String, default: "" },
        audiomack: { type: String, default: "" },
        anghami: { type: String, default: "" },
        beatport: { type: String, default: "" },
        shazam: { type: String, default: "" },
        bandcamp: { type: String, default: "" },
        "7digital": { type: String, default: "" },
        qobuz: { type: String, default: "" },
        adaptr: { type: String, default: "" },
        flo: { type: String, default: "" },
        mixcloud: { type: String, default: "" },
        iTunesStore: { type: String, default: "" },
        instagram: { type: String, default: "" },
        tiktok: { type: String, default: "" },
      },
      default: {},
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
