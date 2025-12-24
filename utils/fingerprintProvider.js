/**
 * Fingerprint Provider Adapter
 * Supports Audible Magic and mock mode for development
 */

const axios = require("axios");

class FingerprintProvider {
  constructor(config) {
    this.provider = config.provider || "audible_magic";
    this.apiKey = config.apiKey || "";
    this.apiUrl = config.apiUrl || "";
    this.mockMode = config.mockMode || false;
  }

  /**
   * Submit audio file for fingerprinting
   * @param {Buffer} audioBuffer - Audio file buffer
   * @param {string} fileName - Original filename
   * @param {Object} metadata - Track metadata
   * @returns {Promise<Object>} Fingerprint result
   */
  async submitFingerprint(audioBuffer, fileName, metadata = {}) {
    if (this.mockMode) {
      return this.mockFingerprint(audioBuffer, fileName, metadata);
    }

    switch (this.provider) {
      case "audible_magic":
        return this.audibleMagicFingerprint(audioBuffer, fileName, metadata);
      default:
        throw new Error(`Unsupported fingerprint provider: ${this.provider}`);
    }
  }

  /**
   * Mock fingerprinting for development
   */
  async mockFingerprint(audioBuffer, fileName, metadata) {
    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Generate mock fingerprint ID
    const crypto = require("crypto");
    const hash = crypto.createHash("sha256");
    hash.update(audioBuffer);
    const fingerprintId = `MOCK-${hash.digest("hex").substring(0, 16).toUpperCase()}`;

    return {
      success: true,
      providerId: fingerprintId,
      status: "completed",
      hasConflict: false,
      conflictTracks: [],
      fingerprintData: {
        algorithm: "mock",
        version: "1.0",
        timestamp: new Date().toISOString(),
      },
      metadata: {
        fileName,
        fileSize: audioBuffer.length,
        ...metadata,
      },
    };
  }

  /**
   * Audible Magic fingerprinting
   */
  async audibleMagicFingerprint(audioBuffer, fileName, metadata) {
    if (!this.apiKey || !this.apiUrl) {
      throw new Error(
        "Audible Magic API key and URL must be configured for production"
      );
    }

    try {
      // Create form data
      const FormData = require("form-data");
      const form = new FormData();
      form.append("file", audioBuffer, {
        filename: fileName,
        contentType: "audio/mpeg",
      });
      form.append("metadata", JSON.stringify(metadata));

      const response = await axios.post(
        `${this.apiUrl}/api/v1/fingerprint`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${this.apiKey}`,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );

      return {
        success: true,
        providerId: response.data.fingerprintId,
        status: response.data.status || "completed",
        hasConflict: response.data.hasConflict || false,
        conflictTracks: response.data.conflictTracks || [],
        fingerprintData: response.data.fingerprintData || {},
        metadata: {
          fileName,
          fileSize: audioBuffer.length,
          ...metadata,
        },
      };
    } catch (error) {
      console.error("Audible Magic fingerprinting error:", error);
      throw new Error(
        `Fingerprinting failed: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Check fingerprint status
   * @param {string} providerId - Provider fingerprint ID
   * @returns {Promise<Object>} Status
   */
  async checkFingerprintStatus(providerId) {
    if (this.mockMode) {
      return {
        status: "completed",
        hasConflict: false,
      };
    }

    if (this.provider === "audible_magic") {
      try {
        const response = await axios.get(
          `${this.apiUrl}/api/v1/fingerprint/${providerId}/status`,
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
            },
          }
        );
        return response.data;
      } catch (error) {
        console.error("Error checking fingerprint status:", error);
        throw error;
      }
    }

    throw new Error(`Unsupported provider: ${this.provider}`);
  }
}

module.exports = FingerprintProvider;
