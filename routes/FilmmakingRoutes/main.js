/**
 * Filmmaking Routes
 * Handles video uploads and management
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { requireAuth } = require("@clerk/express");
const Video = require("../../models/VideoModel");
const Script = require("../../models/ScriptModel");
const AIGeneratedVideo = require("../../models/AIGeneratedVideoModel");
const User = require("../../models/User");
const AuditLog = require("../../models/AuditLogModel");
const { uploadToR2 } = require("../../utils/cloudflareR2");
const crypto = require("crypto");
const axios = require("axios");
require("dotenv").config();

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "video") {
      const allowedTypes = [
        "video/mp4",
        "video/quicktime",
        "video/x-msvideo",
        "video/x-matroska",
        "video/webm",
      ];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Invalid video file type. Only MP4, MOV, AVI, MKV, and WebM are allowed."), false);
      }
    } else if (file.fieldname === "thumbnail") {
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/jpg"];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Invalid thumbnail file type. Only JPEG, PNG, WebP, and GIF are allowed."), false);
      }
    } else {
      cb(new Error("Unexpected field"), false);
    }
  },
});

// Configure multer for script uploads
const scriptUpload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size for scripts
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/fountain",
    ];
    const allowedExtensions = [".pdf", ".txt", ".doc", ".docx", ".fountain"];
    const fileExtension = "." + file.originalname.split(".").pop().toLowerCase();
    
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid script file type. Only PDF, TXT, DOC, DOCX, and Fountain files are allowed."), false);
    }
  },
});

/**
 * Generate SHA-256 hash for video
 */
function generateVideoHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Generate SHA-256 hash for script
 */
function generateScriptHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * POST /api/filmmaking/upload
 * Upload a video
 */
router.post(
  "/upload",
  requireAuth(),
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        title,
        filmmaker,
        project,
        category,
        releaseDate,
        duration,
        description,
      } = req.body;

      // Validate required fields
      if (!title || !filmmaker || !category) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields (title, filmmaker, category)",
        });
      }

      // Validate video file
      if (!req.files || !req.files.video || !req.files.video[0]) {
        return res.status(400).json({
          success: false,
          message: "Video file is required",
        });
      }

      const videoFile = req.files.video[0];
      const thumbnailFile = req.files.thumbnail ? req.files.thumbnail[0] : null;

      // Generate hash for duplicate detection
      let videoHash;
      try {
        videoHash = generateVideoHash(videoFile.buffer);
        console.log("Generated video hash:", videoHash.substring(0, 16) + "...");
      } catch (hashError) {
        console.error("Error generating video hash:", hashError);
        return res.status(500).json({
          success: false,
          message: "Error processing video file",
        });
      }

      // Check for duplicates
      let existingVideo;
      try {
        existingVideo = await Video.findOne({
          "video.videoHash": videoHash,
        });
      } catch (queryError) {
        console.error("Error checking for duplicates:", queryError);
        return res.status(500).json({
          success: false,
          message: "Error checking for duplicate videos",
        });
      }

      if (existingVideo) {
        return res.status(409).json({
          success: false,
          message: "This video already exists in the system. Duplicate uploads are not allowed.",
          existingVideo: {
            title: existingVideo.title,
            filmmaker: existingVideo.filmmaker,
            id: existingVideo._id,
          },
        });
      }

      // Upload video to Cloudflare R2
      console.log("Uploading video to R2...");
      const videoUploadResult = await uploadToR2(
        videoFile.buffer,
        videoFile.originalname,
        videoFile.mimetype,
        "videos"
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

      // Find user by Clerk ID
      const user = await User.findOne({ clerkId: req.auth.userId });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found. Please complete onboarding first.",
        });
      }

      // Create video in database
      let video;
      try {
        video = await Video.create({
          user: user._id,
          title,
          filmmaker,
          project: project || "",
          category,
          releaseDate: releaseDate ? new Date(releaseDate) : null,
          duration: duration || "",
          description: description || "",
          video: {
            fileName: videoFile.originalname,
            fileSize: videoFile.size,
            fileType: videoFile.mimetype,
            fileUrl: videoUploadResult.fileUrl,
            storageKey: videoUploadResult.storageKey,
            videoHash: videoHash,
          },
          thumbnail: thumbnailUploadResult
            ? {
                fileName: thumbnailFile.originalname,
                fileSize: thumbnailFile.size,
                fileType: thumbnailFile.mimetype,
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
          uploadStatus: "ready",
          released: false,
        });
      } catch (dbError) {
        if (dbError.code === 11000 || dbError.name === "MongoServerError") {
          console.error("❌ DUPLICATE DETECTED at database level:", dbError);
          return res.status(409).json({
            success: false,
            message: "This video already exists in the system. Duplicate uploads are not allowed.",
          });
        }
        throw dbError;
      }

      await AuditLog.create({
        user: user._id,
        action: "video_uploaded",
        resourceType: "video",
        resourceId: video._id,
        status: "success",
        metadata: {
          fileName: videoFile.originalname,
          fileSize: videoFile.size,
        },
      });

      return res.status(201).json({
        success: true,
        message: "Video uploaded successfully",
        video,
      });
    } catch (err) {
      console.error("UPLOAD ERROR:", err);
      return res.status(500).json({
        success: false,
        message: err.message || "Server error while uploading video",
      });
    }
  }
);

/**
 * GET /api/filmmaking/my-videos
 * Get user's videos
 */
router.get("/my-videos", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const videos = await Video.find({ user: user._id })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      videos,
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
 * DELETE /api/filmmaking/video/:id
 * Delete a video
 */
router.delete("/video/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const video = await Video.findOne({ _id: req.params.id, user: user._id });
    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found" });
    }

    await Video.deleteOne({ _id: req.params.id });
    
    await AuditLog.create({
      user: user._id,
      action: "video_deleted",
      resourceType: "video",
      resourceId: req.params.id,
      status: "success",
    });

    return res.status(200).json({
      success: true,
      message: "Video deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting video:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting video",
    });
  }
});

/**
 * GET /api/filmmaking/projects
 * Get user's projects (unique project names from videos)
 */
router.get("/projects", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const videos = await Video.find({ user: user._id, project: { $ne: "" } });
    const projectsMap = new Map();
    
    videos.forEach((video) => {
      if (video.project) {
        if (!projectsMap.has(video.project)) {
          projectsMap.set(video.project, []);
        }
        projectsMap.get(video.project).push(video);
      }
    });

    const projects = Array.from(projectsMap.entries()).map(([name, videos]) => ({
      name,
      videoCount: videos.length,
      thumbnail: videos[0]?.thumbnail?.fileUrl || null,
      createdAt: videos[0]?.createdAt || new Date(),
    }));

    return res.status(200).json({
      success: true,
      projects,
    });
  } catch (error) {
    console.error("Error fetching projects:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching projects",
    });
  }
});

/**
 * GET /api/filmmaking/project/:name
 * Get videos in a specific project
 */
router.get("/project/:name", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const decodedName = decodeURIComponent(req.params.name);
    const videos = await Video.find({ 
      user: user._id, 
      project: decodedName 
    }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      videos,
      projectName: decodedName,
    });
  } catch (error) {
    console.error("Error fetching project videos:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching project",
    });
  }
});

/**
 * POST /api/filmmaking/upload-script
 * Upload a script
 */
router.post(
  "/upload-script",
  requireAuth(),
  scriptUpload.single("script"),
  async (req, res) => {
    try {
      const {
        title,
        filmmaker,
        project,
        category,
        description,
      } = req.body;

      // Validate required fields
      if (!title || !filmmaker) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields (title, filmmaker)",
        });
      }

      // Validate script file
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Script file is required",
        });
      }

      const scriptFile = req.file;

      // Get user
      const user = await User.findOne({ clerkId: req.auth.userId });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Generate hash for duplicate detection
      const scriptHash = generateScriptHash(scriptFile.buffer);

      // Check for duplicate script
      const existingScript = await Script.findOne({ "script.scriptHash": scriptHash });
      if (existingScript) {
        return res.status(409).json({
          success: false,
          message: "This script already exists in the system. Duplicate uploads are not allowed.",
        });
      }

      // Upload script to R2
      const scriptUploadResult = await uploadToR2(
        scriptFile.buffer,
        scriptFile.originalname,
        scriptFile.mimetype,
        "scripts"
      );

      // Create script in database
      let script;
      try {
        script = await Script.create({
          user: user._id,
          title,
          filmmaker,
          project: project || "",
          category: category || "",
          description: description || "",
          script: {
            fileName: scriptFile.originalname,
            fileSize: scriptFile.size,
            fileType: scriptFile.mimetype,
            fileUrl: scriptUploadResult.fileUrl,
            storageKey: scriptUploadResult.storageKey,
            scriptHash: scriptHash,
          },
          uploadStatus: "ready",
          released: false,
        });
      } catch (dbError) {
        if (dbError.code === 11000 || dbError.name === "MongoServerError") {
          console.error("❌ DUPLICATE DETECTED at database level:", dbError);
          return res.status(409).json({
            success: false,
            message: "This script already exists in the system. Duplicate uploads are not allowed.",
          });
        }
        throw dbError;
      }

      await AuditLog.create({
        user: user._id,
        action: "script_uploaded",
        resourceType: "script",
        resourceId: script._id,
        status: "success",
        metadata: {
          fileName: scriptFile.originalname,
          fileSize: scriptFile.size,
        },
      });

      return res.status(201).json({
        success: true,
        message: "Script uploaded successfully",
        script,
      });
    } catch (err) {
      console.error("UPLOAD ERROR:", err);
      return res.status(500).json({
        success: false,
        message: err.message || "Server error while uploading script",
      });
    }
  }
);

/**
 * GET /api/filmmaking/my-scripts
 * Get user's scripts
 */
router.get("/my-scripts", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const scripts = await Script.find({ user: user._id })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      scripts,
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
 * DELETE /api/filmmaking/script/:id
 * Delete a script
 */
router.delete("/script/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const script = await Script.findOne({ _id: req.params.id, user: user._id });
    if (!script) {
      return res.status(404).json({ success: false, message: "Script not found" });
    }

    await Script.deleteOne({ _id: req.params.id });

    await AuditLog.create({
      user: user._id,
      action: "script_deleted",
      resourceType: "script",
      resourceId: script._id,
      status: "success",
    });

    return res.status(200).json({
      success: true,
      message: "Script deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting script:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting script",
    });
  }
});

/**
 * GET /api/filmmaking/script/:id/content
 * Proxy endpoint to fetch script content with CORS headers
 */
router.get("/script/:id/content", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const script = await Script.findOne({ _id: req.params.id, user: user._id });
    if (!script) {
      return res.status(404).json({ success: false, message: "Script not found" });
    }

    // Fetch the file from R2
    const response = await fetch(script.script.fileUrl);
    
    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch script content",
      });
    }

    // Get the content type
    const contentType = response.headers.get("content-type") || script.script.fileType;
    
    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${script.script.fileName}"`);

    // For PDF files, return as binary stream for iframe
    if (contentType === "application/pdf" || script.script.fileName.toLowerCase().endsWith(".pdf")) {
      const buffer = await response.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }

    // For text files, return as text
    if (contentType.includes("text/") || 
        script.script.fileName.toLowerCase().endsWith(".txt") ||
        script.script.fileName.toLowerCase().endsWith(".fountain")) {
      const text = await response.text();
      return res.send(text);
    }

    // For other files, stream the content
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("Error fetching script content:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching script content",
    });
  }
});

// Configure multer for image uploads (for AI video reference images)
const imageUpload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max for images
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid image file type. Only JPEG, PNG, and WebP are allowed."), false);
    }
  },
});

/**
 * GET /api/filmmaking/ai-videos
 * Get all AI-generated videos for the current user
 */
router.get("/ai-videos", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const videos = await AIGeneratedVideo.find({ user: user._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      videos,
    });
  } catch (error) {
    console.error("Error fetching AI videos:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching AI videos",
    });
  }
});

/**
 * POST /api/filmmaking/ai-videos/generate
 * Generate a new AI video using Luma API
 */
router.post(
  "/ai-videos/generate",
  requireAuth(),
  imageUpload.array("images", 5), // Allow up to 5 images
  async (req, res) => {
    try {
      const { prompt, title, duration, model: requestedModelRaw } = req.body;

      if (!prompt || !prompt.trim()) {
        return res.status(400).json({
          success: false,
          message: "Prompt is required",
        });
      }

      const user = await User.findOne({ clerkId: req.auth.userId });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      const LUMA_API_KEY = process.env.LUMA_API_KEY;
      if (!LUMA_API_KEY) {
        return res.status(500).json({
          success: false,
          message: "Luma API key not configured",
        });
      }

      // Upload reference images to R2 if provided
      const referenceImages = [];
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          try {
            const uploadResult = await uploadToR2(
              file.buffer,
              file.originalname,
              file.mimetype,
              "ai-video-images"
            );
            referenceImages.push({
              fileName: file.originalname,
              fileSize: file.size,
              fileType: file.mimetype,
              fileUrl: uploadResult.fileUrl,
              storageKey: uploadResult.storageKey,
            });
          } catch (uploadError) {
            console.error("Error uploading reference image:", uploadError);
            // Continue with other images if one fails
          }
        }
      }

      // Create AI video record in database
      const normalizedRequestedModel =
        typeof requestedModelRaw === "string" ? requestedModelRaw.trim() : "";

      const aiVideo = await AIGeneratedVideo.create({
        user: user._id,
        prompt: prompt.trim(),
        referenceImages,
        status: "pending",
        title: title || "",
        duration: duration ? parseInt(duration) : null,
        model: normalizedRequestedModel,
        video: {
          fileName: "",
          fileSize: 0,
          fileType: "",
          fileUrl: "",
          storageKey: "",
          thumbnailUrl: "",
        },
      });

      // Call Luma API to generate video
      // Pro model selection + model-aware params
      const ALLOWED_MODELS = ["ray-1-6", "ray-2", "ray-flash-2"];
      const requestedModel =
        ALLOWED_MODELS.includes(normalizedRequestedModel) ? normalizedRequestedModel : "";

      const getAllowedDurationSecondsForModel = (model) => {
        // Ray 1.6: duration is NOT supported
        if (model === "ray-1-6") return [];
        // Based on observed API errors in your logs
        if (model === "ray-2") return [5, 9];
        if (model === "ray-flash-2") return [5, 9];
        return [5, 9];
      };

      const getDurationParamForModel = (model, durationValue) => {
        if (!durationValue) return undefined;

        // Ray 1.6: duration is NOT supported (API errors if included)
        if (model === "ray-1-6") return undefined;

        const seconds = parseInt(durationValue, 10);
        const allowedSeconds = getAllowedDurationSecondsForModel(model);

        if (!Number.isFinite(seconds)) return undefined;
        if (!allowedSeconds.includes(seconds)) return undefined;
        return `${seconds}s`;
      };

      // If user explicitly chose a model, validate duration strictly for that model.
      if (requestedModel && duration) {
        const allowedSeconds = getAllowedDurationSecondsForModel(requestedModel);
        if (allowedSeconds.length > 0) {
          const seconds = parseInt(duration, 10);
          if (!allowedSeconds.includes(seconds)) {
            return res.status(400).json({
              success: false,
              message: `Invalid duration for ${requestedModel}. Allowed: ${allowedSeconds
                .map((s) => `${s}s`)
                .join(", ")}`,
            });
          }
        }
      }

      // If user chose a model, use it. Otherwise fallback (prefer newer models).
      const modelsToTry = requestedModel ? [requestedModel] : ["ray-flash-2", "ray-2", "ray-1-6"];
      let lumaResponse = null;
      let lastError = null;

      for (const model of modelsToTry) {
        try {
          const requestData = {
            model: model,
            prompt: prompt.trim(),
            aspect_ratio: "16:9",
          };

          // Add duration only if supported by the selected model
          const durationParam = getDurationParamForModel(model, duration);
          if (durationParam) {
            requestData.duration = durationParam;
          }

          // Add reference images if provided
          // Luma API uses keyframes for image-conditioned generations (frame0 as a start frame)
          if (referenceImages.length > 0) {
            const imageUrls = referenceImages.map((img) => img.fileUrl);
            const firstImageUrl = imageUrls[0];
            if (firstImageUrl) {
              requestData.keyframes = {
                frame0: {
                  type: "image",
                  url: firstImageUrl,
                },
              };
              console.log("Adding image keyframe to request (frame0):", firstImageUrl);
            }
          }

          console.log(`Trying Luma API with model ${model}:`, JSON.stringify(requestData, null, 2));
          
          lumaResponse = await axios.post(
            "https://api.lumalabs.ai/dream-machine/v1/generations",
            requestData,
            {
              headers: {
                Authorization: `Bearer ${LUMA_API_KEY}`,
                "Content-Type": "application/json",
              },
            }
          );
          
          console.log("Luma API response:", JSON.stringify(lumaResponse.data, null, 2));

          // Persist the model that actually succeeded
          aiVideo.model = model;
          await aiVideo.save();
          break; // Success, exit loop
        } catch (error) {
          lastError = error;
          const errorDetail = error.response?.data?.detail || error.message;
          console.error(`Error with model ${model}:`, errorDetail);
          
          // If it's not an access error, break and throw
          if (errorDetail && !errorDetail.includes("no access") && !errorDetail.includes("400")) {
            throw error;
          }
          // Otherwise try next model
        }
      }

      // If all models failed, throw the last error
      if (!lumaResponse) {
        throw lastError || new Error("All models failed");
      }

      // Update the record with Luma generation ID
      aiVideo.lumaGenerationId = lumaResponse.data.id || lumaResponse.data.generation?.id || "";
      aiVideo.status = "processing";
      await aiVideo.save();

      // Log the action
      await AuditLog.create({
        user: user._id,
        action: "ai_video_generation_started",
        resourceType: "video",
        resourceId: aiVideo._id,
        status: "success",
        metadata: {
          prompt: prompt.trim(),
          lumaGenerationId: aiVideo.lumaGenerationId,
        },
      });

      return res.status(200).json({
        success: true,
        message: "Video generation started",
        video: aiVideo,
      });
    } catch (error) {
      console.error("Error generating AI video:", error);
      
      // If aiVideo was created, update its status to failed
      if (typeof aiVideo !== 'undefined' && aiVideo && aiVideo._id) {
        try {
          aiVideo.status = "failed";
          aiVideo.errorMessage = error.response?.data?.detail || error.response?.data?.message || error.message || "Failed to start video generation";
          await aiVideo.save();
        } catch (updateError) {
          console.error("Error updating AI video status:", updateError);
        }
      }

      return res.status(500).json({
        success: false,
        message: error.response?.data?.detail || error.response?.data?.message || "Failed to start video generation",
      });
    }
  }
);

/**
 * DELETE /api/filmmaking/ai-videos/:id
 * Delete an AI-generated video
 */
router.delete("/ai-videos/:id", requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const aiVideo = await AIGeneratedVideo.findOne({
      _id: id,
      user: user._id,
    });

    if (!aiVideo) {
      return res.status(404).json({
        success: false,
        message: "AI video not found",
      });
    }

    await AIGeneratedVideo.findByIdAndDelete(id);

    await AuditLog.create({
      user: user._id,
      action: "ai_video_deleted",
      resourceType: "video",
      resourceId: id,
      status: "success",
      metadata: {
        title: aiVideo.title || "",
        prompt: aiVideo.prompt,
      },
    });

    return res.status(200).json({
      success: true,
      message: "AI video deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting AI video:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting AI video",
    });
  }
});

/**
 * GET /api/filmmaking/ai-videos/:id/status
 * Check the status of an AI video generation and update the database
 */
router.get("/ai-videos/:id/status", requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const aiVideo = await AIGeneratedVideo.findOne({
      _id: id,
      user: user._id,
    });

    if (!aiVideo) {
      return res.status(404).json({
        success: false,
        message: "AI video not found",
      });
    }

    // If no Luma generation ID, return current status
    if (!aiVideo.lumaGenerationId) {
      return res.status(200).json({
        success: true,
        video: aiVideo,
      });
    }

    const LUMA_API_KEY = process.env.LUMA_API_KEY;
    if (!LUMA_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Luma API key not configured",
      });
    }

    // Check status with Luma API
    try {
      const lumaResponse = await axios.get(
        `https://api.lumalabs.ai/dream-machine/v1/generations/${aiVideo.lumaGenerationId}`,
        {
          headers: {
            Authorization: `Bearer ${LUMA_API_KEY}`,
          },
        }
      );

      const generationData = lumaResponse.data;
      console.log("Luma API generation data:", JSON.stringify(generationData, null, 2));
      const status = generationData.state || generationData.status || generationData.generation?.state;

      // Initialize variables for URLs
      let videoUrl = null;
      let thumbnailUrl = null;

      // Update video status based on Luma API response
      if (status === "completed" || status === "succeeded" || status === "ready") {
        aiVideo.status = "completed";
        
        // Initialize video object if it doesn't exist
        if (!aiVideo.video) {
          aiVideo.video = {
            fileName: "",
            fileSize: 0,
            fileType: "",
            fileUrl: "",
            storageKey: "",
            thumbnailUrl: "",
          };
        }
        
        // Try different possible field names for video URL
        // Luma API uses assets.video for the video URL
        videoUrl = generationData.assets?.video ||
                        generationData.video_url || 
                        generationData.video?.url ||
                        generationData.output_video_url || 
                        generationData.output?.video_url ||
                        generationData.asset_url ||
                        generationData.asset?.url ||
                        generationData.assets?.[0]?.url ||
                        generationData.result?.video_url ||
                        generationData.result?.url ||
                        generationData.generation?.video_url ||
                        generationData.generation?.video?.url ||
                        generationData.generation?.output_video_url ||
                        generationData.generation?.asset_url ||
                        generationData.generation?.asset?.url ||
                        generationData.generation?.assets?.[0]?.url ||
                        generationData.generation?.assets?.video;
        
        // Try different possible field names for thumbnail URL
        // Luma API uses assets.image for the thumbnail/image
        thumbnailUrl = generationData.assets?.image ||
                            generationData.assets?.thumbnail ||
                            generationData.thumbnail_url || 
                            generationData.thumbnail?.url ||
                            generationData.thumbnail ||
                            generationData.preview_url ||
                            generationData.preview?.url ||
                            generationData.asset?.thumbnail_url ||
                            generationData.asset?.thumbnail ||
                            generationData.assets?.[0]?.thumbnail ||
                            generationData.result?.thumbnail_url ||
                            generationData.result?.thumbnail ||
                            generationData.generation?.thumbnail_url ||
                            generationData.generation?.thumbnail ||
                            generationData.generation?.preview_url ||
                            generationData.generation?.asset?.thumbnail_url ||
                            generationData.generation?.assets?.image ||
                            generationData.generation?.assets?.thumbnail;
        
        if (videoUrl) {
          aiVideo.video.fileUrl = videoUrl;
          console.log("✅ Set video URL:", videoUrl);
        } else {
          console.log("❌ No video URL found. Full response structure:", JSON.stringify(generationData, null, 2));
        }
        
        if (thumbnailUrl) {
          aiVideo.video.thumbnailUrl = thumbnailUrl;
          console.log("✅ Set thumbnail URL:", thumbnailUrl);
        } else {
          console.log("⚠️ No thumbnail URL found");
        }
        
        if (generationData.duration) {
          aiVideo.duration = generationData.duration;
        }
      } else if (status === "failed" || status === "error") {
        aiVideo.status = "failed";
        aiVideo.errorMessage = generationData.error || "Video generation failed";
      } else {
        aiVideo.status = "processing";
      }

      await aiVideo.save();

      return res.status(200).json({
        success: true,
        video: aiVideo,
      });
    } catch (lumaError) {
      console.error("Error checking Luma API status:", lumaError.response?.data || lumaError.message);
      // Return current database status even if API check fails
      return res.status(200).json({
        success: true,
        video: aiVideo,
      });
    }
  } catch (error) {
    console.error("Error checking AI video status:", error);
    return res.status(500).json({
      success: false,
      message: "Server error checking AI video status",
    });
  }
});

module.exports = router;

