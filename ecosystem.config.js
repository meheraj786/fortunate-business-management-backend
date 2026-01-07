module.exports = {
  apps: [
    {
      name: "fortunate-business-management-backend",
      script: "index.js",
      instances: "max",
      exec_mode: "cluster",
      watch: false,
      merge_logs: true,
      env: {
        NODE_ENV: "development",
        TZ: "Asia/Dhaka",
      },
      env_production: {
        NODE_ENV: "production",
        TZ: "Asia/Dhaka",
      },
    },
  ],
};
