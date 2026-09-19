import express from "express";
import cors from "cors";

import authRoutes from "./routes/auth.routes.js";
import roomRoutes from "./routes/room.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    message: "API is running",
  });
});

app.use("/auth", authRoutes);
app.use("/rooms", roomRoutes);

export default app;