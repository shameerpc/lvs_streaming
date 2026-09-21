import { Router } from "express";

import {
  createRoom,
  getRooms,
  getRoomById,
  joinRoom,
  leaveRoom,
} from "../controllers/room.controller.js";

import { authenticate } from "../middleware/auth.middleware.js";
import {
  validateBody,
  validateObjectId,
} from "../middleware/validate.js";
import { createRoomSchema } from "../validation/schemas.js";

const router = Router();

router.use(authenticate);

router.post("/", validateBody(createRoomSchema), createRoom);
router.get("/", getRooms);
router.get("/:id", validateObjectId, getRoomById);
router.post("/:id/join", validateObjectId, joinRoom);
router.post("/:id/leave", validateObjectId, leaveRoom);

export default router;