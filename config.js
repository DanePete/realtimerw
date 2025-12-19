/**
 * Configuration for WebSocket Server
 */

require('dotenv').config();

module.exports = {
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development',
  },
  
  drupal: {
    url: process.env.DRUPAL_URL || 'https://bounded.ddev.site',
    apiKey: process.env.DRUPAL_API_KEY || 'dev-api-key',
  },
  
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || null,
    db: 0,
  },
  
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    expiration: process.env.JWT_EXPIRATION || '24h',
  },
  
  cors: {
    origins: (process.env.ALLOWED_ORIGINS || 'https://bounded.ddev.site')
      .split(',')
      .map(origin => origin.trim()),
  },
  
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  
  presence: {
    heartbeatInterval: 30000, // 30 seconds
    offlineTimeout: 60000, // 60 seconds
  },
  
  chat: {
    maxMessageLength: 5000,
    typingTimeout: 3000, // 3 seconds
    historyLimit: 50,
  },
};

