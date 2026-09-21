import { z } from "zod";

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters")
    .max(128, "Password must be at most 128 characters"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const createRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Room name is required")
    .max(50, "Room name must be at most 50 characters")
    .regex(
      /^[a-zA-Z0-9 _-]+$/,
      "Room name can only contain letters, numbers, spaces, underscores and hyphens"
    ),
});

export const livekitTokenSchema = z.object({
  roomName: z
    .string()
    .trim()
    .min(1, "roomName is required")
    .max(64, "roomName must be at most 64 characters")
    .regex(
      /^[a-zA-Z0-9 _-]+$/,
      "roomName can only contain letters, numbers, spaces, underscores and hyphens"
    ),
});

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Invalid ID format");