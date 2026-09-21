import express, {
  NextFunction,
  Request,
  Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import roomRoutes from "./routes/room.routes.js";
import livekitRoutes from "./routes/livekit.routes.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests, please try again later",
  },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests, please try again later",
  },
});

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    message: "API is running",
  });
});

app.use("/auth", authLimiter, authRoutes);
app.use("/users", apiLimiter, userRoutes);
app.use("/rooms", apiLimiter, roomRoutes);
app.use("/livekit", apiLimiter, livekitRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use(
  (
    err: Error & { status?: number },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const status = err.status ?? 500;

    if (status >= 500) {
      console.error("Unexpected error:", err);
    }

    res.status(status).json({
      success: false,
      message:
        status === 500 ? "Internal server error" : err.message,
    });
  }
);

export default app;