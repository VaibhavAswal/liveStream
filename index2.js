import express from "express";
import { google } from "googleapis";
import fs from "fs";
import dotenv from "dotenv";
import cors from "cors";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

dotenv.config();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];

const saveTokens = (channelName, tokens) => {
  fs.writeFileSync(`${channelName}_tokens.json`, JSON.stringify(tokens));
};

const loadTokens = (channelName) => {
  try {
    return JSON.parse(fs.readFileSync(`${channelName}_tokens.json`));
  } catch (err) {
    return null;
  }
};

const CHANNELS = [
  { name: "ourChannel", tokens: loadTokens("ourChannel") },
  { name: "customerChannel", tokens: loadTokens("customerChannel") },
];

const getOAuthClient = () => {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
};

// Validate tokens before attempting to use them
const validateTokens = async (oauth2Client, tokens) => {
  try {
    oauth2Client.setCredentials(tokens);
    const youtube = google.youtube("v3");
    // Make a simple API call to test the tokens
    await youtube.channels.list({
      auth: oauth2Client,
      part: "snippet",
      mine: true,
    });
    return true;
  } catch (error) {
    console.log("Token validation failed:", error.message);
    return false;
  }
};

app.get("/auth/:channelName", (req, res) => {
  const oauth2Client = getOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state: req.params.channelName,
  });
  res.redirect(authUrl);
});

app.get("/oauth2callback", async (req, res) => {
  const { code, state } = req.query;
  const oauth2Client = getOAuthClient();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    saveTokens(state, tokens);
    res.send(`
            <h1>Authentication Successful!</h1>
            <p>You can now close this window and return to the app.</p>
            <script>
                if (window.opener) {
                    window.opener.postMessage({ channel: '${state}', success: true }, '*');
                    window.close();
                }
            </script>
        `);
  } catch (error) {
    console.error("Error during OAuth callback:", error.message);
    res.status(500).send("Authentication failed.");
  }
});

app.post("/go-live-now", async (req, res) => {
  const { title, teamA, teamB, startTime, endTime } = req.body;
  const authCompleted = req.query.authCompleted === "true";
  const youtube = google.youtube("v3");

  // Function to fetch existing stream
  async function getExistingStream(oauth2Client) {
    const response = await youtube.liveStreams.list({
      auth: oauth2Client,
      part: "id,snippet,cdn",
      mine: true,
    });
    console.log("existing streams: ", response.data.items);
    if (response.data.items.length > 0) {
      const existingStream = response.data.items[0]; // Assuming the first one is the default
      console.log("Using existing stream:", existingStream.id);
      return {
        streamId: existingStream.id,
        streamKey: existingStream.cdn.ingestionInfo.streamName,
        ingestionAddress: existingStream.cdn.ingestionInfo.ingestionAddress,
        streamDetails: {
          resolution: existingStream.cdn.resolution,
          frameRate: existingStream.cdn.frameRate,
          ingestionType: existingStream.cdn.ingestionType,
        },
      };
    } else {
      console.log("No existing stream found.");
      return null;
    }
  }

  // Function to create a broadcast and bind it to an existing or new stream
  async function createBroadcastAndBind(oauth2Client, channelName) {
    // Step 1: Create Broadcast
    const broadcastResponse = await youtube.liveBroadcasts.insert({
      auth: oauth2Client,
      part: "snippet,contentDetails,status",
      requestBody: {
        snippet: {
          title: title || "Live Stream",
          description: `${teamA || "Team A"} vs ${
            teamB || "Team B"
          } - Powered by our application`,
          scheduledStartTime: new Date(startTime).toISOString(),
          scheduledEndTime: new Date(endTime).toISOString(),
        },
        status: {
          privacyStatus: "public",
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          monitorStream: { enableMonitorStream: true },
          enableAutoStart: true,
          enableAutoStop: true,
        },
      },
    });

    const broadcastId = broadcastResponse.data.id;
    console.log(`Broadcast created for ${channelName}, ID: ${broadcastId}`);

    // Step 2: Check for Existing Stream
    let streamDetails = await getExistingStream(oauth2Client);
    if (!streamDetails) {
      console.log("No default stream found. Creating a new stream...");
      const streamResponse = await youtube.liveStreams.insert({
        auth: oauth2Client,
        part: "snippet,cdn,contentDetails,status",
        requestBody: {
          snippet: {
            title: `${title || "New Stream"} - Stream`,
          },
          cdn: {
            ingestionType: "rtmp",
            resolution: "1080p",
            frameRate: "30fps",
          },
        },
      });

      streamDetails = {
        streamId: streamResponse.data.id,
        streamKey: streamResponse.data.cdn.ingestionInfo.streamName,
        ingestionAddress:
          streamResponse.data.cdn.ingestionInfo.ingestionAddress,
        streamDetails: {
          resolution: streamResponse.data.cdn.resolution,
          frameRate: streamResponse.data.cdn.frameRate,
          ingestionType: streamResponse.data.cdn.ingestionType,
        },
      };

      console.log(`New stream created, ID: ${streamDetails.streamId}`);
    }

    // Step 3: Bind Broadcast to Stream
    await youtube.liveBroadcasts.bind({
      auth: oauth2Client,
      part: "id,contentDetails",
      id: broadcastId,
      requestBody: {
        streamId: streamDetails.streamId,
      },
    });

    console.log(`Broadcast and Stream bound for ${channelName}`);
    console.log(
      `Stream URL: ${streamDetails.ingestionAddress}/${streamDetails.streamKey}`
    );

    return {
      channel: channelName,
      broadcastId,
      streamId: streamDetails.streamId,
      streamKey: streamDetails.streamKey,
      ingestionAddress: streamDetails.ingestionAddress,
      scheduledStartTime: new Date().toISOString(),
      studioUrl: `https://studio.youtube.com/video/${broadcastId}/livestreaming`,
      streamDetails: streamDetails.streamDetails,
    };
  }

  // Store results from both channels
  let results = [];

  // Create oauth2Client at the beginning
  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  // If this is a post-auth request for customerChannel
  if (authCompleted) {
    const customerTokens = loadTokens("customerChannel");
    if (!customerTokens) {
      return res.json({
        success: false,
        message: "Customer channel authentication required. Please try again.",
      });
    }

    try {
      // First try ourChannel if tokens exist
      const ourChannelTokens = loadTokens("ourChannel");

      if (ourChannelTokens) {
        const tokensValid = await validateTokens(
          oauth2Client,
          ourChannelTokens
        );
        if (tokensValid) {
          try {
            oauth2Client.setCredentials(ourChannelTokens);
            const ourStreamDetails = await createBroadcastAndBind(
              oauth2Client,
              "ourChannel"
            );
            results.push(ourStreamDetails);
          } catch (error) {
            console.log(
              "Failed to create broadcast on ourChannel:",
              error.message
            );
          }
        }
      }

      // Reset oauth2Client credentials for customer channel
      oauth2Client.setCredentials(customerTokens);
      const customerStreamDetails = await createBroadcastAndBind(
        oauth2Client,
        "customerChannel"
      );
      results.push(customerStreamDetails);

      return res.json({
        success: true,
        results,
        message: `Streams created successfully${
          results.length > 1 ? " on both channels" : " on customer channel"
        }`,
      });
    } catch (error) {
      console.error("Error creating streams:", error);
      return res.json({
        success: false,
        message:
          "Failed to create stream on customer channel. Please try again.",
      });
    }
  }

  // Initial request - proceed to customer channel auth
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state: "customerChannel",
  });

  return res.json({ redirectUrl: authUrl });
});

app.post("/end-stream", async (req, res) => {
    console.log(req.body)
  const { title } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Stream title is required." });
  }

  const results = [];
  const oauth2Client = getOAuthClient();

  try {
    for (const channel of CHANNELS) {
      const tokens = channel.tokens;

      if (!tokens) {
        results.push({
          channelName: channel.name,
          title,
          status: "no_tokens",
          message: `No tokens found for ${channel.name}. Please authenticate.`,
        });
        continue;
      }

      try {
        const tokensValid = await validateTokens(oauth2Client, tokens);

        if (!tokensValid) {
          results.push({
            channelName: channel.name,
            title,
            status: "invalid_tokens",
            message: `Tokens for ${channel.name} are invalid. Please reauthenticate.`,
          });
          continue;
        }

        oauth2Client.setCredentials(tokens);
        const youtube = google.youtube({ version: "v3", auth: oauth2Client });

        // Search for live broadcasts by title
        const searchResponse = await youtube.liveBroadcasts.list({
          part: "id,snippet",
          broadcastStatus: "active",
          broadcastType: "all",
        });

        const matchingBroadcast = searchResponse.data.items.find(
          (broadcast) =>
            broadcast.snippet.title.toLowerCase() === title.toLowerCase()
        );

        if (matchingBroadcast) {
          const broadcastId = matchingBroadcast.id;

          // Transition the live broadcast to "complete"
          await youtube.liveBroadcasts.transition({
            part: "status",
            id: broadcastId,
            broadcastStatus: "complete",
          });

          results.push({
            channelName: channel.name,
            title,
            status: "success",
            message: `Stream "${title}" has ended successfully for ${channel.name}.`,
          });
        } else {
          results.push({
            channelName: channel.name,
            title,
            status: "not_found",
            message: `No live stream with title "${title}" found for ${channel.name}.`,
          });
        }
      } catch (err) {
        results.push({
          channelName: channel.name,
          title,
          status: "error",
          message: `Error ending stream for ${channel.name}: ${err.message}`,
        });
      }
    }

    res.status(200).json({ results });
  } catch (error) {
    res.status(500).json({
      error: "An unexpected error occurred.",
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(
    `Authenticate Our Channel: http://localhost:${PORT}/auth/ourChannel`
  );
  console.log(
    `Authenticate Customer Channel: http://localhost:${PORT}/auth/customerChannel`
  );
});
