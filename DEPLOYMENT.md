# Backend Deployment Guide

This guide provides step-by-step instructions for deploying the backend of the Fortunate Business Management software on a VPS.

## 1. Server Preparation

### 1.1. Install Node.js and npm

First, you need to install Node.js (which includes npm) on your server. We recommend using a version manager like `nvm` to easily manage Node.js versions.

```bash
# Download and install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash

# Load nvm
export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install a recent LTS version of Node.js
nvm install --lts

# Verify installation
node -v
npm -v
```

### 1.2. Install PM2

PM2 is a process manager for Node.js applications that will keep your backend running.

```bash
npm install pm2 -g
```

### 1.3. Install Nginx

Nginx will act as a reverse proxy to forward requests to your Node.js application.

```bash
sudo apt update
sudo apt install nginx
```

## 2. MongoDB Setup & Reliability

### 2.1. Standard Installation

Install MongoDB as per official documentation for your OS.

### 2.2. Enabling Replica Set (Required for Transactions)

MongoDB Transactions require a Replica Set. Follow these steps to convert a standalone instance to a single-node replica set:

1. **Generate a KeyFile (Secure Mode)**:

   ```bash
   openssl rand -base64 756 | sudo tee /var/lib/mongodb/keyfile > /dev/null
   sudo chmod 400 /var/lib/mongodb/keyfile
   sudo chown mongodb:mongodb /var/lib/mongodb/keyfile
   ```

2. **Update `mongod.conf`**:

   ```bash
   sudo nano /etc/mongod.conf
   ```

   Add/Update these sections:

   ```yaml
   security:
     authorization: enabled
     keyFile: /var/lib/mongodb/keyfile

   replication:
     replSetName: "rs0"
   ```

3. **Restart & Initiate**:
   ```bash
   sudo systemctl restart mongod
   mongosh --eval "rs.initiate()"
   ```

### 2.3. Connection String Format

Your `MONGODB_URI` in `.env` must include the `replicaSet` parameter:
`mongodb://username:password@localhost:27017/database_name?authSource=admin&replicaSet=rs0`

## 2. Application Setup

### 2.1. Clone the Repository

Clone your project from the Git repository to a directory on your server (e.g., `/var/www/my-app`).

```bash
git clone <your-repository-url> /var/www/fortunate-backend
cd /var/www/fortunate-backend
```

### 2.2. Install Dependencies

Install the project's dependencies using npm.

```bash
npm install
```

### 2.3. Create Environment File

Create a `.env` file in the root of the project directory. This file will hold your production environment variables.

```bash
nano .env
```

Copy the content from `sample.env` and update the values for your production environment. It should look like this:

```env
PORT=5000 # Or any other port you prefer
MONGODB_URI=<your_production_mongodb_uri>
SECRET_KEY=<your_strong_secret_key>
CORS_ORIGIN=<your_frontend_production_url> # e.g., http://yourdomain.com
NODE_ENV=production
SUPER_ADMIN_PASSWORD=<a_very_strong_password_for_the_superadmin_seed>
```

**Security Note:** Ensure `SECRET_KEY` and `SUPER_ADMIN_PASSWORD` are long, random, and unique strings.

## 3. Running the Application with PM2

### 3.1. Start the Application

Use the `ecosystem.config.js` file to start the application with PM2. This configuration handles clustering and environment variables.

```bash
pm2 start ecosystem.config.js --env production
```

### 3.2. Check Application Status

You can check the status of your application with:

```bash
pm2 list
# or for more details
pm2 show fortunate-business-management-backend
```

### 3.3. View Logs

To monitor logs in real-time:

```bash
pm2 logs fortunate-business-management-backend
```

### 3.4. Enable Startup on Reboot

To ensure your application restarts automatically after a server reboot:

```bash
pm2 startup
# Follow the instructions provided by the command
pm2 save
```

## 4. Configure Nginx as a Reverse Proxy

This setup will allow you to access your backend via a domain/subdomain (e.g., `api.yourdomain.com`) on the standard HTTP/HTTPS ports.

### 4.1. Create Nginx Configuration File

Create a new Nginx configuration file for your backend API.

```bash
sudo nano /etc/nginx/sites-available/api.yourdomain.com
```

### 4.2. Add Configuration

Paste the following configuration into the file. This assumes your backend is running on port 5000.

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:5000; # The port your app is running on
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 4.3. Enable the Site

Create a symbolic link to enable the new configuration.

```bash
sudo ln -s /etc/nginx/sites-available/api.yourdomain.com /etc/nginx/sites-enabled/
```

### 4.4. Test and Restart Nginx

Test your Nginx configuration for syntax errors and then restart the service.

```bash
sudo nginx -t
sudo systemctl restart nginx
```

## 5. (Optional) Secure with SSL using Certbot

It is highly recommended to secure your API with an SSL certificate.

### 5.1. Install Certbot

Certbot is a tool to automatically obtain and renew free SSL certificates from Let's Encrypt.

```bash
sudo apt install certbot python3-certbot-nginx
```

### 5.2. Obtain the Certificate

Run Certbot and follow the on-screen instructions. It will automatically update your Nginx configuration.

```bash
sudo certbot --nginx -d api.yourdomain.com
```

Certbot will also set up a cron job to automatically renew your certificate before it expires.

Your backend is now deployed and accessible at `https://api.yourdomain.com`.
