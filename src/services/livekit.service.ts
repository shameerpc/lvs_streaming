import { AccessToken } from "livekit-server-sdk";
import { env } from "../config/env.js";

export async function createLiveKitToken(
  userId: string,
  roomName: string,
  role: "host" | "participant"
) {
  const token = new AccessToken(
    env.livekitApiKey,
    env.livekitApiSecret,
    {
      identity: userId,
      ttl: "1h",
    }
  );

  if (role === "host") {
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      roomAdmin: true,
    });
  } else {
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });
  }

  return await token.toJwt();
}