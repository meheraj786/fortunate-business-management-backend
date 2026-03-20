#!/bin/bash

echo "🚀 Deploying Fortunate Business Management Backend..."

# Pull latest changes
echo "📥 Pulling from GitHub..."
git pull origin main

# Install dependencies (in case of new packages)
echo "📦 Installing dependencies..."
npm install --production

# Restart PM2
echo "🔄 Restarting PM2..."
pm2 restart fortunate-business-management-backend

echo "✅ Backend deployment complete!"
pm2 status fortunate-business-management-backend
