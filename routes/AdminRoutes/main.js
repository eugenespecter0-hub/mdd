/**
 * Admin Routes
 * Admin dashboard endpoints for track approvals, fingerprints, royalties, payouts
 */

const express = require("express");
const router = express.Router();

// Models
const Track = require("../../models/TrackModel");
const Fingerprint = require("../../models/FingerprintModel");
const Purchase = require("../../models/PurchaseModel");
const RoyaltyPayment = require("../../models/RoyaltyPaymentModel");
const Payout = require("../../models/PayoutModel");
const User = require("../../models/User");
const AuditLog = require("../../models/AuditLogModel");
const ISRCRegistry = require("../../models/ISRCRegistryModel");
const Photo = require("../../models/PhotoModel");
const Video = require("../../models/VideoModel");
const Script = require("../../models/ScriptModel");
const Playlist = require("../../models/PlaylistModel");
const Settings = require("../../models/SettingsModel");
const Sound = require("../../models/SoundModel");
const SoundLicense = require("../../models/SoundLicenseModel");

// Middleware to require admin
async function requireAdmin(req, res, next) {
  try {
    if (!req.auth || !req.auth.userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user || (user.role !== "admin" && user.admin !== true)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
}

/**
 * GET /api/admin/tracks
 * Get all tracks with filters
 */
router.get("/tracks", requireAdmin, async (req, res) => {
  try {
    const {
      status,
      released,
      search,
      page = 1,
      limit = 50,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const query = {};

    if (status) {
      query.uploadStatus = status;
    }
    if (released !== undefined) {
      query.released = released === "true";
    }
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { artist: { $regex: search, $options: "i" } },
        { album: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    const tracks = await Track.find(query)
      .populate("user", "userName email")
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Track.countDocuments(query);

    return res.status(200).json({
      success: true,
      tracks,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching tracks:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching tracks",
    });
  }
});

/**
 * POST /api/admin/tracks/:id/approve
 * Approve track for release
 */
router.post("/tracks/:id/approve", requireAdmin, async (req, res) => {
  try {
    const track = await Track.findById(req.params.id);
    if (!track) {
      return res.status(404).json({ success: false, message: "Track not found" });
    }

    track.released = true;
    track.approved = true;
    track.uploadStatus = "ready";
    await track.save();

    await AuditLog.create({
      user: req.user._id,
      action: "track_approved",
      resourceType: "track",
      resourceId: track._id,
      status: "success",
    });

    return res.status(200).json({
      success: true,
      message: "Track approved",
      track,
    });
  } catch (error) {
    console.error("Error approving track:", error);
    return res.status(500).json({
      success: false,
      message: "Server error approving track",
    });
  }
});

/**
 * POST /api/admin/tracks/:id/reject
 * Reject track
 */
router.post("/tracks/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const track = await Track.findById(req.params.id);
    if (!track) {
      return res.status(404).json({ success: false, message: "Track not found" });
    }

    track.uploadStatus = "failed";
    track.released = false;
    await track.save();

    await AuditLog.create({
      user: req.user._id,
      action: "track_rejected",
      resourceType: "track",
      resourceId: track._id,
      status: "success",
      metadata: { reason },
    });

    return res.status(200).json({
      success: true,
      message: "Track rejected",
      track,
    });
  } catch (error) {
    console.error("Error rejecting track:", error);
    return res.status(500).json({
      success: false,
      message: "Server error rejecting track",
    });
  }
});

/**
 * POST /api/admin/tracks/:id/reingest
 * Re-process track ingestion
 */
router.post("/tracks/:id/reingest", requireAdmin, async (req, res) => {
  try {
    const track = await Track.findById(req.params.id);
    if (!track) {
      return res.status(404).json({ success: false, message: "Track not found" });
    }

    track.uploadStatus = "processing";
    await track.save();

    await AuditLog.create({
      user: req.user._id,
      action: "track_reingested",
      resourceType: "track",
      resourceId: track._id,
      status: "success",
    });

    return res.status(200).json({
      success: true,
      message: "Track marked for re-processing",
    });
  } catch (error) {
    console.error("Error re-ingesting track:", error);
    return res.status(500).json({
      success: false,
      message: "Server error re-ingesting track",
    });
  }
});

/**
 * GET /api/admin/fingerprints
 * Get fingerprints with conflicts
 */
router.get("/fingerprints", requireAdmin, async (req, res) => {
  try {
    const { hasConflict, status, page = 1, limit = 50 } = req.query;

    const query = {};
    if (hasConflict === "true") {
      query.hasConflict = true;
    }
    if (status) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const fingerprints = await Fingerprint.find(query)
      .populate("track")
      .populate("conflictTracks")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Fingerprint.countDocuments(query);

    return res.status(200).json({
      success: true,
      fingerprints,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching fingerprints:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching fingerprints",
    });
  }
});

/**
 * GET /api/admin/royalties
 * Get royalty payments
 */
router.get("/royalties", requireAdmin, async (req, res) => {
  try {
    const { status, recipientId, page = 1, limit = 50 } = req.query;

    const query = {};
    if (status) {
      query.status = status;
    }
    if (recipientId) {
      query.recipient = recipientId;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const royalties = await RoyaltyPayment.find(query)
      .populate("recipient", "userName email")
      .populate("track", "title artist")
      .populate("purchase")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await RoyaltyPayment.countDocuments(query);

    // Calculate totals
    const totals = await RoyaltyPayment.aggregate([
      { $match: query },
      {
        $group: {
          _id: "$status",
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      royalties,
      totals,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching royalties:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching royalties",
    });
  }
});

/**
 * GET /api/admin/payouts
 * Get payouts
 */
router.get("/payouts", requireAdmin, async (req, res) => {
  try {
    const { status, creatorId, page = 1, limit = 50 } = req.query;

    const query = {};
    if (status) {
      query.status = status;
    }
    if (creatorId) {
      query.creator = creatorId;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const payouts = await Payout.find(query)
      .populate("creator", "userName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Payout.countDocuments(query);

    // Calculate totals
    const totals = await Payout.aggregate([
      { $match: query },
      {
        $group: {
          _id: "$status",
          total: { $sum: "$totalAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      payouts,
      totals,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching payouts:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching payouts",
    });
  }
});

/**
 * POST /api/admin/payouts/:id/process
 * Manually trigger payout processing
 */
router.post("/payouts/:id/process", requireAdmin, async (req, res) => {
  try {
    const payout = await Payout.findById(req.params.id);
    if (!payout) {
      return res.status(404).json({ success: false, message: "Payout not found" });
    }

    await AuditLog.create({
      user: req.user._id,
      action: "payout_triggered",
      resourceType: "payout",
      resourceId: payout._id,
      status: "success",
    });

    return res.status(200).json({
      success: true,
      message: "Payout processing triggered",
    });
  } catch (error) {
    console.error("Error triggering payout:", error);
    return res.status(500).json({
      success: false,
      message: "Server error triggering payout",
    });
  }
});

/**
 * GET /api/admin/users
 * Get users
 */
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const { role, search, page = 1, limit = 50 } = req.query;

    const query = {};
    if (role) {
      query.role = role;
    }
    if (search) {
      query.$or = [
        { email: { $regex: search, $options: "i" } },
        { userName: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const users = await User.find(query)
      .select("-__v")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await User.countDocuments(query);

    return res.status(200).json({
      success: true,
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching users",
    });
  }
});

/**
 * GET /api/admin/audit-logs
 * Get audit logs
 */
router.get("/audit-logs", requireAdmin, async (req, res) => {
  try {
    const { action, resourceType, status, page = 1, limit = 100 } = req.query;

    const query = {};
    if (action) {
      query.action = action;
    }
    if (resourceType) {
      query.resourceType = resourceType;
    }
    if (status) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const logs = await AuditLog.find(query)
      .populate("user", "userName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await AuditLog.countDocuments(query);

    return res.status(200).json({
      success: true,
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching audit logs",
    });
  }
});

/**
 * GET /api/admin/stats
 * Get dashboard statistics
 */
router.get("/stats", requireAdmin, async (req, res) => {
  try {
    const [
      totalTracks,
      releasedTracks,
      pendingTracks,
      totalUsers,
      totalCreators,
      totalPurchases,
      totalRevenue,
      pendingPayouts,
      totalPayouts,
      fingerprintConflicts,
    ] = await Promise.all([
      Track.countDocuments(),
      Track.countDocuments({ released: true }),
      Track.countDocuments({ uploadStatus: "processing" }),
      User.countDocuments(),
      User.countDocuments({ role: "creator" }),
      Purchase.countDocuments({ status: "completed" }),
      Purchase.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Payout.countDocuments({ status: "pending" }),
      Payout.countDocuments({ status: "completed" }),
      Fingerprint.countDocuments({ hasConflict: true }),
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        tracks: {
          total: totalTracks,
          released: releasedTracks,
          pending: pendingTracks,
        },
        users: {
          total: totalUsers,
          creators: totalCreators,
        },
        purchases: {
          total: totalPurchases,
          revenue: totalRevenue[0]?.total || 0,
        },
        payouts: {
          pending: pendingPayouts,
          completed: totalPayouts,
        },
        fingerprints: {
          conflicts: fingerprintConflicts,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching stats",
    });
  }
});

/**
 * GET /api/admin/photos
 * Get all photos
 */
router.get("/photos", requireAdmin, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;

    const query = {};
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { photographer: { $regex: search, $options: "i" } },
        { photoCollection: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const photos = await Photo.find(query)
      .populate("user", "userName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Photo.countDocuments(query);

    return res.status(200).json({
      success: true,
      photos,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching photos:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching photos",
    });
  }
});

/**
 * GET /api/admin/videos
 * Get all videos
 */
router.get("/videos", requireAdmin, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;

    const query = {};
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { filmmaker: { $regex: search, $options: "i" } },
        { project: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const videos = await Video.find(query)
      .populate("user", "userName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Video.countDocuments(query);

    return res.status(200).json({
      success: true,
      videos,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching videos:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching videos",
    });
  }
});

/**
 * GET /api/admin/scripts
 * Get all scripts
 */
router.get("/scripts", requireAdmin, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;

    const query = {};
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { filmmaker: { $regex: search, $options: "i" } },
        { project: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const scripts = await Script.find(query)
      .populate("user", "userName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Script.countDocuments(query);

    return res.status(200).json({
      success: true,
      scripts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching scripts:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching scripts",
    });
  }
});

/**
 * GET /api/admin/artists
 * Get all artists with track counts
 */
router.get("/artists", requireAdmin, async (req, res) => {
  try {
    const artists = await Track.aggregate([
      {
        $group: {
          _id: "$artist",
          trackCount: { $sum: 1 },
          latestTrackDate: { $max: "$createdAt" },
          latestTrackId: { $first: "$_id" },
          userId: { $first: "$user" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userData",
        },
      },
      {
        $lookup: {
          from: "tracks",
          localField: "latestTrackId",
          foreignField: "_id",
          as: "latestTrackData",
        },
      },
      {
        $unwind: {
          path: "$userData",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $unwind: {
          path: "$latestTrackData",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          artist: "$_id",
          trackCount: 1,
          latestTrack: "$latestTrackData.title",
          user: {
            userName: "$userData.userName",
            email: "$userData.email",
          },
        },
      },
      {
        $sort: { trackCount: -1 },
      },
    ]);

    return res.status(200).json({
      success: true,
      artists,
    });
  } catch (error) {
    console.error("Error fetching artists:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching artists",
    });
  }
});

/**
 * GET /api/admin/copyright-requests
 * Get copyright requests (using Fingerprint conflicts as copyright requests)
 */
router.get("/copyright-requests", requireAdmin, async (req, res) => {
  try {
    const fingerprints = await Fingerprint.find({ hasConflict: true })
      .populate("track", "title artist")
      .populate("conflictTracks", "title artist")
      .populate({
        path: "track",
        populate: {
          path: "user",
          select: "userName email",
        },
      })
      .sort({ createdAt: -1 });

    const requests = fingerprints.map((fp) => ({
      _id: fp._id,
      track: fp.track,
      user: fp.track?.user,
      reason: `Potential copyright conflict detected`,
      status: fp.status === "conflict" ? "pending" : "resolved",
      createdAt: fp.createdAt,
    }));

    return res.status(200).json({
      success: true,
      requests,
    });
  } catch (error) {
    console.error("Error fetching copyright requests:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching copyright requests",
    });
  }
});

/**
 * GET /api/admin/licensing-requests
 * Get pending licensing requests (purchases with pending status)
 */
router.get("/licensing-requests", requireAdmin, async (req, res) => {
  try {
    const purchases = await Purchase.find({ status: "pending" })
      .populate("track", "title artist")
      .populate("buyer", "userName email")
      .populate("licenseType", "name")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      requests: purchases,
    });
  } catch (error) {
    console.error("Error fetching licensing requests:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching licensing requests",
    });
  }
});

/**
 * GET /api/admin/playlists
 * Get all playlists with user information
 */
router.get("/playlists", requireAdmin, async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = {};

    // Status filter
    if (status && status !== "all") {
      query.status = status;
    }

    let playlists = await Playlist.find(query)
      .populate({
        path: "user",
        select: "userName email",
      })
      .populate({
        path: "tracks.trackId",
        select: "title artist",
      })
      .sort({ createdAt: -1 });

    // Search filter
    if (search) {
      const searchLower = search.toLowerCase();
      playlists = playlists.filter((playlist) => {
        const userName = playlist.user?.userName?.toLowerCase() || "";
        const email = playlist.user?.email?.toLowerCase() || "";
        const name = playlist.name?.toLowerCase() || "";
        return (
          userName.includes(searchLower) ||
          email.includes(searchLower) ||
          name.includes(searchLower)
        );
      });
    }

    return res.status(200).json({
      success: true,
      playlists,
    });
  } catch (error) {
    console.error("Error fetching playlists:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching playlists",
    });
  }
});

/**
 * PATCH /api/admin/playlists/:id/status
 * Update playlist status
 */
router.patch("/playlists/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || !["pending", "started", "completed"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Valid status is required (pending, started, completed)",
      });
    }

    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      return res.status(404).json({
        success: false,
        message: "Playlist not found",
      });
    }

    playlist.status = status;
    await playlist.save();

    // Populate for response
    await playlist.populate({
      path: "user",
      select: "userName email",
    });
    await playlist.populate({
      path: "tracks.trackId",
      select: "title artist",
    });

    return res.status(200).json({
      success: true,
      message: "Playlist status updated successfully",
      playlist,
    });
  } catch (error) {
    console.error("Error updating playlist status:", error);
    return res.status(500).json({
      success: false,
      message: "Server error updating playlist status",
    });
  }
});

/**
 * GET /api/admin/settings
 * Get all settings
 */
router.get("/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await Settings.find().sort({ category: 1, key: 1 });
    const settingsObj = {};
    settings.forEach((setting) => {
      settingsObj[setting.key] = {
        value: setting.value,
        description: setting.description,
        category: setting.category,
      };
    });
    return res.status(200).json({
      success: true,
      settings: settingsObj,
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching settings",
    });
  }
});

/**
 * GET /api/admin/settings/:key
 * Get a specific setting
 */
router.get("/settings/:key", requireAdmin, async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: req.params.key });
    if (!setting) {
      return res.status(404).json({
        success: false,
        message: "Setting not found",
      });
    }
    return res.status(200).json({
      success: true,
      setting: {
        key: setting.key,
        value: setting.value,
        description: setting.description,
        category: setting.category,
      },
    });
  } catch (error) {
    console.error("Error fetching setting:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching setting",
    });
  }
});

/**
 * PUT /api/admin/settings/:key
 * Update a specific setting
 */
router.put("/settings/:key", requireAdmin, async (req, res) => {
  try {
    const { value, description, category } = req.body;

    if (value === undefined) {
      return res.status(400).json({
        success: false,
        message: "Value is required",
      });
    }

    const setting = await Settings.setSetting(
      req.params.key,
      value,
      description || "",
      category || "general"
    );

    return res.status(200).json({
      success: true,
      message: "Setting updated successfully",
      setting: {
        key: setting.key,
        value: setting.value,
        description: setting.description,
        category: setting.category,
      },
    });
  } catch (error) {
    console.error("Error updating setting:", error);
    return res.status(500).json({
      success: false,
      message: "Server error updating setting",
    });
  }
});

/**
 * GET /api/admin/tracking/tracks
 * Get all tracks with tracking information
 */
router.get("/tracking/tracks", requireAdmin, async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = {};

    // Status filter
    if (status === "has-isrc") {
      query.isrc = { $ne: "", $exists: true };
    } else if (status === "missing-ids") {
      query.$or = [
        { "tracking.spotifyId": { $in: [null, ""] } },
        { "tracking.appleId": { $in: [null, ""] } },
        { "tracking.youtubeId": { $in: [null, ""] } },
      ];
    } else if (status === "complete") {
      query.isrc = { $ne: "", $exists: true };
      query["tracking.spotifyId"] = { $ne: "", $exists: true };
      query["tracking.appleId"] = { $ne: "", $exists: true };
      query["tracking.youtubeId"] = { $ne: "", $exists: true };
    }

    let tracks = await Track.find(query)
      .populate({
        path: "user",
        select: "userName email",
      })
      .sort({ createdAt: -1 })
      .limit(500); // Limit to prevent performance issues

    // Search filter
    if (search) {
      const searchLower = search.toLowerCase();
      tracks = tracks.filter((track) => {
        const userName = track.user?.userName?.toLowerCase() || "";
        const email = track.user?.email?.toLowerCase() || "";
        const title = track.title?.toLowerCase() || "";
        const artist = track.artist?.toLowerCase() || "";
        const isrc = track.isrc?.toLowerCase() || "";
        return (
          userName.includes(searchLower) ||
          email.includes(searchLower) ||
          title.includes(searchLower) ||
          artist.includes(searchLower) ||
          isrc.includes(searchLower)
        );
      });
    }

    return res.status(200).json({
      success: true,
      tracks,
    });
  } catch (error) {
    console.error("Error fetching tracking tracks:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching tracks",
    });
  }
});

/**
 * GET /api/admin/sounds
 * Get all sounds with filters
 */
router.get("/sounds", requireAdmin, async (req, res) => {
  try {
    const {
      approved,
      search,
      page = 1,
      limit = 50,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const query = {};

    if (approved !== undefined) {
      query.approved = approved === "true";
    }
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    const sounds = await Sound.find(query)
      .populate("user", "userName email")
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Sound.countDocuments(query);

    return res.status(200).json({
      success: true,
      sounds,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching sounds:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching sounds",
    });
  }
});

/**
 * POST /api/admin/sounds/:id/approve
 * Approve sound for licensing
 */
router.post("/sounds/:id/approve", requireAdmin, async (req, res) => {
  try {
    const sound = await Sound.findById(req.params.id);
    if (!sound) {
      return res.status(404).json({ success: false, message: "Sound not found" });
    }

    sound.approved = true;
    sound.approvedBy = req.user._id;
    sound.approvedAt = new Date();
    sound.uploadStatus = "ready";
    await sound.save();

    await AuditLog.create({
      user: req.user._id,
      action: "sound_approved",
      resourceType: "sound",
      resourceId: sound._id,
      status: "success",
    });

    return res.status(200).json({
      success: true,
      message: "Sound approved",
      sound,
    });
  } catch (error) {
    console.error("Error approving sound:", error);
    return res.status(500).json({
      success: false,
      message: "Server error approving sound",
    });
  }
});

/**
 * POST /api/admin/sounds/:id/reject
 * Reject sound
 */
router.post("/sounds/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const sound = await Sound.findById(req.params.id);
    if (!sound) {
      return res.status(404).json({ success: false, message: "Sound not found" });
    }

    sound.approved = false;
    sound.uploadStatus = "failed";
    await sound.save();

    await AuditLog.create({
      user: req.user._id,
      action: "sound_rejected",
      resourceType: "sound",
      resourceId: sound._id,
      status: "success",
      metadata: { reason: reason || "" },
    });

    return res.status(200).json({
      success: true,
      message: "Sound rejected",
      sound,
    });
  } catch (error) {
    console.error("Error rejecting sound:", error);
    return res.status(500).json({
      success: false,
      message: "Server error rejecting sound",
    });
  }
});

/**
 * GET /api/admin/licensing-activity
 * Get all licensing activity (admin only)
 */
router.get("/licensing-activity", requireAdmin, async (req, res) => {
  try {

    const licenses = await SoundLicense.find({})
      .populate("sound")
      .populate("buyer", "userName email")
      .populate("creator", "userName email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      licenses,
    });
  } catch (error) {
    console.error("Error fetching licensing activity:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching licensing activity",
    });
  }
});

module.exports = router;
