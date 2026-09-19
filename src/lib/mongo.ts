import mongoose from "mongoose";
import { env } from "../config/env.js";

export async function connectMongo(): Promise<void> {
  try {
    await mongoose.connect(env.mongoUri);

    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection failed", error);
    process.exit(1);
  }
}