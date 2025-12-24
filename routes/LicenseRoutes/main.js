/**
 * License Routes
 * Handles license purchases, PDF generation, Stripe webhooks
 */

const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const { NFTStorage, File } = require("nft.storage");
const axios = require("axios");
require('dotenv').config()

// Models
const License = require("../../models/LicenseModel");
const LicenseType = require("../../models/LicenseTypeModel");
const Purchase = require("../../models/PurchaseModel");
const Track = require("../../models/TrackModel");
const User = require("../../models/User");
const RoyaltySplit = require("../../models/RoyaltySplitModel");
const { generateAndUploadLicensePDF } = require("../../utils/pdfGenerator");
const AuditLog = require("../../models/AuditLogModel");
const Sound = require("../../models/SoundModel");
const SoundLicense = require("../../models/SoundLicenseModel");
const SoundLicenseTemplate = require("../../models/SoundLicenseTemplateModel");
const { generateAndUploadSoundLicenseCertificates } = require("../../utils/soundLicenseCertificate");
const { mintStoryLicenseToken } = require("../../utils/storyLicenseOnChain");

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-12-18.acacia",
});

// NFT.Storage
const nftStorage = new NFTStorage({
  token: process.env.NFT_STORAGE_API_KEY || "",
});

const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || "15");

function safeFilename(input) {
  const base = String(input || "file")
    .trim()
    .replace(/[^\w\-\.]+/g, "_")
    .slice(0, 120);
  return base || "file";
}

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
 * POST /api/licenses/purchase
 * Create Stripe Checkout session for license purchase
 */
router.post("/purchase", requireAuth(), async (req, res) => {
  try {
    const { trackId, licenseTypeId } = req.body;

    if (!trackId || !licenseTypeId) {
      return res.status(400).json({
        success: false,
        message: "trackId and licenseTypeId are required",
      });
    }

    const buyer = await User.findOne({ clerkId: req.auth.userId });
    if (!buyer) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const track = await Track.findById(trackId).populate("user");
    if (!track) {
      return res.status(404).json({ success: false, message: "Track not found" });
    }

    if (!track.released) {
      return res.status(400).json({
        success: false,
        message: "Track is not released",
      });
    }

    const licenseType = await LicenseType.findById(licenseTypeId);
    if (!licenseType || !licenseType.isActive) {
      return res.status(404).json({
        success: false,
        message: "License type not found or inactive",
      });
    }

    const creator = await User.findById(track.user);
    if (!creator || !creator.stripeConnectAccountId) {
      return res.status(400).json({
        success: false,
        message: "Creator has not completed Stripe Connect onboarding",
      });
    }

    // Calculate amounts
    const amount = licenseType.price;
    const platformFee = (amount * PLATFORM_FEE_PERCENT) / 100;
    const creatorAmount = amount - platformFee;

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: licenseType.currency.toLowerCase(),
            product_data: {
              name: `${track.title} - ${licenseType.displayName} License`,
              description: `License for ${track.title} by ${track.artist}`,
            },
            unit_amount: Math.round(amount * 100), // Convert to cents
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
        trackId: trackId,
        licenseTypeId: licenseTypeId,
        buyerId: buyer._id.toString(),
        creatorId: creator._id.toString(),
      },
    });

    // Create pending purchase
    const purchase = await Purchase.create({
      buyer: buyer._id,
      track: trackId,
      licenseType: licenseTypeId,
      amount,
      currency: licenseType.currency,
      stripeSessionId: session.id,
      stripeConnectAccountId: creator.stripeConnectAccountId,
      status: "pending",
      platformFee,
      creatorAmount,
    });

    await AuditLog.create({
      user: buyer._id,
      action: "license_purchase_initiated",
      resourceType: "purchase",
      resourceId: purchase._id,
      status: "success",
      metadata: {
        trackId,
        licenseTypeId,
        amount,
      },
    });

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      url: session.url,
      purchaseId: purchase._id,
    });
  } catch (error) {
    console.error("License purchase error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error creating license purchase",
    });
  }
});

/**
 * POST /api/stripe/webhook
 * Handle Stripe webhooks (payment success, etc.)
 * Note: This route is mounted separately in app.js with raw body parser
 */
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // --- Sound license purchases (MacAdam sounds) ---
      if (session?.metadata?.resourceType === "sound") {
        const soundLicenseId = session.metadata.soundLicenseId;
        const templateId = session.metadata.templateId;
        const soundId = session.metadata.soundId;
        const buyerId = session.metadata.buyerId;
        const creatorId = session.metadata.creatorId;

        const license = await SoundLicense.findById(soundLicenseId);
        if (!license) {
          console.error(`SoundLicense not found for session ${session.id}`);
          return res.status(200).json({ received: true });
        }

        if (license.status === "active") {
          return res.status(200).json({ received: true });
        }

        // Payment intent
        const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);

        // Load referenced docs
        const sound = await Sound.findById(soundId);
        const template = await SoundLicenseTemplate.findById(templateId);
        const buyer = await User.findById(buyerId);
        const creator = await User.findById(creatorId);

        if (!sound || !template || !buyer || !creator) {
          console.error(`Missing sound/template/buyer/creator for sound session ${session.id}`);
          return res.status(200).json({ received: true });
        }

        // Mark active + attach Stripe ids
        license.status = "active";
        license.stripePaymentIntentId = paymentIntent.id;
        license.stripeSessionId = session.id;

        // Expiration (if time-based)
        if (license.terms?.durationType === "time_based" && license.terms?.durationDays) {
          const expires = new Date();
          expires.setDate(expires.getDate() + Number(license.terms.durationDays));
          license.expiresAt = expires;
        }

        // Certificates (PDF+JSON) + platform signature (HMAC)
        try {
          const cert = await generateAndUploadSoundLicenseCertificates({
            license,
            sound,
            buyer,
            creator,
            template,
          });
          license.licenseJson = cert.licenseJson;
          license.metadata = {
            ...(license.metadata || {}),
            certificateJsonUrl: cert.json.fileUrl,
            certificateJsonStorageKey: cert.json.storageKey,
            platformSignature: cert.signature,
          };
          license.licensePdfUrl = cert.pdf.fileUrl;
          license.licensePdfStorageKey = cert.pdf.storageKey;
        } catch (e) {
          console.error("Sound license certificate error:", e?.message || e);
        }

        // Record license on Story (mint license token) if on-chain is configured AND buyer provided wallet
        try {
          const receiver =
            license.buyerWalletAddress ||
            String(session?.metadata?.buyerWalletAddress || "").trim();
          const ipId = license.storyFoundationId || sound.storyFoundation?.storyFoundationId || "";
          if (receiver && ipId) {
            const minted = await mintStoryLicenseToken({
              ipId,
              template,
              receiver,
              amount: 1,
            });
            license.storyLicenseTxHash = minted.txHash || "";
            license.storyLicenseTokenIds = minted.licenseTokenIds || [];
          } else {
            license.metadata = {
              ...(license.metadata || {}),
              storyLicenseNotMinted: true,
              storyLicenseNotMintedReason: receiver
                ? "missing_ip_id"
                : "missing_buyer_wallet_address",
            };
          }
        } catch (e) {
          console.error("Story license mint error:", e?.message || e);
          license.metadata = {
            ...(license.metadata || {}),
            storyLicenseNotMinted: true,
            storyLicenseNotMintedReason: "mint_error",
          };
        }

        await license.save();

        // Lock exclusivity if applicable
        if (license.terms?.exclusivity || license.licenseType === "exclusive_buyout") {
          sound.availableForLicensing = false;
          sound.exclusiveLicense = {
            isExclusiveSold: true,
            exclusiveLicenseId: license._id,
            exclusiveBuyer: buyer._id,
            lockedAt: new Date(),
          };
          await sound.save();
        }

        await AuditLog.create({
          action: "sound_license_purchased",
          resourceType: "license",
          resourceId: license._id,
          status: "success",
          metadata: {
            soundId: sound._id,
            licenseNumber: license.licenseNumber,
            storyFoundationId: license.storyFoundationId,
          },
        });

        return res.status(200).json({ received: true });
      }

      const purchase = await Purchase.findOne({
        stripeSessionId: session.id,
      })
        .populate("track")
        .populate("buyer")
        .populate("licenseType");

      if (!purchase) {
        console.error(`Purchase not found for session ${session.id}`);
        return res.status(200).json({ received: true });
      }

      if (purchase.status === "completed") {
        console.log(`Purchase ${purchase._id} already completed`);
        return res.status(200).json({ received: true });
      }

      // Get payment intent
      const paymentIntent = await stripe.paymentIntents.retrieve(
        session.payment_intent
      );

      // Update purchase
      purchase.status = "completed";
      purchase.stripePaymentIntentId = paymentIntent.id;
      await purchase.save();

      // Generate license number
      const licenseNumber = `MAC-${Date.now()}-${purchase._id.toString().slice(-6).toUpperCase()}`;

      // Create license
      const license = await License.create({
        buyer: purchase.buyer._id,
        creator: purchase.track.user,
        track: purchase.track._id,
        licenseType: purchase.licenseType._id,
        purchase: purchase._id,
        stripePaymentIntentId: paymentIntent.id,
        stripeSessionId: session.id,
        licenseNumber,
        status: "active",
      });

      // Generate license JSON
      const licenseJson = {
        licenseNumber,
        track: {
          title: purchase.track.title,
          artist: purchase.track.artist,
          isrc: purchase.track.isrc || "",
        },
        buyer: {
          email: purchase.buyer.email,
          name: purchase.buyer.userName || purchase.buyer.email,
        },
        licenseType: purchase.licenseType.name,
        issuedAt: new Date().toISOString(),
        amount: purchase.amount,
        currency: purchase.currency,
      };

      // Upload to NFT.Storage
      let cid = "";
      try {
        const file = new File([JSON.stringify(licenseJson, null, 2)], "license.json", {
          type: "application/json",
        });
        const result = await nftStorage.storeBlob(file);
        cid = result;
        license.licenseJson = licenseJson;
        license.licenseJsonCid = cid;
      } catch (nftError) {
        console.error("NFT.Storage upload error:", nftError);
        // Continue without IPFS
      }

      // Generate and upload PDF
      try {
        const creator = await User.findById(purchase.track.user);
        const pdfResult = await generateAndUploadLicensePDF(
          license,
          purchase.track,
          purchase.buyer,
          creator,
          purchase.licenseType
        );
        license.licensePdfUrl = pdfResult.fileUrl;
        license.licensePdfStorageKey = pdfResult.storageKey;
      } catch (pdfError) {
        console.error("PDF generation error:", pdfError);
        // Continue without PDF
      }

      await license.save();

      // Calculate and create royalty payments
      const splits = await RoyaltySplit.find({
        track: purchase.track._id,
        isActive: true,
      });

      for (const split of splits) {
        const amount = (purchase.creatorAmount * split.percentage) / 100;
        await require("../../models/RoyaltyPaymentModel").create({
          recipient: split.recipient,
          purchase: purchase._id,
          track: purchase.track._id,
          royaltySplit: split._id,
          amount: Math.round(amount * 100) / 100,
          currency: purchase.currency,
          status: "pending",
        });
      }

      await AuditLog.create({
        action: "license_purchased",
        resourceType: "license",
        resourceId: license._id,
        status: "success",
        metadata: {
          purchaseId: purchase._id,
          licenseNumber,
        },
      });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return res.status(500).json({ received: false, error: error.message });
  }
});

/**
 * GET /api/licenses
 * Get user's licenses
 */
router.get("/", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const licenses = await License.find({ buyer: user._id })
      .populate("track")
      .populate("licenseType")
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
 * GET /api/licenses/my-licenses
 * Get user's licenses (specific route before :id)
 */
router.get("/my-licenses", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const licenses = await License.find({ creator: user._id })
      .populate("track")
      .populate("licenseType")
      .populate("buyer")
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
 * GET /api/licenses/sound/:licenseId/certificate/download
 * Download a sound license certificate as an attachment.
 *
 * Query: type=pdf|json (default: json)
 */
router.get("/sound/:licenseId/certificate/download", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const license = await SoundLicense.findById(req.params.licenseId)
      .populate("sound")
      .populate("buyer", "userName email")
      .populate("creator", "userName email");
    if (!license) {
      return res.status(404).json({ success: false, message: "Sound license not found" });
    }

    const isAdmin = user.admin === true || user.role === "admin";
    const isBuyer = license.buyer?._id?.toString() === user._id.toString();
    const isCreator = license.creator?._id?.toString() === user._id.toString();
    if (!isAdmin && !isBuyer && !isCreator) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const type = String(req.query?.type || "json").toLowerCase();

    let url = "";
    let mime = "application/octet-stream";
    let ext = "bin";

    if (type === "pdf") {
      url = license.licensePdfUrl || "";
      mime = "application/pdf";
      ext = "pdf";
    } else {
      url = String(license?.metadata?.certificateJsonUrl || "");
      mime = "application/json";
      ext = "json";
    }

    if (!url) {
      return res.status(404).json({
        success: false,
        message: `Certificate ${type} not available for this license yet`,
      });
    }

    const base =
      license.licenseNumber ||
      (license._id ? String(license._id).slice(-8) : "license");
    const filename = safeFilename(`macadam-sound-license-${base}.${ext}`);

    const upstream = await axios.get(url, { responseType: "stream" });
    res.setHeader("Content-Type", upstream.headers?.["content-type"] || mime);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    upstream.data.pipe(res);
  } catch (error) {
    console.error("Error downloading sound license certificate:", error);
    return res.status(500).json({
      success: false,
      message: "Server error downloading certificate",
    });
  }
});

/**
 * GET /api/licenses/:id
 * Get license details
 */
router.get("/:id", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const license = await License.findById(req.params.id)
      .populate("track")
      .populate("licenseType")
      .populate("buyer")
      .populate("creator");

    if (!license) {
      return res.status(404).json({ success: false, message: "License not found" });
    }

    // Check if user owns this license
    if (license.buyer._id.toString() !== user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to view this license",
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
 * GET /api/licenses/verify/:licenseId
 * Verify a license for legal / takedown / client verification.
 *
 * Returns either a Track license or Sound license record (public-safe fields).
 */
router.get("/verify/:licenseId", async (req, res) => {
  try {
    const licenseId = req.params.licenseId;

    // Track license first
    const trackLicense = await License.findById(licenseId)
      .populate("track")
      .populate("licenseType")
      .populate("buyer")
      .populate("creator");
    if (trackLicense) {
      const expiresAt = trackLicense.expiresAt ? new Date(trackLicense.expiresAt).toISOString() : null;
      const isValid = trackLicense.status === "active" && (!expiresAt || new Date(expiresAt) > new Date());

      return res.status(200).json({
        isValid: Boolean(isValid),
        licenseId: trackLicense._id,
        licenseNumber: trackLicense.licenseNumber,
        type: "track",
        scope: {
          licenseType: trackLicense.licenseType?.name || "",
          expiresAt,
        },
        storyFoundationId: "",
        soundHash: "",
      });
    }

    // Sound license
    const soundLicense = await SoundLicense.findById(licenseId)
      .populate("sound")
      .populate("buyer", "email userName")
      .populate("creator", "email userName");
    if (!soundLicense) {
      return res.status(404).json({ success: false, message: "License not found" });
    }

    const expiresAt = soundLicense.expiresAt ? new Date(soundLicense.expiresAt).toISOString() : null;
    const isValid = soundLicense.status === "active" && (!expiresAt || new Date(expiresAt) > new Date());

    return res.status(200).json({
      isValid: Boolean(isValid),
      licenseId: soundLicense._id,
      licenseNumber: soundLicense.licenseNumber,
      type: "sound",
      storyFoundationId: soundLicense.storyFoundationId || "",
      soundHash: soundLicense.soundHash || "",
      scope: {
        licenseType: soundLicense.licenseType,
        usageRights: soundLicense.terms?.usageRights || {},
        territory: soundLicense.terms?.territory || "worldwide",
        durationType: soundLicense.terms?.durationType || "perpetual",
        durationDays: soundLicense.terms?.durationDays || null,
        exclusivity: Boolean(soundLicense.terms?.exclusivity),
        attributionRequired: Boolean(soundLicense.terms?.attributionRequired),
        resaleAllowed: false,
        expiresAt,
      },
    });
  } catch (error) {
    console.error("License verify error:", error);
    return res.status(500).json({ success: false, message: "Server error verifying license" });
  }
});

module.exports = router;
