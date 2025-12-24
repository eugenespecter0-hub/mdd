/**
 * ISRC Generator
 * Generates ISRC codes according to ISO 3901 standard
 * Format: CC-XXX-YY-NNNNN
 * CC = Country Code (2 chars)
 * XXX = Registrant Code (3 chars)
 * YY = Year (2 chars)
 * NNNNN = Designation Code (5 digits)
 */

const crypto = require("crypto");

/**
 * Generate ISRC code
 * @param {string} prefix - ISRC prefix (e.g., "USRC1")
 * @param {number} year - Year (2 digits, e.g., 24 for 2024)
 * @param {number} sequence - Sequence number (0-99999)
 * @returns {string} ISRC code
 */
function generateISRC(prefix, year, sequence) {
  if (!prefix || prefix.length !== 5) {
    throw new Error("ISRC prefix must be 5 characters (e.g., USRC1)");
  }

  const countryCode = prefix.substring(0, 2).toUpperCase();
  const registrantCode = prefix.substring(2, 5).toUpperCase();
  const yearCode = String(year).slice(-2).padStart(2, "0");
  const designationCode = String(sequence).padStart(5, "0");

  if (designationCode.length > 5) {
    throw new Error("Sequence number cannot exceed 99999");
  }

  return `${countryCode}${registrantCode}${yearCode}${designationCode}`;
}

/**
 * Get next ISRC sequence for a prefix and year
 * @param {Object} ISRCRegistry - Mongoose model
 * @param {string} prefix - ISRC prefix
 * @param {number} year - Year (2 digits)
 * @returns {Promise<number>} Next sequence number
 */
async function getNextISRCSequence(ISRCRegistry, prefix, year) {
  const yearCode = String(year).slice(-2).padStart(2, "0");
  const countryCode = prefix.substring(0, 2).toUpperCase();
  const registrantCode = prefix.substring(2, 5).toUpperCase();

  // Find the highest sequence for this prefix and year
  const existing = await ISRCRegistry.find({
    prefix: prefix,
    year: yearCode,
  })
    .sort({ designationCode: -1 })
    .limit(1);

  if (existing.length === 0) {
    return 1; // Start from 1
  }

  const lastSequence = parseInt(existing[0].designationCode, 10);
  return lastSequence + 1;
}

/**
 * Assign ISRC to a track
 * @param {Object} ISRCRegistry - Mongoose model
 * @param {Object} Track - Mongoose model
 * @param {string} trackId - Track ID
 * @param {string} prefix - ISRC prefix from env
 * @returns {Promise<Object>} ISRC record
 */
async function assignISRC(ISRCRegistry, Track, trackId, prefix) {
  if (!prefix || prefix.length !== 5) {
    throw new Error("ISRC_PREFIX must be 5 characters (e.g., USRC1)");
  }

  const track = await Track.findById(trackId);
  if (!track) {
    throw new Error("Track not found");
  }

  // Check if track already has ISRC
  const existing = await ISRCRegistry.findOne({ track: trackId });
  if (existing) {
    return existing;
  }

  const year = new Date().getFullYear();
  const sequence = await getNextISRCSequence(ISRCRegistry, prefix, year);
  const isrc = generateISRC(prefix, year, sequence);

  const countryCode = prefix.substring(0, 2).toUpperCase();
  const registrantCode = prefix.substring(2, 5).toUpperCase();
  const yearCode = String(year).slice(-2).padStart(2, "0");
  const designationCode = String(sequence).padStart(5, "0");

  const isrcRecord = await ISRCRegistry.create({
    isrc: isrc,
    track: trackId,
    countryCode,
    registrantCode,
    year: yearCode,
    designationCode,
    prefix: prefix,
    status: "assigned",
  });

  // Update track with ISRC
  track.isrc = isrc;
  await track.save();

  return isrcRecord;
}

module.exports = {
  generateISRC,
  getNextISRCSequence,
  assignISRC,
};
