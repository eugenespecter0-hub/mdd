/**
 * Donation Routes
 * Handles artist donations via Stripe
 */

const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
require('dotenv').config();

// Models
const Donation = require("../../models/DonationModel");
const User = require("../../models/User");
const AuditLog = require("../../models/AuditLogModel");

// Custom middleware to require auth (returns JSON instead of redirecting)
function requireAuth() {
  return async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.userId) {
        return res.status(401).json({ 
          success: false, 
          message: "Unauthorized. Please log in to continue." 
        });
      }
      next();
    } catch (error) {
      return res.status(401).json({ 
        success: false, 
        message: "Unauthorized. Please log in to continue." 
      });
    }
  };
}

// Stripe Configuration
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || "http://localhost:5173";

if (!STRIPE_SECRET_KEY) {
  console.error("ERROR: STRIPE_SECRET_KEY is not set in environment variables");
  console.error("Donation functionality will not work without a valid Stripe secret key");
}

if (!FRONTEND_URL) {
  console.warn("Warning: FRONTEND_URL is not set in environment variables. Using default localhost URL.");
}

// Initialize Stripe
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-12-18.acacia",
}) : null;

// Platform fee percentage (e.g., 15%)
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || "15");

/**
 * GET /api/donations/config
 * Get Stripe publishable key for client-side use
 */
router.get("/config", (req, res) => {
  return res.status(200).json({
    success: true,
    publishableKey: STRIPE_PUBLISHABLE_KEY || null,
  });
});

/**
 * POST /api/donations/create-checkout
 * Create Stripe Checkout session for donation
 * Anyone can make donations - authentication is optional
 */
router.post("/create-checkout", async (req, res) => {
  try {
    // Validate Stripe is configured
    if (!stripe) {
      return res.status(500).json({
        success: false,
        message: "Stripe is not configured. Please set STRIPE_SECRET_KEY in environment variables.",
      });
    }

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

    // Find recipient (artist)
    const recipient = await User.findById(recipientId);
    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: "Recipient not found",
      });
    }

    // Check if donor is logged in (optional)
    let donor = null;
    let donorId = null;
    if (req.auth && req.auth.userId) {
      donor = await User.findOne({ clerkId: req.auth.userId });
      if (donor) {
        donorId = donor._id.toString();
        // Check if user is trying to donate to themselves
        if (donorId === recipientId) {
          return res.status(400).json({
            success: false,
            message: "You cannot donate to yourself",
          });
        }
      }
    }

    // Validate FRONTEND_URL is set
    const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || "http://localhost:5173";
    
    if (!frontendUrl) {
      return res.status(500).json({
        success: false,
        message: "FRONTEND_URL is not configured. Please set it in environment variables.",
      });
    }

    // Create Stripe Checkout session
    let session;
    try {
      session = await stripe.checkout.sessions.create({
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
        success_url: `${frontendUrl}/donation/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendUrl}/donation/failure`,
        metadata: {
          resourceType: "donation",
          donorId: donorId || "anonymous",
          recipientId: recipientId,
          amount: amount.toString(),
          message: message || "",
        },
      });
    } catch (stripeError) {
      console.error("Stripe session creation failed:", stripeError);
      throw stripeError; // Re-throw to be caught by outer catch block
    }

    // Create pending donation record
    // Note: stripePaymentIntentId will be filled by webhook after payment
    let donation;
    try {
      donation = await Donation.create({
        donor: donor ? donor._id : null,
        recipient: recipientId,
        amount: amount,
        currency: "USD",
        stripeSessionId: session.id,
        status: "pending",
        message: message || "",
      });
    } catch (dbError) {
      console.error("Failed to create donation record:", dbError);
      // If donation record creation fails, we should ideally cancel the Stripe session
      // But for now, just throw the error - the Stripe session will expire on its own
      throw new Error(`Failed to create donation record: ${dbError.message}`);
    }

    // Only create audit log if donor is logged in
    if (donor) {
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
    }

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      url: session.url,
      donationId: donation._id,
    });
  } catch (error) {
    console.error("Donation checkout error:", error);
    console.error("Error details:", {
      type: error.type,
      message: error.message,
      code: error.code,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
    
    // Handle Stripe-specific errors
    if (error.type === 'StripeInvalidRequestError' || error.type === 'StripeAPIError' || error.type === 'StripeConnectionError' || error.type === 'StripeAuthenticationError') {
      return res.status(400).json({
        success: false,
        message: error.message || "Invalid Stripe request",
        errorCode: error.code || error.type,
      });
    }
    
    // Provide more helpful error messages
    let errorMessage = "Server error creating donation checkout";
    if (error.message) {
      if (error.message.includes("No such api_key")) {
        errorMessage = "Invalid Stripe API key. Please check your STRIPE_SECRET_KEY environment variable.";
      } else if (error.message.includes("api_key")) {
        errorMessage = "Stripe API key error. Please verify your STRIPE_SECRET_KEY is correct.";
      } else {
        errorMessage = error.message;
      }
    }
    
    return res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      errorType: error.type,
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

    // Always return 200 with JSON, even if donations array is empty
    return res.status(200).json({
      success: true,
      donations: donations || [],
    });
  } catch (error) {
    console.error("Error fetching donations:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching donations",
      donations: [],
    });
  }
});

/**
 * POST /api/donations/verify-session
 * Manually verify a Stripe session and update donation status
 * This is useful if webhook didn't fire or to fix pending donations
 */
router.post("/verify-session", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session ID is required",
      });
    }

    if (!stripe) {
      return res.status(500).json({
        success: false,
        message: "Stripe is not configured",
      });
    }

    // Retrieve session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Find donation
    const donation = await Donation.findOne({
      stripeSessionId: sessionId,
    });

    if (!donation) {
      return res.status(404).json({
        success: false,
        message: "Donation not found for this session",
      });
    }

    // If already completed, return success
    if (donation.status === "completed") {
      return res.status(200).json({
        success: true,
        message: "Donation already completed",
        donation,
      });
    }

    // Check if payment was successful
    if (session.payment_status === "paid") {
      // Get payment intent if available
      let paymentIntentId = null;
      let chargeId = null;
      
      if (session.payment_intent) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(
            session.payment_intent
          );
          paymentIntentId = paymentIntent.id;
          
          const charges = await stripe.charges.list({
            payment_intent: paymentIntent.id,
            limit: 1,
          });
          if (charges.data && charges.data.length > 0) {
            chargeId = charges.data[0].id;
          }
        } catch (error) {
          console.error("Error retrieving payment intent:", error);
        }
      }

      // Update donation
      donation.status = "completed";
      if (paymentIntentId) {
        donation.stripePaymentIntentId = paymentIntentId;
      }
      if (chargeId) {
        donation.stripeChargeId = chargeId;
      }
      
      if (session.customer_email && !donation.donor) {
        donation.donorEmail = session.customer_email;
      }
      
      await donation.save();

      return res.status(200).json({
        success: true,
        message: "Donation verified and marked as completed",
        donation,
      });
    } else {
      return res.status(200).json({
        success: false,
        message: `Payment status: ${session.payment_status}`,
        paymentStatus: session.payment_status,
        donation,
      });
    }
  } catch (error) {
    console.error("Error verifying session:", error);
    return res.status(500).json({
      success: false,
      message: "Error verifying session",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
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

    // Always return 200 with JSON, even if donations array is empty
    return res.status(200).json({
      success: true,
      donations: donations || [],
    });
  } catch (error) {
    console.error("Error fetching received donations:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching received donations",
      donations: [],
    });
  }
});

/**
 * POST /api/donations/fix-pending
 * Admin endpoint to fix all pending donations by checking Stripe
 * This will verify all pending donations against Stripe and mark them as completed if paid
 */
router.post("/fix-pending", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        success: false,
        message: "Stripe is not configured",
      });
    }

    // Find all pending donations
    const pendingDonations = await Donation.find({
      status: "pending",
    }).limit(100); // Limit to 100 at a time

    const results = {
      checked: 0,
      fixed: 0,
      errors: [],
    };

    for (const donation of pendingDonations) {
      try {
        results.checked++;
        
        // Retrieve session from Stripe
        const session = await stripe.checkout.sessions.retrieve(
          donation.stripeSessionId
        );

        // If payment was successful, update donation
        if (session.payment_status === "paid" && donation.status === "pending") {
          let paymentIntentId = null;
          let chargeId = null;
          
          if (session.payment_intent) {
            try {
              const paymentIntent = await stripe.paymentIntents.retrieve(
                session.payment_intent
              );
              paymentIntentId = paymentIntent.id;
              
              const charges = await stripe.charges.list({
                payment_intent: paymentIntent.id,
                limit: 1,
              });
              if (charges.data && charges.data.length > 0) {
                chargeId = charges.data[0].id;
              }
            } catch (error) {
              console.error(`Error retrieving payment intent for donation ${donation._id}:`, error);
            }
          }

          donation.status = "completed";
          if (paymentIntentId) {
            donation.stripePaymentIntentId = paymentIntentId;
          }
          if (chargeId) {
            donation.stripeChargeId = chargeId;
          }
          
          if (session.customer_email && !donation.donor) {
            donation.donorEmail = session.customer_email;
          }
          
          await donation.save();
          results.fixed++;
          console.log(`Fixed pending donation ${donation._id}`);
        }
      } catch (error) {
        console.error(`Error checking donation ${donation._id}:`, error);
        results.errors.push({
          donationId: donation._id,
          error: error.message,
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Checked ${results.checked} donations, fixed ${results.fixed}`,
      results,
    });
  } catch (error) {
    console.error("Error fixing pending donations:", error);
    return res.status(500).json({
      success: false,
      message: "Error fixing pending donations",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;
