const express = require("express");
const { clerkMiddleware } = require("@clerk/express");
const cookieParser = require("cookie-parser");
const path = require("path");
const userRouter = require('../routes/authentication')
const musicRouter = require('../routes/MusicRoutes/main')
const licenseRouter = require('../routes/LicenseRoutes/main')
const uploadRouter = require('../routes/UploadRoutes/main')
const adminRouter = require('../routes/AdminRoutes/main')
const searchRouter = require('../routes/SearchRoutes/main')
const photographyRouter = require('../routes/PhotographyRoutes/main')
const filmmakingRouter = require('../routes/FilmmakingRoutes/main')
const musicGroupRouter = require("../routes/MusicGroupRoutes/main");
const Settings = require('../models/SettingsModel')

const cors = require("cors");

const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

// Validate Clerk environment variables
if (!process.env.CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
  console.error("ERROR: Clerk environment variables are missing!");
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    console.error("  CLERK_PUBLISHABLE_KEY is missing");
  }
  if (!process.env.CLERK_SECRET_KEY) {
    console.error("  CLERK_SECRET_KEY is missing");
  }
  console.error("\nPlease set these environment variables:");
  console.error("  - Development: Add them to your .env file");
  console.error("  - Production: Set them in your hosting platform");
  console.error("\nGet your keys from: https://dashboard.clerk.com/last-active?path=api-keys");
}

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("Connected to MongoDB");
    // Initialize default settings
    try {
      const existingPrice = await Settings.findOne({ key: "streaming_price_per_stream" });
      if (!existingPrice) {
        await Settings.setSetting(
          "streaming_price_per_stream",
          0.1,
          "Price per stream for playlist streaming (in USD)",
          "pricing"
        );
        console.log("Initialized default streaming price: $0.1 per stream");
      }
    } catch (error) {
      console.error("Error initializing default settings:", error);
    }
  })
  .catch((err) => console.error("Could not connect to MongoDB", err));

// Middlewares
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// Configure Clerk middleware with explicit keys if available
if (process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY) {
  app.use(
    clerkMiddleware({
      publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
      secretKey: process.env.CLERK_SECRET_KEY,
    })
  );
  console.log("Clerk middleware configured successfully");
} else {
  console.error("ERROR: Clerk middleware not configured. Authentication will not work.");
  console.error("Please add the following to your .env file:");
  console.error("  CLERK_PUBLISHABLE_KEY=your_publishable_key");
  console.error("  CLERK_SECRET_KEY=your_secret_key");
  console.error("\nGet your keys from: https://dashboard.clerk.com/last-active?path=api-keys");
  process.exit(1);
}

// API Routes (must come before static file serving)
app.use('/api/dashboard', userRouter);
app.use('/api/music', musicRouter);
app.use('/api/licenses', licenseRouter);
app.use('/api/uploads', uploadRouter);
app.use('/api/admin', adminRouter);
app.use('/api/search', searchRouter);
app.use('/api/photography', photographyRouter);
app.use('/api/filmmaking', filmmakingRouter);
app.use('/api/tracking', require('../routes/TrackingRoutes/main'));
app.use('/api/royalties', require('../routes/RoyaltyRoutes/main'));
app.use('/api/sounds', require('../routes/SoundRoutes/main'));
app.use("/api/music-group", musicGroupRouter);
app.use('/api/donations', require('../routes/DonationRoutes/main'));

// Stripe webhook (must be before JSON parsing middleware for raw body)
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), licenseRouter);

// Serve static files from the dist folder (CSS, JS, images, etc.)
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// Root route - serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// Catch-all handler: serve index.html for all non-API routes
// This allows React Router to handle client-side routing
// Note: This must come after static file serving and root route
app.use((req, res) => {
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'API endpoint not found' });
  }
  // Serve index.html for all other routes (client-side routing)
  res.sendFile(path.join(distPath, 'index.html'));
});
// Start server
app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  
  // Schedule daily tracking job - runs every 12 hours
  try {
    const cron = require('node-cron');
    const { trackAllSongs } = require('../cron/trackAllSongs');
    
    // Format: minute hour day month dayOfWeek
    // "0 */12 * * *" means every 12 hours at minute 0
    cron.schedule("0 */12 * * *", async () => {
      console.log("Running scheduled tracking job...");
      await trackAllSongs();
    });
    
    console.log("Daily tracking cron job scheduled (every 12 hours)");
    
    // Also run immediately on startup (optional - comment out if not needed)
    // await trackAllSongs();
  } catch (error) {
    console.error("Error setting up cron job:", error);
  }
});
