import http from "http";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  LocalVideoTrack,
  Room as RtcRoom,
  RoomEvent as RtcRoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  VideoStream,
} from "@livekit/rtc-node";
import { RoomServiceClient } from "livekit-server-sdk";
import { MongoMemoryServer } from "mongodb-memory-server";
import RedisMemoryServer from "redis-memory-server";
import { io as createClientSocket, type Socket as ClientSocket } from "socket.io-client";
import { env } from "../src/config/env.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(cond: () => Promise<boolean>, ms: number, desc: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await wait(300);
  }
  throw new Error(`Timed out waiting for: ${desc}`);
}

// ---- fake media sources (headless sine wave / solid color frames) ----
function makeAudioSource() {
  const source = new AudioSource(48000, 1);
  const sine = new Int16Array(4800); // 100ms @ 48kHz mono
  for (let i = 0; i < sine.length; i++) {
    sine[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 20000);
  }
  const timer = setInterval(() => {
    source.captureFrame(new AudioFrame(sine, 48000, 1, 4800));
  }, 100);
  return { source, stop: () => clearInterval(timer) };
}

function makeVideoSource(width = 640, height = 480) {
  const source = new VideoSource(width, height);
  const frame = new Uint8Array(width * height * 4); // opaque black RGBA
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const t = (Math.floor(x / 20) + Math.floor(y / 20)) % 2;
      frame[i] = t ? 60 : 200; // B
      frame[i + 1] = t ? 120 : 30; // G
      frame[i + 2] = t ? 30 : 120; // R
      frame[i + 3] = 255; // A
    }
  }
  const timer = setInterval(() => {
    source.captureFrame(new VideoFrame(frame, width, height, VideoBufferType.RGBA));
  }, 100);
  return { source, stop: () => clearInterval(timer) };
}

function connectToken() {
  return new Promise<ClientSocket>((resolve, reject) => {
    const socket = createClientSocket(baseUrl, {
      auth: { token: localSockets.token },
      transports: ["websocket"],
    });
    socket.on("connect", () => {
      resolvedSockets.push(socket);
      resolve(socket);
    });
    socket.on("connect_error", reject);
  });
}

function waitForSocketEvent<T>(
  socket: ClientSocket,
  event: string,
  ms = 8000,
  filter?: (d: T) => boolean
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for socket event "${event}"`));
    }, ms);
    const handler = (data: T) => {
      if (filter && !filter(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });
}

// ---- bootstrap state ----
let mongo: MongoMemoryServer;
let redisServer: RedisMemoryServer;
let server: http.Server;
let baseUrl = "";
const resolvedSockets: ClientSocket[] = [];
const localSockets = { token: "" };

async function register(email: string) {
  const username = email.split("@")[0];
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: username, email, password: "test123456" }),
  });
  await res.json();
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "test123456" }),
  });
  const loginBody = (await login.json()) as {
    data: { token: string; user: { id: string } };
  };
  return { token: loginBody.data.token, id: loginBody.data.user.id };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

let passed = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function report(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  passed += ok ? 1 : 0;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
}

async function main() {
  // ---- start in-process backend ----
  mongo = await MongoMemoryServer.create();
  redisServer = await RedisMemoryServer.create();
  const mongoUri = mongo.getUri();
  const redisPort = Number(await redisServer.getPort());
  process.env.MONGO_URI = mongoUri;
  process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;

  const mongooseDefault = (await import("mongoose")).default;
  await mongooseDefault.connect(mongoUri, { dbName: "lvs_streaming_lk_e2e" });

  const { default: app } = await import("../src/app.js");
  const { initSocket } = await import("../src/socket/socket.js");

  server = http.createServer(app);
  initSocket(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;

  const host = await register(`lk-e2e-host-${Date.now()}@test.com`);
  const guest = await register(`lk-e2e-guest-${Date.now()}@test.com`);
  const outsider = await register(`lk-e2e-out-${Date.now()}@test.com`);
  const roomName = `LIVEKIT E2E ${Date.now()}`;

  // create + host auto-join
  const createRes = await fetch(`${baseUrl}/rooms`, {
    method: "POST",
    headers: { ...auth(host.token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: roomName }),
  });
  const created = (await createRes.json()) as { data: { _id: string } };
  const roomId = created.data._id;

  const joinGuest = await fetch(`${baseUrl}/rooms/${roomId}/join`, {
    method: "POST",
    headers: { ...auth(guest.token) },
  });
  report("REST guest joined room", joinGuest.status === 200, `status ${joinGuest.status}`);

  // permission: outsider cannot get a token
  const outsiderTokenRes = await fetch(`${baseUrl}/livekit/token`, {
    method: "POST",
    headers: { ...auth(outsider.token), "Content-Type": "application/json" },
    body: JSON.stringify({ roomName }),
  });
  report(
    "Non-participant token request rejected",
    outsiderTokenRes.status === 403,
    `status ${outsiderTokenRes.status}`
  );

  // host token
  const hostTokRes = await fetch(`${baseUrl}/livekit/token`, {
    method: "POST",
    headers: { ...auth(host.token), "Content-Type": "application/json" },
    body: JSON.stringify({ roomName }),
  });
  const hostTok = (await hostTokRes.json()) as { data: { token: string; role: string } };
  // guest token
  const guestTokRes = await fetch(`${baseUrl}/livekit/token`, {
    method: "POST",
    headers: { ...auth(guest.token), "Content-Type": "application/json" },
    body: JSON.stringify({ roomName }),
  });
  const guestTok = (await guestTokRes.json()) as { data: { token: string; role: string } };

  // token claim assertions
  const decode = (t: string) =>
    JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")) as {
      name?: string;
      video?: {
        room?: string;
        roomJoin?: boolean;
        canPublish?: boolean;
        canSubscribe?: boolean;
        roomAdmin?: boolean;
      };
    };
  const hc = decode(hostTok.data.token);
  const gc = decode(guestTok.data.token);
  report(
    "Host token grants (roomJoin, publish, subscribe, admin)",
    !!hc.video?.roomJoin && !!hc.video?.canPublish && !!hc.video?.canSubscribe && !!hc.video?.roomAdmin,
    `room=${hc.video?.room}`
  );
  report(
    "Guest token grants (roomJoin, publish, subscribe, no admin)",
    !!gc.video?.roomJoin && !!gc.video?.canPublish && !!gc.video?.canSubscribe && gc.video?.roomAdmin !== true
  );
  report("Roles (host vs participant)", hostTok.data.role === "host" && guestTok.data.role === "participant");

  const roomService = new RoomServiceClient(
    env.livekitUrl.replace("wss://", "https://"),
    env.livekitApiKey,
    env.livekitApiSecret
  );

  // ---- SOCKET.IO presence around LiveKit ----
  localSockets.token = host.token;
  const socketHost = await connectToken();

  const onlineEvt = waitForSocketEvent<{ userId: string }>(
    socketHost,
    "user:online",
    8000,
    (d) => d.userId === guest.id
  );
  localSockets.token = guest.token;
  const socketGuest = await connectToken();
  const online = await onlineEvt;
  report("Presence: user:online broadcast to existing member", online.userId === guest.id);

  // host joins, then guest joins -> count reaches 2 for both members
  socketHost.emit("room:join", roomId);
  await waitForSocketEvent<{ participantCount: number }>(socketHost, "participant:count");

  const countEvt = waitForSocketEvent<{ participantCount: number }>(
    socketHost,
    "participant:count",
    8000,
    (d) => d.participantCount === 2
  );
  socketGuest.emit("room:join", roomId);
  const count = await countEvt;
  report("Socket participant:count across both members", count.participantCount === 2, `count=${count.participantCount}`);

  // ---- LiveKit: two real media participants (official Node SDK) ----
  const roomA = new RtcRoom();
  const roomB = new RtcRoom();

  const subFailA: string[] = [];
  const subFailB: string[] = [];
  roomA.on(RtcRoomEvent.TrackSubscriptionFailed, (_sid, reason) => subFailA.push(reason ?? "unknown"));
  roomB.on(RtcRoomEvent.TrackSubscriptionFailed, (_sid, reason) => subFailB.push(reason ?? "unknown"));

  await roomA.connect(env.livekitUrl, hostTok.data.token);
  report("Host A connected to LiveKit", roomA.isConnected);
  await roomB.connect(env.livekitUrl, guestTok.data.token);
  report("Guest B connected to LiveKit", roomB.isConnected);

  // both see each other as remote participants
  await settle(
    () => Promise.resolve(roomA.remoteParticipants.size === 1 && roomB.remoteParticipants.size === 1),
    15000,
    "remote participants visible to each other"
  );
  report("Presence: LiveKit participants see each other", roomA.remoteParticipants.size === 1 && roomB.remoteParticipants.size === 1);

  // A (host) publishes audio + video; B (guest) publishes audio
  const audioA = makeAudioSource();
  const videoA = makeVideoSource();
  const audioB = makeAudioSource();
  await roomA.localParticipant!.publishTrack(
    LocalAudioTrack.createAudioTrack("mic-a", audioA.source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
  );
  await roomA.localParticipant!.publishTrack(
    LocalVideoTrack.createVideoTrack("cam-a", videoA.source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA })
  );
  await roomB.localParticipant!.publishTrack(
    LocalAudioTrack.createAudioTrack("mic-b", audioB.source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
  );

  const remotePubs = (room: RtcRoom) => {
    const out: { kind: number; subscribed: boolean; track: unknown }[] = [];
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        out.push({ kind: pub.kind ?? -1, subscribed: pub.subscribed, track: pub.track });
      }
    }
    return out;
  };

  // B must receive A's video (client-side subscription + actual media frames)
  let bVideo: { subscribed: boolean; track: unknown } | undefined;
  try {
    await settle(
      () =>
        Promise.resolve(
          (bVideo = remotePubs(roomB).find((x) => x.kind === TrackKind.KIND_VIDEO && x.subscribed && x.track)) !== undefined
        ),
      30000,
      "B subscribed to A's video track"
    );
  } catch {
    bVideo = remotePubs(roomB).find((x) => x.kind === TrackKind.KIND_VIDEO);
  }

  let bVideoFrames = 0;
  if (bVideo?.track) {
    const videoFeed = new VideoStream(bVideo.track as never).getReader();
    (async () => {
      for (;;) {
        const { done } = await videoFeed.read();
        if (done) break;
        bVideoFrames++;
      }
    })().catch(() => undefined);
    try {
      await settle(() => Promise.resolve(bVideoFrames > 3), 20000, "B receives video frames");
    } catch {
      /* reported below */
    }
  }
  report(
    "A published video; B received remote video track",
    !!bVideo?.subscribed && bVideoFrames > 3,
    `subscribed=${bVideo?.subscribed}, frames=${bVideoFrames}`
  );

  // A must receive B's audio (client-side subscription + actual media frames)
  let aAudio: { subscribed: boolean; track: unknown } | undefined;
  try {
    await settle(
      () =>
        Promise.resolve(
          (aAudio = remotePubs(roomA).find((x) => x.kind === TrackKind.KIND_AUDIO && x.subscribed && x.track)) !== undefined
        ),
      30000,
      "A subscribed to B's audio track"
    );
  } catch {
    aAudio = remotePubs(roomA).find((x) => x.kind === TrackKind.KIND_AUDIO);
  }

  let aAudioFrames = 0;
  if (aAudio?.track) {
    const audioFeed = new AudioStream(aAudio.track as never).getReader();
    (async () => {
      for (;;) {
        const { done } = await audioFeed.read();
        if (done) break;
        aAudioFrames++;
      }
    })().catch(() => undefined);
    try {
      await settle(() => Promise.resolve(aAudioFrames > 3), 20000, "A receives audio frames");
    } catch {
      /* reported below */
    }
  }
  report(
    "B published audio; A received remote audio track",
    !!aAudio?.subscribed && aAudioFrames > 3,
    `subscribed=${aAudio?.subscribed}, frames=${aAudioFrames}`
  );

  if (!bVideo?.subscribed && subFailB.length) {
    console.log("B subscription failures:", subFailB);
  }
  if (!aAudio?.subscribed && subFailA.length) {
    console.log("A subscription failures:", subFailA);
  }

  // server-side confirmation of published tracks
  const participants = await roomService.listParticipants(roomName);
  const pubSids = participants.flatMap((p) => [...Array.from(p.tracks ?? [], (t) => t.sid)]);
  report(
    "LiveKit SFU lists both participants with published tracks",
    participants.length === 2 && pubSids.length >= 3,
    `participants=${participants.length}, trackSids=${pubSids.length}`
  );

  // B disconnects -> SFU should reflect 1 participant
  await roomB.disconnect();
  await settle(
    async () => (await roomService.listParticipants(roomName)).length === 1,
    15000,
    "guest leave reflected on SFU"
  );
  report("Disconnect: B left, SFU shows 1 participant", true);

  const offlineEvt = waitForSocketEvent<{ userId: string }>(socketHost, "user:offline", 8000);
  const countAfter = waitForSocketEvent<{ participantCount: number }>(
    socketHost,
    "participant:count",
    8000,
    (d) => d.participantCount === 1
  );
  socketGuest.disconnect();
  const offline = await offlineEvt;
  report("Disconnect: user:offline broadcast on socket disconnect", offline.userId === guest.id);

  const count1 = await countAfter;
  report("Disconnect: participant count back to 1", count1.participantCount === 1);

  // A joins room via socket, then fully leaves (LiveKit + socket)
  socketHost.emit("room:leave", roomId);
  await wait(1000);
  await roomA.disconnect();
  await settle(
    async () => (await roomService.listParticipants(roomName)).length === 0,
    15000,
    "host leave reflected on SFU"
  );
  report("Disconnect: A left, SFU shows 0 participants", true);

  // join/leave via REST still consistent
  const restLeave = await fetch(`${baseUrl}/rooms/${roomId}/leave`, {
    method: "POST",
    headers: { ...auth(host.token) },
  });
  report("REST leave (host ends room)", restLeave.status === 200);
  const endState = await fetch(`${baseUrl}/rooms/${roomId}`, {
    method: "GET",
    headers: { ...auth(host.token) },
  });
  const endedRoom = (await endState.json()) as { data: { status: string } };
  report("Host leave ended the room (status=ended)", endedRoom.data.status === "ended");

  // cleanup
  audioA.stop();
  videoA.stop();
  audioB.stop();
  for (const s of resolvedSockets) s.disconnect();
  await mongooseDefault.disconnect();

  const failures = results.filter((r) => !r.ok);
  console.log(`\n===== LIVEKIT E2E: ${passed}/${results.length} passed =====`);
  if (failures.length) {
    console.log("FAILED:");
    for (const f of failures) console.log(`  - ${f.name}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E ERROR:", e);
  for (const s of resolvedSockets) s.disconnect();
  process.exit(1);
});