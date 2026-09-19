import dotenv from "dotenv";

dotenv.config();

const requiredEnv = [
  "PORT",
  "MONGO_URI",
  "REDIS_URL",
  "JWT_SECRET",
] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

export const env = {
  port: Number(process.env.PORT),

  mongoUri: process.env.MONGO_URI as string,

  redisUrl: process.env.REDIS_URL as string,

  jwtSecret: process.env.JWT_SECRET as string,

  livekitUrl: process.env.LIVEKIT_URL || "",
  livekitApiKey: process.env.LIVEKIT_API_KEY || "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || "",
};