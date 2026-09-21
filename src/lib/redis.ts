import Redis from "ioredis";
import { env } from "../config/env.js";

console.log("Redis URL configured:", !!env.redisUrl);

export const redis = new Redis(env.redisUrl);

redis.on("connect", () => {
  console.log("Redis connected");
});

redis.on("ready", () => {
  console.log("Redis ready");
});

redis.on("error", (error) => {
  console.error("Redis error:", error);
});

redis.on("close", () => {
  console.log("Redis connection closed");
});