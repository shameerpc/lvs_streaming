# LVS Livestream Backend

REST + Socket.IO + LiveKit backend for a livestreaming application. Handles authentication, user presence, livestream rooms, and real-time audio/video via [LiveKit](https://livekit.io).

## Features

- **Auth** — register/login with bcrypt-hashed passwords, JWT sessions (`7d`)
- **Users** — current-user profile, online/offline status tracked through Redis
- **Livestream rooms** — create (host auto-joins), list active rooms, join/leave, host-leave ends the room; duplicate active room names rejected
- **Presence & chat** — Socket.IO events for join/leave/online/offline/participant counts and room chat, backed by Redis (multi-instance safe)
- **LiveKit** — backend-issued access tokens so clients can publish/subscribe; guests can join, only room participants get tokens; hosts get `roomAdmin`
- **Security** — helmet, CORS, JSON body limit (10kb), per-route rate limiting, zod validation, centralized error handling
- **Ops** — healthcheck endpoint, multi-stage non-root Docker image, docker-compose with healthchecks, GitHub Actions CI

## Tech Stack

| Layer      | Tech                                                    |
| ---------- | ------------------------------------------------------- |
| Runtime    | Node.js 22+, TypeScript 5, Express 5                    |
| Database   | MongoDB (Mongoose 9)                                    |
| Realtime   | Redis 7 (ioredis 6), Socket.IO 4 + Redis adapter        |
| Media      | LiveKit (cloud or self-hosted) via `livekit-server-sdk` |
| Validation | zod                                                      |
| Tests      | Vitest, in-memory Mongo + Redis, `@livekit/rtc-node`    |

## Requirements

- Node.js **22+**
- MongoDB running locally (or via docker-compose)
- Redis running locally (or via docker-compose)
- A LiveKit project (e.g. [LiveKit Cloud](https://livekit.io/cloud)) — credentials only needed if you use the media features

## Quick Start

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev            # http://localhost:5000
```

Check it's alive:

```bash
curl http://localhost:5000/health
# {"success":true,"message":"API is running"}
```

Or run everything with Docker (see [Docker](#docker)):

```bash
docker compose up --build
```

## Environment Variables

| Variable           | Required | Description                                              |
| ------------------ | -------- | -------------------------------------------------------- |
| `PORT`             | Yes      | HTTP port (default `5000` in docker-compose)             |
| `MONGO_URI`        | Yes      | MongoDB connection string                                |
| `REDIS_URL`        | Yes      | Redis connection string                                  |
| `JWT_SECRET`       | Yes      | Secret used to sign JWTs                                 |
| `LIVEKIT_URL`      | No*      | LiveKit server WebSocket URL (e.g. `wss://<project>.livekit.cloud`) |
| `LIVEKIT_API_KEY`  | No*      | LiveKit API key                                          |
| `LIVEKIT_API_SECRET` | No*    | LiveKit API secret                                       |

\* Required only for `/livekit/token` and the LiveKit e2e script. The server boots without them.

## Scripts

| Command                | Description                                   |
| ---------------------- | --------------------------------------------- |
| `npm run dev`          | Run with hot reload (tsx watch)               |
| `npm run build`        | Compile to `dist/`                            |
| `npm start`            | Run compiled output (`node dist/server.js`)   |
| `npm test`             | Unit/integration suite (Vitest)               |
| `npm run lint`         | ESLint                                        |
| `npx tsc --noEmit`     | Type-check                                    |
| `npx tsx test/livekit-e2e.ts` | LiveKit end-to-end media test against a real LiveKit server |

## API Reference

All endpoints return JSON. Protected endpoints require an `Authorization: Bearer <token>` header.
Requests returning a body are validated with zod → `400` on invalid input.

### Auth

**`POST /auth/register`** — `201`

```bash
curl -X POST http://localhost:5000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com","password":"secret123"}'
```

```json
{ "success": true, "message": "User registered successfully",
  "data": { "id": "...", "name": "Alice", "email": "alice@example.com", "profileImage": null, "online": false } }
```

**`POST /auth/login`** — `200` (sets `online: true`)

```bash
curl -X POST http://localhost:5000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"secret123"}'
```

```json
{ "success": true, "message": "Login successful",
  "data": { "token": "<jwt>", "user": { "id": "...", "name": "Alice", "email": "alice@example.com", "online": true } } }
```

Responses: `409` duplicate email, `401` bad credentials.

### Users

**`GET /users/me`** — `200`

```bash
curl http://localhost:5000/users/me -H "Authorization: Bearer <token>"
```

### Rooms

**`POST /rooms`** — `201`, host auto-joins as the first participant. Body: `{ "name": "My Stream" }` (name allows letters, numbers, spaces, `_` and `-`).

```bash
curl -X POST http://localhost:5000/rooms \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"My Stream"}'
```

`409` if an active room with the same name exists.

**`GET /rooms`** — `200`, active rooms, newest first. Returns `{ success, count, data: [...] }`.

**`GET /rooms/:id`** — `200` (`404` if not found, `400` for invalid id).

**`POST /rooms/:id/join`** — `200`, adds caller to participants. `409` if already joined, `400` if the room ended, `404` if missing.

**`POST /rooms/:id/leave`** — `200`. If the caller is the **host**, the room is ended (`status: ended`, participants cleared). Otherwise the caller is removed. `400` if not a participant.

### LiveKit

**`POST /livekit/token`** — `200`, returns an access token for the room.

```bash
curl -X POST http://localhost:5000/livekit/token \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"roomName":"My Stream"}'
```

```json
{ "success": true,
  "data": { "token": "<jwt>", "serverUrl": "wss://...", "roomName": "My Stream", "role": "host" } }
```

- `404` if there is no active room with that name
- `403` if the caller is not a participant of the room
- Host tokens grant `roomJoin + canPublish + canSubscribe + roomAdmin`; guest tokens grant `roomJoin + canPublish + canSubscribe` (host and guests can both publish/subscribe; only the host can administer the room, e.g. mute others)

The token identity is the user's `userId`, so your client can map LiveKit participants back to app users.

## Socket.IO

Connect with the JWT in the auth handshake:

```js
import { io } from "socket.io-client";
const socket = io("http://localhost:5000", {
  auth: { token: "<jwt>" },
  transports: ["websocket"],
});
```

### Client → Server

| Event          | Payload                                        | Description                  |
| -------------- | ---------------------------------------------- | ---------------------------- |
| `room:join`    | `<roomId>` (24-hex ObjectId)                   | Join a room                  |
| `room:leave`   | `<roomId>`                                     | Leave a room                 |
| `room:message` | `{ roomId, content }` (≤1000 chars)            | Send a chat message to a room |

### Server → Client

| Event              | Payload                                                 |
| ------------------ | ------------------------------------------------------- |
| `user:online`      | `{ userId }` — emitted once per user (multi-tab aware)  |
| `user:offline`     | `{ userId }` — when the last socket for a user closes   |
| `participant:joined` | `{ roomId, participant: { userId, name, profileImage } }` |
| `participant:left` | `{ roomId, participant }`                               |
| `participant:count`| `{ roomId, participantCount }`                          |
| `room:status`      | `{ roomId, participantCount, message }`                 |
| `message:new`      | `{ roomId, sender, content, createdAt }`                |
| `room:error`       | `{ message }`                                           |

## LiveKit

This backend only provides **tokens** — it does not proxy media. The flow is:

1. `POST /livekit/token` for a room → get `{ token, serverUrl, roomName, role }`
2. Client connects to `serverUrl` using the **browser** `livekit-client` SDK with that token
3. Publish camera/mic tracks for other participants to subscribe to (like any LiveKit app)

`test/livekit-e2e.ts` proves this end-to-end with two real participants: it spins up the backend in-process (in-memory Mongo/Redis), creates a room, enforces the 403 for non-participants, connects the host and a guest to a real LiveKit server with the `@livekit/rtc-node` SDK, and verifies video and audio are published, subscribed, and *received as frames* (plus presence, join/leave and disconnect handling):

```bash
npm install
# LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set in .env before running
npx tsx test/livekit-e2e.ts
```

## Testing

The Vitest suite is self-contained — it boots **in-memory** MongoDB and Redis (no external services) and runs the full REST + Socket.IO + LiveKit-token flow:

```bash
npm test
```

```
Test Files  1 passed (1)
     Tests 25 passed (25)
```

The LiveKit media e2e (publish/subscribe verification) is a separate script — see [LiveKit](#livekit).

## Docker

A multi-stage, non-root image plus a full compose stack with healthchecks:

```bash
docker compose up --build
```

- `api` → `http://localhost:5000` (healthcheck hits `/health`)
- `mongo` → mongo:8 with a named volume
- `redis` → redis:7-alpine

The API container reads its config from `.env` on the host. Set `MONGO_URI`/`REDIS_URL` to the compose-service names if you run inside the stack (`mongodb://mongo:27017/...`, `redis://redis:6379`).

## CI

[GitHub Actions](.github/workflows/ci.yml) runs lint, type-check, the Vitest suite (with a Redis service container), and a Docker build on push/PR to `main`.

## Project Structure

```
src/
  app.ts                 Express app (security, rate limits, routes, errors)
  server.ts              HTTP + Socket.IO bootstrap
  config/env.ts          Env loading + validation
  controllers/           Route handlers
  routes/                REST routes
  services/livekit.service.ts   AccessToken creation
  middleware/            auth (JWT), zod body/id validation
  models/                Mongoose models (User, Room)
  socket/                Socket.IO server: auth, presence, rooms, chat
  lib/                   mongo & redis clients
  validation/schemas.ts  zod schemas
test/
  backend.test.ts        Vitest suite (25 tests, in-memory Mongo/Redis)
  livekit-e2e.ts         LiveKit end-to-end media test
```