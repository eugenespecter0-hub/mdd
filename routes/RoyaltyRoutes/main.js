const express = require("express");
const router = express.Router();
const multer = require("multer");
const { requireAuth } = require("@clerk/express");
const path = require("path");
const fs = require("fs");
const Track = require("../../models/TrackModel");
const TrackRegistry = require("../../models/TrackRegistryModel");
const User = require("../../models/User");
const { parseDSPReport } = require("../../royalty/parsers/parseDSPReport");
const { parseYouTubeCID } = require("../../royalty/parsers/parseYouTubeCID");
const { parseSoundExchange } = require("../../royalty/parsers/parseSoundExchange");

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../../uploads/royalty-reports");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `royalty-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [".csv", ".xml", ".xlsx"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only CSV, XML, and XLSX files are allowed."));
    }
  },
});

/**
 * POST /api/royalties/upload-report
 * Upload and parse royalty report
 */
router.post("/upload-report", requireAuth(), upload.single("report"), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    const reportType = req.body.reportType || "dsp"; // dsp, youtube, soundexchange

    let parsedData = [];

    try {
      // Detect report type and parse accordingly
      if (reportType === "youtube" || reportType === "youtube-cid") {
        parsedData = await parseYouTubeCID(filePath);
      } else if (reportType === "soundexchange" || reportType === "sx") {
        parsedData = await parseSoundExchange(filePath);
      } else {
        // Default to DSP report
        const fileType = fileExt === ".xml" ? "xml" : "csv";
        parsedData = await parseDSPReport(filePath, fileType);
      }

      if (parsedData.length === 0) {
        // Clean up file
        fs.unlinkSync(filePath);
        return res.status(400).json({
          success: false,
          message: "No valid records found in the report",
        });
      }

      // Match records to tracks and save earnings
      const matchedRecords = [];
      const unmatchedRecords = [];

      for (const record of parsedData) {
        let track = null;

        // Try to match by ISRC first
        if (record.isrc) {
          track = await Track.findOne({ isrc: record.isrc.toUpperCase() });
        }

        // If no match by ISRC, try to match by YouTube video ID
        if (!track && record.videoId) {
          const registry = await TrackRegistry.findOne({ "youtube.id": record.videoId });
          if (registry) {
            track = await Track.findById(registry.trackId);
          }
        }

        // If still no match, try to match by asset ID (YouTube CID)
        if (!track && record.assetId) {
          // This would require additional mapping logic
          // For now, we'll mark as unmatched
        }

        if (track) {
          // Save earnings to track (you may want to create a separate Earnings model)
          // For now, we'll just track the match
          matchedRecords.push({
            trackId: track._id,
            trackTitle: track.title,
            trackArtist: track.artist,
            record,
          });
        } else {
          unmatchedRecords.push(record);
        }
      }

      // Clean up uploaded file
      fs.unlinkSync(filePath);

      return res.status(200).json({
        success: true,
        message: "Report processed successfully",
        summary: {
          totalRecords: parsedData.length,
          matched: matchedRecords.length,
          unmatched: unmatchedRecords.length,
        },
        matchedRecords: matchedRecords.slice(0, 100), // Limit response size
        unmatchedRecords: unmatchedRecords.slice(0, 100),
      });
    } catch (parseError) {
      // Clean up file on error
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      console.error("Error parsing report:", parseError);
      return res.status(500).json({
        success: false,
        message: "Error parsing report",
        error: parseError.message,
      });
    }
  } catch (error) {
    console.error("Error uploading royalty report:", error);
    return res.status(500).json({
      success: false,
      message: "Server error uploading report",
    });
  }
});

module.exports = router;

