/**
 * Donation Routes
 * Handles artist donations via Stripe
 */

const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const { requireAuth } = require("@clerk/express");

// Models
const Donation = require("../../models/DonationModel");
const User = require("../../models/User");
const AuditLog = require("../../models/AuditLogModel");

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-12-18.acacia",
});

// Platform fee percentage (e.g., 15%)
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || "15");

/**
 * POST /api/donations/create-checkout
 * Create Stripe Checkout session for donation
 */
router.post("/create-checkout", requireAuth(), async (req, res) => {
  try {
    const { recipientId, amount, message } = req.body;

    // Validate inputs
    if (!recipientId) {
      return res.status(400).json({
        success: false,
        message: "Recipient ID is required",
      });
    }

    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        message: "Amount must be at least $1",
      });
    }

    // Find donor (current user)
    const donor = await User.findOne({ clerkId: req.auth.userId });
    if (!donor) {
      return res.status(404).json({
        success: false,
        message: "Donor not found",
      });
    }

    // Find recipient (artist)
    const recipient = await User.findById(recipientId);
    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: "Recipient not found",
      });
    }

    // Check if user is trying to donate to themselves
    if (donor._id.toString() === recipientId) {
      return res.status(400).json({
        success: false,
        message: "You cannot donate to yourself",
      });
    }

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Donation to ${recipient.userName || "Artist"}`,
              description: message
                ? `Donation: ${message}`
                : `Support ${recipient.userName || "this artist"}`,
            },
            unit_amount: Math.round(amount * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/donation/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/donation/failure`,
      metadata: {
        resourceType: "donation",
        donorId: donor._id.toString(),
        recipientId: recipientId,
        amount: amount.toString(),
        message: message || "",
      },
    });

    // Create pending donation record
    const donation = await Donation.create({
      donor: donor._id,
      recipient: recipientId,
      amount: amount,
      currency: "USD",
      stripeSessionId: session.id,
      stripePaymentIntentId: "", // Will be filled by webhook
      status: "pending",
      message: message || "",
    });

    await AuditLog.create({
      user: donor._id,
      action: "donation_initiated",
      resourceType: "donation",
      resourceId: donation._id,
      status: "success",
      metadata: {
        recipientId,
        amount,
      },
    });

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      url: session.url,
      donationId: donation._id,
    });
  } catch (error) {
    console.error("Donation checkout error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error creating donation checkout",
    });
  }
});

/**
 * GET /api/donations/my-donations
 * Get donations made by current user
 */
router.get("/my-donations", requireAuth(), async (req, res) => {
  try {
    const donor = await User.findOne({ clerkId: req.auth.userId });
    if (!donor) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const donations = await Donation.find({ donor: donor._id })
      .populate("recipient", "userName email imageUrl")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      donations,
    });
  } catch (error) {
    console.error("Error fetching donations:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching donations",
    });
  }
});

/**
 * GET /api/donations/received
 * Get donations received by current user (artist)
 */
router.get("/received", requireAuth(), async (req, res) => {
  try {
    const recipient = await User.findOne({ clerkId: req.auth.userId });
    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const donations = await Donation.find({ recipient: recipient._id })
      .populate("donor", "userName email imageUrl")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      donations,
    });
  } catch (error) {
    console.error("Error fetching received donations:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching received donations",
    });
  }
});

module.exports = router;
