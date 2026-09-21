import type http from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { redis } from "../lib/redis.js";
import User from "../models/User.js";
import Room from "../models/Room.js";

const ONLINE_TTL_SECONDS = 60 * 60 * 24;

const onlineKey = (userId: string) => `online:${userId}`;
const roomKey = (roomId: string) => `room:${roomId}:participants`;

const subClient = redis.duplicate();

subClient.on("error", (error) => {
  console.error("Redis sub client error:", error);
});

function getUserId(user: unknown): string {
  const payload = user as {
    id?: string;
    userId?: string;
    _id?: string;
  };

  const userId = payload.id ?? payload.userId ?? payload._id;

  if (!userId) {
    throw new Error("User ID not found in JWT");
  }

  return userId;
}

function isValidRoomId(roomId: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(roomId);
}

async function syncRoomMembership(
  roomId: string,
  userId: string,
  action: "join" | "leave"
) {
  const room = await Room.findById(roomId);

  if (!room) {
    return;
  }

  const isPresent = room.participants.some(
    (participant) => participant.toString() === userId
  );

  if (action === "join" && !isPresent) {
    room.participants.push(new mongoose.Types.ObjectId(userId));
  } else if (action === "leave" && isPresent) {
    room.participants = room.participants.filter(
      (participant) => participant.toString() !== userId
    );
  }

  room.participantCount = room.participants.length;

  await room.save();
}

export function initSocket(httpServer: http.Server) {
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
    adapter: createAdapter(redis, subClient),
  });

  // Socket authentication middleware
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error("Authentication token required"));
      }

      const decoded = jwt.verify(token, env.jwtSecret);

      socket.data.user = decoded;

      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  // Socket connection
  io.on("connection", async (socket) => {
    console.log("Socket connected:", socket.id);

    let userId: string;

    try {
      userId = getUserId(socket.data.user);
    } catch (error) {
      console.error("Presence error:", error);
      socket.disconnect();
      return;
    }

    socket.data.joinedRooms = new Set<string>();

    try {
      const user = await User.findById(userId).select(
        "name email profileImage"
      );

      if (!user) {
        socket.disconnect();
        return;
      }

      socket.data.profile = {
        userId,
        name: user.name,
        profileImage: user.profileImage,
      };

      const previousCount = await redis.scard(onlineKey(userId));

      await redis.sadd(onlineKey(userId), socket.id);
      await redis.expire(onlineKey(userId), ONLINE_TTL_SECONDS);

      if (previousCount === 0) {
        await User.updateOne(
          { _id: userId },
          { online: true }
        );
        // Broadcast once per user (multi-tab aware).
        io.emit("user:online", { userId });
      }
    } catch (error) {
      console.error("Connection setup error:", error);
      socket.disconnect();
      return;
    }

    // Join room
    socket.on("room:join", async (roomId: string) => {
      try {
        if (!isValidRoomId(roomId)) {
          socket.emit("room:error", {
            message: "Invalid room ID",
          });
          return;
        }

        socket.join(roomId);
        (socket.data.joinedRooms as Set<string>).add(roomId);

        await redis.sadd(roomKey(roomId), userId);
        await redis.expire(roomKey(roomId), ONLINE_TTL_SECONDS);

        const participantCount = await redis.scard(
          roomKey(roomId)
        );

        await syncRoomMembership(roomId, userId, "join");

        console.log(`${userId} joined room ${roomId}`);
        console.log(`Participant count: ${participantCount}`);

        socket.to(roomId).emit("participant:joined", {
          roomId,
          participant: socket.data.profile,
        });

        io.to(roomId).emit("participant:count", {
          roomId,
          participantCount,
        });

        io.to(roomId).emit("room:status", {
          roomId,
          participantCount,
          message: "Participant joined the room",
        });
      } catch (error) {
        console.error("Room join error:", error);
        socket.emit("room:error", {
          message: "Could not join room",
        });
      }
    });

    // Leave room
    socket.on("room:leave", async (roomId: string) => {
      try {
        if (!isValidRoomId(roomId)) {
          socket.emit("room:error", {
            message: "Invalid room ID",
          });
          return;
        }

        socket.leave(roomId);
        (socket.data.joinedRooms as Set<string>).delete(roomId);

        const afterCount = await redis.srem(
          roomKey(roomId),
          userId
        );

        const participantCount = await redis.scard(
          roomKey(roomId)
        );

        if (afterCount === 1 && participantCount === 0) {
          await syncRoomMembership(roomId, userId, "leave");
        }

        console.log(`${userId} left room ${roomId}`);
        console.log(`Participant count: ${participantCount}`);

        socket.to(roomId).emit("participant:left", {
          roomId,
          participant: socket.data.profile,
        });

        io.to(roomId).emit("participant:count", {
          roomId,
          participantCount,
        });

        io.to(roomId).emit("room:status", {
          roomId,
          participantCount,
          message: "Participant left the room",
        });
      } catch (error) {
        console.error("Room leave error:", error);
        socket.emit("room:error", {
          message: "Could not leave room",
        });
      }
    });

    // Send a message to the room
    socket.on(
      "room:message",
      async (data: { roomId: string; content: string }) => {
        try {
          const message = {
            roomId: data?.roomId,
            content: data?.content,
          };

          if (
            !isValidRoomId(message.roomId ?? "") ||
            typeof message.content !== "string" ||
            message.content.trim().length === 0 ||
            message.content.length > 1000
          ) {
            socket.emit("room:error", {
              message: "Invalid message",
            });
            return;
          }

          if (!socket.rooms.has(message.roomId!)) {
            socket.emit("room:error", {
              message: "Not a member of this room",
            });
            return;
          }

          io.to(message.roomId!).emit("message:new", {
            roomId: message.roomId,
            sender: socket.data.profile,
            content: message.content.trim(),
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          console.error("Room message error:", error);
          socket.emit("room:error", {
            message: "Could not send message",
          });
        }
      }
    );

    // Disconnect
    socket.on("disconnect", async () => {
      try {
        const joinedRooms = socket.data.joinedRooms as Set<string>;

        for (const roomId of joinedRooms) {
          const afterCount = await redis.srem(
            roomKey(roomId),
            userId
          );

          const participantCount = await redis.scard(
            roomKey(roomId)
          );

          if (afterCount === 1 && participantCount === 0) {
            await syncRoomMembership(roomId, userId, "leave");
          }

          socket.to(roomId).emit("participant:left", {
            roomId,
            participant: socket.data.profile,
          });

          io.to(roomId).emit("participant:count", {
            roomId,
            participantCount,
          });

          io.to(roomId).emit("room:status", {
            roomId,
            participantCount,
            message: "Participant left the room",
          });
        }

        const afterDisconnect = await redis.srem(
          onlineKey(userId),
          socket.id
        );

        const stillOnline = await redis.scard(
          onlineKey(userId)
        );

        if (afterDisconnect > 0 && stillOnline === 0) {
          await redis.del(onlineKey(userId));
          await User.updateOne(
            { _id: userId },
            { online: false }
          );
          io.emit("user:offline", { userId });
        }

        console.log(`User ${userId} is offline`);
        console.log("Socket disconnected:", socket.id);
      } catch (error) {
        console.error("Disconnect cleanup error:", error);
      }
    });
  });

  return io;
}