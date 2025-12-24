const express = require("express");
const router = express.Router();
const multer = require("multer");
const { requireAuth } = require("@clerk/express");
const Track = require("../../models/TrackModel");
const Album = require("../../models/AlbumModel");
const User = require("../../models/User");
const ISRCRegistry = require("../../models/ISRCRegistryModel");
const Playlist = require("../../models/PlaylistModel");
const TrackLicense = require("../../models/TrackLicenseModel");
const Settings = require("../../models/SettingsModel");
const TrackRegistry = require("../../models/TrackRegistryModel");
const { uploadToR2 } = require("../../utils/cloudflareR2");
const { generateAudioHash } = require("../../utils/audioValidation");
const { getAudioDuration } = require("../../utils/audioDuration");
const { assignISRC } = require("../../utils/isrcGenerator");

// Configure multer for memory storage (we'll upload directly to R2)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Allow audio files
    if (file.fieldname === "audio") {
      const allowedTypes = ["audio/mpeg", "audio/wav", "audio/flac", "audio/x-wav", "audio/mp3"];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Invalid audio file type. Only MP3, WAV, and FLAC are allowed."), false);
      }
    }
    // Allow image files for thumbnail
    else if (file.fieldname === "thumbnail" || file.fieldname === "albumThumbnail") {
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/jpg"];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Invalid image file type. Only JPEG, PNG, WebP, and GIF are allowed."), false);
      }
    } else {
      cb(new Error("Unexpected field"), false);
    }
  },
});

// Upload Track
router.post(
  "/upload",
  requireAuth(),
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        title,
        artist,
        album,
        genre,
        releaseDate,
        isrc,
        description,
      } = req.body;

      // Validate required fields
      if (!title || !artist || !genre) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields (title, artist, genre)",
        });
      }

      // Validate audio file
      if (!req.files || !req.files.audio || !req.files.audio[0]) {
        return res.status(400).json({
          success: false,
          message: "Audio file is required",
        });
      }

      const audioFile = req.files.audio[0];
      const thumbnailFile = req.files.thumbnail ? req.files.thumbnail[0] : null;

      // Generate hash from audio file content for duplicate detection
      // This MUST happen BEFORE uploading to R2 to prevent duplicate files in bucket
      let audioHash;
      try {
        audioHash = generateAudioHash(audioFile.buffer);
        console.log("Generated audio hash:", audioHash.substring(0, 16) + "...");
      } catch (hashError) {
        console.error("Error generating audio hash:", hashError);
        return res.status(500).json({
          success: false,
          message: "Error processing audio file for duplicate detection",
        });
      }

      // Check if audio with same hash already exists (duplicate detection)
      // This MUST happen BEFORE uploading to R2 to prevent duplicate files in bucket
      let existingTrack;
      try {
        existingTrack = await Track.findOne({
          "audio.audioHash": audioHash,
        });
        
        console.log("Duplicate check result:", {
          hash: audioHash.substring(0, 16) + "...",
          found: !!existingTrack,
          existingTrackId: existingTrack?._id,
        });
      } catch (queryError) {
        console.error("Error checking for duplicates:", queryError);
        return res.status(500).json({
          success: false,
          message: "Error checking for duplicate audio files",
        });
      }

      if (existingTrack) {
        console.log("❌ DUPLICATE DETECTED - Blocking upload to R2");
        console.log("Existing track:", {
          id: existingTrack._id,
          title: existingTrack.title,
          artist: existingTrack.artist,
          hash: existingTrack.audio?.audioHash?.substring(0, 16) + "...",
        });
        return res.status(409).json({
          success: false,
          message: "This audio file already exists in the system. Duplicate uploads are not allowed.",
          existingTrack: {
            title: existingTrack.title,
            artist: existingTrack.artist,
            id: existingTrack._id,
          },
        });
      }

      console.log("✅ No duplicate found - proceeding with upload to R2");

      // Calculate audio duration
      console.log("Calculating audio duration...");
      let durationSeconds = null;
      try {
        durationSeconds = await getAudioDuration(audioFile.buffer);
        console.log("Audio duration:", durationSeconds, "seconds");
      } catch (durationError) {
        console.error("Error calculating duration:", durationError);
        // Continue without duration - it's optional
      }

      // Upload audio file to Cloudflare R2
      console.log("Uploading audio file to R2...");
      const audioUploadResult = await uploadToR2(
        audioFile.buffer,
        audioFile.originalname,
        audioFile.mimetype,
        "audio"
      );

      // Upload thumbnail to Cloudflare R2 (if provided)
      let thumbnailUploadResult = null;
      if (thumbnailFile) {
        console.log("Uploading thumbnail to R2...");
        thumbnailUploadResult = await uploadToR2(
          thumbnailFile.buffer,
          thumbnailFile.originalname,
          thumbnailFile.mimetype,
          "thumbnails"
        );
      }

      // Find user by Clerk ID to get MongoDB _id
      const user = await User.findOne({ clerkId: req.auth.userId });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found. Please complete onboarding first.",
        });
      }

      // Create track in database
      // Note: The unique index on audioHash will also prevent duplicates at DB level
      let track;
      try {
        track = await Track.create({
          user: user._id, // MongoDB ObjectId
          title,
          artist,
          album: album || "",
          genre,
          releaseDate: releaseDate ? new Date(releaseDate) : null,
          isrc: isrc || "", // Will be overwritten if auto-generated
          description: description || "",

          audio: {
            fileName: audioFile.originalname,
            fileSize: audioFile.size,
            fileType: audioFile.mimetype,
            fileUrl: audioUploadResult.fileUrl,
            storageKey: audioUploadResult.storageKey,
            audioHash: audioHash, // Store hash for duplicate detection
          },

          thumbnail: thumbnailUploadResult
            ? {
                fileName: thumbnailFile.originalname,
                fileSize: thumbnailFile.size,
                fileType: thumbnailFile.mimetype,
                fileUrl: thumbnailUploadResult.fileUrl,
                storageKey: thumbnailUploadResult.storageKey,
              }
            : null,

          uploadStatus: "ready",
          durationSeconds: durationSeconds, // Store calculated duration
        });

        // Generate ISRC automatically if prefix is configured
        const isrcPrefix = process.env.ISRC_PREFIX;
        if (isrcPrefix && isrcPrefix.length === 5) {
          try {
            await assignISRC(ISRCRegistry, Track, track._id.toString(), isrcPrefix);
            // Reload track to get updated ISRC
            track = await Track.findById(track._id);
            console.log(`ISRC auto-generated for track ${track._id}: ${track.isrc}`);
          } catch (isrcError) {
            console.error("Error generating ISRC:", isrcError);
            // Continue without ISRC - don't fail the upload
          }
        } else {
          // ISRC_PREFIX not configured - this is okay, user can assign manually later
          // Don't log warning as it's not an error
        }

        // Create TrackRegistry entry
        try {
          await TrackRegistry.findOneAndUpdate(
            { trackId: track._id },
            {
              trackId: track._id,
              title: track.title,
              artist: track.artist,
              isrc: track.isrc || track.tracking?.isrc || "",
              creator: user._id,
            },
            { upsert: true, new: true }
          );

          // Update track with ISRC in tracking field
          if (track.isrc) {
            track.tracking = track.tracking || {};
            track.tracking.isrc = track.isrc;
            await track.save();
          }
        } catch (registryError) {
          console.error("Error creating TrackRegistry entry:", registryError);
          // Continue - don't fail the upload if registry creation fails
        }
      } catch (dbError) {
        // Handle duplicate key error from unique index
        if (dbError.code === 11000 || dbError.name === "MongoServerError") {
          console.error("❌ DUPLICATE DETECTED at database level:", dbError);
          // Note: File was already uploaded to R2, but we prevent duplicate DB entry
          // In production, you might want to delete the R2 file here
          return res.status(409).json({
            success: false,
            message: "This audio file already exists in the system. Duplicate uploads are not allowed.",
          });
        }
        throw dbError; // Re-throw other errors
      }

      return res.status(201).json({
        success: true,
        message: "Track uploaded successfully",
        track,
      });
    } catch (err) {
      console.error("UPLOAD ERROR:", err);
      return res.status(500).json({
        success: false,
        message: err.message || "Server error while uploading track",
      });
    }
  }
);

// Fetch All Released Tracks (Public)
router.get("/released", async (req, res) => {
  try {
    const { genre, search, sort = "recent" } = req.query;

    // Build query - only released AND approved tracks
    const query = { released: true, approved: true };

    // Genre filter
    if (genre && genre !== "all") {
      query.genre = genre;
    }

    // Search filter
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { artist: { $regex: search, $options: "i" } },
        { album: { $regex: search, $options: "i" } },
      ];
    }

    // Sort options
    let sortOption = { createdAt: -1 }; // default: recent
    if (sort === "oldest") {
      sortOption = { createdAt: 1 };
    } else if (sort === "title") {
      sortOption = { title: 1 };
    } else if (sort === "artist") {
      sortOption = { artist: 1 };
    }

    const tracks = await Track.find(query)
      .populate("user", "userName email imageUrl")
      .sort(sortOption)
      .limit(1000); // Limit to prevent performance issues

    return res.status(200).json({
      success: true,
      tracks,
      count: tracks.length,
    });
  } catch (err) {
    console.error("FETCH RELEASED TRACKS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching released tracks",
    });
  }
});

// Fetch Recently Released Tracks (Last Week) - Public
router.get("/released/recent", async (req, res) => {
  try {
    const { genre, search, sort = "recent" } = req.query;

    // Calculate date 7 days ago
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Build query - tracks released in last week AND approved
    const query = {
      released: true,
      approved: true,
      createdAt: { $gte: oneWeekAgo },
    };

    // Genre filter
    if (genre && genre !== "all") {
      query.genre = genre;
    }

    // Search filter
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { artist: { $regex: search, $options: "i" } },
        { album: { $regex: search, $options: "i" } },
      ];
    }

    // Sort options
    let sortOption = { createdAt: -1 }; // default: recent
    if (sort === "oldest") {
      sortOption = { createdAt: 1 };
    } else if (sort === "title") {
      sortOption = { title: 1 };
    } else if (sort === "artist") {
      sortOption = { artist: 1 };
    }

    const tracks = await Track.find(query)
      .populate("user", "userName email imageUrl")
      .sort(sortOption)
      .limit(1000);

    return res.status(200).json({
      success: true,
      tracks,
      count: tracks.length,
    });
  } catch (err) {
    console.error("FETCH RECENT RELEASED TRACKS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching recent released tracks",
    });
  }
});

// Fetch My Tracks
router.get("/my-tracks", requireAuth(), async (req, res) => {
  try {
    // Find user by Clerk ID to get MongoDB _id
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found. Please complete onboarding first.",
      });
    }

    const tracks = await Track.find({
      user: user._id,
    })
      .populate("user", "userName email imageUrl")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      tracks,
    });
  } catch (err) {
    console.error("FETCH ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching tracks",
    });
  }
});

// Delete Track
router.delete("/:trackId", requireAuth(), async (req, res) => {
  try {
    const { trackId } = req.params;

    // Find user by Clerk ID
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Find track and verify ownership
    const track = await Track.findOne({
      _id: trackId,
      user: user._id,
    });

    if (!track) {
      return res.status(404).json({
        success: false,
        message: "Track not found or you don't have permission to delete it",
      });
    }

    // Delete track from database
    await Track.findByIdAndDelete(trackId);

    // TODO: Optionally delete files from R2 storage
    // You can add R2 deletion logic here if needed

    return res.status(200).json({
      success: true,
      message: "Track deleted successfully",
    });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error deleting track",
    });
  }
});

// Update Track Lyrics
router.patch("/:trackId/lyrics", requireAuth(), async (req, res) => {
  try {
    const { trackId } = req.params;
    const { lyrics } = req.body;

    // Find user by Clerk ID
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Find track and verify ownership
    const track = await Track.findOne({
      _id: trackId,
      user: user._id,
    });

    if (!track) {
      return res.status(404).json({
        success: false,
        message: "Track not found or you don't have permission to update it",
      });
    }

    // Update lyrics
    track.lyrics = lyrics || "";
    await track.save();

    return res.status(200).json({
      success: true,
      message: "Lyrics updated successfully",
      track,
    });
  } catch (err) {
    console.error("UPDATE LYRICS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error updating lyrics",
    });
  }
});

// Toggle Track Release Status
router.patch("/:trackId/release", requireAuth(), async (req, res) => {
  try {
    const { trackId } = req.params;
    const { released } = req.body;

    // Find user by Clerk ID
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Find track and verify ownership
    const track = await Track.findOne({
      _id: trackId,
      user: user._id,
    });

    if (!track) {
      return res.status(404).json({
        success: false,
        message: "Track not found or you don't have permission to update it",
      });
    }

    // Update release status
    track.released = released !== undefined ? released : !track.released;
    await track.save();

    return res.status(200).json({
      success: true,
      message: track.released
        ? "Track marked as released"
        : "Track marked as not released",
      track,
    });
  } catch (err) {
    console.error("TOGGLE RELEASE ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error updating release status",
    });
  }
});

// Create Album
router.post(
  "/albums",
  requireAuth(),
  upload.single("albumThumbnail"),
  async (req, res) => {
    try {
      const { name, description, trackIds } = req.body;

      // Validate required fields
      if (!name || !name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Album name is required",
        });
      }

      // Parse trackIds (should be JSON array)
      let tracks = [];
      if (trackIds) {
        try {
          tracks = typeof trackIds === "string" ? JSON.parse(trackIds) : trackIds;
          if (!Array.isArray(tracks)) {
            return res.status(400).json({
              success: false,
              message: "trackIds must be an array",
            });
          }
        } catch (parseError) {
          return res.status(400).json({
            success: false,
            message: "Invalid trackIds format",
          });
        }
      }

      // Find user by Clerk ID
      const user = await User.findOne({ clerkId: req.auth.userId });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found. Please complete onboarding first.",
        });
      }

      // Verify all tracks belong to the user
      if (tracks.length > 0) {
        const userTracks = await Track.find({
          _id: { $in: tracks },
          user: user._id,
        });

        if (userTracks.length !== tracks.length) {
          return res.status(403).json({
            success: false,
            message: "Some tracks do not belong to you or do not exist",
          });
        }
      }

      // Upload album thumbnail to Cloudflare R2 (if provided)
      let thumbnailUploadResult = null;
      if (req.file) {
        console.log("Uploading album thumbnail to R2...");
        thumbnailUploadResult = await uploadToR2(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype,
          "album-thumbnails"
        );
      }

      // Create album in database
      const album = await Album.create({
        user: user._id,
        name: name.trim(),
        description: description ? description.trim() : "",
        tracks: tracks,
        thumbnail: thumbnailUploadResult
          ? {
              fileName: thumbnailUploadResult.fileName,
              fileSize: thumbnailUploadResult.fileSize,
              fileType: thumbnailUploadResult.fileType,
              fileUrl: thumbnailUploadResult.fileUrl,
              storageKey: thumbnailUploadResult.storageKey,
            }
          : {
              fileName: "",
              fileSize: 0,
              fileType: "",
              fileUrl: "",
              storageKey: "",
            },
      });

      // Populate tracks for response
      await album.populate("tracks");

      return res.status(201).json({
        success: true,
        message: "Album created successfully",
        album,
      });
    } catch (err) {
      console.error("CREATE ALBUM ERROR:", err);
      return res.status(500).json({
        success: false,
        message: "Server error creating album",
      });
    }
  }
);

// Get User Albums
router.get("/albums", requireAuth(), async (req, res) => {
  try {
    // Find user by Clerk ID
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Get all albums for the user, populated with tracks
    const albums = await Album.find({ user: user._id })
      .populate("tracks")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      albums,
    });
  } catch (err) {
    console.error("GET ALBUMS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching albums",
    });
  }
});

/**
 * POST /api/music/playlists
 * Create a new playlist
 */
router.post("/playlists", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const { name, selectedTracks } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Playlist name is required",
      });
    }

    if (!selectedTracks || !Array.isArray(selectedTracks) || selectedTracks.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one track is required",
      });
    }

    // Validate all tracks have stream counts
    const invalidTracks = selectedTracks.filter(
      (t) => !t.streams || t.streams <= 0
    );
    if (invalidTracks.length > 0) {
      return res.status(400).json({
        success: false,
        message: "All tracks must have valid stream counts",
      });
    }

    // Verify all tracks belong to the user and are approved
    const trackIds = selectedTracks.map((t) => t.trackId);
    const tracks = await Track.find({
      _id: { $in: trackIds },
      user: user._id,
      approved: true,
    });

    if (tracks.length !== trackIds.length) {
      return res.status(400).json({
        success: false,
        message: "Some tracks are invalid or not approved",
      });
    }

    // Calculate totals
    const totalStreams = selectedTracks.reduce((sum, t) => sum + (t.streams || 0), 0);
    // Get streaming price from settings (default to 0.1 if not set)
    const streamPrice = await Settings.getSetting("streaming_price_per_stream", 0.1);
    const totalPrice = totalStreams * streamPrice;

    // Create playlist
    const playlist = new Playlist({
      user: user._id,
      name: name.trim(),
      tracks: selectedTracks.map((t) => ({
        trackId: t.trackId,
        streams: t.streams,
      })),
      totalStreams,
      totalPrice,
    });

    await playlist.save();

    // Populate track details
    await playlist.populate({
      path: "tracks.trackId",
      select: "title artist",
    });

    return res.status(201).json({
      success: true,
      message: "Playlist created successfully",
      playlist,
    });
  } catch (error) {
    console.error("Error creating playlist:", error);
    return res.status(500).json({
      success: false,
      message: "Server error creating playlist",
    });
  }
});

/**
 * GET /api/music/playlists
 * Get all playlists for the current user
 */
router.get("/playlists", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const playlists = await Playlist.find({ user: user._id })
      .populate({
        path: "tracks.trackId",
        select: "title artist",
      })
      .sort({ createdAt: -1 });

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
 * GET /api/music/playlists/:id
 * Get a specific playlist by ID
 */
router.get("/playlists/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const playlist = await Playlist.findOne({
      _id: req.params.id,
      user: user._id,
    }).populate({
      path: "tracks.trackId",
      select: "title artist",
    });

    if (!playlist) {
      return res.status(404).json({
        success: false,
        message: "Playlist not found",
      });
    }

    return res.status(200).json({
      success: true,
      playlist,
    });
  } catch (error) {
    console.error("Error fetching playlist:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching playlist",
    });
  }
});

/**
 * DELETE /api/music/playlists/:id
 * Delete a playlist
 */
router.delete("/playlists/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const playlist = await Playlist.findOneAndDelete({
      _id: req.params.id,
      user: user._id,
    });

    if (!playlist) {
      return res.status(404).json({
        success: false,
        message: "Playlist not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Playlist deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting playlist:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting playlist",
    });
  }
});

/**
 * POST /api/music/licenses
 * Create a new track license
 */
router.post("/licenses", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const { trackId, licenseType, terms, price, duration } = req.body;

    if (!trackId) {
      return res.status(400).json({
        success: false,
        message: "Track ID is required",
      });
    }

    if (!licenseType) {
      return res.status(400).json({
        success: false,
        message: "License type is required",
      });
    }

    if (price === undefined || price < 0) {
      return res.status(400).json({
        success: false,
        message: "Valid price is required",
      });
    }

    if (!duration || duration < 1) {
      return res.status(400).json({
        success: false,
        message: "Valid duration (years) is required",
      });
    }

    // Verify track belongs to the user
    const track = await Track.findOne({
      _id: trackId,
      user: user._id,
    });

    if (!track) {
      return res.status(404).json({
        success: false,
        message: "Track not found or you don't have permission",
      });
    }

    // Create license
    const license = new TrackLicense({
      user: user._id,
      track: trackId,
      licenseType,
      terms: terms || "",
      price: parseFloat(price),
      duration: parseInt(duration),
    });

    await license.save();

    // Populate track details
    await license.populate({
      path: "track",
      select: "title artist",
    });

    return res.status(201).json({
      success: true,
      message: "License created successfully",
      license,
    });
  } catch (error) {
    console.error("Error creating license:", error);
    return res.status(500).json({
      success: false,
      message: "Server error creating license",
    });
  }
});

/**
 * GET /api/music/licenses
 * Get all licenses for the current user's tracks
 */
router.get("/licenses", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const licenses = await TrackLicense.find({ user: user._id })
      .populate({
        path: "track",
        select: "title artist",
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      licenses,
    });
  } catch (error) {
    console.error("Error fetching licenses:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching licenses",
    });
  }
});

/**
 * GET /api/music/licenses/:id
 * Get a specific license by ID
 */
router.get("/licenses/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const license = await TrackLicense.findOne({
      _id: req.params.id,
      user: user._id,
    }).populate({
      path: "track",
      select: "title artist",
    });

    if (!license) {
      return res.status(404).json({
        success: false,
        message: "License not found",
      });
    }

    return res.status(200).json({
      success: true,
      license,
    });
  } catch (error) {
    console.error("Error fetching license:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching license",
    });
  }
});

/**
 * DELETE /api/music/licenses/:id
 * Delete a license
 */
router.delete("/licenses/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const license = await TrackLicense.findOneAndDelete({
      _id: req.params.id,
      user: user._id,
    });

    if (!license) {
      return res.status(404).json({
        success: false,
        message: "License not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "License deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting license:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting license",
    });
  }
});

module.exports = router;
