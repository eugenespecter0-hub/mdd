const mm = require("music-metadata");

/**
 * Extract duration from audio file buffer
 * @param {Buffer} audioBuffer - The audio file buffer
 * @returns {Promise<number>} - Duration in seconds
 */
async function getAudioDuration(audioBuffer) {
  try {
    const metadata = await mm.parseBuffer(audioBuffer);
    return Math.floor(metadata.format.duration || 0);
  } catch (error) {
    console.error("Error extracting audio duration:", error);
    return null;
  }
}

module.exports = {
  getAudioDuration,
};
