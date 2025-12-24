const crypto = require("crypto");

/**
 * Generate SHA-256 hash from audio file buffer
 * This creates a unique fingerprint of the audio content, regardless of filename
 * @param {Buffer} audioBuffer - The audio file buffer
 * @returns {string} - SHA-256 hash in hexadecimal format
 */
function generateAudioHash(audioBuffer) {
  return crypto.createHash("sha256").update(audioBuffer).digest("hex");
}

module.exports = {
  generateAudioHash,
};
