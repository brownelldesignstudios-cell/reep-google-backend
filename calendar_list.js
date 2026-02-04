import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

dotenv.config();

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
} = process.env;

const oauth2Client = new OAuth2Client(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const TOKEN_PATH = path.join(process.cwd(), "tokens.json");
const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
oauth2Client.setCredentials(tokens);

const calendar = google.calendar({ version: "v3", auth: oauth2Client });

const run = async () => {
  const resp = await calendar.calendarList.list();
  const items = resp.data.items || [];
  console.log("\nCALENDARS:");
  for (const c of items) {
    console.log(`- ${c.summary}  |  id=${c.id}  |  primary=${c.primary ? "yes" : "no"}`);
  }
  console.log("");
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
