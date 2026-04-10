// PM2 — para despliegue directo sin Docker
//
// Uso:
//   npm install -g pm2
//   pm2 start ecosystem.config.js --env production
//   pm2 save       # persiste entre reinicios
//   pm2 startup    # genera el comando para arrancar PM2 con el sistema
//
// Comandos útiles:
//   pm2 logs labshorturl       # ver logs en tiempo real
//   pm2 monit                  # monitor de CPU/RAM
//   pm2 reload labshorturl     # recarga sin downtime (0-downtime restart)

module.exports = {
  apps: [{
    name: 'labshorturl',
    script: 'src/server.js',

    instances: 1,
    exec_mode: 'fork',

    watch: false,
    max_memory_restart: '256M',

    // Las variables de entorno de producción van en tu .env o aquí
    env_production: {
      NODE_ENV:   'production',
      PORT:       3000,
      // BASE_URL, ADMIN_USER, ADMIN_PASS, SESSION_SECRET, DATABASE_URL — definir en .env
    },

    // Logs de PM2 (adicionales a los de Morgan)
    error_file: 'logs/pm2-error.log',
    out_file:   'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // Reintentos de arranque
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 3000,
  }],
};
