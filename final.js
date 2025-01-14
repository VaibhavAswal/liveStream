import express from "express";
import { google } from "googleapis";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";

const app = express();
dotenv.config();

mongoose.connect(process.env.MONGODB_URI);

// Company Schema
const CompanySchema = new mongoose.Schema({
  name: { type: String, required: true },
  youtubeTokens: { type: Object },
});

const Company = mongoose.model("Company", CompanySchema);

// Academy Schema
const AcademySchema = new mongoose.Schema({
  academyId: { type: String, required: true },
  name: { type: String, required: true },
  youtubeTokens: { type: Object },
  grounds: [
    {
      groundId: { type: String, required: true },
      title: { type: String, required: true },
      streamKey: { type: String, required: true },
      academyStreamId: { type: String },
      companyStreamId: { type: String },
    },
  ],
});

const Academy = mongoose.model("Academy", AcademySchema);

app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];

const getOAuthClient = () => {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
};

const getCompanyOAuthClient = async () => {
  try {
    const company = await Company.findOne();
    if (!company || !company.youtubeTokens) {
      throw new Error("Company not authenticated");
    }

    const oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    oauth2Client.setCredentials(company.youtubeTokens);

    oauth2Client.on("tokens", async (newTokens) => {
      const updatedTokens = {
        ...company.youtubeTokens,
        ...newTokens,
      };

      await Company.findOneAndUpdate(
        { _id: company._id },
        { youtubeTokens: updatedTokens }
      );
    });

    return oauth2Client;
  } catch (error) {
    console.error("Error in getCompanyOAuthClient:", error);
    throw error;
  }
};

// Company Routes
app.post("/company", async (req, res) => {
  const { name } = req.body;
  try {
    const existingCompany = await Company.findOne();
    if (existingCompany) {
      return res.status(400).json({ error: "Company already exists" });
    }
    const company = new Company({ name });
    await company.save();
    res.json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/company", async (req, res) => {
  try {
    const company = await Company.findOne();
    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }
    res.json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/company/auth", async (req, res) => {
  const company = await Company.findOne();
  if (!company) {
    return res
      .status(404)
      .json({ error: "Company not found. Please create company first." });
  }

  const oauth2Client = getOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state: "company",
  });
  res.redirect(authUrl);
});

// Academy Routes
app.post("/academies", async (req, res) => {
  try {
    const { academyId, name, grounds } = req.body;
    const academy = new Academy({
      academyId,
      name,
      grounds: grounds.map((ground) => ({
        ...ground,
        streamKey: `${academyId}-${ground.groundId}-${Date.now()}`,
      })),
    });
    await academy.save();
    res.json(academy);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/academies/:academyId", async (req, res) => {
  try {
    const academy = await Academy.findOne({ academyId: req.params.academyId });
    if (!academy) {
      return res.status(404).json({ error: "Academy not found" });
    }
    res.json(academy);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/academies/:academyId", async (req, res) => {
  try {
    const academy = await Academy.findOneAndUpdate(
      { academyId: req.params.academyId },
      req.body,
      { new: true }
    );
    if (!academy) {
      return res.status(404).json({ error: "Academy not found" });
    }
    res.json(academy);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/auth/:academyId", async (req, res) => {
  try {
    const academy = await Academy.findOne({ academyId: req.params.academyId });
    if (!academy) {
      return res.status(404).json({ error: "Academy not found" });
    }

    const oauth2Client = getOAuthClient();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
      state: academy.academyId,
    });
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/oauth2callback", async (req, res) => {
  const { code, state } = req.query;
  const oauth2Client = getOAuthClient();

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (state === "company") {
      await Company.findOneAndUpdate(
        {},
        { youtubeTokens: tokens },
        { new: true }
      );
    } else {
      await Academy.findOneAndUpdate(
        { academyId: state },
        { youtubeTokens: tokens }
      );
    }

    res.send(`
      <h1>Authentication Successful!</h1>
      <p>You can now close this window.</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({ id: '${state}', success: true }, '*');
          window.close();
        }
      </script>
    `);
  } catch (error) {
    res.status(500).send("Authentication failed.");
  }
});

// Streaming Functions
const getExistingStream = async (
  oauth2Client,
  academy,
  groundId,
  isCompanyChannel = false
) => {
  const youtube = google.youtube("v3");
  const ground = academy.grounds.find((g) => g.groundId === groundId);

  if (!ground) {
    throw new Error("Ground not found");
  }

  const streamId = isCompanyChannel
    ? ground.companyStreamId
    : ground.academyStreamId;
  const streamName = isCompanyChannel
    ? `${academy.name}:${ground.title.replace(/\s+/g, "")}`
    : ground.streamKey;

  if (streamId) {
    try {
      const streamResponse = await youtube.liveStreams.list({
        auth: oauth2Client,
        part: "id,snippet,cdn",
        id: streamId,
      });

      if (streamResponse.data.items.length > 0) {
        const existingStream = streamResponse.data.items[0];
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
      }
    } catch (error) {
      console.log("Error fetching existing stream:", error);
    }
  }

  const streamResponse = await youtube.liveStreams.insert({
    auth: oauth2Client,
    part: "snippet,cdn,contentDetails,status",
    requestBody: {
      snippet: {
        title: isCompanyChannel
          ? `${academy.name} - ${ground.title}`
          : `${ground.title} - Stream`,
      },
      cdn: {
        ingestionType: "rtmp",
        resolution: "1080p",
        frameRate: "30fps",
        ingestionInfo: {
          streamName: streamName,
        },
      },
    },
  });

  const updateField = isCompanyChannel ? "companyStreamId" : "academyStreamId";
  await Academy.findOneAndUpdate(
    {
      academyId: academy.academyId,
      "grounds.groundId": groundId,
    },
    {
      $set: {
        [`grounds.$.${updateField}`]: streamResponse.data.id,
      },
    }
  );

  return {
    streamId: streamResponse.data.id,
    streamKey: streamResponse.data.cdn.ingestionInfo.streamName,
    ingestionAddress: streamResponse.data.cdn.ingestionInfo.ingestionAddress,
    streamDetails: {
      resolution: streamResponse.data.cdn.resolution,
      frameRate: streamResponse.data.cdn.frameRate,
      ingestionType: streamResponse.data.cdn.ingestionType,
    },
  };
};

async function createBroadcastAndBind(
  oauth2Client,
  academy,
  groundId,
  title,
  teamA,
  teamB,
  isCompanyChannel = false,
  startTime = new Date()
) {
  const youtube = google.youtube("v3");

  const streamDetails = await getExistingStream(
    oauth2Client,
    academy,
    groundId,
    isCompanyChannel
  );

  const broadcastResponse = await youtube.liveBroadcasts.insert({
    auth: oauth2Client,
    part: "snippet,contentDetails,status",
    requestBody: {
      snippet: {
        title: title,
        description: `${teamA} vs ${teamB}`,
        scheduledStartTime: new Date(startTime).toISOString(),
      },
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        monitorStream: { enableMonitorStream: true },
        enableAutoStart: true,
        enableAutoStop: true,
        enableDvr: true,
        recordFromStart: true,
        enableContentEncryption: false,
        startWithSlate: false,
        defaultStreamKey: streamDetails.streamId,
      },
    },
  });

  await youtube.liveBroadcasts.bind({
    auth: oauth2Client,
    part: "id,contentDetails",
    id: broadcastResponse.data.id,
    streamId: streamDetails.streamId,
  });

  return {
    academyId: academy.academyId,
    groundId,
    broadcastId: broadcastResponse.data.id,
    ...streamDetails,
  };
}

// Streaming Routes
app.post("/go-live-now", async (req, res) => {
  const { academyId, groundId, title, teamA, teamB, startTime } = req.body;

  try {
    const academy = await Academy.findOne({ academyId });
    if (!academy || !academy.youtubeTokens) {
      return res.status(400).json({
        success: false,
        message: "Academy not authenticated",
      });
    }

    const academyOAuth2Client = getOAuthClient();
    academyOAuth2Client.setCredentials(academy.youtubeTokens);
    const academyResult = await createBroadcastAndBind(
      academyOAuth2Client,
      academy,
      groundId,
      title,
      teamA,
      teamB,
      false,
      startTime
    );

    const companyOAuth2Client = await getCompanyOAuthClient();
    const companyResult = await createBroadcastAndBind(
      companyOAuth2Client,
      academy,
      groundId,
      title,
      teamA,
      teamB,
      true,
      startTime
    );

    res.json({
      success: true,
      academyStream: academyResult,
      companyStream: companyResult,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/end-stream", async (req, res) => {
  const { academyId, title } = req.body;

  try {
    const academy = await Academy.findOne({ academyId });
    if (!academy || !academy.youtubeTokens) {
      return res.status(400).json({ error: "Academy not authenticated" });
    }

    const academyOAuth2Client = getOAuthClient();
    academyOAuth2Client.setCredentials(academy.youtubeTokens);

    const companyOAuth2Client = await getCompanyOAuthClient();
    const youtube = google.youtube("v3");

    const endBroadcast = async (auth, isCompanyChannel) => {
      const searchResponse = await youtube.liveBroadcasts.list({
        auth,
        part: "id,snippet",
        broadcastStatus: "active",
        broadcastType: "all",
      });

      const broadcast = searchResponse.data.items.find(
        (b) =>
          b.snippet.title ===
          (isCompanyChannel ? `${academy.name} - ${title}` : title)
      );

      if (broadcast) {
        await youtube.liveBroadcasts.transition({
          auth,
          part: "status",
          id: broadcast.id,
          broadcastStatus: "complete",
        });
        return true;
      }
      return false;
    };

    const [academyEnded, companyEnded] = await Promise.all([
      endBroadcast(academyOAuth2Client, false),
      endBroadcast(companyOAuth2Client, true),
    ]);

    res.json({
      success: true,
      academyStreamEnded: academyEnded,
      companyStreamEnded: companyEnded,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});