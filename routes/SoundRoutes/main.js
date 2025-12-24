const express = require("express");
const router = express.Router();
const multer = require("multer");
const axios = require("axios");
const Stripe = require("stripe");
const { requireAuth } = require("@clerk/express");
const Sound = require("../../models/SoundModel");
const SoundLicense = require("../../models/SoundLicenseModel");
const SoundLicenseTemplate = require("../../models/SoundLicenseTemplateModel");
const User = require("../../models/User");
const Settings = require("../../models/SettingsModel");
const AuditLog = require("../../models/AuditLogModel");
const { uploadToR2 } = require("../../utils/cloudflareR2");
const { generateAudioHash } = require("../../utils/audioValidation");
const { getAudioDuration } = require("../../utils/audioDuration");
const {
  registerSoundIP,
  listSoundRegistrations,
  fetchSoundProof,
  fetchSoundRegistration,
} = require("../../utils/storyFoundation");
const { createSpgCollection } = require("../../utils/storySpg");
const { getStoryWalletStatus } = require("../../utils/storyWallet");
const { publishTemplateToStory } = require("../../utils/storyLicenseOnChain");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-12-18.acacia",
});
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || "15");

function safeFilename(input) {
  const base = String(input || "proof")
    .trim()
    .replace(/[^\w\-\.]+/g, "_")
    .slice(0, 80);
  return base || "proof";
}

function getDefaultSoundLicenseTemplateSpecs() {
  return [
    {
      licenseType: "personal_noncommercial",
      price: 15,
      currency: "USD",
      usageRights: {
        allowed: ["personal_use", "non_commercial_online"],
        prohibited: ["resale", "redistribution_standalone", "content_id_claims"],
      },
      territory: "worldwide",
      durationType: "perpetual",
      exclusivity: false,
      attributionRequired: true,
      legalText:
        "PERSONAL / NON-COMMERCIAL LICENSE\n\nGrant: Creator grants Buyer a non-exclusive, non-transferable license to synchronize and use this sound in personal projects and non-commercial online content.\n\nRestrictions: Buyer may not resell, sublicense, or redistribute the sound as a standalone file, sample pack, or library asset. No use to claim Content ID ownership over the sound itself.\n\nAttribution: Required where reasonably possible (credit Creator + MacAdam).\n\nTerm/Territory: Perpetual, worldwide.\n\nOwnership: Creator retains all right, title, and interest in the sound and the underlying IP. This license is tied to the Story IP ID + file hash recorded at purchase.\n",
    },
    {
      licenseType: "commercial_online",
      price: 75,
      currency: "USD",
      usageRights: {
        allowed: ["ads_social", "youtube", "online_marketing", "monetized_content"],
        prohibited: ["resale", "redistribution_standalone", "content_id_claims"],
      },
      territory: "worldwide",
      durationType: "perpetual",
      exclusivity: false,
      attributionRequired: false,
      legalText:
        "COMMERCIAL – ONLINE LICENSE\n\nGrant: Creator grants Buyer a non-exclusive, non-transferable license to use this sound in monetized online content (YouTube, social, ads, websites, apps).\n\nRestrictions: No resale, sublicensing, or redistribution as a standalone file/sample pack. No Content ID claims over the sound itself.\n\nTerm/Territory: Perpetual, worldwide.\n\nOwnership: Creator retains ownership. This license is tied to the Story IP ID + file hash recorded at purchase.\n",
    },
    {
      licenseType: "commercial_film_tv",
      price: 250,
      currency: "USD",
      usageRights: {
        allowed: ["film_tv", "streaming", "broadcast", "theatrical", "festival"],
        prohibited: ["resale", "redistribution_standalone", "content_id_claims"],
      },
      territory: "worldwide",
      durationType: "perpetual",
      exclusivity: false,
      attributionRequired: false,
      legalText:
        "COMMERCIAL – FILM/TV/STREAMING LICENSE\n\nGrant: Creator grants Buyer a non-exclusive, non-transferable license to synchronize and use this sound in film, TV, streaming productions, broadcast, trailers, and promotional materials.\n\nRestrictions: No resale, sublicensing, or redistribution as a standalone file. No Content ID claims over the sound itself.\n\nTerm/Territory: Perpetual, worldwide.\n\nOwnership: Creator retains ownership. This license is tied to the Story IP ID + file hash recorded at purchase.\n",
    },
    {
      licenseType: "exclusive_buyout",
      price: 1500,
      currency: "USD",
      usageRights: {
        allowed: ["all_commercial"],
        prohibited: ["redistribution_standalone", "content_id_claims"],
      },
      territory: "worldwide",
      durationType: "perpetual",
      exclusivity: true,
      attributionRequired: false,
      legalText:
        "EXCLUSIVE BUYOUT LICENSE\n\nGrant: Creator grants Buyer an exclusive license to use this sound commercially. After purchase, MacAdam will disable further licensing of this sound.\n\nRestrictions: Buyer may not redistribute the sound as a standalone file/sample pack. No Content ID claims over the sound itself.\n\nTerm/Territory: Perpetual, worldwide.\n\nOwnership: Creator retains ownership unless separately assigned in writing. This exclusive license is tied to the Story IP ID + file hash recorded at purchase.\n",
    },
  ];
}

async function upsertDefaultSoundLicenseTemplates(sound) {
  if (!sound) return [];
  const storyFoundationId = sound.storyFoundation?.storyFoundationId || "";
  if (!storyFoundationId) return [];

  const defaults = getDefaultSoundLicenseTemplateSpecs();
  const created = [];
  for (const d of defaults) {
    const doc = await SoundLicenseTemplate.findOneAndUpdate(
      { sound: sound._id, licenseType: d.licenseType },
      {
        sound: sound._id,
        creator: sound.user,
        storyFoundationId,
        ...d,
        resaleAllowed: false,
        isActive: true,
      },
      { upsert: true, new: true }
    );
    created.push(doc);
  }
  return created;
}

async function ensureSoundLicenseTemplates(sound) {
  if (!sound) return { created: [], updatedStoryLink: false };
  const storyFoundationId = sound.storyFoundation?.storyFoundationId || "";
  if (!storyFoundationId) return { created: [], updatedStoryLink: false };

  const count = await SoundLicenseTemplate.countDocuments({ sound: sound._id });
  if (count === 0) {
    const created = await upsertDefaultSoundLicenseTemplates(sound);
    return { created, updatedStoryLink: false };
  }

  const r = await SoundLicenseTemplate.updateMany(
    {
      sound: sound._id,
      $or: [{ storyFoundationId: "" }, { storyFoundationId: { $exists: false } }],
    },
    { $set: { storyFoundationId } }
  );
  return { created: [], updatedStoryLink: Boolean(r?.modifiedCount) };
}

async function getOrCreateSoundProofFile(sound, storyFoundationId) {
  if (!sound) throw new Error("Sound is required");
  if (!storyFoundationId) throw new Error("storyFoundationId is required");

  // Already generated
  if (sound?.storyFoundation?.proofFileUrl) {
    return {
      url: sound.storyFoundation.proofFileUrl,
      mimeType: sound.storyFoundation.proofMimeType || "application/octet-stream",
      ext: (sound.storyFoundation.proofMimeType || "").includes("pdf") ? "pdf" : "json",
    };
  }

  const storedProof = sound?.storyFoundation?.proof || {};
  const isOnChain = storedProof?.type === "story-onchain";
  if (isOnChain) {
    const proofPayload = {
      type: "story-onchain-proof",
      storyFoundationId: sound.storyFoundation.storyFoundationId,
      timestamp: sound.storyFoundation.timestamp
        ? new Date(sound.storyFoundation.timestamp).toISOString()
        : null,
      soundId: sound._id.toString(),
      creatorUserId: sound.user.toString(),
      fileUrl: sound.audio?.fileUrl || "",
      fileHash: sound.audio?.audioHash || "",
      onChain: storedProof,
    };

    const buf = Buffer.from(JSON.stringify(proofPayload, null, 2), "utf8");
    const key = `ip/${sound.user}/sounds/${sound._id}/story-proof-${storyFoundationId}.json`;
    const uploaded = await uploadToR2(buf, key, "application/json");

    sound.storyFoundation = {
      ...(sound.storyFoundation || {}),
      proofFileUrl: uploaded.fileUrl,
      proofStorageKey: uploaded.storageKey,
      proofMimeType: "application/json",
      proofSavedAt: new Date(),
    };
    await sound.save();

    return { url: uploaded.fileUrl, mimeType: "application/json", ext: "json" };
  }

  // REST mode fallback (if configured)
  const proof = await fetchSoundProof({
    storyFoundationId,
    creatorUserId: String(sound.user),
    platformSoundId: String(sound._id),
    fileHash: sound.audio?.audioHash || "",
  });

  const key = `ip/${sound.user}/sounds/${sound._id}/story-proof-${storyFoundationId}.${proof.ext}`;
  const uploaded = await uploadToR2(proof.buffer, key, proof.mimeType);

  sound.storyFoundation = {
    ...(sound.storyFoundation || {}),
    proofFileUrl: uploaded.fileUrl,
    proofStorageKey: uploaded.storageKey,
    proofMimeType: proof.mimeType,
    proofSavedAt: new Date(),
  };
  await sound.save();

  return { url: uploaded.fileUrl, mimeType: proof.mimeType, ext: proof.ext || "bin" };
}

async function verifySoundOwnerOnStoryFoundation({ sound, expectedCreatorUserId }) {
  const storyFoundationId = sound?.storyFoundation?.storyFoundationId || "";
  const timestamp = sound?.storyFoundation?.timestamp
    ? new Date(sound.storyFoundation.timestamp).toISOString()
    : null;

  if (!storyFoundationId) {
    return { isValidOwner: false, storyFoundationId: "", timestamp };
  }

  // On-chain mode: verify locally using stored proof + hash
  const localProof = sound?.storyFoundation?.proof || {};
  if (localProof?.type === "story-onchain") {
    const proofMeta = localProof?.metadata || {};
    const proofCreatorUserId = proofMeta?.creatorUserId ? String(proofMeta.creatorUserId) : "";
    const proofFileHash = proofMeta?.fileHash || "";

    const hashMatches = !!sound?.audio?.audioHash && proofFileHash === sound.audio.audioHash;
    const creatorMatches =
      !!expectedCreatorUserId && !!proofCreatorUserId && String(proofCreatorUserId) === String(expectedCreatorUserId);

    return {
      isValidOwner: Boolean(hashMatches && creatorMatches),
      storyFoundationId,
      timestamp,
    };
  }

  try {
    const reg = await fetchSoundRegistration({ storyFoundationId });
    const regMeta = reg.metadata || {};
    const regCreatorUserId =
      regMeta.creatorUserId || regMeta.creator_id || regMeta.creatorId || reg.creatorUserId || "";
    const regFileHash = reg.fileHash || "";
    const regTimestamp = reg.timestamp ? new Date(reg.timestamp).toISOString() : timestamp;

    const hashMatches = !!sound?.audio?.audioHash && regFileHash === sound.audio.audioHash;
    const creatorMatches = !!expectedCreatorUserId && String(regCreatorUserId) === String(expectedCreatorUserId);

    return {
      isValidOwner: Boolean(hashMatches && creatorMatches),
      storyFoundationId: reg.storyFoundationId || storyFoundationId,
      timestamp: regTimestamp,
    };
  } catch (e) {
    console.error("Story Foundation verification error:", e?.message || e);
    return { isValidOwner: false, storyFoundationId, timestamp };
  }
}

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "audio") {
      const allowedTypes = ["audio/mpeg", "audio/wav", "audio/flac", "audio/x-wav", "audio/mp3"];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Invalid audio file type. Only MP3, WAV, and FLAC are allowed."), false);
      }
    } else if (file.fieldname === "thumbnail") {
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

// Middleware to require authentication
async function requireAuthMiddleware(req, res, next) {
  try {
    if (!req.auth || !req.auth.userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
}

/**
 * POST /api/sounds/upload
 * Upload a sound file
 */
router.post(
  "/upload",
  requireAuth(),
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const user = await User.findOne({ clerkId: req.auth.userId });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      const { title, description, category, tags } = req.body;

      // Validate required fields
      if (!title || !category) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields (title, category)",
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
      let audioHash;
      try {
        audioHash = generateAudioHash(audioFile.buffer);
      } catch (hashError) {
        console.error("Error generating audio hash:", hashError);
        return res.status(500).json({
          success: false,
          message: "Error processing audio file for duplicate detection",
        });
      }

      // Check if audio with same hash already exists
      const existingSound = await Sound.findOne({ "audio.audioHash": audioHash });
      if (existingSound) {
        return res.status(409).json({
          success: false,
          message: "This audio file already exists in the system. Duplicate uploads are not allowed.",
        });
      }

      // Get audio duration
      let durationSeconds = null;
      try {
        durationSeconds = await getAudioDuration(audioFile.buffer);
      } catch (durationError) {
        console.error("Error getting audio duration:", durationError);
        // Continue without duration
      }

      // Upload audio to Cloudflare R2
      const audioUploadResult = await uploadToR2(
        audioFile.buffer,
        `sounds/${user._id}/${Date.now()}-${audioFile.originalname}`,
        audioFile.mimetype
      );

      // Upload thumbnail to R2 if provided
      let thumbnailUploadResult = null;
      if (thumbnailFile) {
        try {
          thumbnailUploadResult = await uploadToR2(
            thumbnailFile.buffer,
            `sounds/thumbnails/${user._id}/${Date.now()}-${thumbnailFile.originalname}`,
            thumbnailFile.mimetype
          );
        } catch (thumbnailError) {
          console.error("Error uploading thumbnail:", thumbnailError);
          // Continue without thumbnail
        }
      }

      // Parse tags
      const tagsArray = tags ? (Array.isArray(tags) ? tags : tags.split(",").map((t) => t.trim())) : [];

      // Create sound record
      const sound = await Sound.create({
        user: user._id,
        title,
        description: description || "",
        category,
        tags: tagsArray,
        audio: {
          fileName: audioFile.originalname,
          fileSize: audioFile.size,
          fileType: audioFile.mimetype,
          fileUrl: audioUploadResult.fileUrl,
          storageKey: audioUploadResult.storageKey,
          audioHash: audioHash,
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
        durationSeconds: durationSeconds,
      });

      // Register IP on Story Foundation
      const creatorName =
        user.userName ||
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        user.email ||
        "Unknown";
      const metadata = {
        title: sound.title,
        description: sound.description || "",
        creator: creatorName,
        uploadDate: new Date().toISOString(),
        creatorUserId: String(user._id),
        platformSoundId: String(sound._id),
      };

      const registration = await registerSoundIP({
        fileHash: audioHash,
        fileUrl: sound.audio.fileUrl,
        metadata,
      });

      sound.storyFoundation = {
        storyFoundationId: registration.storyFoundationId,
        timestamp: new Date(registration.timestamp),
        proof: registration.proof,
      };
      await sound.save();

      // Seed professional license templates (Story-based)
      try {
        await ensureSoundLicenseTemplates(sound);
      } catch (e) {
        console.error("Error seeding sound license templates:", e?.message || e);
      }

      return res.status(201).json({
        success: true,
        storyFoundationId: registration.storyFoundationId,
        timestamp: registration.timestamp,
        fileUrl: sound.audio.fileUrl,
        metadata: {
          title: metadata.title,
          description: metadata.description,
          creator: metadata.creator,
        },
      });
    } catch (err) {
      console.error("UPLOAD ERROR:", err?.message || err);
      return res.status(500).json({
        success: false,
        message: err.message || "Server error while uploading sound",
      });
    }
  }
);

/**
 * POST /api/sounds/:id/register-story
 * Register an already-uploaded sound on Story Foundation.
 *
 * Output:
 * { success: true, storyFoundationId: string, timestamp: ISO string }
 */
router.post("/:id/register-story", requireAuth(), async (req, res) => {
  try {
    const currentUser = await User.findOne({ clerkId: req.auth.userId });
    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isAdmin = currentUser.admin === true || currentUser.role === "admin";
    const sound = await Sound.findById(req.params.id);
    if (!sound) {
      return res.status(404).json({ success: false, message: "Sound not found" });
    }

    const isOwner = sound.user?.toString() === currentUser._id.toString();
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    if (sound.storyFoundation?.storyFoundationId) {
      return res.status(200).json({
        success: true,
        storyFoundationId: sound.storyFoundation.storyFoundationId,
        timestamp: sound.storyFoundation.timestamp
          ? new Date(sound.storyFoundation.timestamp).toISOString()
          : null,
      });
    }

    if (!sound.audio?.fileUrl) {
      return res.status(400).json({ success: false, message: "Sound file URL missing" });
    }

    // Ensure we have a hash (fallback: fetch file and hash it)
    let audioHash = sound.audio?.audioHash;
    if (!audioHash) {
      const fileResponse = await fetch(sound.audio.fileUrl);
      if (!fileResponse.ok) {
        return res.status(500).json({
          success: false,
          message: `Failed to fetch file for hashing: ${fileResponse.status}`,
        });
      }
      const fileBuffer = await fileResponse.arrayBuffer();
      audioHash = generateAudioHash(Buffer.from(fileBuffer));
      sound.audio.audioHash = audioHash;
    }

    const creator = await User.findById(sound.user);
    const creatorName =
      creator?.userName ||
      [creator?.firstName, creator?.lastName].filter(Boolean).join(" ") ||
      creator?.email ||
      "Unknown";

    const metadata = {
      title: sound.title,
      description: sound.description || "",
      creator: creatorName,
      uploadDate: new Date().toISOString(),
      creatorUserId: String(sound.user),
      platformSoundId: String(sound._id),
    };

    const registration = await registerSoundIP({
      fileHash: audioHash,
      fileUrl: sound.audio.fileUrl,
      metadata,
    });

    sound.storyFoundation = {
      ...(sound.storyFoundation || {}),
      storyFoundationId: registration.storyFoundationId,
      timestamp: new Date(registration.timestamp),
      proof: registration.proof,
    };

    await sound.save();

    // Seed professional license templates (Story-based)
    try {
      await ensureSoundLicenseTemplates(sound);
    } catch (e) {
      console.error("Error seeding sound license templates:", e?.message || e);
    }

    return res.status(200).json({
      success: true,
      storyFoundationId: registration.storyFoundationId,
      timestamp: registration.timestamp,
    });
  } catch (error) {
    console.error("Error registering sound on Story Foundation:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error registering sound on Story Foundation",
    });
  }
});

/**
 * POST /api/sounds/batch-upload
 * Upload multiple sound files and register each on Story Foundation.
 *
 * Expected multipart/form-data:
 * - audio: multiple files (same fieldname "audio")
 * - items: JSON string array with metadata in the SAME ORDER as the audio files
 *   [
 *     { title, description?, category, tags? },
 *     ...
 *   ]
 *
 * Output:
 * { results: [ { title, status, storyFoundationId, timestamp } | { title, status, error } ] }
 */
router.post("/batch-upload", requireAuth(), upload.array("audio", 25), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const audioFiles = Array.isArray(req.files) ? req.files : [];
    if (audioFiles.length === 0) {
      return res.status(400).json({ success: false, message: "At least one audio file is required" });
    }

    // Parse metadata items (optional; falls back to filename)
    let items = [];
    if (req.body?.items) {
      try {
        items = typeof req.body.items === "string" ? JSON.parse(req.body.items) : req.body.items;
        if (!Array.isArray(items)) items = [];
      } catch (e) {
        return res.status(400).json({ success: false, message: "Invalid items JSON" });
      }
    }

    const creatorName =
      user.userName ||
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.email ||
      "Unknown";

    const results = [];
    const seenHashes = new Set();

    for (let i = 0; i < audioFiles.length; i++) {
      const audioFile = audioFiles[i];
      const meta = items[i] || {};

      // Basic metadata
      const titleFromMeta = typeof meta.title === "string" ? meta.title.trim() : "";
      const title = titleFromMeta || audioFile.originalname || `Sound ${i + 1}`;
      const description = typeof meta.description === "string" ? meta.description : "";
      const category = typeof meta.category === "string" ? meta.category : "";
      const tags = meta.tags;

      try {
        if (!category) {
          throw new Error("Missing required field: category");
        }

        // Hash
        const audioHash = generateAudioHash(audioFile.buffer);
        if (seenHashes.has(audioHash)) {
          throw new Error("Duplicate file in this batch (same audio hash)");
        }
        seenHashes.add(audioHash);

        const existingSound = await Sound.findOne({ "audio.audioHash": audioHash });
        if (existingSound) {
          throw new Error("This audio file already exists in the system (duplicate hash)");
        }

        // Duration (best-effort)
        let durationSeconds = null;
        try {
          durationSeconds = await getAudioDuration(audioFile.buffer);
        } catch (durationError) {
          console.error("Error getting audio duration:", durationError);
        }

        // Upload to R2
        const audioUploadResult = await uploadToR2(
          audioFile.buffer,
          `sounds/${user._id}/${Date.now()}-${audioFile.originalname}`,
          audioFile.mimetype
        );

        // Tags
        const tagsArray = tags
          ? Array.isArray(tags)
            ? tags
            : String(tags)
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
          : [];

        // Create sound record (no thumbnail in batch flow)
        const sound = await Sound.create({
          user: user._id,
          title,
          description: description || "",
          category,
          tags: tagsArray,
          audio: {
            fileName: audioFile.originalname,
            fileSize: audioFile.size,
            fileType: audioFile.mimetype,
            fileUrl: audioUploadResult.fileUrl,
            storageKey: audioUploadResult.storageKey,
            audioHash,
          },
          thumbnail: {
            fileName: "",
            fileSize: 0,
            fileType: "",
            fileUrl: "",
            storageKey: "",
          },
          uploadStatus: "ready",
          durationSeconds,
        });

        // Register on Story Foundation
        const registrationMetadata = {
          title: sound.title,
          description: sound.description || "",
          creator: creatorName,
          uploadDate: new Date().toISOString(),
          creatorUserId: String(user._id),
          platformSoundId: String(sound._id),
        };

        const registration = await registerSoundIP({
          fileHash: audioHash,
          fileUrl: sound.audio.fileUrl,
          metadata: registrationMetadata,
        });

        sound.storyFoundation = {
          ...(sound.storyFoundation || {}),
          storyFoundationId: registration.storyFoundationId,
          timestamp: new Date(registration.timestamp),
          proof: registration.proof,
        };
        await sound.save();

        // Seed professional license templates (Story-based)
        try {
          await ensureSoundLicenseTemplates(sound);
        } catch (e) {
          console.error("Error seeding sound license templates:", e?.message || e);
        }

        results.push({
          title: sound.title,
          status: "success",
          storyFoundationId: registration.storyFoundationId,
          timestamp: registration.timestamp,
        });
      } catch (fileErr) {
        results.push({
          title,
          status: "failed",
          error: fileErr?.message || "Unknown error",
        });
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("BATCH UPLOAD ERROR:", err?.message || err);
    return res.status(500).json({
      success: false,
      message: err.message || "Server error while batch uploading sounds",
    });
  }
});

/**
 * GET /api/sounds/story-registrations
 * Fetch Story Foundation registrations for a creator and map to platform sound IDs.
 *
 * Query:
 * - creatorUserId (optional; defaults to current user; admin only if different)
 *
 * Output: JSON array
 * [
 *   { soundId, title, timestamp, storyFoundationId, fileUrl }
 * ]
 */
router.get("/story-registrations", requireAuth(), async (req, res) => {
  try {
    const currentUser = await User.findOne({ clerkId: req.auth.userId });
    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const creatorUserId = (req.query.creatorUserId || currentUser._id).toString();
    const isSelf = creatorUserId === currentUser._id.toString();
    const isAdmin = currentUser.admin === true || currentUser.role === "admin";

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    // Fetch registrations from Story Foundation (preferred)
    let sfRegs = [];
    try {
      sfRegs = await listSoundRegistrations({ creatorUserId });
    } catch (e) {
      console.error("Story Foundation list error (falling back to DB):", e?.message || e);
      sfRegs = [];
    }

    // Fetch all sounds for creator from DB to map hashes/ids
    const sounds = await Sound.find({ user: creatorUserId }).select(
      "_id title audio.fileUrl audio.audioHash storyFoundation.storyFoundationId storyFoundation.timestamp"
    );

    const byId = new Map(sounds.map((s) => [s._id.toString(), s]));
    const byHash = new Map(sounds.map((s) => [s.audio?.audioHash, s]).filter(([h]) => !!h));
    const byStoryId = new Map(
      sounds
        .map((s) => [s.storyFoundation?.storyFoundationId, s])
        .filter(([sid]) => !!sid)
    );

    const out = [];
    const seen = new Set(); // key: storyFoundationId|soundId|hash

    for (const reg of sfRegs) {
      const meta = reg.metadata || {};
      const metaSoundId = meta.platformSoundId ? String(meta.platformSoundId) : "";
      const soundFromMeta = metaSoundId ? byId.get(metaSoundId) : null;
      const soundFromHash = reg.fileHash ? byHash.get(reg.fileHash) : null;
      const soundFromStoryId = reg.storyFoundationId ? byStoryId.get(reg.storyFoundationId) : null;
      const sound = soundFromMeta || soundFromHash || soundFromStoryId || null;

      const soundId = sound?._id?.toString() || metaSoundId || "";
      const storyFoundationId = reg.storyFoundationId || sound?.storyFoundation?.storyFoundationId || "";
      const timestamp =
        (reg.timestamp ? new Date(reg.timestamp).toISOString() : null) ||
        (sound?.storyFoundation?.timestamp ? new Date(sound.storyFoundation.timestamp).toISOString() : null) ||
        null;
      const fileUrl = sound?.audio?.fileUrl || reg.fileUrl || "";
      const title = meta.title || sound?.title || "";

      const key = `${storyFoundationId}|${soundId}|${reg.fileHash || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        soundId,
        title,
        timestamp,
        storyFoundationId,
        fileUrl,
      });
    }

    // Fallback: include DB registrations not returned by Story list
    for (const s of sounds) {
      const storyFoundationId = s.storyFoundation?.storyFoundationId;
      if (!storyFoundationId) continue;

      const soundId = s._id.toString();
      const key = `${storyFoundationId}|${soundId}|${s.audio?.audioHash || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        soundId,
        title: s.title || "",
        timestamp: s.storyFoundation?.timestamp ? new Date(s.storyFoundation.timestamp).toISOString() : null,
        storyFoundationId,
        fileUrl: s.audio?.fileUrl || "",
      });
    }

    // Most recent first
    out.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });

    return res.status(200).json(out);
  } catch (error) {
    console.error("Error fetching story registrations:", error);
    return res.status(500).json({ success: false, message: "Server error fetching story registrations" });
  }
});

/**
 * GET /api/sounds/story-proof
 * Fetch proof from Story Foundation, save to R2, return download URL.
 *
 * Query:
 * - soundId (optional)
 * - storyFoundationId (optional)
 *
 * Output: { url: "https://..." }
 */
router.get("/story-proof", requireAuth(), async (req, res) => {
  try {
    const currentUser = await User.findOne({ clerkId: req.auth.userId });
    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const soundId = req.query.soundId ? String(req.query.soundId) : "";
    const storyFoundationIdParam = req.query.storyFoundationId ? String(req.query.storyFoundationId) : "";

    if (!soundId && !storyFoundationIdParam) {
      return res.status(400).json({
        success: false,
        message: "Provide soundId or storyFoundationId",
      });
    }

    const isAdmin = currentUser.admin === true || currentUser.role === "admin";
    let sound = null;

    if (soundId) {
      sound = await Sound.findById(soundId);
      if (!sound) {
        return res.status(404).json({ success: false, message: "Sound not found" });
      }
      const isOwner = sound.user?.toString() === currentUser._id.toString();
      if (!isOwner && !isAdmin) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
    } else {
      sound = await Sound.findOne({ "storyFoundation.storyFoundationId": storyFoundationIdParam });
      if (!sound) {
        return res.status(404).json({ success: false, message: "Sound not found for that Story Foundation ID" });
      }
      const isOwner = sound.user?.toString() === currentUser._id.toString();
      if (!isOwner && !isAdmin) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
    }

    const storyFoundationId = storyFoundationIdParam || sound?.storyFoundation?.storyFoundationId || "";
    if (!storyFoundationId) {
      return res.status(400).json({
        success: false,
        message: "This sound does not have a Story Foundation registration yet",
      });
    }

    const proofFile = await getOrCreateSoundProofFile(sound, storyFoundationId);
    return res.status(200).json({ url: proofFile.url });
  } catch (error) {
    console.error("Error fetching story proof:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching Story Foundation proof",
    });
  }
});

/**
 * GET /api/sounds/story-proof/download
 * Streams the proof file with Content-Disposition: attachment
 * so browsers download it instead of opening.
 */
router.get("/story-proof/download", requireAuth(), async (req, res) => {
  try {
    const currentUser = await User.findOne({ clerkId: req.auth.userId });
    if (!currentUser) return res.status(404).json({ success: false, message: "User not found" });

    const soundId = req.query.soundId ? String(req.query.soundId) : "";
    const storyFoundationIdParam = req.query.storyFoundationId ? String(req.query.storyFoundationId) : "";
    if (!soundId && !storyFoundationIdParam) {
      return res.status(400).json({ success: false, message: "Provide soundId or storyFoundationId" });
    }

    const isAdmin = currentUser.admin === true || currentUser.role === "admin";
    let sound = null;

    if (soundId) {
      sound = await Sound.findById(soundId);
    } else {
      sound = await Sound.findOne({ "storyFoundation.storyFoundationId": storyFoundationIdParam });
    }

    if (!sound) return res.status(404).json({ success: false, message: "Sound not found" });
    const isOwner = sound.user?.toString() === currentUser._id.toString();
    if (!isOwner && !isAdmin) return res.status(403).json({ success: false, message: "Forbidden" });

    const storyFoundationId = storyFoundationIdParam || sound?.storyFoundation?.storyFoundationId || "";
    if (!storyFoundationId) {
      return res.status(400).json({ success: false, message: "This sound does not have a Story registration yet" });
    }

    const proofFile = await getOrCreateSoundProofFile(sound, storyFoundationId);
    const fileResponse = await fetch(proofFile.url);
    if (!fileResponse.ok) {
      return res.status(502).json({ success: false, message: `Failed to fetch proof file: ${fileResponse.status}` });
    }
    const buf = Buffer.from(await fileResponse.arrayBuffer());

    const titleSafe = safeFilename(sound.title || sound._id.toString());
    const filename = `${titleSafe}-story-proof-${storyFoundationId}.${proofFile.ext || "json"}`;

    res.setHeader("Content-Type", proofFile.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buf.byteLength);
    return res.status(200).send(buf);
  } catch (error) {
    console.error("Error downloading story proof:", error?.message || error);
    return res.status(500).json({ success: false, message: error?.message || "Server error downloading proof" });
  }
});

/**
 * GET/POST /api/sounds/story/setup-ui
 * Admin toggle to show/hide Story Setup UI in creator tools.
 */
router.get("/story/setup-ui", requireAuth(), async (req, res) => {
  try {
    const currentUser = await User.findOne({ clerkId: req.auth.userId });
    if (!currentUser) return res.status(404).json({ success: false, message: "User not found" });
    const isAdmin = currentUser.admin === true || currentUser.role === "admin";
    if (!isAdmin) return res.status(403).json({ success: false, message: "Forbidden" });

    const enabled = await Settings.getSetting("story_setup_ui_enabled", false);
    return res.status(200).json({ enabled: Boolean(enabled) });
  } catch (error) {
    console.error("Error reading setup-ui setting:", error?.message || error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/story/setup-ui", requireAuth(), async (req, res) => {
  try {
    const currentUser = await User.findOne({ clerkId: req.auth.userId });
    if (!currentUser) return res.status(404).json({ success: false, message: "User not found" });
    const isAdmin = currentUser.admin === true || currentUser.role === "admin";
    if (!isAdmin) return res.status(403).json({ success: false, message: "Forbidden" });

    const enabled = Boolean(req.body?.enabled);
    await Settings.setSetting(
      "story_setup_ui_enabled",
      enabled,
      "Show/hide Story Setup UI in creator tools",
      "feature"
    );

    return res.status(200).json({ success: true, enabled });
  } catch (error) {
    console.error("Error saving setup-ui setting:", error?.message || error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * GET /api/sounds/my-sounds
 * Get all sounds uploaded by the current user
 */
router.get("/my-sounds", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const sounds = await Sound.find({ user: user._id }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      sounds,
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
 * POST /api/sounds/:id/set-license
 * Set license information for a sound
 */
router.post("/:id/set-license", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const { licensePrice, licenseType, licenseTerms } = req.body;

    const sound = await Sound.findOne({
      _id: req.params.id,
      user: user._id,
    });

    if (!sound) {
      return res.status(404).json({
        success: false,
        message: "Sound not found or you don't have permission",
      });
    }

    sound.licensePrice = parseFloat(licensePrice) || 0;
    sound.licenseType = licenseType || "sync";
    sound.licenseTerms = licenseTerms || "";
    await sound.save();

    return res.status(200).json({
      success: true,
      message: "License information updated",
      sound,
    });
  } catch (error) {
    console.error("Error setting license:", error);
    return res.status(500).json({
      success: false,
      message: "Server error setting license",
    });
  }
});

/**
 * GET /api/sounds/:id/license-templates
 * List active license templates for a sound (for filmmakers).
 */
router.get("/:id/license-templates", requireAuth(), async (req, res) => {
  try {
    const sound = await Sound.findById(req.params.id);
    if (!sound) {
      return res.status(404).json({ success: false, message: "Sound not found" });
    }

    // Filmmakers should only see active templates.
    // Owners/admin can request all templates with ?all=true (to manage pricing/toggles/legal text).
    const wantsAll = String(req.query?.all || "") === "true";
    let filter = { sound: sound._id, isActive: true };
    if (wantsAll) {
      const user = await User.findOne({ clerkId: req.auth.userId });
      const isOwner = user && sound.user?.toString() === user._id.toString();
      const isAdmin = user && (user.admin === true || user.role === "admin");
      if (isOwner || isAdmin) {
        filter = { sound: sound._id };
      }
    }

    // For filmmakers: only show templates that the creator has explicitly published to Story
    // (so Story tracks the licensing terms on-chain).
    if (!wantsAll) {
      filter = { ...filter, storyLicenseAttached: true };
    }

    const templates = await SoundLicenseTemplate.find(filter).sort({ price: 1 });

    return res.status(200).json({ success: true, templates });
  } catch (error) {
    console.error("Error fetching sound license templates:", error?.message || error);
    return res.status(500).json({ success: false, message: "Server error fetching license templates" });
  }
});

/**
 * POST /api/sounds/:id/license-templates/seed
 * Create default templates for a sound (creator/admin).
 */
router.post("/:id/license-templates/seed", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const sound = await Sound.findById(req.params.id);
    if (!sound) return res.status(404).json({ success: false, message: "Sound not found" });

    const isOwner = sound.user?.toString() === user._id.toString();
    const isAdmin = user.admin === true || user.role === "admin";
    if (!isOwner && !isAdmin) return res.status(403).json({ success: false, message: "Forbidden" });

    const storyFoundationId = sound.storyFoundation?.storyFoundationId || "";
    if (!storyFoundationId) {
      return res.status(400).json({
        success: false,
        message: "Sound must be registered on Story before seeding templates",
      });
    }

    const templates = await upsertDefaultSoundLicenseTemplates(sound);
    return res.status(200).json({ success: true, templates });
  } catch (error) {
    console.error("Error seeding sound license templates:", error?.message || error);
    return res.status(500).json({ success: false, message: "Server error seeding license templates" });
  }
});

/**
 * POST /api/sounds/:id/license-templates/publish
 * Publish (attach) license templates to Story so Story tracks which terms are available for the IP.
 *
 * Body: { templateId?: string } (if omitted, publishes all ACTIVE templates)
 */
router.post("/:id/license-templates/publish", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const sound = await Sound.findById(req.params.id);
    if (!sound) return res.status(404).json({ success: false, message: "Sound not found" });

    const isOwner = sound.user?.toString() === user._id.toString();
    const isAdmin = user.admin === true || user.role === "admin";
    if (!isOwner && !isAdmin) return res.status(403).json({ success: false, message: "Forbidden" });

    const ipId = sound.storyFoundation?.storyFoundationId || "";
    if (!ipId) {
      return res.status(400).json({ success: false, message: "Register this sound on Story first" });
    }

    const templateId = req.body?.templateId ? String(req.body.templateId) : "";
    const filter = templateId
      ? { _id: templateId, sound: sound._id }
      : { sound: sound._id, isActive: true, storyLicenseAttached: { $ne: true } };

    const templates = await SoundLicenseTemplate.find(filter);
    if (!templates.length) {
      return res.status(404).json({ success: false, message: "No templates found" });
    }

    const results = [];
    for (const t of templates) {
      try {
        if (t.storyLicenseAttached === true) {
          results.push({
            templateId: t._id,
            licenseType: t.licenseType,
            storyLicenseTermsId: t.storyLicenseTermsId,
            storyLicenseAttached: true,
            storyAttachTxHash: t.storyAttachTxHash,
            storyTermsUri: t.storyTermsUri,
            status: "skipped",
            message: "Already published to Story",
          });
          continue;
        }
        const r = await publishTemplateToStory({ ipId, template: t });
        results.push({
          templateId: t._id,
          licenseType: t.licenseType,
          storyLicenseTermsId: t.storyLicenseTermsId,
          storyLicenseAttached: t.storyLicenseAttached,
          storyAttachTxHash: t.storyAttachTxHash,
          storyTermsUri: t.storyTermsUri,
          result: r,
          status: "success",
        });
      } catch (e) {
        results.push({
          templateId: t._id,
          licenseType: t.licenseType,
          status: "failed",
          error: e?.message || "Failed to publish",
        });
      }
    }

    return res.status(200).json({ success: true, results });
  } catch (error) {
    console.error("Error publishing license templates to Story:", error?.message || error);
    return res.status(500).json({ success: false, message: "Server error publishing templates" });
  }
});

/**
 * PUT /api/sounds/license-templates/:templateId
 * Update a license template (creator/admin).
 */
router.put("/license-templates/:templateId", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const template = await SoundLicenseTemplate.findById(req.params.templateId);
    if (!template) return res.status(404).json({ success: false, message: "Template not found" });

    const isOwner = template.creator?.toString() === user._id.toString();
    const isAdmin = user.admin === true || user.role === "admin";
    if (!isOwner && !isAdmin) return res.status(403).json({ success: false, message: "Forbidden" });

    const updates = {};
    const allowed = [
      "usageRights",
      "territory",
      "territoryNotes",
      "durationType",
      "durationDays",
      "exclusivity",
      "attributionRequired",
      "price",
      "currency",
      "legalText",
      "isActive",
    ];
    for (const k of allowed) {
      if (req.body?.[k] !== undefined) updates[k] = req.body[k];
    }

    const updated = await SoundLicenseTemplate.findByIdAndUpdate(template._id, updates, { new: true });
    return res.status(200).json({ success: true, template: updated });
  } catch (error) {
    console.error("Error updating sound license template:", error?.message || error);
    return res.status(500).json({ success: false, message: "Server error updating license template" });
  }
});

/**
 * POST /api/sounds/:id/purchase-license
 * Create Stripe Checkout session for a sound license purchase (filmmaker).
 *
 * Body: { templateId }
 * Output: { success, sessionId, url, pendingLicenseId }
 */
router.post("/:id/purchase-license", requireAuth(), async (req, res) => {
  try {
    const buyer = await User.findOne({ clerkId: req.auth.userId });
    if (!buyer) return res.status(404).json({ success: false, message: "User not found" });

    const { templateId } = req.body || {};
    if (!templateId) {
      return res.status(400).json({ success: false, message: "templateId is required" });
    }

    const sound = await Sound.findById(req.params.id).populate("user");
    if (!sound) return res.status(404).json({ success: false, message: "Sound not found" });

    if (!sound.approved || !sound.availableForLicensing) {
      return res.status(400).json({ success: false, message: "Sound is not available for licensing" });
    }

    if (sound.exclusiveLicense?.isExclusiveSold) {
      return res.status(400).json({ success: false, message: "Exclusive license already sold" });
    }

    const template = await SoundLicenseTemplate.findById(templateId);
    if (!template || !template.isActive) {
      return res.status(404).json({ success: false, message: "License template not found or inactive" });
    }

    if (template.sound.toString() !== sound._id.toString()) {
      return res.status(400).json({ success: false, message: "Template does not belong to this sound" });
    }

    // Must be Story-registered before purchase
    const creator = await User.findById(sound.user);
    if (!creator) return res.status(404).json({ success: false, message: "Creator not found" });

    const verification = await verifySoundOwnerOnStoryFoundation({
      sound,
      expectedCreatorUserId: creator._id.toString(),
    });
    if (!verification.isValidOwner) {
      return res.status(400).json({ success: false, message: "Sound is not verified on Story for this creator" });
    }

    if (!creator.stripeConnectAccountId) {
      return res.status(400).json({ success: false, message: "Creator has not completed Stripe Connect onboarding" });
    }

    const amount = Number(template.price || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "Template does not have a valid price" });
    }

    const platformFee = (amount * PLATFORM_FEE_PERCENT) / 100;
    const creatorAmount = amount - platformFee;

    // Create pending license record
    const licenseNumber = `SND-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const pendingLicense = await SoundLicense.create({
      buyer: buyer._id,
      creator: creator._id,
      sound: sound._id,
      template: template._id,
      licenseType: template.licenseType,
      storyFoundationId: sound.storyFoundation?.storyFoundationId || verification.storyFoundationId || "",
      soundHash: sound.audio?.audioHash || "",
      licenseNumber,
      price: amount,
      currency: template.currency || "USD",
      status: "pending",
      terms: {
        usageRights: template.usageRights || {},
        territory: template.territory || "worldwide",
        territoryNotes: template.territoryNotes || "",
        durationType: template.durationType || "perpetual",
        durationDays: template.durationDays || null,
        exclusivity: Boolean(template.exclusivity),
        attributionRequired: Boolean(template.attributionRequired),
        resaleAllowed: false,
        legalText: template.legalText || "",
      },
      metadata: {
        platformFee,
        creatorAmount,
      },
    });

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: (template.currency || "USD").toLowerCase(),
            product_data: {
              name: `${sound.title} - ${template.licenseType} License`,
              description: `License for ${sound.title} by ${creator.userName || creator.email}`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/license/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/license/cancel`,
      payment_intent_data: {
        application_fee_amount: Math.round(platformFee * 100),
        transfer_data: {
          destination: creator.stripeConnectAccountId,
        },
      },
      metadata: {
        resourceType: "sound",
        soundId: sound._id.toString(),
        templateId: template._id.toString(),
        buyerId: buyer._id.toString(),
        creatorId: creator._id.toString(),
        soundLicenseId: pendingLicense._id.toString(),
      },
    });

    pendingLicense.stripeSessionId = session.id;
    await pendingLicense.save();

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      url: session.url,
      pendingLicenseId: pendingLicense._id,
    });
  } catch (error) {
    console.error("Sound license purchase error:", error?.message || error);
    return res.status(500).json({ success: false, message: error?.message || "Server error creating purchase" });
  }
});

/**
 * GET /api/sounds/approved
 * Get all approved sounds available for licensing (for filmmakers)
 */
router.get("/approved", requireAuth(), async (req, res) => {
  try {
    const { category, search, page = 1, limit = 20, storyOnly } = req.query;

    const query = {
      approved: true,
      availableForLicensing: true,
    };

    // Only show sounds that the musician has actually published to Story licensing.
    // This means:
    // - sound has a Story IP ID
    // - and at least 1 attached license template exists
    const requireStoryOnly = String(storyOnly || "") === "true";
    let storySoundIds = null;
    if (requireStoryOnly) {
      query["storyFoundation.storyFoundationId"] = { $ne: "" };
      storySoundIds = await SoundLicenseTemplate.distinct("sound", {
        isActive: true,
        storyLicenseAttached: true,
      });
      query._id = { $in: storySoundIds };
    }

    if (category) {
      query.category = category;
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { tags: { $in: [new RegExp(search, "i")] } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const sounds = await Sound.find(query)
      .populate("user", "userName email")
      .sort({ createdAt: -1 })
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
    console.error("Error fetching approved sounds:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching approved sounds",
    });
  }
});

/**
 * DELETE /api/sounds/:id
 * Delete a sound
 */
router.delete("/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const sound = await Sound.findOne({
      _id: req.params.id,
      user: user._id,
    });

    if (!sound) {
      return res.status(404).json({
        success: false,
        message: "Sound not found or you don't have permission to delete it",
      });
    }

    // Delete sound from database
    await Sound.findByIdAndDelete(req.params.id);

    // TODO: Optionally delete files from R2 storage
    // You can add R2 deletion logic here if needed

    return res.status(200).json({
      success: true,
      message: "Sound deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting sound:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting sound",
    });
  }
});

/**
 * POST /api/sounds/:id/license
 * License a sound (for filmmakers) - requires agreement
 */
router.post("/:id/license", requireAuth(), async (req, res) => {
  try {
    const buyer = await User.findOne({ clerkId: req.auth.userId });
    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const { agreed } = req.body;
    if (!agreed) {
      return res.status(400).json({
        success: false,
        message: "You must agree to the license terms",
      });
    }

    const sound = await Sound.findById(req.params.id).populate("user");
    if (!sound) {
      return res.status(404).json({
        success: false,
        message: "Sound not found",
      });
    }

    if (!sound.approved || !sound.availableForLicensing) {
      return res.status(400).json({
        success: false,
        message: "Sound is not available for licensing",
      });
    }

    if (!sound.licensePrice || sound.licensePrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "Sound does not have a valid license price",
      });
    }

    const creator = await User.findById(sound.user);
    if (!creator) {
      return res.status(404).json({
        success: false,
        message: "Creator not found",
      });
    }

    // Verify Story Foundation ownership before licensing
    const verification = await verifySoundOwnerOnStoryFoundation({
      sound,
      expectedCreatorUserId: creator._id.toString(),
    });
    if (!verification.isValidOwner) {
      return res.status(400).json({
        success: false,
        message: "Sound is not verified on Story Foundation for this creator",
      });
    }

    // Generate license number
    const licenseNumber = `SL-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Create license record with active status
    const license = await SoundLicense.create({
      buyer: buyer._id,
      creator: creator._id,
      sound: sound._id,
      licenseType: sound.licenseType,
      licenseNumber,
      price: sound.licensePrice,
      status: "active",
      metadata: {
        agreedAt: new Date(),
        licenseTerms: sound.licenseTerms,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Sound licensed successfully",
      license,
    });
  } catch (error) {
    console.error("Error licensing sound:", error);
    return res.status(500).json({
      success: false,
      message: "Server error licensing sound",
    });
  }
});

/**
 * POST /api/sounds/verify-owner
 * Verify a sound is registered on Story Foundation and owned by the platform user.
 *
 * Input: { soundId, userId }
 * Output: { isValidOwner: boolean, storyFoundationId: string, timestamp: ISO|string|null }
 */
router.post("/verify-owner", requireAuth(), async (req, res) => {
  try {
    const { soundId, userId } = req.body || {};
    if (!soundId || !userId) {
      return res.status(400).json({
        success: false,
        message: "soundId and userId are required",
      });
    }

    const sound = await Sound.findById(soundId);
    if (!sound) {
      return res.status(404).json({ success: false, message: "Sound not found" });
    }

    const result = await verifySoundOwnerOnStoryFoundation({
      sound,
      expectedCreatorUserId: String(userId),
    });

    return res.status(200).json({
      isValidOwner: result.isValidOwner,
      storyFoundationId: result.storyFoundationId || "",
      timestamp: result.timestamp,
    });
  } catch (error) {
    console.error("Error verifying sound owner:", error);
    return res.status(500).json({
      success: false,
      message: "Server error verifying sound owner",
    });
  }
});

/**
 * POST /api/sounds/story/create-spg
 * Create (or return existing) SPG NFT Collection contract for MacAdam on Story.
 * Admin only.
 *
 * Body (optional): { name, symbol }
 *
 * Output: { spgNftContract, txHash, chainId, rpcUrl, contractURI, env }
 */
router.post("/story/create-spg", requireAuth(), async (req, res) => {
  try {
    const currentUser = await User.findOne({ clerkId: req.auth.userId });
    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const isAdmin = currentUser.admin === true || currentUser.role === "admin";
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    // If already saved, return it (no new tx)
    const existing = await Settings.getSetting("story_spg_nft_contract", "");
    const chainId = Number(process.env.STORY_ONCHAIN_CHAIN_ID || 1315);
    const rpcUrl = process.env.STORY_ONCHAIN_RPC_URL || "https://aeneid.storyrpc.io";
    if (existing) {
      return res.status(200).json({
        spgNftContract: existing,
        txHash: "",
        chainId,
        rpcUrl,
        contractURI: await Settings.getSetting("story_spg_contract_uri", ""),
        env: {
          STORY_ONCHAIN_CHAIN_ID: String(chainId),
          STORY_ONCHAIN_RPC_URL: rpcUrl,
          STORY_SPG_NFT_CONTRACT: existing,
        },
      });
    }

    const name = req.body?.name || "MacAdam SPG";
    const symbol = req.body?.symbol || "MACSPG";

    const created = await createSpgCollection({ name, symbol });
    if (!created.spgNftContract) {
      return res.status(500).json({ success: false, message: "Failed to create SPG collection" });
    }

    await Settings.setSetting(
      "story_spg_nft_contract",
      created.spgNftContract,
      "SPG NFT collection contract used for MacAdam Story registrations",
      "feature"
    );
    await Settings.setSetting(
      "story_spg_contract_uri",
      created.contractURI,
      "Contract URI for MacAdam SPG collection",
      "feature"
    );

    return res.status(201).json({
      spgNftContract: created.spgNftContract,
      txHash: created.txHash,
      chainId: created.chainId,
      rpcUrl: created.rpcUrl,
      contractURI: created.contractURI,
      env: {
        STORY_ONCHAIN_CHAIN_ID: String(created.chainId),
        STORY_ONCHAIN_RPC_URL: created.rpcUrl,
        STORY_SPG_NFT_CONTRACT: created.spgNftContract,
      },
    });
  } catch (error) {
    console.error("Error creating SPG collection:", error?.message || error);
    return res.status(500).json({ success: false, message: error?.message || "Server error creating SPG collection" });
  }
});

/**
 * GET /api/sounds/story/wallet-status
 * Admin-only helper to show the platform Story wallet address + balance.
 */
router.get("/story/wallet-status", requireAuth(), async (req, res) => {
  try {
    const currentUser = await User.findOne({ clerkId: req.auth.userId });
    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const isAdmin = currentUser.admin === true || currentUser.role === "admin";
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const status = await getStoryWalletStatus();
    return res.status(200).json({
      ...status,
      faucets: [
        "https://faucet.story.foundation",
        "https://faucet.quicknode.com/story/aeneid",
      ],
      network: {
        name: "Story Aeneid Testnet",
        chainId: 1315,
        rpcUrl: "https://aeneid.storyrpc.io",
        currencySymbol: "IP",
        explorer: "https://aeneid.storyscan.io",
      },
    });
  } catch (error) {
    console.error("Error getting Story wallet status:", error?.message || error);
    return res.status(500).json({ success: false, message: error?.message || "Server error" });
  }
});

/**
 * GET /api/sounds/my-licenses
 * Get all sounds licensed by the current filmmaker
 */
router.get("/my-licenses", requireAuth(), async (req, res) => {
  try {
    const buyer = await User.findOne({ clerkId: req.auth.userId });
    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const licenses = await SoundLicense.find({ buyer: buyer._id, status: "active" })
      .populate("sound")
      .populate("creator", "userName email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      licenses,
    });
  } catch (error) {
    console.error("Error fetching licensed sounds:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching licensed sounds",
    });
  }
});

/**
 * GET /api/sounds/:id/licenses
 * Get all licenses for a specific sound (for the current user)
 */
router.get("/:id/licenses", requireAuth(), async (req, res) => {
  try {
    const buyer = await User.findOne({ clerkId: req.auth.userId });
    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const licenses = await SoundLicense.find({
      sound: req.params.id,
      buyer: buyer._id,
      status: "active",
    })
      .populate("sound")
      .populate("creator", "userName email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      licenses,
    });
  } catch (error) {
    console.error("Error fetching sound licenses:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching sound licenses",
    });
  }
});

/**
 * GET /api/sounds/licensing-activity
 * Get licensing activity for sounds created by the current artist
 */
router.get("/licensing-activity", requireAuth(), async (req, res) => {
  try {
    const creator = await User.findOne({ clerkId: req.auth.userId });
    if (!creator) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const licenses = await SoundLicense.find({ creator: creator._id, status: "active" })
      .populate("sound")
      .populate("buyer", "userName email")
      .populate("template")
      .sort({ createdAt: -1 });

    // Only show activity for Story-based licensing templates that have been published to Story.
    const filtered = (licenses || []).filter((l) => {
      const ipId = l.storyFoundationId || l.sound?.storyFoundation?.storyFoundationId || "";
      const isPublished = Boolean(l.template?.storyLicenseAttached);
      return Boolean(ipId) && isPublished;
    });

    return res.status(200).json({
      success: true,
      licenses: filtered,
    });
  } catch (error) {
    console.error("Error fetching licensing activity:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching licensing activity",
    });
  }
});

/**
 * GET /api/sounds/license-usage
 * Show creators where/when their sounds were downloaded under license.
 */
router.get("/license-usage", requireAuth(), async (req, res) => {
  try {
    const creator = await User.findOne({ clerkId: req.auth.userId });
    if (!creator) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const logs = await AuditLog.find({
      action: "sound_license_download",
      resourceType: "sound",
      "metadata.creatorId": creator._id,
    })
      .sort({ createdAt: -1 })
      .limit(500);

    return res.status(200).json({ success: true, logs });
  } catch (error) {
    console.error("Error fetching license usage logs:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching license usage",
    });
  }
});

/**
 * GET /api/sounds/:id/download
 * Download a licensed sound file (proxy through server to avoid CORS)
 */
router.get("/:id/download", requireAuth(), async (req, res) => {
  try {
    const buyer = await User.findOne({ clerkId: req.auth.userId });
    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const sound = await Sound.findById(req.params.id);
    if (!sound) {
      return res.status(404).json({
        success: false,
        message: "Sound not found",
      });
    }

    // Require a licenseId so we can watermark + audit exactly which license was used
    const licenseId = req.query.licenseId ? String(req.query.licenseId) : "";
    if (!licenseId) {
      return res.status(400).json({
        success: false,
        message: "licenseId is required to download this sound",
      });
    }

    // Check if user has a valid license for this sound
    const license = await SoundLicense.findOne({
      _id: licenseId,
      buyer: buyer._id,
      sound: sound._id,
      status: "active",
    });

    if (!license) {
      return res.status(403).json({
        success: false,
        message: "You do not have a license for this sound",
      });
    }

    // Expiration enforcement
    if (license.expiresAt && new Date(license.expiresAt) <= new Date()) {
      return res.status(403).json({
        success: false,
        message: "This license has expired",
      });
    }

    // Audit: download usage (creator can see where/when the file was retrieved)
    try {
      await AuditLog.create({
        user: buyer._id,
        action: "sound_license_download",
        resourceType: "sound",
        resourceId: sound._id,
        status: "success",
        metadata: {
          licenseId: license._id,
          licenseNumber: license.licenseNumber,
          buyerId: buyer._id,
          creatorId: sound.user,
          soundId: sound._id,
          storyFoundationId:
            license.storyFoundationId ||
            sound.storyFoundation?.storyFoundationId ||
            "",
          soundHash: license.soundHash || sound.audio?.audioHash || "",
        },
        ipAddress: req.ip || "",
        userAgent: req.get("user-agent") || "",
      });
    } catch (e) {
      console.error("AuditLog sound_license_download error:", e?.message || e);
    }

    // Fetch the file from R2 and stream it to the client
    try {
      const fileResponse = await fetch(sound.audio.fileUrl);
      if (!fileResponse.ok) {
        throw new Error(`Failed to fetch file: ${fileResponse.status}`);
      }

      const fileBuffer = await fileResponse.arrayBuffer();
      
      // Watermark metadata (MVP): headers + filename (file bytes unchanged)
      res.setHeader("X-Macadam-License-Id", String(license._id));
      res.setHeader("X-Macadam-Buyer-Id", String(buyer._id));
      res.setHeader("X-Macadam-Sound-Id", String(sound._id));
      res.setHeader("X-Macadam-Story-Ip-Id", String(license.storyFoundationId || sound.storyFoundation?.storyFoundationId || ""));

      const baseName = (sound.audio.fileName || sound.title || "sound").replace(/"/g, "");
      const filename = `${baseName.replace(/\.[^.]+$/, "")}-license-${license.licenseNumber}${baseName.includes(".") ? baseName.slice(baseName.lastIndexOf(".")) : ""}`;
      
      // Set headers for download
      res.setHeader("Content-Type", sound.audio.fileType || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", fileBuffer.byteLength);

      // Send the file
      res.send(Buffer.from(fileBuffer));
    } catch (fetchError) {
      console.error("Error fetching file from R2:", fetchError);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch file from storage",
      });
    }
  } catch (error) {
    console.error("Error downloading sound:", error);
    return res.status(500).json({
      success: false,
      message: "Server error downloading sound",
    });
  }
});

// Free Sounds from Freesound API (CC0 and CC-BY only)
router.get("/free-sounds", requireAuth(), async (req, res) => {
  try {
    const { query = "", page = 1, pageSize = 20 } = req.query;
    const FREESOUND_API_KEY = process.env.FREESOUND_API_KEY;
    const FREESOUND_API_URL = "https://freesound.org/apiv2";

    if (!FREESOUND_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Freesound API key not configured",
      });
    }

    // Search for sounds with CC0 or CC-BY licenses only
    // If query is empty, use "*" to get all sounds
    const searchUrl = `${FREESOUND_API_URL}/search/text/`;
    const searchParams = {
      query: query || "*",
      filter: "license:(\"Attribution\" OR \"Creative Commons 0\")", // CC-BY and CC0
      page: page,
      page_size: pageSize,
      fields: "id,name,description,license,username,previews,duration,filesize,download,tags",
      token: FREESOUND_API_KEY,
    };

    const response = await axios.get(searchUrl, { params: searchParams });

    if (response.data && response.data.results) {
      // Filter to only include CC0 and CC-BY licenses
      const filteredResults = response.data.results.filter((sound) => {
        const license = sound.license || "";
        return (
          license.includes("Creative Commons 0") ||
          license.includes("Attribution") ||
          license === "http://creativecommons.org/licenses/by/3.0/" ||
          license === "http://creativecommons.org/publicdomain/zero/1.0/"
        );
      });

      // Format the results
      const formattedSounds = filteredResults.map((sound) => ({
        id: sound.id,
        title: sound.name,
        description: sound.description || "",
        license: sound.license,
        creator: sound.username,
        duration: sound.duration,
        fileSize: sound.filesize,
        previewUrl: sound.previews?.["preview-hq-mp3"] || sound.previews?.["preview-lq-mp3"] || null,
        downloadUrl: sound.download || null,
        tags: sound.tags || [],
      }));

      return res.json({
        success: true,
        sounds: formattedSounds,
        count: formattedSounds.length,
        totalCount: response.data.count || 0,
        next: response.data.next || null,
        previous: response.data.previous || null,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
      });
    } else {
      return res.json({
        success: true,
        sounds: [],
        count: 0,
      });
    }
  } catch (error) {
    console.error("Error fetching free sounds:", error);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.detail || "Failed to fetch free sounds",
    });
  }
});

// Download free sound (proxy through backend to handle CORS)
router.get("/free-sounds/:id/download", requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    const FREESOUND_API_KEY = process.env.FREESOUND_API_KEY;
    const FREESOUND_API_URL = "https://freesound.org/apiv2";

    if (!FREESOUND_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Freesound API key not configured",
      });
    }

    // Get sound details first to verify license
    const soundUrl = `${FREESOUND_API_URL}/sounds/${id}/`;
    const soundResponse = await axios.get(soundUrl, {
      params: {
        token: FREESOUND_API_KEY,
        fields: "id,name,license,download",
      },
    });

    const sound = soundResponse.data;
    const license = sound.license || "";

    // Verify license is CC0 or CC-BY
    const isAllowed =
      license.includes("Creative Commons 0") ||
      license.includes("Attribution") ||
      license === "http://creativecommons.org/licenses/by/3.0/" ||
      license === "http://creativecommons.org/publicdomain/zero/1.0/";

    if (!isAllowed) {
      return res.status(403).json({
        success: false,
        message: "This sound does not have an allowed license (CC0 or CC-BY only)",
      });
    }

    // Get download URL
    const downloadUrl = `${FREESOUND_API_URL}/sounds/${id}/download/`;
    const downloadResponse = await axios.get(downloadUrl, {
      params: {
        token: FREESOUND_API_KEY,
      },
      responseType: "stream",
    });

    // Set headers
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sound.name || `sound-${id}.mp3`}"`
    );

    // Stream the file
    downloadResponse.data.pipe(res);
  } catch (error) {
    console.error("Error downloading free sound:", error);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.detail || "Failed to download sound",
    });
  }
});

module.exports = router;

