# 🚂 Railway Deployment Guide

## Environment Variables to Set in Railway

After deploying, set these in Railway dashboard → Variables tab:

```bash
# Required
API_KEY=<generate-secure-key>
JWT_SECRET=<generate-secure-key>
NODE_ENV=production

# Optional (Railway sets this automatically)
PORT=3000
```

## Generate Secure Keys

```bash
# API Key (32 characters)
openssl rand -base64 32

# JWT Secret (64 characters)
openssl rand -base64 64
```

## Health Check URL

Once deployed, visit:
```
https://your-app.up.railway.app/health
```

Should return: `{"status":"ok"}`

