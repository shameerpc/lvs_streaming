import { io } from "socket.io-client";

const BASE_URL = "http://localhost:5000";

async function getToken(): Promise<string> {
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "socket-test@example.com",
      password: "test123456",
    }),
  });

  if (loginRes.ok) {
    const body = await loginRes.json();
    return body.data.token;
  }

  await fetch(`${BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Socket Test",
      email: "socket-test@example.com",
      password: "test123456",
    }),
  });

  const loginAgain = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "socket-test@example.com",
      password: "test123456",
    }),
  });

  const body = await loginAgain.json();
  return body.data.token;
}

getToken()
  .then((token) => {
    const socket = io(BASE_URL, {
      auth: { token },
    });

    socket.on("connect", () => {
      console.log("Connected:", socket.id);
    });

    socket.on("connect_error", (error) => {
      console.error("Connection error:", error.message);
    });

    socket.on("disconnect", (reason) => {
      console.log("Disconnected:", reason);
    });

    socket.on("room:status", (data) => {
      console.log("room:status", data);
    });

    socket.emit("room:join", "test-room");

    setTimeout(() => {
      console.log("Closing connection");
      socket.close();
      process.exit(0);
    }, 5000);
  })
  .catch((error) => {
    console.error("Failed to get auth token:", error);
    process.exit(1);
  });