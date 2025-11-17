import express from "express"
import http from "http"
import { Server } from "socket.io"
import { Redis } from '@upstash/redis'
import dotenv from "dotenv"
dotenv.config()

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: "https://chat-bot-ashy-mu.vercel.app/" },
})


const redisClient = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!
})

// Track connected users and admins
const connectedUsers: Record<string, { role: string, userId?: string }> = {} // socketId -> {role, userId}
let adminSockets: Set<string> = new Set()

io.on("connection", async (socket) => {
  const role = (socket.handshake.query.role as string) || "user"
  const userId = (socket.handshake.query.userId as string) || ""
  connectedUsers[socket.id] = { role, userId }

  console.log(`${role} connected: ${socket.id}`, userId)

  // Admin logic
  if (role === "admin") {
    adminSockets.add(socket.id);

    // 🟩 Get currently connected users
    const currentUsers = Object.values(connectedUsers)
      .filter((u) => u.role === "user" && u.userId)
      .map((u) => u.userId);

    // 🟩 Emit current users list to this admin only
    io.to(socket.id).emit("current-users", currentUsers);

    // 🟩 Also send their existing chat history if needed
    const allChats = [];
    for (const userId of currentUsers) {
      const isKicked = await redisClient.get(`user:${userId}:kicked`);
      if (isKicked) continue;

      const messagesRaw = await redisClient.get(`chat:${userId}`) as string;
      const detailsRaw = await redisClient.get(`user:${userId}:details`) as string;
      const unreadRaw = await redisClient.get(`user:${userId}:unreadCount`) as string;
      const unreadCount = unreadRaw ? parseInt(unreadRaw) : 0;

      let messages = [];
      try {
        messages = Array.isArray(messagesRaw)
          ? messagesRaw
          : JSON.parse(messagesRaw || "");
      } catch {
        messages = [];
      }

      let details = null;
      try {
        details = detailsRaw;
      } catch {
        details = {};
      }

      allChats.push({ userId, messages, details, unreadCount });
    }

    // 🟩 Send chat histories to that admin
    socket.emit("all-chats", allChats);

  }


  socket.on("get-all-chats", async () => {
    console.log("all chats calledddd");

    const everyChats = [];

    // get all permanent history keys
    const keys = await redisClient.keys("chat-history:*");

    for (const key of keys) {
      const userId = key.replace("chat-history:", "");

      // Skip kicked users (optional)
      const isKicked = await redisClient.get(`user:${userId}:kicked`);
      if (isKicked) continue;

      // permanent message history
      const historyRaw = await redisClient.get(`chat-history:${userId}`);
      let messages = [];

      try {
        messages = Array.isArray(historyRaw)
          ? historyRaw
          : JSON.parse(historyRaw as string);
      } catch {
        messages = [];
      }

      // user details
      const detailsRaw = await redisClient.get(`user:${userId}:details`);
      let details = null;

      try {
        details = detailsRaw;
      } catch {
        details = {};
      }

      // unread
      const unreadCount = parseInt(
        (await redisClient.get(`user:${userId}:unreadCount`)) || "0"
      );

      everyChats.push({
        userId,
        messages,
        details,
        unreadCount,
      });
    }

    // send back ONLY to this socket
    socket.emit("all-chats-response", everyChats);
  });


  // socket.on("get-all-chats", async () => {
  //   console.log("get all chats called")
  //   const allChats = [];

  //   // find all users who have a chat key
  //   const keys = await redisClient.keys("chat:*");

  //   for (const key of keys) {
  //     const userId = key.replace("chat:", "");

  //     // Skip kicked users (optional)
  //     const isKicked = await redisClient.get(`user:${userId}:kicked`);
  //     if (isKicked) continue;

  //     // messages
  //     const messagesRaw = await redisClient.get(`chat:${userId}`);
  //     let messages = [];
  //     try {
  //       messages = JSON.parse(messagesRaw as string);
  //     } catch {
  //       messages = [];
  //     }

  //     // user details
  //     const detailsRaw = await redisClient.get(`user:${userId}:details`);
  //     let details = {};
  //     try {
  //       details = JSON.parse(detailsRaw as string);
  //     } catch {
  //       details = {};
  //     }

  //     // unread
  //     const unreadCount = parseInt(
  //       (await redisClient.get(`user:${userId}:unreadCount`)) || "0"
  //     );

  //     allChats.push({
  //       userId,
  //       messages,
  //       details,
  //       unreadCount,
  //     });
  //   }

  //   // Send back to the requester only
  //   socket.emit("all-chats-response", allChats);
  // });




  //   socket.on("get-user-details", async (userId) => {
  //   const details = await redisClient.get(`user:${userId}:details`)
  //   if (details) {
  //     io.to(socket.id).emit("user-details", { userId, ...JSON.parse(details as string) })
  //   }
  // })

  socket.on("user-details", async ({ userId, answers }) => {
    if (!userId || !answers) return;

    // Save details directly (not wrapped inside `{ answers }`)
    await redisClient.set(`user:${userId}:details`, JSON.stringify(answers));

    // Broadcast to all admins with the same shape
    adminSockets.forEach((adminId) => {
      io.to(adminId).emit("user-details", { userId, answers });
    });
  });


  // Notify admins when a new user joins
  if (role === "user" && userId) {
    const wasKicked = await redisClient.get(`user:${userId}:kicked`);

    if (wasKicked) {
      // Don’t send any past messages
      console.log(`User ${userId} was kicked — skipping message history`);
    } else {
      // Send past messages only if not kicked
      const stored = await redisClient.get(`chat:${userId}`);
      const pastMessages = Array.isArray(stored) ? stored : [];
      if (pastMessages.length > 0) {
        socket.emit("message-history", pastMessages);
      }
    }
  }

  // Private messaging
  socket.on("private-message", async ({ to, message, name, organization, location, email }) => {
    if (!message) return

    const sender = connectedUsers[socket.id]
    if (!sender) return
    const senderId = sender.userId

    // Determine chat key
    const chatKey = sender.role === "user" ? `chat:${senderId}` : `chat:${to}`
    const prevMessages = await redisClient.get(chatKey)
    const newMessage = { from: sender.role, text: message, timestamp: Date.now(), name, organization, location, email }
    const messages = Array.isArray(prevMessages) ? prevMessages : []
    messages.push(newMessage)
    await redisClient.set(chatKey, JSON.stringify(messages), { ex: 24 * 60 * 60 })

    // Save permanent chat history
    const historyKey = `chat-history:${sender.role === "user" ? senderId : to}`;
    const prevHistory = await redisClient.get(historyKey);
    const historyMessages = Array.isArray(prevHistory) ? prevHistory : [];
    historyMessages.push(newMessage);

    // store permanently (never expires)
    await redisClient.set(historyKey, JSON.stringify(historyMessages));


    // Emit to target
    if (sender.role === "user") {
      const unreadKey = `user:${senderId}:unreadCount`;
      const current = parseInt((await redisClient.get(unreadKey)) || "0");
      await redisClient.set(unreadKey, current + 1);
      adminSockets.forEach(adminId => {
        io.to(adminId).emit("message", { from: senderId, message, name, organization, location, email })
      })
    } else if (sender.role === "admin" && to) {
      // find the socket of the user with that userId
      const targetSocketId = Object.entries(connectedUsers)
        .find(([_, u]) => u.userId === to)?.[0]
      if (targetSocketId) io.to(targetSocketId).emit("message", { from: "admin", message, name, organization, location, email })
    }
  })


  socket.on("reset-unread", async (userId) => {
    console.log("reset", userId)
    await redisClient.set(`user:${userId}:unreadCount`, 0);
  });


  socket.on("disconnect", () => {
    console.log(`${role} disconnected: ${socket.id}`)
    const u = connectedUsers[socket.id]
    if (!u) return
    io.to(socket.id).emit("session-ended");
    console.log("session ended")
    delete connectedUsers[socket.id]

    if (role === "admin") adminSockets.delete(socket.id)
    if (role === "user" && u.userId) {
      adminSockets.forEach(adminId => {
        io.to(adminId).emit("user-left", u.userId)
      })
    }
  })

  socket.on("kick-user", async (userId) => {
    console.log(`${role} kicking: ${userId}`);
    if (!userId) return;

    const socketId = Object.entries(connectedUsers).find(
      ([_, u]) => u.userId === userId
    )?.[0];

    if (!socketId) return;

    // Mark user as kicked in Redis
    await redisClient.set(`user:${userId}:kicked`, "true", { ex: 24 * 60 * 60 }); // kicked flag lasts 1 day

    // Optionally, clear their chat messages
    await redisClient.del(`chat:${userId}`);

    await redisClient.del(`user:${userId}:unreadCount`);

    // Notify and disconnect the user
    io.to(socketId).emit("kicked");
    io.sockets.sockets.get(socketId)?.disconnect(true);

    delete connectedUsers[socketId];
  });


  socket.on('delete-history', async (userId) => {
    if (!userId) return;
    await redisClient.del(`chat-history:${userId}`);
    console.log("chat-history deleted")
  })


  socket.on("user-disconnected", async (userId: string) => {
  console.log("Deleting chat for:", userId);

  await redisClient.del(`chat:${userId}`);
  await redisClient.del(`user:${userId}:details`);
  await redisClient.del(`user:${userId}:unreadCount`);
  
  // optional: mark user offline

  console.log(`Chat deleted for user ${userId}`);
});



})

server.listen(8080, () => console.log("listening on *:8080"))
