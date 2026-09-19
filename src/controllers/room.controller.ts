import { Response } from "express";
import mongoose from "mongoose";

import Room from "../models/Room.js";
import User from "../models/User.js";
import { AuthRequest } from "../middleware/auth.middleware.js";

// Create Room
export const createRoom = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const { name } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Room name is required",
      });
    }

    if (!req.userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const room = await Room.create({
      name: name.trim(),
      host: req.userId,
      participants: [req.userId],
      participantCount: 1,
      status: "active",
    });

    const populatedRoom = await room.populate([
      {
        path: "host",
        select: "name email profileImage",
      },
      {
        path: "participants",
        select: "name email profileImage",
      },
    ]);

    return res.status(201).json({
      success: true,
      message: "Room created successfully",
      data: populatedRoom,
    });
  } catch (error) {
    console.error("Create room error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Get Active Rooms
export const getRooms = async (
  _req: AuthRequest,
  res: Response
) => {
  try {
    const rooms = await Room.find({ status: "active" })
      .populate("host", "name email profileImage")
      .populate("participants", "name email profileImage")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: rooms.length,
      data: rooms,
    });
  } catch (error) {
    console.error("Get rooms error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Get Room Details
export const getRoomById = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid room ID",
      });
    }

    const room = await Room.findById(id)
      .populate("host", "name email profileImage")
      .populate("participants", "name email profileImage");

    if (!room) {
      return res.status(404).json({
        success: false,
        message: "Room not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: room,
    });
  } catch (error) {
    console.error("Get room error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Join Room
export const joinRoom = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid room ID",
      });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({
        success: false,
        message: "Room not found",
      });
    }

    if (room.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Room is no longer active",
      });
    }

    const alreadyJoined = room.participants.some(
      (participant) => participant.toString() === userId
    );

    if (alreadyJoined) {
      return res.status(409).json({
        success: false,
        message: "User already joined this room",
      });
    }

    room.participants.push(
      new mongoose.Types.ObjectId(userId)
    );

    room.participantCount = room.participants.length;

    await room.save();

    const populatedRoom = await room.populate([
      {
        path: "host",
        select: "name email profileImage",
      },
      {
        path: "participants",
        select: "name email profileImage",
      },
    ]);

    return res.status(200).json({
      success: true,
      message: "Joined room successfully",
      data: populatedRoom,
    });
  } catch (error) {
    console.error("Join room error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Leave Room
export const leaveRoom = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid room ID",
      });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({
        success: false,
        message: "Room not found",
      });
    }

    const isParticipant = room.participants.some(
      (participant) => participant.toString() === userId
    );

    if (!isParticipant) {
      return res.status(400).json({
        success: false,
        message: "User is not a participant",
      });
    }

    // Host leaving ends the room.
    if (room.host.toString() === userId) {
      room.status = "ended";
      room.participants = [];
      room.participantCount = 0;

      await room.save();

      return res.status(200).json({
        success: true,
        message: "Host left and room ended",
        data: room,
      });
    }

    room.participants = room.participants.filter(
      (participant) => participant.toString() !== userId
    );

    room.participantCount = room.participants.length;

    await room.save();

    return res.status(200).json({
      success: true,
      message: "Left room successfully",
      data: room,
    });
  } catch (error) {
    console.error("Leave room error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};