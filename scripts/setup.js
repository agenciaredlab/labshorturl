#!/usr/bin/env node
'use strict';

// ── LabShortURL — Asistente de Instalación ────────────────────────────────
// Detecta el entorno de red y guía al usuario paso a paso para generar
// la configuración correcta (.env) según el modo de despliegue.
//
// Uso:  node scripts/setup.js

const readline = require('readline');
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// ── Colores ANSI ──────────────────────────────────────────────────────────
const c = {
  reset:  s => `\x1b[0m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  blue:   s => `\x1b[34m${s}\x1b[0m`,
};

const hr = (char = '─', len = 52) => char.repeat(len);
const ok   = msg => console.log(`  ${c.green('✓')} ${msg}`);
const warn = msg => console.log(`  ${c.yellow('!')} ${msg}`);
const fail = msg => console.log(`  ${c.red('✗')} ${msg}`);
const info = msg => console.log(`  ${c.dim(msg)}`);

// ── Ejecutar comando silencioso ───────────────────────────────────────────
function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 })
      .toString().trim();
  } catch { return null; }
}

// ── Detección de entorno ──────────────────────────────────────────────────
function detectEnv() {
  const e = {};

  // Docker
  const dockerVer = run('docker --version');
  e.docker = !!dockerVer;
  e.dockerVersion = dockerVer?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;

  // Docker Compose (plugin v2 o standalone v1)
  e.compose = !!(run('docker compose version') || run('docker-compose --version'));

  // Docker Swarm
  const swarmState = run("docker info --format '{{.Swarm.LocalNodeState}}'");
  e.swarm = swarmState === 'active';
  const swarmCtrl  = run("docker info --format '{{.Swarm.ControlAvailable}}'");
  e.swarmManager   = swarmCtrl === 'true';

  // PM2
  e.pm2 = !!run('pm2 --version');

  // Interfaces de red locales (IPs del servidor)
  e.localIps = [];
  try {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const a of iface) {
        if (a.family === 'IPv4' && !a.internal) e.localIps.push(a.address);
      }
    }
  } catch {}

  // IP pública
  e.publicIp = (
    run('curl -s --max-time 4 https://api.ipify.org') ||
    run('curl -s --max-time 4 http://checkip.amazonaws.com') ||
    run('curl -s --max-time 4 https://ifconfig.me') ||
    null
  );
  if (e.publicIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(e.publicIp)) e.publicIp = null;

  // Proxy/reverse proxy activo en 80/443
  e.port80  = isPortOpen('localhost', 80);
  e.port443 = isPortOpen('localhost', 443);

  // .env existente
  e.hasEnv = fs.existsSync(path.join(ROOT, '.env'));

  // Hostname
  e.hostname = os.hostname();

  return e;
}

function isPortOpen(host, port) {
  const res = spawnSync('nc', ['-z', '-w1', host, String(port)], { timeout: 1500 });
  return res.status === 0;
}

// ── Readline helpers ──────────────────────────────────────────────────────
function makeRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, label, defaultVal = '', opts = {}) {
  return new Promise(resolve => {
    const { validate, secret } = opts;

    const loop = () => {
      const hint = defaultVal ? ` ${c.dim(`[${defaultVal}]`)}` : '';
      const suffix = defaultVal ? ': ' : ': ';

      process.stdout.write(label + hint + suffix);

      if (secret) {
        // Hide input (terminal raw mode trick)
        let input = '';
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.setEncoding('utf8');
          const onData = ch => {
            if (ch === '\r' || ch === '\n') {
              process.stdin.setRawMode(false);
              process.stdin.pause();
              process.stdin.removeListener('data', onData);
              process.stdout.write('\n');
              const value = input || defaultVal;
              if (validate) {
                const err = validate(value);
                if (err) { console.log(c.red(`  ✗ ${err}`)); loop(); return; }
              }
              resolve(value);
            } else if (ch === '\u0003') {
              process.exit(0);
            } else if (ch === '\u007F') {
              if (input.length > 0) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
            } else {
              input += ch;
              process.stdout.write('*');
            }
          };
          process.stdin.on('data', onData);
        } else {
          // Non-TTY (piped input)
          rl.question('', answer => {
            const value = answer.trim() || defaultVal;
            resolve(value);
          });
        }
      } else {
        rl.question('', answer => {
          const value = answer.trim() || defaultVal;
          if (validate) {
            const err = validate(value);
            if (err) { console.log(c.red(`  ✗ ${err}`)); loop(); return; }
          }
          resolve(value);
        });
      }
    };
    loop();
  });
}

function confirm(rl, label, defaultYes = true) {
  const hint = defaultYes ? c.dim('[S/n]') : c.dim('[s/N]');
  return new Promise(resolve => {
    rl.question(`${label} ${hint}: `, answer => {
      const a = answer.trim().toLowerCase();
      if (!a) { resolve(defaultYes); return; }
      resolve(a === 's' || a === 'si' || a === 'y' || a === 'yes');
    });
  });
}

async function choose(rl, label, options, defaultIdx = 0) {
  console.log(label);
  options.forEach((o, i) => {
    const marker = i === defaultIdx ? c.cyan('▶') : ' ';
    const num    = c.bold(`${i + 1})`);
    console.log(`  ${marker} ${num} ${o.label}`);
  });
  while (true) {
    const raw = await ask(rl, `Elige`, String(defaultIdx + 1));
    const n = parseInt(raw) - 1;
    if (n >= 0 && n < options.length) return options[n].value;
    console.log(c.red(`  ✗ Elige un número entre 1 y ${options.length}`));
  }
}

// ── Validadores ───────────────────────────────────────────────────────────
const validators = {
  url: v => {
    if (!v) return 'La URL es obligatoria';
    try { new URL(v); return null; }
    catch { return 'URL inválida. Ejemplo: https://go.miempresa.com'; }
  },
  port: v => {
    const n = parseInt(v);
    return (n > 0 && n < 65536) ? null : 'Puerto inválido (1-65535)';
  },
  pass: v => v.length >= 8 ? null : 'Mínimo 8 caracteres',
  dbUrl: v => {
    if (!v) return 'La DATABASE_URL es obligatoria';
    return v.startsWith('postgresql://') || v.startsWith('postgres://')
      ? null : 'Debe empezar con postgresql:// o postgres://';
  },
};

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log();
  console.log(c.cyan(c.bold('  ╔══════════════════════════════════════════════════╗')));
  console.log(c.cyan(c.bold('  ║      LabShortURL — Asistente de Instalación      ║')));
  console.log(c.cyan(c.bold('  ╚══════════════════════════════════════════════════╝')));
  console.log();

  // ── Detectar entorno ────────────────────────────────────────────────────
  console.log(c.bold('  Detectando entorno…') + '\n');

  const env = detectEnv();

  // Docker
  if (env.docker) {
    let label = `Docker ${env.dockerVersion}`;
    if (env.swarm) label += ` · Swarm ${env.swarmManager ? c.green('(manager)') : c.yellow('(worker)')}`;
    ok(label);
    if (env.compose) ok('Docker Compose disponible');
  } else {
    fail('Docker no detectado');
  }
  if (env.pm2)      ok(`PM2 disponible`);
  else              info('PM2 no detectado');

  // Red
  console.log();
  if (env.publicIp) {
    ok(`IP pública: ${c.cyan(env.publicIp)}`);
  } else {
    warn('No se pudo detectar la IP pública');
  }
  if (env.localIps.length > 0) {
    info(`IPs locales: ${env.localIps.join(', ')}`);
  }
  if (env.port443) ok('Puerto 443 activo → proxy HTTPS detectado');
  if (env.port80)  info('Puerto 80 activo (HTTP)');

  if (env.hasEnv) {
    console.log();
    warn('Ya existe un archivo .env (se creará un backup antes de sobreescribir)');
  }

  console.log();

  const rl = makeRL();

  try {
    // ── Modo de despliegue ─────────────────────────────────────────────────
    console.log(c.bold(hr('─')));
    console.log(c.bold('  Modo de despliegue'));
    console.log(c.bold(hr('─')) + '\n');

    const modeOptions = [];
    if (env.compose) {
      modeOptions.push({
        label: `Docker Compose       ${c.dim('(un servidor, más sencillo)')}`,
        value: 'compose',
      });
    }
    if (env.swarm && env.swarmManager) {
      modeOptions.push({
        label: `Docker Swarm/Portainer ${c.dim('(alta disponibilidad, múltiples réplicas)')}`,
        value: 'swarm',
      });
    } else if (env.swarm && !env.swarmManager) {
      warn('Este nodo es un Swarm worker, no manager. Conéctate al manager para desplegar.');
    }
    if (env.pm2) {
      modeOptions.push({
        label: `PM2                  ${c.dim('(sin Docker, proceso Node directo)')}`,
        value: 'pm2',
      });
    }
    modeOptions.push({
      label: `Solo generar .env    ${c.dim('(configuración manual)')}`      ,
      value: 'manual',
    });

    const mode = modeOptions.length === 1
      ? modeOptions[0].value
      : await choose(rl, '', modeOptions, 0);

    console.log();

    // ── Red ────────────────────────────────────────────────────────────────
    console.log(c.bold(hr('─')));
    console.log(c.bold('  Red y dominio'));
    console.log(c.bold(hr('─')) + '\n');

    // Sugerir URL base según lo detectado
    let defaultUrl = 'http://localhost:3000';
    if (env.port443 && env.publicIp) defaultUrl = `https://${env.publicIp}`;
    else if (env.publicIp)           defaultUrl = `http://${env.publicIp}:3000`;

    const baseUrl = await ask(rl,
      'Dominio o URL base (incluye http:// o https://)',
      defaultUrl,
      { validate: validators.url }
    );

    const isHttps = baseUrl.startsWith('https://');

    // Proxy reverso
    let behindProxy = isHttps || env.port443;
    if (!isHttps) {
      console.log(c.dim('  (Activa cookies seguras, trust proxy y HSTS)'));
      behindProxy = await confirm(rl, '¿La app estará detrás de un proxy HTTPS (nginx, Traefik, Cloudflare)?', env.port443);
    }
    const nodeEnv = (isHttps || behindProxy) ? 'production' : 'development';

    // Puerto
    let port = '3000';
    if (mode !== 'swarm') {
      port = await ask(rl, 'Puerto en el que escucha la app', '3000', { validate: validators.port });
    }

    console.log();

    // ── Admin ──────────────────────────────────────────────────────────────
    console.log(c.bold(hr('─')));
    console.log(c.bold('  Cuenta de administrador'));
    console.log(c.bold(hr('─')) + '\n');

    const adminUser = await ask(rl, 'Nombre de usuario admin', 'admin');
    const adminPass = await ask(rl, 'Contraseña admin', '', {
      secret: true,
      validate: validators.pass,
    });

    const sessionSecret = crypto.randomBytes(32).toString('hex');
    info('Session secret generado automáticamente');

    console.log();

    // ── Base de datos ──────────────────────────────────────────────────────
    console.log(c.bold(hr('─')));
    console.log(c.bold('  Base de datos (PostgreSQL)'));
    console.log(c.bold(hr('─')) + '\n');

    let databaseUrl;
    let pgPassword;

    if (mode === 'compose') {
      const useBundled = await confirm(rl, '¿Usar PostgreSQL incluido en Docker Compose?', true);
      if (useBundled) {
        pgPassword   = crypto.randomBytes(16).toString('hex');
        databaseUrl  = `postgresql://labshorturl:${pgPassword}@db:5432/labshorturl`;
        info('Contraseña de PostgreSQL generada automáticamente');
        info('Servicio "db" de docker-compose.yml');
      } else {
        databaseUrl = await ask(rl,
          'DATABASE_URL',
          'postgresql://user:pass@host:5432/labshorturl',
          { validate: validators.dbUrl }
        );
      }

    } else if (mode === 'swarm') {
      const useStack = await confirm(rl, '¿Usar el servicio PostgreSQL incluido en docker-stack.yml?', true);
      if (useStack) {
        pgPassword   = crypto.randomBytes(16).toString('hex');
        databaseUrl  = `postgresql://labshorturl:${pgPassword}@db:5432/labshorturl`;
        info('Contraseña de PostgreSQL generada automáticamente');
      } else {
        databaseUrl = await ask(rl,
          'DATABASE_URL de PostgreSQL externo',
          'postgresql://user:pass@host:5432/labshorturl',
          { validate: validators.dbUrl }
        );
      }

    } else {
      // PM2 / manual — necesita un postgres ya corriendo
      info('Necesitas un servidor PostgreSQL accesible desde esta máquina.');
      const localPg = await confirm(rl, '¿PostgreSQL corre en este mismo servidor (localhost)?', true);
      const defaultDbUrl = localPg
        ? 'postgresql://labshorturl:labshorturl@localhost:5432/labshorturl'
        : 'postgresql://user:pass@host:5432/labshorturl';
      databaseUrl = await ask(rl, 'DATABASE_URL', defaultDbUrl, { validate: validators.dbUrl });
    }

    console.log();

    // ── Opcionales ─────────────────────────────────────────────────────────
    console.log(c.bold(hr('─')));
    console.log(c.bold('  Opcionales'));
    console.log(c.bold(hr('─')) + '\n');

    info('Sentry: monitoreo de errores en tiempo real. Obtén el DSN en sentry.io');
    const sentryDsn = await ask(rl, `Sentry DSN ${c.dim('(Enter para omitir)')}`, '');

    console.log();

    // ── Resumen ────────────────────────────────────────────────────────────
    console.log(c.bold(hr('═')));
    console.log(c.bold('  Resumen de configuración'));
    console.log(c.bold(hr('═')) + '\n');

    const dbDisplay = databaseUrl.replace(/:([^:@/]+)@/, ':***@');
    const col = (k, v) => console.log(`  ${c.dim(k.padEnd(16))} ${c.cyan(v)}`);

    col('BASE_URL',     baseUrl);
    col('NODE_ENV',     nodeEnv);
    col('Puerto',       port);
    col('ADMIN_USER',   adminUser);
    col('DATABASE_URL', dbDisplay);
    col('Sentry',       sentryDsn ? 'configurado' : 'no configurado');
    col('Modo deploy',  mode);
    if (behindProxy) info('Trust proxy + cookies seguras activadas');

    console.log();
    const save = await confirm(rl, c.bold('¿Guardar .env y aplicar configuración?'), true);
    if (!save) {
      console.log(c.yellow('\n  Cancelado. No se guardaron cambios.\n'));
      rl.close();
      return;
    }

    // ── Escribir .env ──────────────────────────────────────────────────────
    const envPath = path.join(ROOT, '.env');
    if (env.hasEnv) {
      const bak = `${envPath}.backup-${Date.now()}`;
      fs.copyFileSync(envPath, bak);
      warn(`.env anterior respaldado → ${path.basename(bak)}`);
    }

    const envLines = [
      `# Generado por scripts/setup.js — ${new Date().toISOString()}`,
      `# Modo de despliegue: ${mode}`,
      '',
      '# ── Servidor ──',
      `PORT=${port}`,
      `BASE_URL=${baseUrl}`,
      '',
      '# ── Base de datos ──',
      `DATABASE_URL=${databaseUrl}`,
      ...(pgPassword ? [`PG_PASSWORD=${pgPassword}`] : []),
      '',
      '# ── Admin ──',
      `ADMIN_USER=${adminUser}`,
      `ADMIN_PASS=${adminPass}`,
      '',
      '# ── Sesión ──',
      `SESSION_SECRET=${sessionSecret}`,
      '',
      '# ── Entorno ──',
      `NODE_ENV=${nodeEnv}`,
      '',
      '# ── Monitoreo ──',
      `SENTRY_DSN=${sentryDsn}`,
    ];

    fs.writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });
    ok('.env guardado (permisos 600)');

    // ── Próximos pasos ─────────────────────────────────────────────────────
    console.log();
    console.log(c.bold(hr('─')));
    console.log(c.bold('  Próximos pasos'));
    console.log(c.bold(hr('─')) + '\n');

    const step = (n, msg) => console.log(`  ${c.cyan(c.bold(n + '.'))} ${msg}`);
    const cmd  = s => console.log(`     ${c.dim(s)}`);

    if (mode === 'compose') {
      step(1, 'Levanta los servicios:');
      cmd('docker compose up -d');
      step(2, `Abre ${c.cyan(baseUrl)} en tu navegador`);
      step(3, 'Configura backup automático (cron):');
      cmd(`0 3 * * * ${path.join(ROOT, 'scripts/backup.sh')} >> ${path.join(ROOT, 'logs/backup.log')} 2>&1`);

    } else if (mode === 'swarm') {
      step(1, 'Crea los Docker secrets:');
      if (pgPassword) {
        cmd(`printf '%s' '${pgPassword}' | docker secret create labshorturl_pg_password -`);
      }
      cmd(`printf '%s' '${adminPass}' | docker secret create labshorturl_admin_pass -`);
      cmd(`printf '%s' '${sessionSecret}' | docker secret create labshorturl_session_secret -`);
      cmd(`printf '%s' '${databaseUrl}' | docker secret create labshorturl_database_url -`);
      if (sentryDsn) {
        cmd(`printf '%s' '${sentryDsn}' | docker secret create labshorturl_sentry_dsn -`);
      }
      step(2, 'Construye la imagen:');
      cmd('docker build -t labshorturl:latest .');
      step(3, 'Despliega el stack:');
      cmd('docker stack deploy -c docker-stack.yml labshorturl');
      step(4, `Abre ${c.cyan(baseUrl)} en tu navegador`);

    } else if (mode === 'pm2') {
      step(1, 'Instala dependencias:');
      cmd('npm install --omit=dev');
      step(2, 'Inicia con PM2:');
      cmd('pm2 start ecosystem.config.js --env production');
      cmd('pm2 save && pm2 startup');
      step(3, `Abre ${c.cyan(baseUrl)} en tu navegador`);
      step(4, 'Configura backup automático (cron):');
      cmd(`0 3 * * * ${path.join(ROOT, 'scripts/backup.sh')} >> ${path.join(ROOT, 'logs/backup.log')} 2>&1`);

    } else {
      step(1, 'Revisa el .env generado');
      step(2, 'Inicia la aplicación con el método de tu preferencia');
      step(3, `Abre ${c.cyan(baseUrl)} en tu navegador`);
    }

    console.log();
    console.log(c.green(c.bold('  ¡Configuración completada!')));
    console.log();

  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(c.red(`\n  Error: ${err.message}\n`));
  process.exit(1);
});
