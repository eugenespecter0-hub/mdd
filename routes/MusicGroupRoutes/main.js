const express = require("express");
const router = express.Router();
const { requireAuth } = require("@clerk/express");

const User = require("../../models/User");
const MusicGroupIntake = require("../../models/MusicGroupIntakeModel");

function cleanStr(v, max = 2000) {
  return String(v || "").trim().slice(0, max);
}

// Public: Phase 1 intake form (no uploads)
router.post("/intake", async (req, res) => {
  try {
    const fullName = cleanStr(req.body?.fullName, 120);
    const email = cleanStr(req.body?.email, 180);
    const stageName = cleanStr(req.body?.stageName, 120);
    const country = cleanStr(req.body?.country, 80);
    const links = cleanStr(req.body?.links, 4000);
    const goals = cleanStr(req.body?.goals, 4000);

    if (!fullName || !email) {
      return res.status(400).json({
        success: false,
        message: "fullName and email are required",
      });
    }

    const intake = await MusicGroupIntake.create({
      fullName,
      email,
      stageName,
      country,
      links,
      goals,
      metadata: {
        ipAddress: req.ip || "",
        userAgent: req.get("user-agent") || "",
      },
    });

    return res.status(201).json({ success: true, intakeId: intake._id });
  } catch (error) {
    console.error("MusicGroup intake error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Admin: list intakes
router.get("/intakes", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const isAdmin = user.admin === true || user.role === "admin";
    if (!isAdmin) return res.status(403).json({ success: false, message: "Forbidden" });

    const items = await MusicGroupIntake.find({})
      .sort({ createdAt: -1 })
      .limit(200);

    return res.status(200).json({ success: true, items });
  } catch (error) {
    console.error("MusicGroup intakes list error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;


