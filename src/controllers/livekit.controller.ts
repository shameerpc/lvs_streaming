import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware.js";
import { createLiveKitToken } from "../services/livekit.service.js";
import { env } from "../config/env.js";
import Room from "../models/Room.js";

export async function generateLiveKitToken(
  req: AuthRequest,
  res: Response
) {
  try {
    const { roomName } = req.body;

    if (!req.userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!roomName) {
      return res.status(400).json({
        success: false,
        message: "roomName is required",
      });
    }

    const room = await Room.findOne({
      name: roomName,
      status: "active",
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        message: "Room not found",
      });
    }

    const isHost = room.host.toString() === req.userId;

    const role = isHost ? "host" : "participant";

    const token = await createLiveKitToken(
      req.userId,
      roomName,
      role
    );

    return res.status(200).json({
      success: true,
      data: {
        token,
        serverUrl: env.livekitUrl,
        roomName,
        role,
      },
    });
  } catch (error) {
    console.error("LiveKit token error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to generate LiveKit token",
    });
  }
}