import { Router } from "express";
import { generateLiveKitToken } from "../controllers/livekit.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.js";
import { livekitTokenSchema } from "../validation/schemas.js";

const router = Router();

router.post(
  "/token",
  authenticate,
  validateBody(livekitTokenSchema),
  generateLiveKitToken
);

export default router;