const express = require("express");
const router = express.Router();
const { requireAuth } = require("@clerk/express");
const axios = require("axios");
const Track = require("../../models/TrackModel");
const TrackRegistry = require("../../models/TrackRegistryModel");
const User = require("../../models/User");

/**
 * GET /api/tracking/spotify/:isrc
 * Lookup track on Spotify by ISRC
 */
router.get("/spotify/:isrc", requireAuth(), async (req, res) => {
  try {
    const { isrc } = req.params;
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!isrc) {
      return res.status(400).json({ success: false, message: "ISRC is required" });
    }

    // Spotify API requires OAuth token - using client credentials flow
    // For production, store SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in env
    const spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
    const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!spotifyClientId || !spotifyClientSecret) {
      return res.status(500).json({
        success: false,
        message: "Spotify API credentials not configured",
      });
    }

    // Get access token
    let accessToken;
    try {
      const tokenResponse = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
          grant_type: "client_credentials",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString("base64")}`,
          },
        }
      );
      accessToken = tokenResponse.data.access_token;
    } catch (tokenError) {
      console.error("Error getting Spotify token:", tokenError);
      return res.status(500).json({
        success: false,
        message: "Failed to authenticate with Spotify API",
      });
    }

    // Find track by ISRC first
    const track = await Track.findOne({ isrc: isrc.toUpperCase(), user: user._id });
    if (!track) {
      return res.status(404).json({
        success: false,
        message: "Track not found",
      });
    }

    // If track already has a Spotify ID, use it directly
    if (track.tracking?.spotifyId && track.tracking.spotifyId.trim() !== "") {
      try {
        const trackResponse = await axios.get(`https://api.spotify.com/v1/tracks/${track.tracking.spotifyId}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const spotifyTrack = trackResponse.data;

        // Update DailyTrackingStats
        const DailyTrackingStats = require("../../models/DailyTrackingStatsModel");
        await DailyTrackingStats.findOneAndUpdate(
          { trackId: track._id, date: new Date().toISOString().split("T")[0] },
          {
            trackId: track._id,
            date: new Date().toISOString().split("T")[0],
            spotify: {
              streams: 0,
              popularity: spotifyTrack.popularity || 0,
            },
          },
          { upsert: true, new: true }
        );

        // Update TrackRegistry
        await TrackRegistry.findOneAndUpdate(
          { trackId: track._id },
          {
            trackId: track._id,
            title: track.title,
            artist: track.artist,
            isrc: isrc.toUpperCase(),
            creator: track.user,
            spotify: {
              id: track.tracking.spotifyId,
              name: spotifyTrack.name,
              album: spotifyTrack.album?.name || "",
              popularity: spotifyTrack.popularity || 0,
              externalUrl: spotifyTrack.external_urls?.spotify || "",
              lastUpdated: new Date(),
            },
          },
          { upsert: true, new: true }
        );

        return res.status(200).json({
          success: true,
          spotifyId: track.tracking.spotifyId,
          track: {
            id: track.tracking.spotifyId,
            name: spotifyTrack.name,
            artist: spotifyTrack.artists?.map((a) => a.name).join(", ") || "",
            album: spotifyTrack.album?.name || "",
            popularity: spotifyTrack.popularity || 0,
            externalUrl: spotifyTrack.external_urls?.spotify || "",
            previewUrl: spotifyTrack.preview_url || "",
          },
        });
      } catch (trackError) {
        console.error("Error fetching track by ID:", trackError);
        // Fall through to ISRC search
      }
    }

    // Search for track by ISRC
    try {
      const searchResponse = await axios.get("https://api.spotify.com/v1/search", {
        params: {
          q: `isrc:${isrc}`,
          type: "track",
          limit: 1,
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const tracks = searchResponse.data.tracks?.items || [];
      if (tracks.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Track not found on Spotify by ISRC. If you have a Spotify ID, add it manually using 'Manage IDs'.",
        });
      }

      const spotifyTrack = tracks[0];
      const spotifyId = spotifyTrack.id;

      // Update track tracking field
      track.tracking = track.tracking || {};
      track.tracking.spotifyId = spotifyId;
      track.tracking.isrc = isrc.toUpperCase();
      await track.save();

      // Update DailyTrackingStats
      const DailyTrackingStats = require("../../models/DailyTrackingStatsModel");
      await DailyTrackingStats.findOneAndUpdate(
        { trackId: track._id, date: new Date().toISOString().split("T")[0] },
        {
          trackId: track._id,
          date: new Date().toISOString().split("T")[0],
          spotify: {
            streams: 0,
            popularity: spotifyTrack.popularity || 0,
          },
        },
        { upsert: true, new: true }
      );

      // Update or create TrackRegistry
      await TrackRegistry.findOneAndUpdate(
        { trackId: track._id },
        {
          trackId: track._id,
          title: track.title,
          artist: track.artist,
          isrc: isrc.toUpperCase(),
          creator: track.user,
          spotify: {
            id: spotifyId,
            name: spotifyTrack.name,
            album: spotifyTrack.album?.name || "",
            popularity: spotifyTrack.popularity || 0,
            externalUrl: spotifyTrack.external_urls?.spotify || "",
            lastUpdated: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      return res.status(200).json({
        success: true,
        spotifyId,
        track: {
          id: spotifyId,
          name: spotifyTrack.name,
          artist: spotifyTrack.artists?.map((a) => a.name).join(", ") || "",
          album: spotifyTrack.album?.name || "",
          popularity: spotifyTrack.popularity || 0,
          externalUrl: spotifyTrack.external_urls?.spotify || "",
          previewUrl: spotifyTrack.preview_url || "",
        },
      });
    } catch (searchError) {
      console.error("Error searching Spotify:", searchError);
      return res.status(500).json({
        success: false,
        message: "Error searching Spotify API",
        error: searchError.message,
      });
    }
  } catch (error) {
    console.error("Error in Spotify lookup:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during Spotify lookup",
    });
  }
});

/**
 * GET /api/tracking/apple/:isrc
 * Lookup track on Apple Music by ISRC
 */
router.get("/apple/:isrc", requireAuth(), async (req, res) => {
  try {
    const { isrc } = req.params;
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!isrc) {
      return res.status(400).json({ success: false, message: "ISRC is required" });
    }

    // Apple Music API requires developer token
    const appleDeveloperToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
    if (!appleDeveloperToken) {
      return res.status(500).json({
        success: false,
        message: "Apple Music API credentials not configured",
      });
    }

    try {
      const searchResponse = await axios.get(
        `https://api.music.apple.com/v1/catalog/us/songs`,
        {
          params: {
            "filter[isrc]": isrc,
          },
          headers: {
            Authorization: `Bearer ${appleDeveloperToken}`,
          },
        }
      );

      const songs = searchResponse.data.data || [];
      if (songs.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Track not found on Apple Music",
        });
      }

      const appleSong = songs[0];
      const appleId = appleSong.id;
      const albumId = appleSong.relationships?.albums?.data?.[0]?.id || "";

      // Find track by ISRC
      const track = await Track.findOne({ isrc: isrc.toUpperCase() });
      if (track) {
        // Update track tracking field
        track.tracking = track.tracking || {};
        track.tracking.appleId = appleId;
        track.tracking.isrc = isrc.toUpperCase();
        await track.save();

        // Update or create TrackRegistry
        await TrackRegistry.findOneAndUpdate(
          { trackId: track._id },
          {
            trackId: track._id,
            title: track.title,
            artist: track.artist,
            isrc: isrc.toUpperCase(),
            creator: track.user,
            apple: {
              id: appleId,
              albumId: albumId,
              name: appleSong.attributes?.name || "",
              albumName: appleSong.relationships?.albums?.data?.[0]?.attributes?.name || "",
              externalUrl: appleSong.attributes?.url || "",
              lastUpdated: new Date(),
            },
          },
          { upsert: true, new: true }
        );
      }

      return res.status(200).json({
        success: true,
        appleId,
        albumId,
        track: {
          id: appleId,
          name: appleSong.attributes?.name || "",
          artist: appleSong.attributes?.artistName || "",
          album: appleSong.relationships?.albums?.data?.[0]?.attributes?.name || "",
          externalUrl: appleSong.attributes?.url || "",
        },
      });
    } catch (searchError) {
      console.error("Error searching Apple Music:", searchError);
      if (searchError.response?.status === 404) {
        return res.status(404).json({
          success: false,
          message: "Track not found on Apple Music",
        });
      }
      return res.status(500).json({
        success: false,
        message: "Error searching Apple Music API",
        error: searchError.message,
      });
    }
  } catch (error) {
    console.error("Error in Apple Music lookup:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during Apple Music lookup",
    });
  }
});

/**
 * GET /api/tracking/youtube/:isrc
 * Lookup track on YouTube by ISRC (searches using title + artist)
 */
router.get("/youtube/:isrc", requireAuth(), async (req, res) => {
  try {
    const { isrc } = req.params;
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!isrc) {
      return res.status(400).json({ success: false, message: "ISRC is required" });
    }

    // Find track by ISRC to get title and artist
    const track = await Track.findOne({ isrc: isrc.toUpperCase(), user: user._id });
    if (!track) {
      return res.status(404).json({
        success: false,
        message: "Track not found. Please upload track first.",
      });
    }

    // YouTube Data API requires API key
    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    if (!youtubeApiKey) {
      return res.status(500).json({
        success: false,
        message: "YouTube API key not configured",
      });
    }

    // If track already has a YouTube ID, use it directly
    if (track.tracking?.youtubeId && track.tracking.youtubeId.trim() !== "") {
      try {
        const videoResponse = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
          params: {
            part: "snippet,statistics",
            id: track.tracking.youtubeId,
            key: youtubeApiKey,
          },
        });

        const videos = videoResponse.data.items || [];
        if (videos.length > 0) {
          const video = videos[0];
          
          // Update DailyTrackingStats
          const DailyTrackingStats = require("../../models/DailyTrackingStatsModel");
          await DailyTrackingStats.findOneAndUpdate(
            { trackId: track._id, date: new Date().toISOString().split("T")[0] },
            {
              trackId: track._id,
              date: new Date().toISOString().split("T")[0],
              youtube: {
                views: parseInt(video.statistics?.viewCount || 0),
                likes: parseInt(video.statistics?.likeCount || 0),
                comments: parseInt(video.statistics?.commentCount || 0),
              },
            },
            { upsert: true, new: true }
          );

          // Update TrackRegistry
          await TrackRegistry.findOneAndUpdate(
            { trackId: track._id },
            {
              trackId: track._id,
              title: track.title,
              artist: track.artist,
              isrc: isrc.toUpperCase(),
              creator: track.user,
              youtube: {
                id: track.tracking.youtubeId,
                title: video.snippet.title,
                channelTitle: video.snippet.channelTitle || "",
                publishedAt: video.snippet.publishedAt || "",
                views: parseInt(video.statistics?.viewCount || 0),
                likes: parseInt(video.statistics?.likeCount || 0),
                comments: parseInt(video.statistics?.commentCount || 0),
                lastUpdated: new Date(),
              },
            },
            { upsert: true, new: true }
          );

          return res.status(200).json({
            success: true,
            videoId: track.tracking.youtubeId,
            track: {
              id: track.tracking.youtubeId,
              title: video.snippet.title,
              channelTitle: video.snippet.channelTitle || "",
              description: video.snippet.description || "",
              thumbnail: video.snippet.thumbnails?.high?.url || "",
              externalUrl: `https://www.youtube.com/watch?v=${track.tracking.youtubeId}`,
              views: parseInt(video.statistics?.viewCount || 0),
              likes: parseInt(video.statistics?.likeCount || 0),
              comments: parseInt(video.statistics?.commentCount || 0),
            },
          });
        }
      } catch (videoError) {
        console.error("Error fetching video by ID:", videoError);
        // Fall through to search
      }
    }

    // Search YouTube using title + artist
    const searchQuery = `${track.title} ${track.artist}`;
    try {
      const searchResponse = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          q: searchQuery,
          type: "video",
          maxResults: 1,
          key: youtubeApiKey,
        },
      });

      const videos = searchResponse.data.items || [];
      if (videos.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Track not found on YouTube by search. If you have a YouTube ID, add it manually using 'Manage IDs'.",
        });
      }

      const youtubeVideo = videos[0];
      const youtubeId = youtubeVideo.id.videoId;

      // Get full video details including statistics
      const videoDetailsResponse = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
        params: {
          part: "snippet,statistics",
          id: youtubeId,
          key: youtubeApiKey,
        },
      });

      const videoDetails = videoDetailsResponse.data.items?.[0];

      // Update track tracking field
      track.tracking = track.tracking || {};
      track.tracking.youtubeId = youtubeId;
      track.tracking.isrc = isrc.toUpperCase();
      await track.save();

      // Update DailyTrackingStats
      const DailyTrackingStats = require("../../models/DailyTrackingStatsModel");
      await DailyTrackingStats.findOneAndUpdate(
        { trackId: track._id, date: new Date().toISOString().split("T")[0] },
        {
          trackId: track._id,
          date: new Date().toISOString().split("T")[0],
          youtube: {
            views: videoDetails ? parseInt(videoDetails.statistics?.viewCount || 0) : 0,
            likes: videoDetails ? parseInt(videoDetails.statistics?.likeCount || 0) : 0,
            comments: videoDetails ? parseInt(videoDetails.statistics?.commentCount || 0) : 0,
          },
        },
        { upsert: true, new: true }
      );

      // Update or create TrackRegistry
      await TrackRegistry.findOneAndUpdate(
        { trackId: track._id },
        {
          trackId: track._id,
          title: track.title,
          artist: track.artist,
          isrc: isrc.toUpperCase(),
          creator: track.user,
          youtube: {
            id: youtubeId,
            title: youtubeVideo.snippet?.title || "",
            channelTitle: youtubeVideo.snippet?.channelTitle || "",
            externalUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
            views: videoDetails ? parseInt(videoDetails.statistics?.viewCount || 0) : 0,
            likes: videoDetails ? parseInt(videoDetails.statistics?.likeCount || 0) : 0,
            comments: videoDetails ? parseInt(videoDetails.statistics?.commentCount || 0) : 0,
            lastUpdated: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      return res.status(200).json({
        success: true,
        videoId: youtubeId,
        track: {
          id: youtubeId,
          title: youtubeVideo.snippet?.title || "",
          channelTitle: youtubeVideo.snippet?.channelTitle || "",
          description: youtubeVideo.snippet?.description || "",
          thumbnail: youtubeVideo.snippet?.thumbnails?.high?.url || "",
          externalUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
          views: videoDetails ? parseInt(videoDetails.statistics?.viewCount || 0) : 0,
          likes: videoDetails ? parseInt(videoDetails.statistics?.likeCount || 0) : 0,
          comments: videoDetails ? parseInt(videoDetails.statistics?.commentCount || 0) : 0,
        },
      });
    } catch (searchError) {
      console.error("Error searching YouTube:", searchError);
      return res.status(500).json({
        success: false,
        message: "Error searching YouTube API",
        error: searchError.message,
      });
    }
  } catch (error) {
    console.error("Error in YouTube lookup:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during YouTube lookup",
    });
  }
});

/**
 * GET /api/tracking/all/:isrc
 * Lookup track on all platforms at once
 */
router.get("/all/:isrc", requireAuth(), async (req, res) => {
  try {
    const { isrc } = req.params;
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Find track to get title/artist for YouTube lookup
    const track = await Track.findOne({ isrc: isrc.toUpperCase() });

    const results = {
      spotify: null,
      apple: null,
      youtube: null,
    };

    // Run all lookups in parallel using internal functions
    const { lookupSpotify, lookupApple, lookupYouTube } = require("../../cron/trackAllSongs");

    const [spotifyData, appleData, youtubeData] = await Promise.all([
      lookupSpotify(isrc, track),
      lookupApple(isrc, track),
      lookupYouTube(isrc, track),
    ]);

    results.spotify = spotifyData ? { success: true, data: spotifyData } : { success: false };
    results.apple = appleData ? { success: true, data: appleData } : { success: false };
    results.youtube = youtubeData ? { success: true, data: youtubeData } : { success: false };

    return res.status(200).json({
      success: true,
      results,
    });
  } catch (error) {
    console.error("Error in all platforms lookup:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during platform lookups",
    });
  }
});

/**
 * GET /api/tracking/stats
 * Get overall tracking statistics
 */
router.get("/stats", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Get user's tracks
    const tracks = await Track.find({ user: user._id });
    const totalTracks = tracks.length;

    // Count tracks with ISRC
    const tracksWithISRC = tracks.filter((t) => t.isrc && t.isrc.trim() !== "").length;

    // Count tracks with platform IDs
    const spotifyLinked = tracks.filter(
      (t) => t.tracking?.spotifyId && t.tracking.spotifyId.trim() !== ""
    ).length;
    const appleLinked = tracks.filter(
      (t) => t.tracking?.appleId && t.tracking.appleId.trim() !== ""
    ).length;
    const youtubeLinked = tracks.filter(
      (t) => t.tracking?.youtubeId && t.tracking.youtubeId.trim() !== ""
    ).length;

    // Count tracks missing any platform ID (tracks with ISRC but missing at least one platform link)
    const missingIDs = tracks.filter((t) => {
      const hasISRC = t.isrc && t.isrc.trim() !== "";
      if (!hasISRC) return false;
      const hasSpotify = t.tracking?.spotifyId && t.tracking.spotifyId.trim() !== "";
      const hasApple = t.tracking?.appleId && t.tracking.appleId.trim() !== "";
      const hasYouTube = t.tracking?.youtubeId && t.tracking.youtubeId.trim() !== "";
      // Missing if has ISRC but doesn't have all three platform IDs
      return !hasSpotify || !hasApple || !hasYouTube;
    }).length;

    // Calculate total streams from DailyTrackingStats and TrackRegistry
    const DailyTrackingStats = require("../../models/DailyTrackingStatsModel");
    const trackIds = tracks.map((t) => t._id);
    
    let totalStreams = 0;
    
    if (trackIds.length > 0) {
      // Get latest stats from DailyTrackingStats
      const allStats = await DailyTrackingStats.find({
        trackId: { $in: trackIds },
      }).sort({ date: -1 });

      // Also get current data from TrackRegistry (has latest YouTube views)
      const registryData = await TrackRegistry.find({ trackId: { $in: trackIds } });

      // Create maps for easy lookup
      const trackStatsMap = new Map();
      allStats.forEach((stat) => {
        const trackIdStr = stat.trackId.toString();
        // Only keep the latest stat for each track
        if (!trackStatsMap.has(trackIdStr)) {
          trackStatsMap.set(trackIdStr, stat);
        }
      });

      const registryMap = new Map();
      registryData.forEach((reg) => {
        registryMap.set(reg.trackId.toString(), reg);
      });

      // Sum up streams from all platforms across all tracks
      // Prioritize TrackRegistry for YouTube views (most current)
      trackIds.forEach((trackId) => {
        const trackIdStr = trackId.toString();
        const stat = trackStatsMap.get(trackIdStr);
        const registry = registryMap.get(trackIdStr);

        // Spotify streams (always 0 from API, but check stats)
        const spotifyStreams = stat?.spotify?.streams || 0;
        
        // Apple plays (from stats)
        const applePlays = stat?.apple?.plays || 0;
        
        // YouTube views - use registry first (most current), then stats
        const youtubeViews = registry?.youtube?.views || stat?.youtube?.views || 0;
        
        totalStreams += spotifyStreams + applePlays + youtubeViews;
      });

      console.log(`[TRACKING STATS] Tracks: ${trackIds.length}, Stats records: ${allStats.length}, Registry records: ${registryData.length}, Total streams: ${totalStreams}`);
    }

    return res.status(200).json({
      success: true,
      stats: {
        totalTracks,
        tracksWithISRC,
        spotifyLinked,
        appleLinked,
        youtubeLinked,
        missingIDs,
        totalStreams,
      },
    });
  } catch (error) {
    console.error("Error fetching tracking stats:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching tracking stats",
    });
  }
});

/**
 * GET /api/tracking/track/:trackId
 * Get tracking details for a specific track
 */
router.get("/track/:trackId", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const track = await Track.findOne({ _id: req.params.trackId, user: user._id });
    if (!track) {
      return res.status(404).json({ success: false, message: "Track not found" });
    }

    return res.status(200).json({
      success: true,
      track,
    });
  } catch (error) {
    console.error("Error fetching track details:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching track details",
    });
  }
});

/**
 * GET /api/tracking/stats/:trackId
 * Get daily tracking stats for a specific track
 */
router.get("/stats/:trackId", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const track = await Track.findOne({ _id: req.params.trackId, user: user._id });
    if (!track) {
      return res.status(404).json({ success: false, message: "Track not found" });
    }

    const DailyTrackingStats = require("../../models/DailyTrackingStatsModel");
    const stats = await DailyTrackingStats.find({ trackId: track._id })
      .sort({ date: -1 })
      .limit(30); // Last 30 days

    return res.status(200).json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error("Error fetching daily stats:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching daily stats",
    });
  }
});

/**
 * PUT /api/tracking/track/:trackId/platforms
 * Manually update platform IDs for a track
 */
router.put("/track/:trackId/platforms", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const { spotifyId, appleId, youtubeId, mlcWorkId } = req.body;

    const track = await Track.findOne({ _id: req.params.trackId, user: user._id });
    if (!track) {
      return res.status(404).json({ success: false, message: "Track not found" });
    }

    // Update tracking field
    track.tracking = track.tracking || {};
    if (spotifyId !== undefined) track.tracking.spotifyId = spotifyId.trim();
    if (appleId !== undefined) track.tracking.appleId = appleId.trim();
    if (youtubeId !== undefined) track.tracking.youtubeId = youtubeId.trim();
    if (mlcWorkId !== undefined) track.tracking.mlcWorkId = mlcWorkId.trim();
    if (track.isrc) track.tracking.isrc = track.isrc;

    await track.save();

    // Update TrackRegistry
    await TrackRegistry.findOneAndUpdate(
      { trackId: track._id },
      {
        trackId: track._id,
        title: track.title,
        artist: track.artist,
        isrc: track.isrc || "",
        creator: track.user,
        spotify: {
          id: track.tracking.spotifyId || "",
          lastUpdated: track.tracking.spotifyId ? new Date() : null,
        },
        apple: {
          id: track.tracking.appleId || "",
          lastUpdated: track.tracking.appleId ? new Date() : null,
        },
        youtube: {
          id: track.tracking.youtubeId || "",
          lastUpdated: track.tracking.youtubeId ? new Date() : null,
        },
        mlcWorkId: track.tracking.mlcWorkId || "",
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Platform IDs updated successfully",
      track,
    });
  } catch (error) {
    console.error("Error updating platform IDs:", error);
    return res.status(500).json({
      success: false,
      message: "Server error updating platform IDs",
    });
  }
});

/**
 * GET /api/tracking/youtube-data/:youtubeId
 * Fetch YouTube video data by YouTube ID
 */
router.get("/youtube-data/:youtubeId", requireAuth(), async (req, res) => {
  try {
    let { youtubeId } = req.params;
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    if (!youtubeApiKey) {
      return res.status(500).json({
        success: false,
        message: "YouTube API key not configured",
      });
    }

    // Extract YouTube ID from URL if it's a full URL
    // Handles formats like: https://www.youtube.com/watch?v=VIDEO_ID or https://youtu.be/VIDEO_ID
    if (youtubeId.includes("youtube.com") || youtubeId.includes("youtu.be")) {
      try {
        const url = new URL(youtubeId);
        if (url.hostname.includes("youtu.be")) {
          youtubeId = url.pathname.substring(1); // Remove leading slash
        } else {
          youtubeId = url.searchParams.get("v") || youtubeId;
        }
      } catch (urlError) {
        // If URL parsing fails, try regex extraction
        const match = youtubeId.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (match) {
          youtubeId = match[1];
        }
      }
    }

    // Clean up the ID (remove any extra characters)
    youtubeId = youtubeId.trim().split("&")[0].split("?")[0];

    if (!youtubeId || youtubeId.length !== 11) {
      return res.status(400).json({
        success: false,
        message: `Invalid YouTube ID format: "${req.params.youtubeId}". YouTube IDs must be exactly 11 characters. Extracted ID: "${youtubeId}" (${youtubeId.length} chars)`,
        providedId: req.params.youtubeId,
        extractedId: youtubeId,
      });
    }

    console.log(`Fetching YouTube video data for ID: ${youtubeId} (original: ${req.params.youtubeId})`);

    // Get video data by ID
    try {
      const videoResponse = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
        params: {
          part: "snippet,statistics",
          id: youtubeId,
          key: youtubeApiKey,
        },
      });

      const videos = videoResponse.data.items || [];
      if (videos.length === 0) {
        // Check if there's an error from YouTube API
        if (videoResponse.data.error) {
          console.error("YouTube API Error:", videoResponse.data.error);
          return res.status(400).json({
            success: false,
            message: videoResponse.data.error.message || "YouTube API error",
            error: videoResponse.data.error,
          });
        }
        
        // If no videos found, the ID might be invalid or video was deleted
        console.warn(`No video found for YouTube ID: ${youtubeId}`);
        return res.status(404).json({
          success: false,
          message: `Video not found on YouTube with ID: ${youtubeId}. The video may have been deleted or the ID is incorrect.`,
          youtubeId: youtubeId,
        });
      }

      const video = videos[0];

      // Find track by YouTube ID
      const track = await Track.findOne({ "tracking.youtubeId": youtubeId, user: user._id });
      
      if (track) {
        // Update DailyTrackingStats
        const DailyTrackingStats = require("../../models/DailyTrackingStatsModel");
        const today = new Date().toISOString().split("T")[0];
        const views = parseInt(video.statistics?.viewCount || 0);
        const likes = parseInt(video.statistics?.likeCount || 0);
        const comments = parseInt(video.statistics?.commentCount || 0);
        
        console.log(`Saving YouTube stats for track ${track._id}: views=${views}, likes=${likes}, comments=${comments}, date=${today}`);
        
        await DailyTrackingStats.findOneAndUpdate(
          { trackId: track._id, date: today },
          {
            trackId: track._id,
            date: today,
            youtube: {
              views: views,
              likes: likes,
              comments: comments,
            },
          },
          { upsert: true, new: true }
        );
        
        console.log(`YouTube stats saved successfully for track ${track._id}`);

        // Update TrackRegistry
        await TrackRegistry.findOneAndUpdate(
          { trackId: track._id },
          {
            trackId: track._id,
            title: track.title,
            artist: track.artist,
            isrc: track.isrc || "",
            creator: track.user,
            youtube: {
              id: youtubeId,
              title: video.snippet.title,
              channelTitle: video.snippet.channelTitle || "",
              publishedAt: video.snippet.publishedAt || "",
              views: parseInt(video.statistics?.viewCount || 0),
              likes: parseInt(video.statistics?.likeCount || 0),
              comments: parseInt(video.statistics?.commentCount || 0),
              lastUpdated: new Date(),
            },
          },
          { upsert: true, new: true }
        );
      }

      return res.status(200).json({
        success: true,
        data: {
          id: youtubeId,
          title: video.snippet.title,
          channelTitle: video.snippet.channelTitle || "",
          description: video.snippet.description || "",
          thumbnail: video.snippet.thumbnails?.high?.url || "",
          externalUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
          views: parseInt(video.statistics?.viewCount || 0),
          likes: parseInt(video.statistics?.likeCount || 0),
          comments: parseInt(video.statistics?.commentCount || 0),
        },
      });
    } catch (searchError) {
      console.error("Error fetching YouTube video:", searchError);
      return res.status(500).json({
        success: false,
        message: "Error fetching YouTube video data",
        error: searchError.response?.data?.error?.message || searchError.message,
      });
    }
  } catch (error) {
    console.error("Error in YouTube data fetch:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching YouTube data",
    });
  }
});

/**
 * GET /api/tracking/spotify-data/:spotifyId
 * Fetch Spotify track data by Spotify ID
 */
router.get("/spotify-data/:spotifyId", requireAuth(), async (req, res) => {
  try {
    const { spotifyId } = req.params;
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
    const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!spotifyClientId || !spotifyClientSecret) {
      return res.status(500).json({
        success: false,
        message: "Spotify API credentials not configured",
      });
    }

    // Get access token
    let accessToken;
    try {
      const tokenResponse = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
          grant_type: "client_credentials",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString("base64")}`,
          },
        }
      );
      accessToken = tokenResponse.data.access_token;
    } catch (tokenError) {
      console.error("Error getting Spotify token:", tokenError);
      return res.status(500).json({
        success: false,
        message: "Failed to authenticate with Spotify API",
      });
    }

    // Get track data by ID
    try {
      const trackResponse = await axios.get(`https://api.spotify.com/v1/tracks/${spotifyId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const spotifyTrack = trackResponse.data;

      // Update DailyTrackingStats with current data
      const DailyTrackingStats = require("../../models/DailyTrackingStatsModel");
      const track = await Track.findOne({ "tracking.spotifyId": spotifyId, user: user._id });
      
      if (track) {
        await DailyTrackingStats.findOneAndUpdate(
          { trackId: track._id, date: new Date().toISOString().split("T")[0] },
          {
            trackId: track._id,
            date: new Date().toISOString().split("T")[0],
            spotify: {
              streams: 0, // Spotify API doesn't provide stream count directly
              popularity: spotifyTrack.popularity || 0,
            },
          },
          { upsert: true, new: true }
        );
      }

      return res.status(200).json({
        success: true,
        data: {
          id: spotifyTrack.id,
          name: spotifyTrack.name,
          artist: spotifyTrack.artists?.map((a) => a.name).join(", ") || "",
          album: spotifyTrack.album?.name || "",
          popularity: spotifyTrack.popularity || 0,
          externalUrl: spotifyTrack.external_urls?.spotify || "",
          previewUrl: spotifyTrack.preview_url || "",
        },
      });
    } catch (searchError) {
      console.error("Error fetching Spotify track:", searchError);
      return res.status(500).json({
        success: false,
        message: "Error fetching Spotify track data",
        error: searchError.response?.data?.error?.message || searchError.message,
      });
    }
  } catch (error) {
    console.error("Error in Spotify data fetch:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during Spotify data fetch",
    });
  }
});

/**
 * POST /api/tracking/track/:trackId/assign-isrc
 * Manually assign ISRC to a track
 */
router.post("/track/:trackId/assign-isrc", requireAuth(), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const track = await Track.findOne({ _id: req.params.trackId, user: user._id });
    if (!track) {
      return res.status(404).json({ success: false, message: "Track not found" });
    }

    if (track.isrc && track.isrc.trim() !== "") {
      return res.status(400).json({
        success: false,
        message: "Track already has an ISRC assigned",
      });
    }

    const isrcPrefix = process.env.ISRC_PREFIX;
    if (!isrcPrefix || isrcPrefix.length !== 5) {
      return res.status(400).json({
        success: false,
        message: "ISRC generation is not configured. You can still add platform IDs manually.",
      });
    }

    const { assignISRC } = require("../../utils/isrcGenerator");
    const ISRCRegistry = require("../../models/ISRCRegistryModel");

    await assignISRC(ISRCRegistry, Track, track._id.toString(), isrcPrefix);
    
    // Reload track to get updated ISRC
    const updatedTrack = await Track.findById(track._id);

    // Create TrackRegistry entry if it doesn't exist
    await TrackRegistry.findOneAndUpdate(
      { trackId: track._id },
      {
        trackId: track._id,
        title: updatedTrack.title,
        artist: updatedTrack.artist,
        isrc: updatedTrack.isrc || "",
        creator: updatedTrack.user,
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      success: true,
      message: "ISRC assigned successfully",
      track: updatedTrack,
    });
  } catch (error) {
    console.error("Error assigning ISRC:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error assigning ISRC",
    });
  }
});

module.exports = router;

