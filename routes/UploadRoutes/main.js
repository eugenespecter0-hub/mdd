/**
 * Upload Routes
 * Handles presigned URLs and upload completion
 */

const express = require("express");
const router = express.Router();
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

// Models
const Track = require("../../models/TrackModel");
const User = require("../../models/User");
const AuditLog = require("../../models/AuditLogModel");
const ISRCRegistry = require("../../models/ISRCRegistryModel");

// Utils
const { assignISRC } = require("../../utils/isrcGenerator");

// S3/R2 client
const s3Client = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Middleware to require auth
function requireAuth() {
  return async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.userId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
      next();
    } catch (error) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
  };
}

/**
 * POST /api/uploads/presign
 * Generate presigned URL for direct upload to S3/R2
 * Supports: audio, image, and video files
 */
router.post("/presign", requireAuth(), async (req, res) => {
  try {
    const { fileName, fileType, fileSize, contentType } = req.body; // contentType: 'audio' | 'image' | 'video'

    if (!fileName || !fileType || !fileSize) {
      return res.status(400).json({
        success: false,
        message: "fileName, fileType, and fileSize are required",
      });
    }

    // Validate file type based on contentType
    let allowedTypes = [];
    let folder = "uploads";
    
    if (contentType === "audio") {
      allowedTypes = [
        "audio/mpeg",
        "audio/mp3",
        "audio/wav",
        "audio/flac",
        "audio/aac",
        "audio/ogg",
      ];
      folder = "audio";
    } else if (contentType === "image") {
      allowedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "image/tiff",
        "image/gif",
      ];
      folder = "photos";
    } else if (contentType === "video") {
      allowedTypes = [
        "video/mp4",
        "video/quicktime",
        "video/x-msvideo",
        "video/x-matroska",
        "video/webm",
      ];
      folder = "videos";
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid contentType. Must be 'audio', 'image', or 'video'",
      });
    }

    if (!allowedTypes.includes(fileType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid file type for ${contentType}. Allowed types: ${allowedTypes.join(", ")}`,
      });
    }

    // Validate file size based on content type
    let maxSize = 500 * 1024 * 1024; // Default 500MB
    if (contentType === "image") {
      maxSize = 50 * 1024 * 1024; // 50MB for images
    } else if (contentType === "video") {
      maxSize = 500 * 1024 * 1024; // 500MB for videos
    } else if (contentType === "audio") {
      maxSize = 500 * 1024 * 1024; // 500MB for audio
    }

    if (fileSize > maxSize) {
      return res.status(400).json({
        success: false,
        message: `File size exceeds maximum allowed size (${Math.round(maxSize / (1024 * 1024))}MB)`,
      });
    }

    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Generate unique storage key
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString("hex");
    const fileExtension = fileName.split(".").pop();
    const storageKey = `${folder}/${user._id}/${timestamp}-${randomString}.${fileExtension}`;

    // Generate presigned URL
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: storageKey,
      ContentType: fileType,
      ContentLength: fileSize,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600, // 1 hour
    });

    return res.status(200).json({
      success: true,
      presignedUrl,
      storageKey,
      expiresIn: 3600,
    });
  } catch (error) {
    console.error("Presign URL error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error generating presigned URL",
    });
  }
});

/**
 * POST /api/uploads/complete
 * Mark upload as complete
 */
router.post("/complete", requireAuth(), async (req, res) => {
  try {
    const {
      storageKey,
      fileName,
      fileType,
      fileSize,
      title,
      artist,
      album,
      genre,
      description,
      releaseDate,
      thumbnailStorageKey,
      thumbnailFileName,
      thumbnailFileType,
      thumbnailFileSize,
      thumbnailUrl,
    } = req.body;

    if (!storageKey || !fileName || !fileType || !fileSize || !title || !artist || !genre) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Download file to compute hash (or get hash from client if already computed)
    // For now, we'll compute it during ingestion
    // In production, you might want to compute it client-side and send it here

    // Get file URL (construct from storage key)
    const fileUrl = `${process.env.R2_PUBLIC_URL || process.env.R2_ENDPOINT}/${storageKey}`;

    // Create track record
    let track = await Track.create({
      user: user._id,
      title,
      artist,
      album: album || "",
      genre,
      description: description || "",
      releaseDate: releaseDate ? new Date(releaseDate) : null,
      audio: {
        fileName,
        fileSize: parseInt(fileSize),
        fileType,
        fileUrl,
        storageKey,
        audioHash: "", // Will be computed during ingestion
      },
      thumbnail: thumbnailStorageKey
        ? {
            fileName: thumbnailFileName || "",
            fileSize: thumbnailFileSize || 0,
            fileType: thumbnailFileType || "",
            fileUrl: thumbnailUrl || "",
            storageKey: thumbnailStorageKey || "",
          }
        : {
            fileName: "",
            fileSize: 0,
            fileType: "",
            fileUrl: "",
            storageKey: "",
          },
      uploadStatus: "processing",
      released: false,
    });

    // Generate ISRC if prefix is configured
    let isrcRecord = null;
    const isrcPrefix = process.env.ISRC_PREFIX;
    if (isrcPrefix && isrcPrefix.length === 5) {
      try {
        isrcRecord = await assignISRC(ISRCRegistry, Track, track._id.toString(), isrcPrefix);
        // Reload track to get updated ISRC
        const updatedTrack = await Track.findById(track._id);
        if (updatedTrack) {
          track = updatedTrack;
        }
      } catch (isrcError) {
        console.error("Error generating ISRC:", isrcError);
        // Continue without ISRC - don't fail the upload
      }
    }

    await AuditLog.create({
      user: user._id,
      action: "track_uploaded",
      resourceType: "track",
      resourceId: track._id,
      status: "success",
      metadata: {
        fileName,
        fileSize,
        isrc: track.isrc || null,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Upload completed. Track is being processed.",
      track: {
        _id: track._id,
        title: track.title,
        artist: track.artist,
        uploadStatus: track.uploadStatus,
        isrc: track.isrc || null,
      },
    });
  } catch (error) {
    console.error("Upload complete error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error completing upload",
    });
  }
});

module.exports = router;
