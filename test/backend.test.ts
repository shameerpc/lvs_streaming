import http from "http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import RedisMemoryServer from "redis-memory-server";
import { io as createSocket, Socket } from "socket.io-client";

const mongooseModule = () => import("mongoose");

type AppModule = typeof import("../src/app.js");
type SocketModule = typeof import("../src/socket/socket.js");
type RedisModule = typeof import("../src/lib/redis.js");

let mongo: MongoMemoryServer;
let redisServer: RedisMemoryServer;
let server: http.Server;
let baseUrl = "";

let app: AppModule["default"];
let initSocket: SocketModule["initSocket"];
let redis: RedisModule["redis"];

const clientSockets: Socket[] = [];

async function registerUser(email: string): Promise<{
  email: string;
  password: string;
  token: string;
  id: string;
}> {
  const password = "test123456";

  const res = await request(server)
    .post("/auth/register")
    .send({ name: email.split("@")[0], email, password })
    .expect(201);

  const loginRes = await request(server)
    .post("/auth/login")
    .send({ email, password })
    .expect(200);

  return {
    email,
    password,
    token: loginRes.body.data.token,
    id: res.body.data.id,
  };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(baseUrl, {
      auth: { token },
      transports: ["websocket"],
    });

    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

function waitFor<T>(
  socket: Socket,
  event: string,
  timeoutMs = 5000,
  filter?: (data: T) => boolean
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for event "${event}"`));
    }, timeoutMs);

    const handler = (data: T) => {
      if (filter && !filter(data)) {
        return;
      }
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };

    socket.on(event, handler);
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  redisServer = await RedisMemoryServer.create();

  const mongoUri = mongo.getUri();
  const redisHost = await redisServer.getHost();
  const redisPort = Number(await redisServer.getPort());

  process.env.MONGO_URI = mongoUri;
  process.env.REDIS_URL = `redis://${redisHost}:${redisPort}`;

  const mongooseDefault = await mongooseModule();
  await mongooseDefault.default.connect(mongoUri, {
    dbName: "lvs_streaming_test",
  });

  app = (await import("../src/app.js")).default;
  initSocket = (await import("../src/socket/socket.js")).initSocket;
  redis = (await import("../src/lib/redis.js")).redis;

  server = http.createServer(app);
  initSocket(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (typeof address === "object" && address !== null) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  } else {
    throw new Error("Server failed to allocate a port");
  }

  await redis.ping();
});

afterAll(async () => {
  for (const socket of clientSockets) {
    socket.disconnect();
  }
  clientSockets.length = 0;

  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });

  const mongooseDefault = await import("mongoose");
  await mongooseDefault.default.disconnect();
  redis?.disconnect();
  await mongo?.stop();
  await redisServer?.stop();
});

describe("AUTH", () => {
  it("registers a user and never returns the password hash", async () => {
    const email = `auth-register-${Date.now()}@test.com`;

    const res = await request(server)
      .post("/auth/register")
      .send({ name: "Test User", email, password: "test123456" })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(email);
    expect(res.body.data.online).toBe(false);
    expect(JSON.stringify(res.body.data)).not.toContain(`"password"`);
    expect(res.body.data.id).toBeDefined();
  });

  it("returns 409 for a duplicate email", async () => {
    const email = `auth-dupe-${Date.now()}@test.com`;

    await request(server)
      .post("/auth/register")
      .send({ name: "First", email, password: "test123456" })
      .expect(201);

    const res = await request(server)
      .post("/auth/register")
      .send({ name: "Second", email, password: "test123456" })
      .expect(409);

    expect(res.body.message).toBe("Email already registered");
  });

  it("returns 400 for an invalid email", async () => {
    const res = await request(server)
      .post("/auth/register")
      .send({ name: "Bad", email: "not-an-email", password: "test123456" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 400 for a short password", async () => {
    const res = await request(server)
      .post("/auth/register")
      .send({ name: "Short", email: `short-${Date.now()}@test.com`, password: "123" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("logs in and returns a JWT", async () => {
    const email = `login-${Date.now()}@test.com`;

    await registerUser(email);

    const res = await request(server)
      .post("/auth/login")
      .send({ email, password: "test123456" })
      .expect(200);

    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.token.split(".")).toHaveLength(3);
  });

  it("returns 401 for invalid credentials", async () => {
    const email = `badpwd-${Date.now()}@test.com`;

    await registerUser(email);

    const res = await request(server)
      .post("/auth/login")
      .send({ email, password: "wrongpassword" })
      .expect(401);

    expect(res.body.message).toBe("Invalid email or password");
  });
});

describe("USERS", () => {
  it("GET /users/me works with a valid token and hides password", async () => {
    const user = await registerUser(`me-${Date.now()}@test.com`);

    const res = await request(server)
      .get("/users/me")
      .set(auth(user.token))
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(user.email);
    expect(JSON.stringify(res.body.data)).not.toContain(`"password"`);
  });

  it("GET /users/me returns 401 without a token", async () => {
    const res = await request(server).get("/users/me").expect(401);

    expect(res.body.message).toBe("Authentication required");
  });

  it("GET /users/me returns 401 for a malformed token", async () => {
    const res = await request(server)
      .get("/users/me")
      .set(auth("garbage.token.value"))
      .expect(401);

    expect(res.body.message).toBe("Invalid or expired token");
  });
});

describe("ROOMS", () => {
  it("creates a room with host auto-joined and participantCount 1", async () => {
    const user = await registerUser(`room-host-${Date.now()}@test.com`);

    const res = await request(server)
      .post("/rooms")
      .set(auth(user.token))
      .send({ name: "Live Room A" })
      .expect(201);

    expect(String(res.body.data.host._id ?? res.body.data.host)).toBe(
      user.id
    );
    expect(res.body.data.participantCount).toBe(1);
    expect(res.body.data.status).toBe("active");
    expect(res.body.data.createdAt).toBeDefined();
    expect(
      res.body.data.participants.some(
        (p: { _id: string }) => p._id.toString() === user.id
      )
    ).toBe(true);
  });

  it("rejects duplicate active room names", async () => {
    const host = await registerUser(`room-dupe-${Date.now()}@test.com`);

    const name = `Dupe Room ${Date.now()}`;

    await request(server)
      .post("/rooms")
      .set(auth(host.token))
      .send({ name })
      .expect(201);

    const res = await request(server)
      .post("/rooms")
      .set(auth(host.token))
      .send({ name })
      .expect(409);

    expect(res.body.message).toBe("Room name already in use");
  });

  it("rejects room creation without authentication", async () => {
    const res = await request(server)
      .post("/rooms")
      .send({ name: "No Auth Room" })
      .expect(401);

    expect(res.body.success).toBe(false);
  });

  it("rejects invalid room names", async () => {
    const user = await registerUser(`room-badname-${Date.now()}@test.com`);

    const res = await request(server)
      .post("/rooms")
      .set(auth(user.token))
      .send({ name: "Bad!Name;;" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("lists active rooms", async () => {
    const user = await registerUser(`room-list-${Date.now()}@test.com`);

    await request(server)
      .post("/rooms")
      .set(auth(user.token))
      .send({ name: `Listable ${Date.now()}` })
      .expect(201);

    const res = await request(server)
      .get("/rooms")
      .set(auth(user.token))
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.count).toBeGreaterThan(0);
  });

  it("returns 400 for an invalid ObjectId", async () => {
    const user = await registerUser(`room-badid-${Date.now()}@test.com`);

    const res = await request(server)
      .get("/rooms/not-a-valid-id")
      .set(auth(user.token))
      .expect(400);

    expect(res.body.message).toBe("Invalid room ID");
  });

  it("returns 404 for an unknown room", async () => {
    const user = await registerUser(`room-404-${Date.now()}@test.com`);

    const res = await request(server)
      .get(`/rooms/${new mongoose.Types.ObjectId().toHexString()}`)
      .set(auth(user.token))
      .expect(404);

    expect(res.body.success).toBe(false);
  });

  it("join/duplicate-join/leave lifecycle is correct", async () => {
    const host = await registerUser(`life-host-${Date.now()}@test.com`);
    const guest = await registerUser(`life-guest-${Date.now()}@test.com`);

    const createRes = await request(server)
      .post("/rooms")
      .set(auth(host.token))
      .send({ name: `Lifecycle ${Date.now()}` })
      .expect(201);

    const roomId = createRes.body.data._id;

    const joinRes = await request(server)
      .post(`/rooms/${roomId}/join`)
      .set(auth(guest.token))
      .expect(200);

    expect(joinRes.body.data.participantCount).toBe(2);

    const dupeRes = await request(server)
      .post(`/rooms/${roomId}/join`)
      .set(auth(guest.token))
      .expect(409);

    expect(dupeRes.body.message).toBe("User already joined this room");

    const leaveRes = await request(server)
      .post(`/rooms/${roomId}/leave`)
      .set(auth(guest.token))
      .expect(200);

    expect(leaveRes.body.data.participantCount).toBe(1);

    const notParticipantRes = await request(server)
      .post(`/rooms/${roomId}/leave`)
      .set(auth(guest.token))
      .expect(400);

    expect(notParticipantRes.body.message).toBe("User is not a participant");
  });

  it("rejects joining an ended room", async () => {
    const host = await registerUser(`end-host-${Date.now()}@test.com`);
    const guest = await registerUser(`end-guest-${Date.now()}@test.com`);

    const createRes = await request(server)
      .post("/rooms")
      .set(auth(host.token))
      .send({ name: `Ended ${Date.now()}` })
      .expect(201);

    const roomId = createRes.body.data._id;

    await request(server)
      .post(`/rooms/${roomId}/leave`)
      .set(auth(host.token))
      .expect(200);

    const res = await request(server)
      .post(`/rooms/${roomId}/join`)
      .set(auth(guest.token))
      .expect(400);

    expect(res.body.message).toBe("Room is no longer active");
  });
});

describe("LIVEKIT", () => {
  it("requires authentication", async () => {
    const res = await request(server)
      .post("/livekit/token")
      .send({ roomName: "Room X" })
      .expect(401);

    expect(res.body.success).toBe(false);
  });

  it("rejects an invalid roomName", async () => {
    const user = await registerUser(`lk-bad-${Date.now()}@test.com`);

    const res = await request(server)
      .post("/livekit/token")
      .set(auth(user.token))
      .send({ roomName: "Invalid!Name@@" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 404 for a room that does not exist", async () => {
    const user = await registerUser(`lk-404-${Date.now()}@test.com`);

    const res = await request(server)
      .post("/livekit/token")
      .set(auth(user.token))
      .send({ roomName: "Missing Room" })
      .expect(404);

    expect(res.body.message).toBe("Room not found");
  });

  it("rejects LiveKit tokens for users who are not participants", async () => {
    const host = await registerUser(`lk-nonmember-host-${Date.now()}@test.com`);
    const outsider = await registerUser(
      `lk-nonmember-out-${Date.now()}@test.com`
    );

    const roomName = `LiveKit Nonmember ${Date.now()}`;

    const createRes = await request(server)
      .post("/rooms")
      .set(auth(host.token))
      .send({ name: roomName })
      .expect(201);

    const roomId = createRes.body.data._id;

    const outsiderRes = await request(server)
      .post("/livekit/token")
      .set(auth(outsider.token))
      .send({ roomName })
      .expect(403);

    expect(outsiderRes.body.message).toBe(
      "You are not a participant of this room"
    );

    const hostRes = await request(server)
      .post("/livekit/token")
      .set(auth(host.token))
      .send({ roomName })
      .expect(200);

    expect(hostRes.body.data.role).toBe("host");

    await request(server)
      .post(`/rooms/${roomId}/join`)
      .set(auth(outsider.token))
      .expect(200);

    const joinedRes = await request(server)
      .post("/livekit/token")
      .set(auth(outsider.token))
      .send({ roomName })
      .expect(200);

    expect(joinedRes.body.data.role).toBe("participant");
  });

  it("returns a host token for the room owner and a participant token for others", async () => {
    const host = await registerUser(`lk-host-${Date.now()}@test.com`);
    const guest = await registerUser(`lk-guest-${Date.now()}@test.com`);

    const roomName = `LiveKit Room ${Date.now()}`;

    const createRes = await request(server)
      .post("/rooms")
      .set(auth(host.token))
      .send({ name: roomName })
      .expect(201);

    await request(server)
      .post(`/rooms/${createRes.body.data._id}/join`)
      .set(auth(guest.token))
      .expect(200);

    const hostRes = await request(server)
      .post("/livekit/token")
      .set(auth(host.token))
      .send({ roomName })
      .expect(200);

    expect(hostRes.body.data.role).toBe("host");
    expect(hostRes.body.data.token).toBeDefined();
    expect(hostRes.body.data.token.split(".")).toHaveLength(3);
    expect(hostRes.body.data.roomName).toBe(roomName);
    expect(hostRes.body.data.serverUrl).toBeDefined();

    const guestRes = await request(server)
      .post("/livekit/token")
      .set(auth(guest.token))
      .send({ roomName })
      .expect(200);

    expect(guestRes.body.data.role).toBe("participant");
    expect(guestRes.body.data.token).toBeDefined();
    expect(JSON.stringify(guestRes.body.data)).not.toContain("livekitApiSecret");
  });
});

describe("SOCKET.IO", () => {
  it("rejects a socket connection without a token", async () => {
    const socket = createSocket(baseUrl, { transports: ["websocket"] });

    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => {
        reject(new Error("Expected connection to be rejected"));
      });
      socket.on("connect_error", () => resolve());
    });

    socket.disconnect();
  });

  it("handles presence, rooms, participant counts and messaging", async () => {
    const roomId = new mongoose.Types.ObjectId().toHexString();
    const userA = await registerUser(`socket-a-${Date.now()}@test.com`);
    const userB = await registerUser(`socket-b-${Date.now()}@test.com`);

    const socketA = await connectSocket(userA.token);
    clientSockets.push(socketA);

    // B connecting should broadcast user:online to already-connected A.
    // (A also receives its own user:online event; filter it out.)
    const bOnline = waitFor<{ userId: string }>(
      socketA,
      "user:online",
      5000,
      (data) => data.userId !== userA.id
    );
    const socketB = await connectSocket(userB.token);
    clientSockets.push(socketB);

    const online = await bOnline;
    expect(online.userId).toBe(userB.id);

    // A joins the room first.
    socketA.emit("room:join", roomId);
    await waitFor<{ participantCount: number }>(socketA, "participant:count");

    // B joins: A should observe participant:joined and a count of 2.
    const joinedA = waitFor<{
      roomId: string;
      participant: { userId: string };
    }>(socketA, "participant:joined");
    const countForA = waitFor<{
      roomId: string;
      participantCount: number;
    }>(socketA, "participant:count");

    socketB.emit("room:join", roomId);

    const joined = await joinedA;
    expect(joined.participant.userId).toBe(userB.id);

    const countA = await countForA;
    expect(countA.participantCount).toBe(2);

    // Redis room set contains exactly the two unique users.
    await expect
      .poll(() => redis.scard(`room:${roomId}:participants`), {
        timeout: 3000,
      })
      .toBe(2);

    // Duplicate joins do not inflate the Redis count.
    socketA.emit("room:join", roomId);
    await expect
      .poll(() => redis.scard(`room:${roomId}:participants`), {
        timeout: 3000,
      })
      .toBe(2);

    // Messaging.
    const msgFromA = waitFor<{
      roomId: string;
      sender: { userId: string };
      content: string;
    }>(socketA, "message:new");

    socketB.emit("room:message", { roomId, content: "hello from B" });

    const msg = await msgFromA;
    expect(msg.content).toBe("hello from B");
    expect(msg.sender.userId).toBe(userB.id);

    // Non-member messaging is rejected.
    const errorFromB = waitFor<{ message: string }>(socketB, "room:error");
    socketB.emit("room:message", {
      roomId: new mongoose.Types.ObjectId().toHexString(),
      content: "not allowed",
    });
    const err = await errorFromB;
    expect(err.message).toContain("Not a member");

    // Disconnect cleanup: A sees B leave the room and go offline.
    const leftEvent = waitFor<{ participant: { userId: string } }>(
      socketA,
      "participant:left"
    );
    const offlineEvent = waitFor<{ userId: string }>(socketA, "user:offline");

    socketB.disconnect();

    const leftPayload = await leftEvent;
    expect(leftPayload.participant.userId).toBe(userB.id);

    const offline = await offlineEvent;
    expect(offline.userId).toBe(userB.id);

    await expect
      .poll(() => redis.scard(`room:${roomId}:participants`), {
        timeout: 3000,
      })
      .toBe(1);

    await expect
      .poll(() => redis.get(`online:${userB.id}`), { timeout: 3000 })
      .toBeNull();

    socketA.disconnect();
    clientSockets.length = 0;
  });
});