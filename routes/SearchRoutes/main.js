/**
 * Search Routes
 * Meilisearch-powered catalog search
 */

const express = require("express");
const router = express.Router();
const MeiliSearch = require("meilisearch").MeiliSearch;

// Meilisearch client
const meilisearchClient = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_MASTER_KEY || "masterKey",
});

/**
 * GET /api/search
 * Search tracks
 */
router.get("/", async (req, res) => {
  try {
    const { q, genre, limit = 20, offset = 0 } = req.query;

    if (!q && !genre) {
      return res.status(400).json({
        success: false,
        message: "Query parameter 'q' or 'genre' is required",
      });
    }

    const index = meilisearchClient.index("tracks");

    let searchResults;
    if (q) {
      searchResults = await index.search(q, {
        limit: parseInt(limit),
        offset: parseInt(offset),
        filter: genre ? `genre = ${genre}` : undefined,
        attributesToRetrieve: [
          "id",
          "title",
          "artist",
          "album",
          "genre",
          "duration",
          "isrc",
          "createdAt",
          "released",
        ],
      });
    } else {
      // Genre-only search
      searchResults = await index.search("", {
        limit: parseInt(limit),
        offset: parseInt(offset),
        filter: `genre = ${genre}`,
        attributesToRetrieve: [
          "id",
          "title",
          "artist",
          "album",
          "genre",
          "duration",
          "isrc",
          "createdAt",
          "released",
        ],
      });
    }

    return res.status(200).json({
      success: true,
      query: q || "",
      genre: genre || null,
      hits: searchResults.hits,
      estimatedTotalHits: searchResults.estimatedTotalHits,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error performing search",
    });
  }
});

/**
 * POST /api/search/index
 * Initialize Meilisearch index (admin only - add auth if needed)
 */
router.post("/index", async (req, res) => {
  try {
    const index = meilisearchClient.index("tracks");

    // Configure index settings
    await index.updateSettings({
      searchableAttributes: ["title", "artist", "album", "genre", "isrc"],
      filterableAttributes: ["genre", "released"],
      sortableAttributes: ["createdAt", "duration"],
      rankingRules: [
        "words",
        "typo",
        "proximity",
        "attribute",
        "sort",
        "exactness",
      ],
    });

    return res.status(200).json({
      success: true,
      message: "Search index configured",
    });
  } catch (error) {
    console.error("Index configuration error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error configuring index",
    });
  }
});

module.exports = router;
