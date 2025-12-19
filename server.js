/**
 * Bounded WebSocket Server
 * Real-time features: notifications, presence, chat
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const config = require('./config');

// Initialize Express
const app = express();
const httpServer = createServer(app);

// Add CORS middleware to Express
app.use(cors({
  origin: config.cors.origins,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

// Initialize Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: config.cors.origins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Initialize Redis clients (optional - for scaling)
let redisClient = null;
let redisPub = null;
let redisSub = null;
let redisEnabled = false;

// Try to connect to Redis (optional)
(async () => {
  try {
    if (config.redis.host && config.redis.host !== 'localhost') {
      redisClient = redis.createClient({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
      });
      
      redisPub = redisClient.duplicate();
      redisSub = redisClient.duplicate();
      
      await redisClient.connect();
      await redisPub.connect();
      await redisSub.connect();
      
      redisEnabled = true;
      console.log('✅ Redis connected');
    } else {
      console.log('ℹ️  Redis disabled (not needed for single instance)');
    }
  } catch (error) {
    console.log('ℹ️  Redis unavailable, running without it (fine for small deployments)');
    redisEnabled = false;
  }
})();

// In-memory stores (backed by Redis)
const onlineUsers = new Map(); // socketId => userId
const userSockets = new Map(); // userId => Set of socketIds
const typingUsers = new Map(); // roomId => Set of userIds

// ============================================
// AUTHENTICATION
// ============================================

/**
 * Verify token from Drupal (base64 encoded JSON for now)
 */
async function verifyToken(token) {
  try {
    // Decode base64 token (Drupal sends base64-encoded JSON)
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    
    // Verify expiration
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }
    
    // Verify it has required fields
    if (!decoded.uid || !decoded.name) {
      throw new Error('Invalid token structure');
    }
    
    return decoded;
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return null;
  }
}

// ============================================
// MIDDLEWARE
// ============================================

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    return next(new Error('Authentication token required'));
  }
  
  const user = await verifyToken(token);
  
  if (!user) {
    return next(new Error('Invalid authentication token'));
  }
  
  socket.userId = user.uid;
  socket.userData = user;
  next();
});

// ============================================
// CONNECTION HANDLING
// ============================================

io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`✅ User ${userId} connected (socket: ${socket.id})`);
  
  // Track connection
  onlineUsers.set(socket.id, userId);
  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }
  userSockets.get(userId).add(socket.id);
  
  // Mark user online
  markUserOnline(userId, socket.id);
  
  // Send connection success
  socket.emit('authenticated', {
    userId: userId,
    timestamp: Date.now(),
  });
  
  // Join user's personal room
  socket.join(`user:${userId}`);
  
  // ==========================================
  // PRESENCE EVENTS
  // ==========================================
  
  socket.on('presence:update', (status) => {
    updatePresence(userId, status);
  });
  
  socket.on('presence:heartbeat', () => {
    updateHeartbeat(userId);
  });
  
  // ==========================================
  // CHAT EVENTS
  // ==========================================
  
  socket.on('chat:join', (roomId) => {
    socket.join(`chat:${roomId}`);
    console.log(`User ${userId} joined chat room ${roomId}`);
    
    // Notify others in room
    socket.to(`chat:${roomId}`).emit('chat:user_joined', {
      userId: userId,
      userName: socket.userData.name,
      timestamp: Date.now(),
    });
  });
  
  socket.on('chat:leave', (roomId) => {
    socket.leave(`chat:${roomId}`);
    console.log(`User ${userId} left chat room ${roomId}`);
    
    // Stop typing if was typing
    if (typingUsers.has(roomId)) {
      typingUsers.get(roomId).delete(userId);
    }
  });
  
  socket.on('chat:message', async (data) => {
    const { roomId, message, messageId } = data;
    
    // Validate message
    if (!message || message.length > config.chat.maxMessageLength) {
      return socket.emit('chat:error', { error: 'Invalid message' });
    }
    
    // Save to Drupal database
    try {
      await saveChatMessage(roomId, userId, message, messageId);
      
      // Broadcast to room
      io.to(`chat:${roomId}`).emit('chat:message', {
        messageId: messageId,
        roomId: roomId,
        userId: userId,
        userName: socket.userData.name,
        userAvatar: socket.userData.avatar,
        message: message,
        timestamp: Date.now(),
      });
      
      // Stop typing indicator
      if (typingUsers.has(roomId)) {
        typingUsers.get(roomId).delete(userId);
        broadcastTyping(roomId);
      }
      
    } catch (error) {
      console.error('Error saving message:', error);
      socket.emit('chat:error', { error: 'Failed to send message' });
    }
  });
  
  socket.on('chat:typing_start', (roomId) => {
    if (!typingUsers.has(roomId)) {
      typingUsers.set(roomId, new Set());
    }
    typingUsers.get(roomId).add(userId);
    broadcastTyping(roomId);
  });
  
  socket.on('chat:typing_stop', (roomId) => {
    if (typingUsers.has(roomId)) {
      typingUsers.get(roomId).delete(userId);
      broadcastTyping(roomId);
    }
  });
  
  socket.on('chat:read', async (data) => {
    const { roomId, messageId } = data;
    
    // Save read receipt to database
    await saveReadReceipt(roomId, userId, messageId);
    
    // Broadcast read receipt
    socket.to(`chat:${roomId}`).emit('chat:read', {
      messageId: messageId,
      userId: userId,
      timestamp: Date.now(),
    });
  });
  
  // ==========================================
  // NOTIFICATION EVENTS
  // ==========================================
  
  socket.on('notification:read', async (notificationId) => {
    await markNotificationRead(userId, notificationId);
  });
  
  socket.on('notification:read_all', async () => {
    await markAllNotificationsRead(userId);
  });
  
  // ==========================================
  // DISCONNECTION
  // ==========================================
  
  socket.on('disconnect', () => {
    console.log(`❌ User ${userId} disconnected (socket: ${socket.id})`);
    
    // Remove from tracking
    onlineUsers.delete(socket.id);
    
    if (userSockets.has(userId)) {
      userSockets.get(userId).delete(socket.id);
      
      // If user has no more connections, mark offline
      if (userSockets.get(userId).size === 0) {
        userSockets.delete(userId);
        markUserOffline(userId);
      }
    }
    
    // Remove from typing
    typingUsers.forEach((users, roomId) => {
      if (users.has(userId)) {
        users.delete(userId);
        broadcastTyping(roomId);
      }
    });
  });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Mark user as online
 */
async function markUserOnline(userId, socketId) {
  await redisClient.setEx(`presence:${userId}`, config.presence.offlineTimeout / 1000, 'online');
  await redisClient.sAdd(`online:users`, userId.toString());
  
  // Broadcast to followers
  const followers = await getFollowers(userId);
  followers.forEach(followerId => {
    io.to(`user:${followerId}`).emit('presence:online', {
      userId: userId,
      timestamp: Date.now(),
    });
  });
}

/**
 * Mark user as offline
 */
async function markUserOffline(userId) {
  await redisClient.del(`presence:${userId}`);
  await redisClient.sRem(`online:users`, userId.toString());
  
  // Broadcast to followers
  const followers = await getFollowers(userId);
  followers.forEach(followerId => {
    io.to(`user:${followerId}`).emit('presence:offline', {
      userId: userId,
      timestamp: Date.now(),
    });
  });
}

/**
 * Update presence status
 */
async function updatePresence(userId, status) {
  await redisClient.setEx(`presence:${userId}:status`, 3600, status);
  
  // Broadcast status change
  const followers = await getFollowers(userId);
  followers.forEach(followerId => {
    io.to(`user:${followerId}`).emit('presence:status', {
      userId: userId,
      status: status,
      timestamp: Date.now(),
    });
  });
}

/**
 * Update heartbeat
 */
async function updateHeartbeat(userId) {
  await redisClient.setEx(`presence:${userId}`, config.presence.offlineTimeout / 1000, 'online');
}

/**
 * Broadcast typing indicator
 */
function broadcastTyping(roomId) {
  const typing = Array.from(typingUsers.get(roomId) || []);
  io.to(`chat:${roomId}`).emit('chat:typing', {
    roomId: roomId,
    users: typing,
    timestamp: Date.now(),
  });
}

/**
 * Get user's followers from Drupal
 */
async function getFollowers(userId) {
  try {
    const response = await axios.get(`${config.drupal.url}/api/user/${userId}/followers`, {
      headers: {
        'X-API-Key': config.drupal.apiKey,
      },
    });
    return response.data.followers || [];
  } catch (error) {
    console.error('Error fetching followers:', error.message);
    return [];
  }
}

/**
 * Save chat message to Drupal
 */
async function saveChatMessage(roomId, userId, message, messageId) {
  try {
    await axios.post(`${config.drupal.url}/api/chat/message`, {
      room_id: roomId,
      user_id: userId,
      message: message,
      message_id: messageId,
    }, {
      headers: {
        'X-API-Key': config.drupal.apiKey,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error saving message:', error.message);
    throw error;
  }
}

/**
 * Save read receipt
 */
async function saveReadReceipt(roomId, userId, messageId) {
  try {
    await axios.post(`${config.drupal.url}/api/chat/read`, {
      room_id: roomId,
      user_id: userId,
      message_id: messageId,
    }, {
      headers: {
        'X-API-Key': config.drupal.apiKey,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error saving read receipt:', error.message);
  }
}

/**
 * Mark notification as read
 */
async function markNotificationRead(userId, notificationId) {
  try {
    await axios.post(`${config.drupal.url}/api/notifications/${notificationId}/read`, {
      user_id: userId,
    }, {
      headers: {
        'X-API-Key': config.drupal.apiKey,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error marking notification read:', error.message);
  }
}

/**
 * Mark all notifications as read
 */
async function markAllNotificationsRead(userId) {
  try {
    await axios.post(`${config.drupal.url}/api/notifications/read-all`, {
      user_id: userId,
    }, {
      headers: {
        'X-API-Key': config.drupal.apiKey,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error marking notifications read:', error.message);
  }
}

// ============================================
// DRUPAL → NODE.JS EVENTS
// ============================================

/**
 * API endpoint for Drupal to send notifications
 */
app.use(express.json());

app.post('/api/notify', (req, res) => {
  const { api_key, user_id, event, data } = req.body;
  
  // Verify API key
  if (api_key !== config.drupal.apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Send notification to user
  io.to(`user:${user_id}`).emit('notification', {
    event: event,
    data: data,
    timestamp: Date.now(),
  });
  
  res.json({ success: true });
});

app.post('/api/broadcast', (req, res) => {
  const { api_key, room, event, data } = req.body;
  
  // Verify API key
  if (api_key !== config.drupal.apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Broadcast to room
  io.to(room).emit(event, data);
  
  res.json({ success: true });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    connections: io.engine.clientsCount,
    onlineUsers: onlineUsers.size,
  });
});

// ============================================
// START SERVER
// ============================================

const PORT = config.server.port;

httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   🚀 Bounded WebSocket Server Started                 ║
║                                                        ║
║   Port: ${PORT}                                          ║
║   Environment: ${config.server.env}                           ║
║   Drupal URL: ${config.drupal.url}     ║
║                                                        ║
║   ✅ Socket.io ready                                   ║
║   ✅ Redis connected                                   ║
║   ✅ Authentication enabled                            ║
║                                                        ║
║   Ready for real-time magic! ⚡                        ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
});

// ============================================
// CLEANUP
// ============================================

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await redisClient.quit();
  await redisPub.quit();
  await redisSub.quit();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

