const Track = require("../models/TrackModel");
const TrackRegistry = require("../models/TrackRegistryModel");
const DailyTrackingStats = require("../models/DailyTrackingStatsModel");
const axios = require("axios");

/**
 * Lookup track on Spotify by ISRC
 */
async function lookupSpotify(isrc, track) {
  try {
    const spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
    const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!spotifyClientId || !spotifyClientSecret) {
      console.log("Spotify credentials not configured");
      return null;
    }

    // Get access token
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

    const accessToken = tokenResponse.data.access_token;

    // Search for track
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
      return null;
    }

    const spotifyTrack = tracks[0];
    const spotifyId = spotifyTrack.id;

    // Update track
    if (track) {
      track.tracking = track.tracking || {};
      track.tracking.spotifyId = spotifyId;
      track.tracking.isrc = isrc.toUpperCase();
      await track.save();

      // Update registry
      await TrackRegistry.findOneAndUpdate(
        { trackId: track._id },
        {
          "spotify.id": spotifyId,
          "spotify.name": spotifyTrack.name,
          "spotify.album": spotifyTrack.album?.name || "",
          "spotify.popularity": spotifyTrack.popularity || 0,
          "spotify.externalUrl": spotifyTrack.external_urls?.spotify || "",
          "spotify.lastUpdated": new Date(),
        },
        { upsert: false }
      );
    }

    return {
      id: spotifyId,
      popularity: spotifyTrack.popularity || 0,
      streams: 0, // Spotify doesn't provide stream count in search API
    };
  } catch (error) {
    console.error(`Error looking up Spotify for ISRC ${isrc}:`, error.message);
    return null;
  }
}

/**
 * Lookup track on Apple Music by ISRC
 */
async function lookupApple(isrc, track) {
  try {
    const appleDeveloperToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
    if (!appleDeveloperToken) {
      console.log("Apple Music credentials not configured");
      return null;
    }

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
      return null;
    }

    const appleSong = songs[0];
    const appleId = appleSong.id;
    const albumId = appleSong.relationships?.albums?.data?.[0]?.id || "";

    // Update track
    if (track) {
      track.tracking = track.tracking || {};
      track.tracking.appleId = appleId;
      track.tracking.isrc = isrc.toUpperCase();
      await track.save();

      // Update registry
      await TrackRegistry.findOneAndUpdate(
        { trackId: track._id },
        {
          "apple.id": appleId,
          "apple.albumId": albumId,
          "apple.name": appleSong.attributes?.name || "",
          "apple.albumName": appleSong.relationships?.albums?.data?.[0]?.attributes?.name || "",
          "apple.externalUrl": appleSong.attributes?.url || "",
          "apple.lastUpdated": new Date(),
        },
        { upsert: false }
      );
    }

    return {
      id: appleId,
      rank: null, // Apple Music doesn't provide rank in catalog API
      plays: 0,
    };
  } catch (error) {
    console.error(`Error looking up Apple Music for ISRC ${isrc}:`, error.message);
    return null;
  }
}

/**
 * Lookup track on YouTube by title + artist
 */
async function lookupYouTube(isrc, track) {
  try {
    if (!track) {
      return null;
    }

    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    if (!youtubeApiKey) {
      console.log("YouTube API key not configured");
      return null;
    }

    const searchQuery = `${track.title} ${track.artist}`;
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
      return null;
    }

    const youtubeVideo = videos[0];
    const youtubeId = youtubeVideo.id.videoId;

    // Get video statistics
    const statsResponse = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
      params: {
        part: "statistics",
        id: youtubeId,
        key: youtubeApiKey,
      },
    });

    const videoStats = statsResponse.data.items?.[0]?.statistics || {};
    const views = parseInt(videoStats.viewCount || 0);
    const likes = parseInt(videoStats.likeCount || 0);
    const comments = parseInt(videoStats.commentCount || 0);

    // Update track
    track.tracking = track.tracking || {};
    track.tracking.youtubeId = youtubeId;
    track.tracking.isrc = isrc.toUpperCase();
    await track.save();

    // Update registry
    await TrackRegistry.findOneAndUpdate(
      { trackId: track._id },
      {
        "youtube.id": youtubeId,
        "youtube.title": youtubeVideo.snippet?.title || "",
        "youtube.channelTitle": youtubeVideo.snippet?.channelTitle || "",
        "youtube.externalUrl": `https://www.youtube.com/watch?v=${youtubeId}`,
        "youtube.lastUpdated": new Date(),
      },
      { upsert: false }
    );

    return {
      id: youtubeId,
      views,
      likes,
      comments,
    };
  } catch (error) {
    console.error(`Error looking up YouTube for ISRC ${isrc}:`, error.message);
    return null;
  }
}

/**
 * Main function to track all songs
 * Runs every 12 hours
 */
async function trackAllSongs() {
  console.log("Starting daily tracking job...");
  const startTime = Date.now();

  try {
    // Get all tracks with ISRC
    const tracks = await Track.find({
      isrc: { $ne: "", $exists: true },
    }).populate("user");

    console.log(`Found ${tracks.length} tracks with ISRC to track`);

    let processed = 0;
    let errors = 0;

    for (const track of tracks) {
      try {
        const isrc = track.isrc.toUpperCase();
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Lookup all platforms
        const [spotifyData, appleData, youtubeData] = await Promise.all([
          lookupSpotify(isrc, track),
          lookupApple(isrc, track),
          lookupYouTube(isrc, track),
        ]);

        // Save daily stats
        await DailyTrackingStats.findOneAndUpdate(
          { trackId: track._id, date: today },
          {
            trackId: track._id,
            date: today,
            spotify: {
              streams: spotifyData?.streams || 0,
              popularity: spotifyData?.popularity || 0,
              followers: 0,
            },
            apple: {
              rank: appleData?.rank || null,
              plays: appleData?.plays || 0,
            },
            youtube: {
              views: youtubeData?.views || 0,
              likes: youtubeData?.likes || 0,
              comments: youtubeData?.comments || 0,
            },
          },
          { upsert: true, new: true }
        );

        processed++;
        if (processed % 10 === 0) {
          console.log(`Processed ${processed}/${tracks.length} tracks...`);
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error processing track ${track._id}:`, error.message);
        errors++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `Tracking job completed. Processed: ${processed}, Errors: ${errors}, Duration: ${duration}s`
    );
  } catch (error) {
    console.error("Error in trackAllSongs job:", error);
  }
}

module.exports = { trackAllSongs, lookupSpotify, lookupApple, lookupYouTube };

