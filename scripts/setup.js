#!/usr/bin/env node
'use strict';

// ── LabShortURL — Asistente de Instalación ────────────────────────────────
// Detecta el entorno de red (Docker, Portainer, Swarm, PM2) y guía al
// usuario paso a paso para generar la configuración correcta.
//
// Uso:  node scripts/setup.js   |   npm run setup

const readline = require('readline');
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// ── Colores ANSI ──────────────────────────────────────────────────────────
const c = {
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  blue:   s => `\x1b[34m${s}\x1b[0m`,
};

const hr   = (char = '─', len = 52) => char.repeat(len);
const ok   = msg => console.log(`  ${c.green('✓')} ${msg}`);
const warn = msg => console.log(`  ${c.yellow('!')} ${msg}`);
const fail = msg => console.log(`  ${c.red('✗')} ${msg}`);
const info = msg => console.log(`  ${c.dim(msg)}`);
const blank = () => console.log();

// ── Ejecutar comando silencioso ───────────────────────────────────────────
function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 })
      .toString().trim();
  } catch { return null; }
}

function isPortOpen(host, port) {
  const r = spawnSync('nc', ['-z', '-w1', host, String(port)], { timeout: 1500 });
  return r.status === 0;
}

// ── Detección de entorno ──────────────────────────────────────────────────
function detectEnv() {
  const e = {};

  // ── Docker ────────────────────────────────────────────────────────────
  const dockerVer = run('docker --version');
  e.docker        = !!dockerVer;
  e.dockerVersion = dockerVer?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;

  // Docker Compose (plugin v2 o standalone v1)
  e.compose = !!(run('docker compose version') || run('docker-compose --version'));

  // Docker Swarm
  const swarmState = run("docker info --format '{{.Swarm.LocalNodeState}}'");
  e.swarm          = swarmState === 'active';
  const swarmCtrl  = run("docker info --format '{{.Swarm.ControlAvailable}}'");
  e.swarmManager   = swarmCtrl === 'true';

  // ── Portainer ─────────────────────────────────────────────────────────
  // Detectar por nombre de contenedor o por puertos accesibles
  const portainerContainer = run(
    'docker ps --filter "name=portainer" --format "{{.Names}}" 2>/dev/null'
  );
  const port9000 = isPortOpen('localhost', 9000);
  const port9443 = isPortOpen('localhost', 9443);

  e.portainer      = !!(portainerContainer || port9000 || port9443);
  e.portainerPort  = port9443 ? 9443 : (port9000 ? 9000 : null);
  e.portainerProto = port9443 ? 'https' : 'http';
  e.portainerUrl   = e.portainerPort
    ? `${e.portainerProto}://localhost:${e.portainerPort}`
    : null;

  // ── PM2 ───────────────────────────────────────────────────────────────
  e.pm2 = !!run('pm2 --version');

  // ── Red ───────────────────────────────────────────────────────────────
  e.localIps = [];
  try {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const a of iface) {
        if (a.family === 'IPv4' && !a.internal) e.localIps.push(a.address);
      }
    }
  } catch {}

  e.publicIp = (
    run('curl -s --max-time 4 https://api.ipify.org') ||
    run('curl -s --max-time 4 http://checkip.amazonaws.com') ||
    run('curl -s --max-time 4 https://ifconfig.me') ||
    null
  );
  if (e.publicIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(e.publicIp)) e.publicIp = null;

  e.port80  = isPortOpen('localhost', 80);
  e.port443 = isPortOpen('localhost', 443);

  // ── Otros ─────────────────────────────────────────────────────────────
  e.hasEnv  = fs.existsSync(path.join(ROOT, '.env'));
  e.hostname = os.hostname();

  return e;
}

// ── Readline helpers ──────────────────────────────────────────────────────
function makeRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, label, defaultVal = '', opts = {}) {
  return new Promise(resolve => {
    const { validate, secret } = opts;

    const loop = () => {
      const hint   = defaultVal ? ` ${c.dim(`[${defaultVal}]`)}` : '';
      process.stdout.write(label + hint + ': ');

      if (secret && process.stdin.isTTY) {
        let input = '';
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
            if (validate) { const err = validate(value); if (err) { console.log(c.red(`  ✗ ${err}`)); loop(); return; } }
            resolve(value);
          } else if (ch === '\u0003') {
            process.exit(0);
          } else if (ch === '\u007F') {
            if (input.length > 0) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
          } else {
            input += ch; process.stdout.write('*');
          }
        };
        process.stdin.on('data', onData);
      } else {
        rl.question('', answer => {
          const value = answer.trim() || defaultVal;
          if (validate) { const err = validate(value); if (err) { console.log(c.red(`  ✗ ${err}`)); loop(); return; } }
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
  if (label) console.log(label);
  options.forEach((o, i) => {
    const marker = i === defaultIdx ? c.cyan('▶') : ' ';
    console.log(`  ${marker} ${c.bold(`${i + 1})`)} ${o.label}`);
  });
  while (true) {
    const raw = await ask(rl, 'Elige', String(defaultIdx + 1));
    const n = parseInt(raw) - 1;
    if (n >= 0 && n < options.length) return options[n].value;
    console.log(c.red(`  ✗ Elige un número entre 1 y ${options.length}`));
  }
}

// ── Validadores ───────────────────────────────────────────────────────────
const V = {
  url:  v => { try { new URL(v); return null; } catch { return 'URL inválida. Ejemplo: https://go.miempresa.com'; } },
  port: v => (parseInt(v) > 0 && parseInt(v) < 65536) ? null : 'Puerto inválido (1-65535)',
  pass: v => v.length >= 8 ? null : 'Mínimo 8 caracteres',
  dbUrl: v => (v.startsWith('postgresql://') || v.startsWith('postgres://'))
    ? null : 'Debe empezar con postgresql:// o postgres://',
};

// ── Helpers de salida ─────────────────────────────────────────────────────
function section(title) {
  blank();
  console.log(c.bold(hr('─')));
  console.log(c.bold(`  ${title}`));
  console.log(c.bold(hr('─')));
  blank();
}

function step(n, msg) { console.log(`  ${c.cyan(c.bold(n + '.'))} ${msg}`); }
function cmd(s)       { console.log(`     ${c.dim(s)}`); }
function note(s)      { console.log(`     ${c.yellow('→')} ${s}`); }

// ── Escribir .env ─────────────────────────────────────────────────────────
function writeEnv(fields, mode, hasEnv) {
  const envPath = path.join(ROOT, '.env');
  if (hasEnv) {
    const bak = `${envPath}.backup-${Date.now()}`;
    fs.copyFileSync(envPath, bak);
    warn(`.env anterior respaldado → ${path.basename(bak)}`);
  }
  const lines = [
    `# Generado por scripts/setup.js — ${new Date().toISOString()}`,
    `# Modo de despliegue: ${mode}`,
    '',
    '# ── Servidor ──',
    `PORT=${fields.port}`,
    `BASE_URL=${fields.baseUrl}`,
    '',
    '# ── Base de datos ──',
    `DATABASE_URL=${fields.databaseUrl}`,
    ...(fields.pgPassword ? [`PG_PASSWORD=${fields.pgPassword}`] : []),
    '',
    '# ── Admin ──',
    `ADMIN_USER=${fields.adminUser}`,
    `ADMIN_PASS=${fields.adminPass}`,
    '',
    '# ── Sesión ──',
    `SESSION_SECRET=${fields.sessionSecret}`,
    '',
    '# ── Entorno ──',
    `NODE_ENV=${fields.nodeEnv}`,
    '',
    '# ── Monitoreo ──',
    `SENTRY_DSN=${fields.sentryDsn}`,
  ];
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
  ok('.env guardado (permisos 600)');
}

// ── Generar archivo de variables para Portainer ───────────────────────────
function writePortainerEnv(fields) {
  const outPath = path.join(ROOT, 'portainer.env');
  const lines = [
    `# Variables de entorno para Portainer`,
    `# Copia y pega estas líneas en:`,
    `#   Portainer → Stacks → [tu stack] → Environment variables`,
    `# Generado: ${new Date().toISOString()}`,
    '',
    `PORT=${fields.port}`,
    `BASE_URL=${fields.baseUrl}`,
    `NODE_ENV=${fields.nodeEnv}`,
    `ADMIN_USER=${fields.adminUser}`,
    `ADMIN_PASS=${fields.adminPass}`,
    `SESSION_SECRET=${fields.sessionSecret}`,
    `DATABASE_URL=${fields.databaseUrl}`,
    ...(fields.pgPassword ? [`PG_PASSWORD=${fields.pgPassword}`] : []),
    `SENTRY_DSN=${fields.sentryDsn}`,
  ];
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  ok(`portainer.env guardado → cópialo en Portainer`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  blank();
  console.log(c.cyan(c.bold('  ╔══════════════════════════════════════════════════╗')));
  console.log(c.cyan(c.bold('  ║      LabShortURL — Asistente de Instalación      ║')));
  console.log(c.cyan(c.bold('  ╚══════════════════════════════════════════════════╝')));
  blank();

  // ── Detección ──────────────────────────────────────────────────────────
  console.log(c.bold('  Detectando entorno…') + '\n');
  const env = detectEnv();

  if (env.docker) {
    let label = `Docker ${env.dockerVersion}`;
    if (env.swarm) label += ` · Swarm ${env.swarmManager ? c.green('(manager)') : c.yellow('(worker)')}`;
    ok(label);
    if (env.compose) ok('Docker Compose disponible');
  } else {
    fail('Docker no detectado');
  }

  if (env.portainer) {
    const pUrl = env.portainerUrl ? ` (${c.cyan(env.portainerUrl)})` : '';
    ok(`Portainer detectado${pUrl}`);
  } else {
    info('Portainer no detectado en este host');
  }

  if (env.pm2) ok('PM2 disponible');
  else         info('PM2 no detectado');

  blank();
  if (env.publicIp)           ok(`IP pública: ${c.cyan(env.publicIp)}`);
  else                        warn('No se pudo detectar la IP pública');
  if (env.localIps.length)    info(`IPs locales: ${env.localIps.join(', ')}`);
  if (env.port443)            ok('Puerto 443 activo → proxy HTTPS detectado');
  if (env.port80)             info('Puerto 80 activo');
  if (env.hasEnv)             { blank(); warn('Ya existe un archivo .env (se respaldará antes de sobreescribir)'); }

  const rl = makeRL();

  try {
    // ── Modo de despliegue ────────────────────────────────────────────────
    section('Modo de despliegue');

    const modeOptions = [];

    // Portainer es la primera opción si está detectado
    if (env.portainer && env.docker) {
      if (env.swarm && env.swarmManager) {
        modeOptions.push({
          label: `Portainer + Swarm    ${c.dim('(stack en Portainer, alta disponibilidad)')}`,
          value: 'portainer-swarm',
        });
      }
      modeOptions.push({
        label: `Portainer Standalone ${c.dim('(stack en Portainer, docker-compose.yml)')}`,
        value: 'portainer',
      });
    }

    if (env.compose) {
      modeOptions.push({
        label: `Docker Compose CLI   ${c.dim('(docker compose up -d en terminal)')}`,
        value: 'compose',
      });
    }
    if (env.swarm && env.swarmManager && !env.portainer) {
      modeOptions.push({
        label: `Docker Swarm CLI     ${c.dim('(docker stack deploy en terminal)')}`,
        value: 'swarm',
      });
    }
    if (env.pm2) {
      modeOptions.push({
        label: `PM2                  ${c.dim('(sin Docker, proceso Node directo)')}`,
        value: 'pm2',
      });
    }
    modeOptions.push({
      label: `Solo generar .env    ${c.dim('(configuración manual)')}`,
      value: 'manual',
    });

    if (env.swarm && !env.swarmManager) {
      warn('Este nodo es un Swarm worker. Conéctate al nodo manager para desplegar stacks.');
      blank();
    }

    const mode = modeOptions.length === 1
      ? modeOptions[0].value
      : await choose(rl, null, modeOptions, 0);

    // ── Red y dominio ─────────────────────────────────────────────────────
    section('Red y dominio');

    let defaultUrl = 'http://localhost:3000';
    if (env.port443 && env.publicIp) defaultUrl = `https://${env.publicIp}`;
    else if (env.publicIp)           defaultUrl = `http://${env.publicIp}:3000`;

    const baseUrl = await ask(rl,
      'Dominio o URL base (incluye http:// o https://)',
      defaultUrl, { validate: V.url }
    );

    const isHttps = baseUrl.startsWith('https://');
    let behindProxy = isHttps || env.port443;
    if (!isHttps) {
      info('(Activa cookies seguras, trust proxy y HSTS)');
      behindProxy = await confirm(rl,
        '¿La app estará detrás de un proxy HTTPS (nginx, Traefik, Cloudflare)?',
        env.port443
      );
    }
    const nodeEnv = (isHttps || behindProxy) ? 'production' : 'development';

    let port = '3000';
    if (mode !== 'swarm' && mode !== 'portainer-swarm') {
      port = await ask(rl, 'Puerto expuesto al host', '3000', { validate: V.port });
    }

    // ── Admin ─────────────────────────────────────────────────────────────
    section('Cuenta de administrador');

    const adminUser = await ask(rl, 'Nombre de usuario admin', 'admin');
    const adminPass = await ask(rl, 'Contraseña admin', '', { secret: true, validate: V.pass });
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    info('Session secret generado automáticamente');

    // ── Base de datos ─────────────────────────────────────────────────────
    section('Base de datos (PostgreSQL)');

    let databaseUrl, pgPassword;

    if (mode === 'portainer' || mode === 'compose') {
      info('docker-compose.yml incluye un servicio "db" (postgres:16-alpine).');
      const useBundled = await confirm(rl, '¿Usar ese PostgreSQL incluido?', true);
      if (useBundled) {
        pgPassword  = crypto.randomBytes(16).toString('hex');
        databaseUrl = `postgresql://labshorturl:${pgPassword}@db:5432/labshorturl`;
        info('Contraseña de PostgreSQL generada automáticamente');
      } else {
        databaseUrl = await ask(rl, 'DATABASE_URL',
          'postgresql://user:pass@host:5432/labshorturl', { validate: V.dbUrl });
      }

    } else if (mode === 'portainer-swarm' || mode === 'swarm') {
      info('docker-stack.yml incluye un servicio "db" (postgres:16-alpine).');
      const useBundled = await confirm(rl, '¿Usar ese PostgreSQL incluido?', true);
      if (useBundled) {
        pgPassword  = crypto.randomBytes(16).toString('hex');
        databaseUrl = `postgresql://labshorturl:${pgPassword}@db:5432/labshorturl`;
        info('Contraseña de PostgreSQL generada automáticamente');
      } else {
        databaseUrl = await ask(rl, 'DATABASE_URL de PostgreSQL externo',
          'postgresql://user:pass@host:5432/labshorturl', { validate: V.dbUrl });
      }

    } else {
      // PM2 / manual
      info('Necesitas un servidor PostgreSQL accesible desde esta máquina.');
      const localPg = await confirm(rl, '¿PostgreSQL corre en localhost?', true);
      databaseUrl = await ask(rl, 'DATABASE_URL',
        localPg
          ? 'postgresql://labshorturl:labshorturl@localhost:5432/labshorturl'
          : 'postgresql://user:pass@host:5432/labshorturl',
        { validate: V.dbUrl }
      );
    }

    // ── Opcionales ────────────────────────────────────────────────────────
    section('Opcionales');

    info('Sentry: monitoreo de errores en tiempo real. Obtén el DSN en sentry.io');
    const sentryDsn = await ask(rl, `Sentry DSN ${c.dim('(Enter para omitir)')}`, '');

    // ── Resumen ───────────────────────────────────────────────────────────
    blank();
    console.log(c.bold(hr('═')));
    console.log(c.bold('  Resumen de configuración'));
    console.log(c.bold(hr('═')));
    blank();

    const col = (k, v) => console.log(`  ${c.dim(k.padEnd(16))} ${c.cyan(v)}`);
    const dbDisplay = databaseUrl.replace(/:([^:@/]+)@/, ':***@');
    col('BASE_URL',     baseUrl);
    col('NODE_ENV',     nodeEnv);
    col('Puerto',       port || '3000');
    col('ADMIN_USER',   adminUser);
    col('DATABASE_URL', dbDisplay);
    col('Sentry',       sentryDsn ? 'configurado' : 'no configurado');
    col('Modo deploy',  mode);
    if (behindProxy) info('Trust proxy + cookies seguras activadas');

    blank();
    const save = await confirm(rl, c.bold('¿Guardar configuración?'), true);
    if (!save) { console.log(c.yellow('\n  Cancelado. No se guardaron cambios.\n')); rl.close(); return; }

    const fields = {
      port: port || '3000', baseUrl, nodeEnv,
      adminUser, adminPass, sessionSecret,
      databaseUrl, pgPassword: pgPassword || null,
      sentryDsn,
    };

    // ── Guardar archivos ──────────────────────────────────────────────────
    blank();
    writeEnv(fields, mode, env.hasEnv);
    if (mode === 'portainer' || mode === 'portainer-swarm') {
      writePortainerEnv(fields);
    }

    // ── Próximos pasos ────────────────────────────────────────────────────
    section('Próximos pasos');

    const pUrl = env.portainerUrl || 'http://localhost:9000';

    if (mode === 'portainer') {
      // ── Portainer Standalone ──────────────────────────────────────────
      step(1, `Abre Portainer → ${c.cyan(pUrl)}`);
      blank();
      step(2, 'Crea el stack:');
      note(`Stacks → ${c.bold('+ Add stack')}`);
      note(`Name: ${c.cyan('labshorturl')}`);
      note(`Build method: ${c.bold('Web editor')}  (pega el contenido de docker-compose.yml)`);
      blank();
      step(3, `Añade las variables de entorno:`);
      note(`Sección ${c.bold('"Environment variables"')} → ${c.bold('"Load variables from .env file"')}`);
      note(`Sube o pega el contenido de ${c.cyan('portainer.env')} (generado en el paso anterior)`);
      note(`O añádelas manualmente una a una`);
      blank();
      step(4, `Haz clic en ${c.bold('"Deploy the stack"')}`);
      step(5, `Abre ${c.cyan(baseUrl)} en tu navegador`);
      step(6, 'Configura backup automático (cron):');
      cmd(`0 3 * * * ${path.join(ROOT, 'scripts/backup.sh')} >> ${path.join(ROOT, 'logs/backup.log')} 2>&1`);

    } else if (mode === 'portainer-swarm') {
      // ── Portainer Swarm ───────────────────────────────────────────────
      step(1, `Abre Portainer → ${c.cyan(pUrl)}`);
      blank();
      step(2, 'Crea los secrets (Portainer UI):');
      note(`Swarm → ${c.bold('Secrets')} → ${c.bold('+ Add secret')}`);
      const secrets = [
        ['labshorturl_admin_pass',      adminPass],
        ['labshorturl_session_secret',  sessionSecret],
        ['labshorturl_database_url',    databaseUrl],
        ...(pgPassword ? [['labshorturl_pg_password', pgPassword]] : []),
        ...(sentryDsn  ? [['labshorturl_sentry_dsn',  sentryDsn]]  : []),
      ];
      for (const [name, value] of secrets) {
        note(`Name: ${c.cyan(name)}  /  Value: ${c.dim(value.length > 40 ? value.slice(0, 40) + '…' : value)}`);
      }
      blank();
      step(3, 'Crea el stack:');
      note(`Stacks → ${c.bold('+ Add stack')}`);
      note(`Name: ${c.cyan('labshorturl')}`);
      note(`Build method: ${c.bold('Web editor')}  (pega el contenido de docker-stack.yml)`);
      note(`Añade estas variables de entorno en la sección ${c.bold('"Environment variables"')}:`);
      note(`  ${c.cyan('BASE_URL')}=${baseUrl}`);
      note(`  ${c.cyan('NODE_ENV')}=${nodeEnv}`);
      if (sentryDsn) note(`  ${c.cyan('SENTRY_DSN')}=${sentryDsn}`);
      blank();
      step(4, `Haz clic en ${c.bold('"Deploy the stack"')}`);
      step(5, `Abre ${c.cyan(baseUrl)} en tu navegador`);
      blank();
      info(`Consejo: en Portainer puedes actualizar la imagen con:`);
      info(`  Stacks → labshorturl → Editor → "Update the stack"`);

    } else if (mode === 'compose') {
      step(1, 'Levanta los servicios:');
      cmd('docker compose up -d');
      step(2, `Abre ${c.cyan(baseUrl)} en tu navegador`);
      step(3, 'Configura backup automático (cron):');
      cmd(`0 3 * * * ${path.join(ROOT, 'scripts/backup.sh')} >> ${path.join(ROOT, 'logs/backup.log')} 2>&1`);

    } else if (mode === 'swarm') {
      step(1, 'Crea los Docker secrets:');
      if (pgPassword) cmd(`printf '%s' '${pgPassword}' | docker secret create labshorturl_pg_password -`);
      cmd(`printf '%s' '${adminPass}' | docker secret create labshorturl_admin_pass -`);
      cmd(`printf '%s' '${sessionSecret}' | docker secret create labshorturl_session_secret -`);
      cmd(`printf '%s' '${databaseUrl}' | docker secret create labshorturl_database_url -`);
      if (sentryDsn) cmd(`printf '%s' '${sentryDsn}' | docker secret create labshorturl_sentry_dsn -`);
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

    blank();
    console.log(c.green(c.bold('  ¡Configuración completada!')));
    blank();

  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(c.red(`\n  Error: ${err.message}\n`));
  process.exit(1);
});
