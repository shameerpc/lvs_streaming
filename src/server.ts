import http from "http";
import app from "./app.js";
import { env } from "./config/env.js";
import { connectMongo } from "./lib/mongo.js";
import { initSocket } from "./socket/socket.js";

const httpServer = http.createServer(app);

initSocket(httpServer);

async function startServer() {
  try {
    await connectMongo();

    httpServer.listen(env.port, () => {
      console.log(`Server running on port ${env.port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();