import express from "express";
import { google } from "googleapis";
import fs from "fs";
import dotenv from "dotenv";
import cors from "cors";

const app = express();
const PORT = 3000;

// More detailed CORS configuration
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
  { name: "customerChannel" },
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
  console.log("Received Request Body:", req.body);
  const { title, teamA, teamB } = req.body;
  const authCompleted = req.query.authCompleted === "true";
  const youtube = google.youtube("v3");

  async function createBroadcastAndStream(oauth2Client, channelName) {
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
          scheduledStartTime: new Date().toISOString(),
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

    // Step 2: Create Stream
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

    const streamId = streamResponse.data.id;
    console.log(`Stream created for ${channelName}, ID: ${streamId}`);

    // Step 3: Bind Broadcast and Stream
    await youtube.liveBroadcasts.bind({
      auth: oauth2Client,
      part: "id,contentDetails",
      id: broadcastId,
      requestBody: {
        streamId: streamId,
      },
    });

    console.log(`Broadcast and Stream bound for ${channelName}`);

    return {
      channel: channelName,
      broadcastId,
      streamId,
      streamKey: streamResponse.data.cdn.ingestionInfo.streamName,
      ingestionAddress: streamResponse.data.cdn.ingestionInfo.ingestionAddress,
      scheduledStartTime: new Date().toISOString(),
      studioUrl: `https://studio.youtube.com/video/${broadcastId}/livestreaming`,
      streamDetails: {
        resolution: streamResponse.data.cdn.resolution,
        frameRate: streamResponse.data.cdn.frameRate,
        ingestionType: streamResponse.data.cdn.ingestionType,
      },
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
            const ourStreamDetails = await createBroadcastAndStream(
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
      const customerStreamDetails = await createBroadcastAndStream(
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



app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(
    `Authenticate Our Channel: http://localhost:${PORT}/auth/ourChannel`
  );
  console.log(
    `Authenticate Customer Channel: http://localhost:${PORT}/auth/customerChannel`
  );
});
