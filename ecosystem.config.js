module.exports = {
  apps: [
    {
      name: "fortunate-business-management-backend",
      script: "index.js",
      instances: 4, // Match your CPU cores exactly
      exec_mode: "cluster",
      watch: false,
      merge_logs: true,

      // Memory management - Optimized for 8GB VPS
      max_memory_restart: "768M", // 4 × 768MB = ~3GB total

      // Node.js options for memory management
      node_args: [
        "--max-old-space-size=768", // 768MB heap per instance
        "--optimize-for-size",
        "--gc-interval=100", // More frequent garbage collection
        "--max-semi-space-size=32", // Limit young generation
      ],

      // Auto restart on crashes
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 4000,

      // Kill timeout
      kill_timeout: 5000,
      listen_timeout: 10000,

      // Environment variables
      env: {
        NODE_ENV: "development",
        TZ: "Asia/Dhaka",
        UV_THREADPOOL_SIZE: "8", // Increase thread pool for file operations
      },
      env_production: {
        NODE_ENV: "production",
        TZ: "Asia/Dhaka",
        UV_THREADPOOL_SIZE: "8",
      },

      // Logging configuration
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Monitoring
      monitoring: true,
    },
  ],
};
