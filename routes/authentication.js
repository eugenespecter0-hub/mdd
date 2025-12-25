const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Settings = require("../models/SettingsModel");
const { requireAuth } = require("@clerk/express");

router.post("/onboarding", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { clerkId: req.body.clerkId },
      {
        $set: {
          clerkId: req.body.clerkId,
          email: req.body.email,
          firstName: req.body.firstName,
          userName:req.body.username,
          lastName: req.body.lastName,
          imageUrl: req.body.imageUrl,
          creatorType: req.body.creatorType,
          country: req.body.country,
          bio: req.body.bio,
          onboardingCompleted: true,
        },
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/user/:clerkId", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.params.clerkId });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(user);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Public (auth) dashboard config flags
router.get("/config", requireAuth(), async (req, res) => {
  try {
    // default: OFF (show Coming Soon) unless admin enables
    const creatorToolsEnabled = await Settings.getSetting(
      "creator_tools_enabled",
      false
    );
    return res.status(200).json({
      creatorToolsEnabled: Boolean(creatorToolsEnabled),
    });
  } catch (e) {
    return res.status(200).json({ creatorToolsEnabled: false });
  }
});

// Add additional creator type to user profile
router.post("/user/add-creator-type", requireAuth(), async (req, res) => {
  try {
    const { creatorType } = req.body;
    const clerkId = req.auth.userId;

    if (!creatorType) {
      return res.status(400).json({ success: false, message: "Creator type is required" });
    }

    const validTypes = ["musician", "photographer", "filmmaker"];
    if (!validTypes.includes(creatorType)) {
      return res.status(400).json({ success: false, message: "Invalid creator type" });
    }

    const user = await User.findOne({ clerkId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Check if user already has this as primary creator type
    if (user.creatorType === creatorType) {
      return res.status(400).json({
        success: false,
        message: "This is already your primary creator type",
      });
    }

    // Check if already in additional types
    if (user.additionalCreatorTypes && user.additionalCreatorTypes.includes(creatorType)) {
      return res.status(400).json({
        success: false,
        message: "This creator type is already added to your profile",
      });
    }

    // Add to additional creator types
    const updatedUser = await User.findOneAndUpdate(
      { clerkId },
      { $addToSet: { additionalCreatorTypes: creatorType } },
      { new: true }
    );

    res.json({ success: true, user: updatedUser });
  } catch (e) {
    console.error("Error adding creator type:", e);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Update streaming platform links
router.put("/user/streaming-links", requireAuth(), async (req, res) => {
  try {
    const clerkId = req.auth.userId;
    const { streamingLinks } = req.body;

    if (!streamingLinks) {
      return res.status(400).json({ 
        success: false, 
        message: "Streaming links are required" 
      });
    }

    // Validate required fields (Spotify, Apple Music, YouTube Music are mandatory)
    if (!streamingLinks.spotify || !streamingLinks.appleMusic || !streamingLinks.youtubeMusic) {
      return res.status(400).json({
        success: false,
        message: "Spotify, Apple Music, and YouTube Music links are required",
      });
    }

    const user = await User.findOne({ clerkId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Update streaming links
    user.streamingLinks = user.streamingLinks || {};
    Object.keys(streamingLinks).forEach((key) => {
      if (streamingLinks[key]) {
        user.streamingLinks[key] = streamingLinks[key].trim();
      } else {
        user.streamingLinks[key] = "";
      }
    });

    await user.save();

    res.json({ success: true, user });
  } catch (e) {
    console.error("Error updating streaming links:", e);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
