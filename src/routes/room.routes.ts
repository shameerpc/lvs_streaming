import { Router } from "express";

import {
  createRoom,
  getRooms,
  getRoomById,
  joinRoom,
  leaveRoom,
} from "../controllers/room.controller.js";

import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authenticate);

router.post("/", createRoom);
router.get("/", getRooms);
router.get("/:id", getRoomById);
router.post("/:id/join", joinRoom);
router.post("/:id/leave", leaveRoom);

export default router;