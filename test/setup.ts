import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

process.env.NODE_ENV = "test";

const envPath = resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

process.env.JWT_SECRET ??= "test_jwt_secret";
process.env.PORT ??= "5000";
process.env.MONGO_URI ??= "mongodb://127.0.0.1:27017/lvs_streaming_test";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";