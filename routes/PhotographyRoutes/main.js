/**
 * Photography Routes
 * Handles photo uploads and management
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { requireAuth } = require("@clerk/express");
const Photo = require("../../models/PhotoModel");
const AIGeneratedImage = require("../../models/AIGeneratedImageModel");
const User = require("../../models/User");
const AuditLog = require("../../models/AuditLogModel");
const { uploadToR2 } = require("../../utils/cloudflareR2");
const crypto = require("crypto");
const axios = require("axios");

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "image") {
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/tiff", "image/jpg", "image/gif"];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Invalid image file type. Only JPEG, PNG, WebP, TIFF, and GIF are allowed."), false);
      }
    } else {
      cb(new Error("Unexpected field"), false);
    }
  },
});

// Multer for AI reference image uploads (up to 4)
const aiImageUpload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max per image
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Invalid image type. Only JPEG, PNG, WebP are allowed."), false);
  },
});

/**
 * Generate SHA-256 hash for image
 */
function generateImageHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * POST /api/photography/upload
 * Upload a photo
 */
router.post(
  "/upload",
  requireAuth(),
  upload.single("image"),
  async (req, res) => {
    try {
      const {
        title,
        photographer,
        collection,
        category,
        captureDate,
        location,
        description,
      } = req.body;

      // Validate required fields
      if (!title || !photographer || !category) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields (title, photographer, category)",
        });
      }

      // Validate image file
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image file is required",
        });
      }

      const imageFile = req.file;

      // Generate hash for duplicate detection
      let imageHash;
      try {
        imageHash = generateImageHash(imageFile.buffer);
        console.log("Generated image hash:", imageHash.substring(0, 16) + "...");
      } catch (hashError) {
        console.error("Error generating image hash:", hashError);
        return res.status(500).json({
          success: false,
          message: "Error processing image file",
        });
      }

      // Check for duplicates
      let existingPhoto;
      try {
        existingPhoto = await Photo.findOne({
          "image.imageHash": imageHash,
        });
      } catch (queryError) {
        console.error("Error checking for duplicates:", queryError);
        return res.status(500).json({
          success: false,
          message: "Error checking for duplicate images",
        });
      }

      if (existingPhoto) {
        return res.status(409).json({
          success: false,
          message: "This image already exists in the system. Duplicate uploads are not allowed.",
          existingPhoto: {
            title: existingPhoto.title,
            photographer: existingPhoto.photographer,
            id: existingPhoto._id,
          },
        });
      }

      // Upload image to Cloudflare R2
      console.log("Uploading image to R2...");
      const imageUploadResult = await uploadToR2(
        imageFile.buffer,
        imageFile.originalname,
        imageFile.mimetype,
        "photos"
      );

      // Find user by Clerk ID
      const user = await User.findOne({ clerkId: req.auth.userId });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found. Please complete onboarding first.",
        });
      }

      // Create photo in database
      let photo;
      try {
        photo = await Photo.create({
          user: user._id,
          title,
          photographer,
          photoCollection: collection || "",
          category,
          captureDate: captureDate ? new Date(captureDate) : null,
          location: location || "",
          description: description || "",
          image: {
            fileName: imageFile.originalname,
            fileSize: imageFile.size,
            fileType: imageFile.mimetype,
            fileUrl: imageUploadResult.fileUrl,
            storageKey: imageUploadResult.storageKey,
            imageHash: imageHash,
          },
          uploadStatus: "ready",
          released: false,
        });
      } catch (dbError) {
        if (dbError.code === 11000 || dbError.name === "MongoServerError") {
          console.error("❌ DUPLICATE DETECTED at database level:", dbError);
          return res.status(409).json({
            success: false,
            message: "This image already exists in the system. Duplicate uploads are not allowed.",
          });
        }
        throw dbError;
      }

      await AuditLog.create({
        user: user._id,
        action: "photo_uploaded",
        resourceType: "photo",
        resourceId: photo._id,
        status: "success",
        metadata: {
          fileName: imageFile.originalname,
          fileSize: imageFile.size,
        },
      });

      return res.status(201).json({
        success: true,
        message: "Photo uploaded successfully",
        photo,
      });
    } catch (err) {
      console.error("UPLOAD ERROR:", err);
      return res.status(500).json({
        success: false,
        message: err.message || "Server error while uploading photo",
      });
    }
  }
);

/**
 * GET /api/photography/photographers
 * Get all photographers (public endpoint, no auth required)
 */
router.get("/photographers", async (req, res) => {
  try {
    const { search, specialty } = req.query;

    // Find all users with photographer creator type
    const userQuery = {
      $or: [
        { creatorType: "photographer" },
        { additionalCreatorTypes: "photographer" },
      ],
    };

    const users = await User.find(userQuery)
      .select("userName firstName lastName email imageUrl bio country creatorType additionalCreatorTypes createdAt")
      .sort({ createdAt: -1 });

    // Get photo counts for each photographer
    const photographers = await Promise.all(
      users.map(async (user) => {
        const photoCount = await Photo.countDocuments({ user: user._id, released: true });
        
        // Determine specialty from photos if not set
        let photographerSpecialty = specialty;
        if (!photographerSpecialty) {
          const photos = await Photo.find({ user: user._id, released: true })
            .select("category")
            .limit(10);
          const categories = photos.map(p => p.category).filter(Boolean);
          if (categories.length > 0) {
            // Get most common category
            const categoryCounts = {};
            categories.forEach(cat => {
              categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            });
            const sortedCategories = Object.entries(categoryCounts)
              .sort((a, b) => b[1] - a[1]);
            photographerSpecialty = sortedCategories.length > 0 ? sortedCategories[0][0] : null;
          }
        }

        return {
          _id: user._id,
          userName: user.userName,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          imageUrl: user.imageUrl,
          bio: user.bio,
          country: user.country,
          photoCount,
          specialty: photographerSpecialty,
        };
      })
    );

    // Filter by search query
    let filteredPhotographers = photographers;
    if (search) {
      const query = search.toLowerCase();
      filteredPhotographers = photographers.filter((p) => {
        const name =
          p.userName ||
          `${p.firstName || ""} ${p.lastName || ""}`.trim() ||
          p.email;
        return (
          name.toLowerCase().includes(query) ||
          p.bio?.toLowerCase().includes(query) ||
          p.country?.toLowerCase().includes(query)
        );
      });
    }

    // Filter by specialty
    if (specialty && specialty !== "all") {
      filteredPhotographers = filteredPhotographers.filter(
        (p) => p.specialty?.toLowerCase() === specialty.toLowerCase()
      );
    }

    return res.status(200).json({
      success: true,
      photographers: filteredPhotographers,
      count: filteredPhotographers.length,
    });
  } catch (error) {
    console.error("Error fetching photographers:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching photographers",
    });
  }
});

/**
 * GET /api/photography/my-photos
 * Get user's photos
 */
router.get("/my-photos", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const photos = await Photo.find({ user: user._id })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      photos,
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
 * DELETE /api/photography/photo/:id
 * Delete a photo
 */
router.delete("/photo/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const photo = await Photo.findOne({ _id: req.params.id, user: user._id });
    if (!photo) {
      return res.status(404).json({ success: false, message: "Photo not found" });
    }

    await Photo.deleteOne({ _id: req.params.id });
    
    await AuditLog.create({
      user: user._id,
      action: "photo_deleted",
      resourceType: "photo",
      resourceId: req.params.id,
      status: "success",
    });

    return res.status(200).json({
      success: true,
      message: "Photo deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting photo:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting photo",
    });
  }
});

/**
 * GET /api/photography/collections
 * Get user's collections (unique collection names from photos)
 */
router.get("/collections", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const photos = await Photo.find({ user: user._id, photoCollection: { $ne: "" } });
    const collectionsMap = new Map();
    
    photos.forEach((photo) => {
      if (photo.photoCollection) {
        if (!collectionsMap.has(photo.photoCollection)) {
          collectionsMap.set(photo.photoCollection, []);
        }
        collectionsMap.get(photo.photoCollection).push(photo);
      }
    });

    const collections = Array.from(collectionsMap.entries()).map(([name, photos]) => ({
      name,
      photoCount: photos.length,
      thumbnail: photos[0]?.image?.fileUrl || null,
      createdAt: photos[0]?.createdAt || new Date(),
    }));

    return res.status(200).json({
      success: true,
      collections,
    });
  } catch (error) {
    console.error("Error fetching collections:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching collections",
    });
  }
});

/**
 * GET /api/photography/collection/:name
 * Get photos in a specific collection
 */
router.get("/collection/:name", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const decodedName = decodeURIComponent(req.params.name);
    const photos = await Photo.find({ 
      user: user._id, 
      photoCollection: decodedName 
    }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      photos,
      collectionName: decodedName,
    });
  } catch (error) {
    console.error("Error fetching collection photos:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching collection",
    });
  }
});

/**
 * POST /api/photography/collection/create
 * Create a new collection and add photos to it
 */
router.post("/collection/create", requireAuth(), async (req, res) => {
  try {
    const { collectionName, photoIds } = req.body;

    if (!collectionName || !collectionName.trim()) {
      return res.status(400).json({
        success: false,
        message: "Collection name is required",
      });
    }

    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one photo must be selected",
      });
    }

    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Verify all photos belong to the user
    const photos = await Photo.find({
      _id: { $in: photoIds },
      user: user._id,
    });

    if (photos.length !== photoIds.length) {
      return res.status(403).json({
        success: false,
        message: "Some photos not found or don't belong to you",
      });
    }

    // Update all photos to have this collection name
    await Photo.updateMany(
      { _id: { $in: photoIds }, user: user._id },
      { $set: { photoCollection: collectionName.trim() } }
    );

    await AuditLog.create({
      user: user._id,
      action: "collection_created",
      resourceType: "photo",
      status: "success",
      metadata: {
        collectionName: collectionName.trim(),
        photoCount: photoIds.length,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Collection created successfully",
      collection: {
        name: collectionName.trim(),
        photoCount: photoIds.length,
      },
    });
  } catch (error) {
    console.error("Error creating collection:", error);
    return res.status(500).json({
      success: false,
      message: "Server error creating collection",
    });
  }
});

/**
 * GET /api/photography/ai-images
 * List AI generated images for current user
 */
router.get("/ai-images", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const images = await AIGeneratedImage.find({ user: user._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, images });
  } catch (error) {
    console.error("Error fetching AI images:", error);
    return res.status(500).json({ success: false, message: "Server error fetching AI images" });
  }
});

/**
 * POST /api/photography/ai-images/generate
 * Generate an image using Luma (Photon) with optional reference images
 */
router.post(
  "/ai-images/generate",
  requireAuth(),
  aiImageUpload.array("images", 4),
  async (req, res) => {
    let aiImage;
    try {
      const { prompt, title = "", model = "photon-flash-1", aspect_ratio = "1:1" } = req.body;

      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ success: false, message: "Prompt is required" });
      }

      const user = await User.findOne({ clerkId: req.auth.userId });
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      const LUMA_API_KEY = process.env.LUMA_API_KEY;
      if (!LUMA_API_KEY) {
        return res.status(500).json({ success: false, message: "Luma API key not configured" });
      }

      // Upload reference images (optional)
      const referenceImages = [];
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          try {
            const uploadResult = await uploadToR2(
              file.buffer,
              file.originalname,
              file.mimetype,
              "ai-image-references"
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
          }
        }
      }

      aiImage = await AIGeneratedImage.create({
        user: user._id,
        prompt: prompt.trim(),
        title: typeof title === "string" ? title.trim() : "",
        model: typeof model === "string" ? model.trim() : "photon-flash-1",
        aspectRatio: typeof aspect_ratio === "string" ? aspect_ratio.trim() : "1:1",
        referenceImages,
        status: "pending",
      });

      // Stronger conditioning:
      // - For "use my face" / identity: character_ref (identity0) + prompt instruction
      // - For "use my image as part of the prompt" / composition: image_ref influences output
      // - For single-image edits: modify_image_ref keeps strongest fidelity
      const requestData = {
        model: aiImage.model,
        prompt:
          referenceImages.length > 0
            ? `${aiImage.prompt}\n\nIMPORTANT: Use identity0 from the reference images as the main subject. Keep identity0 consistent (same face/person).`
            : aiImage.prompt,
        aspect_ratio: aiImage.aspectRatio,
      };

      // If user provided reference images, include them as a character reference
      if (referenceImages.length > 0) {
        const refUrls = referenceImages.map((img) => img.fileUrl).slice(0, 4);

        // Identity conditioning
        requestData.character_ref = {
          identity0: {
            images: refUrls,
          },
        };

        // Composition / visual guidance conditioning
        requestData.image_ref = refUrls.map((url) => ({
          url,
          weight: 0.9,
        }));

        // If only one image provided, treat it as an edit of that image for best fidelity
        if (refUrls.length === 1) {
          requestData.modify_image_ref = {
            url: refUrls[0],
            weight: 1.0,
          };
        }
      }

      const lumaResponse = await axios.post(
        "https://api.lumalabs.ai/dream-machine/v1/generations/image",
        requestData,
        {
          headers: {
            Authorization: `Bearer ${LUMA_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );

      aiImage.lumaGenerationId = lumaResponse.data.id || "";
      aiImage.status = "processing";
      await aiImage.save();

      await AuditLog.create({
        user: user._id,
        action: "ai_image_generation_started",
        resourceType: "image",
        resourceId: aiImage._id,
        status: "success",
        metadata: {
          lumaGenerationId: aiImage.lumaGenerationId,
          model: aiImage.model,
          aspect_ratio: aiImage.aspectRatio,
        },
      });

      return res.status(200).json({ success: true, image: aiImage });
    } catch (error) {
      console.error("Error generating AI image:", error.response?.data || error.message);

      if (aiImage && aiImage._id) {
        try {
          aiImage.status = "failed";
          aiImage.errorMessage =
            error.response?.data?.detail ||
            error.response?.data?.message ||
            error.message ||
            "Failed to start image generation";
          await aiImage.save();
        } catch (updateError) {
          console.error("Error updating AI image status:", updateError);
        }
      }

      return res.status(500).json({
        success: false,
        message: error.response?.data?.detail || error.response?.data?.message || "Failed to generate image",
      });
    }
  }
);

/**
 * GET /api/photography/ai-images/:id/status
 * Poll Luma status and update the record with final image URL
 */
router.get("/ai-images/:id/status", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const aiImage = await AIGeneratedImage.findOne({ _id: req.params.id, user: user._id });
    if (!aiImage) return res.status(404).json({ success: false, message: "AI image not found" });

    if (!aiImage.lumaGenerationId) {
      return res.status(200).json({ success: true, image: aiImage });
    }

    const LUMA_API_KEY = process.env.LUMA_API_KEY;
    if (!LUMA_API_KEY) {
      return res.status(500).json({ success: false, message: "Luma API key not configured" });
    }

    try {
      const lumaResponse = await axios.get(
        `https://api.lumalabs.ai/dream-machine/v1/generations/${aiImage.lumaGenerationId}`,
        { headers: { Authorization: `Bearer ${LUMA_API_KEY}` } }
      );

      const generationData = lumaResponse.data;
      const status = generationData.state || generationData.status;

      if (status === "completed" || status === "succeeded" || status === "ready") {
        aiImage.status = "completed";
        const imageUrl =
          generationData.assets?.image ||
          generationData.image_url ||
          generationData.output_image_url ||
          generationData.asset_url;
        if (imageUrl) aiImage.image.fileUrl = imageUrl;
      } else if (status === "failed" || status === "error") {
        aiImage.status = "failed";
        aiImage.errorMessage = generationData.failure_reason || generationData.error || "Image generation failed";
      } else {
        aiImage.status = "processing";
      }

      await aiImage.save();
      return res.status(200).json({ success: true, image: aiImage });
    } catch (lumaError) {
      console.error("Error checking Luma image status:", lumaError.response?.data || lumaError.message);
      return res.status(200).json({ success: true, image: aiImage });
    }
  } catch (error) {
    console.error("Error checking AI image status:", error);
    return res.status(500).json({ success: false, message: "Server error checking AI image status" });
  }
});

/**
 * DELETE /api/photography/ai-images/:id
 * Delete an AI generated image record
 */
router.delete("/ai-images/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const aiImage = await AIGeneratedImage.findOne({ _id: req.params.id, user: user._id });
    if (!aiImage) return res.status(404).json({ success: false, message: "AI image not found" });

    await AIGeneratedImage.findByIdAndDelete(aiImage._id);

    await AuditLog.create({
      user: user._id,
      action: "ai_image_deleted",
      resourceType: "image",
      resourceId: aiImage._id,
      status: "success",
    });

    return res.status(200).json({ success: true, message: "AI image deleted" });
  } catch (error) {
    console.error("Error deleting AI image:", error);
    return res.status(500).json({ success: false, message: "Server error deleting AI image" });
  }
});

module.exports = router;

