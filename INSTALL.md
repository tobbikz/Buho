# Puesta en marcha de Búho

Guía para instalar Búho en un servidor nuevo, sin conocer el código. Toma unos
quince minutos, y la mayor parte es crear el usuario de monitoreo en cada base.

Si sólo se quiere ver funcionando: `./install.sh` y saltar a
[Primer ingreso](#primer-ingreso).

---

## Qué se está instalando

Tres procesos, en contenedores separados:

| Proceso | Qué hace | Con qué habla |
| --- | --- | --- |
| **store** | PostgreSQL donde Búho guarda su propia historia | nadie más |
| **collector** | se conecta a cada base monitoreada, muestrea y corre los checks | las bases monitoreadas y el store |
| **web** | la consola | **sólo** el store |

Esa última frontera es deliberada: un render de la consola no puede abrir
conexiones contra la base de un cliente. Las credenciales de las instancias
monitoreadas existen únicamente en el colector.

Búho es **agentless**: no se instala nada en los servidores monitoreados. Se
conecta como un cliente más, con un usuario de sólo lectura.

---

## Requisitos

- Linux con Docker y el plugin `compose` (`docker compose version`)
- 2 GB de RAM y 10 GB de disco libres para empezar; el store crece con la
  retención configurada y el número de instancias
- Alcance de red desde el servidor de Búho hacia cada base a monitorear
- `openssl` para generar los secretos la primera vez

No hace falta Node ni PostgreSQL en el host: todo va dentro de los contenedores.

---

## 1. Usuario de monitoreo, uno por servidor

Búho nunca necesita escribir. Los scripts de `sql/` crean un usuario con el
mínimo privilegio que cada motor exige para leer sus propias estadísticas, y
están comentados con **por qué** hace falta cada permiso.

```bash
# PostgreSQL — rol pg_monitor, sin acceso a los datos de las tablas
psql   -h TU_SERVIDOR -U postgres -f sql/monitor-user.sql

# MariaDB — PROCESS, REPLICATION CLIENT, SLAVE MONITOR
mariadb -h TU_SERVIDOR -u root   < sql/monitor-user-mariadb.sql

# SQL Server — VIEW SERVER STATE, VIEW ANY DEFINITION, lectura de msdb
sqlcmd -S TU_SERVIDOR -U sa      -i sql/monitor-user-mssql.sql
```

Cada script deja al final la contraseña que hay que cambiar. Cambiarla ahí y
usar la misma en `config.json`.

Lo que un usuario así **no** puede hacer: leer filas de las tablas, escribir,
cambiar configuración, ni ver contraseñas. Lo que sí ve: nombres de objetos,
textos de consultas normalizados (`pg_stat_statements`) y planes de ejecución.
Si eso último es sensible en el entorno, conviene decidirlo antes de instalar y
no después.

### Extras opcionales de PostgreSQL

Búho funciona sin ellos, pero pierde vistas completas:

```sql
-- Consultas más caras, planes y el análisis por consulta.
-- Requiere reinicio: shared_preload_libraries no es recargable.
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
ALTER SYSTEM SET track_io_timing = on;   -- este sí es recargable
-- reiniciar, y después, dentro de cada base:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Bloat medido de verdad, para el botón "medir" de la pantalla de vacuum.
-- Sin esto el bloat sigue estimándose, que es honesto pero aproximado.
CREATE EXTENSION IF NOT EXISTS pgstattuple;
GRANT pg_stat_scan_tables TO buho_monitor;   -- estadísticas, no datos
```

### Extras opcionales de MariaDB

Sin `performance_schema` no hay analítica de consultas: la pantalla de consultas
queda vacía y lo dice. Encenderlo requiere reiniciar y cuesta cerca de un 5 % de
CPU. Sin `log_bin` no hay métricas de binlog ni de replicación.

```ini
[mysqld]
performance_schema = ON
slow_query_log     = ON
long_query_time    = 0.1
log_output         = TABLE   ; para que Búho lea el slow log por SQL
```

### Extras opcionales de SQL Server

Las consultas salen de la caché de planes, que se vacía al reiniciar el servicio
y bajo presión de memoria. Para que sobrevivan, Query Store, que es por base:

```sql
ALTER DATABASE [MiBase] SET QUERY_STORE = ON;
GRANT EXECUTE ON sys.xp_readerrorlog TO buho_monitor;  -- log de errores
```

Los deadlocks completos ya salen de la sesión `system_health`, que viene
encendida por omisión y no hay que configurar.

---

## 2. Configuración

```bash
git clone <repo> buho && cd buho
./install.sh          # crea .env y config.json, y se detiene para que se edite
```

`.env` lo genera el script con secretos aleatorios y no lo vuelve a tocar:
regenerar `BUHO_AUTH_SECRET` cerraría todas las sesiones abiertas.

En `config.json`, una entrada por servidor:

```json
{
  "instances": [
    {
      "alias": "ventas-prod",
      "environment": "prod",
      "host": "10.0.0.10",
      "port": 5432,
      "database": "ventas",
      "user": "buho_monitor",
      "password": "la-que-se-puso-en-el-script",
      "tags": { "grupo": "produccion-cr", "equipo": "datos" }
    }
  ]
}
```

Campos que vale la pena conocer:

| Campo | Para qué |
| --- | --- |
| `alias` | cómo se llama en la consola; único |
| `engine` | `postgres` (por omisión), `mariadb` o `mssql` |
| `tags` | agrupan y filtran la flota; `grupo` es el que usa la barra lateral |
| `hostMetrics` | CPU, memoria y disco del servidor. PostgreSQL no los expone: se leen de `/proc`, en `local` o por `ssh` |
| `logs` | lectura del log de PostgreSQL: de ahí salen los deadlocks completos y los errores de la aplicación |
| `collector.retention` | cuántos días se guarda cada resolución |

`config.example.json` tiene los tres motores y todas las opciones con
comentarios.

### Métricas del host (opcional)

Sin esto, Búho no puede decir si la lentitud es de la base o del servidor.
Como es agentless, se leen por SSH con una llave dedicada:

```json
"hostMetrics": {
  "source": "ssh",
  "target": "buho@10.0.0.10",
  "identityFile": "/etc/buho/id_ed25519",
  "dataDirectory": "/var/lib/postgresql/18/main"
}
```

El usuario remoto sólo necesita leer `/proc` y correr `df`: ningún privilegio
especial. Si Búho corre en el mismo servidor, `"source": "local"`.

### Log de PostgreSQL (opcional)

```json
"logs": { "source": "journal", "access": "ssh", "target": "buho@10.0.0.10", "unit": "postgresql" }
```

o, si el log va a archivos:

```json
"logs": { "source": "file", "access": "local", "path": "/var/log/postgresql/*.log" }
```

Para que el log sirva de verdad conviene, en la instancia monitoreada:

```sql
ALTER SYSTEM SET log_lock_waits = on;         -- esperas de lock con detalle
ALTER SYSTEM SET deadlock_timeout = '1s';
ALTER SYSTEM SET log_min_duration_statement = '1s';
ALTER SYSTEM SET log_checkpoints = on;
-- 'jsonlog' es el formato que menos se rompe al parsear
ALTER SYSTEM SET log_destination = 'jsonlog';
SELECT pg_reload_conf();
```

---

## 3. Arranque

```bash
./install.sh
```

Construye las imágenes, levanta los tres contenedores, espera a que el colector
aplique el esquema y verifica que ya estén entrando muestras. Al final imprime
la URL y la contraseña de arranque.

Opciones:

| Comando | Cuándo |
| --- | --- |
| `./install.sh` | instalar o actualizar (compila en el host) |
| `./install.sh --pull` | **bajar imágenes publicadas; el cliente no compila** |
| `./install.sh --sin-build` | reiniciar sin reconstruir ni bajar |
| `./install.sh --verificar` | comprobar una instalación existente |

### Sin compilar (lo que se vende)

El cliente no necesita Node ni `docker build`. Con Docker y Compose basta:

```bash
git clone https://github.com/tobbikz/buho-monitor.git
cd buho-monitor
# editar config.json (ver sección 2) y crear el usuario de monitoreo
./install.sh --pull
```

Eso baja `collector` y `web` desde GHCR (`ghcr.io/tobbikz/buho-monitor/...`)
y levanta el store. Para fijar una versión concreta:

```bash
export BUHO_COLLECTOR_IMAGE=ghcr.io/tobbikz/buho-monitor/collector:0.3.0
export BUHO_WEB_IMAGE=ghcr.io/tobbikz/buho-monitor/web:0.3.0
./install.sh --pull
```

Las imágenes se publican automáticamente al etiquetar un release (`v0.3.0`).
Si GHCR pide autenticación para paquetes privados: `echo $TOKEN | docker login ghcr.io -u USUARIO --password-stdin`.

---

## Primer ingreso

1. Abrir <http://127.0.0.1:3100>
2. Entrar con la contraseña que imprimió el instalador (está en `.env`, como
   `BUHO_AUTH_PASSWORD`)
3. **Administración → Usuarios**: crear la cuenta propia como `admin`

En cuanto existe una cuenta, la contraseña de arranque deja de funcionar. Hay
dos roles y no más: `admin` cambia configuración, usuarios, descubrimiento y
retención; `viewer` sólo lee.

La consola escucha en `127.0.0.1` a propósito. Para exponerla, un proxy con TLS
delante o una VPN. La autenticación no reemplaza a ninguno de los dos.

Ejemplo mínimo con nginx:

```nginx
server {
  listen 443 ssl;
  server_name buho.empresa.com;
  ssl_certificate     /etc/ssl/certs/buho.pem;
  ssl_certificate_key /etc/ssl/private/buho.key;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Con TLS terminado en el proxy, dejar `BUHO_AUTH_COOKIE_SECURE=false`: exigir
`secure` detrás de un proxy que habla HTTP hacia Búho impide entrar a todos.

---

## Qué mirar el primer día

| Pantalla | Qué contesta |
| --- | --- |
| **Resumen** | qué instancia está peor ahora |
| **Chequeos** | los 22 chequeos de toda la flota, priorizados por cuántas instancias toca cada uno |
| **Informe** | cómo se portó la semana; se descarga en Markdown |
| **Parque** | versiones, configuración, disco, replicación, respaldos, jobs y licencias |
| **Seguridad** | autenticación, privilegios, cifrado, superficie de ataque y auditoría |

Las líneas base ("¿es normal este número para un martes a las 3pm?") necesitan
historia: aparecen a los pocos días con la forma por hora del día, y a las cinco
semanas empiezan a distinguir el martes del domingo.

---

## Comprobar que todo responde

```bash
BUHO_URL=http://127.0.0.1:3100 BUHO_USER=tu-usuario BUHO_PASSWORD=tu-contraseña \
  npm run verify:v1
```

Entra a la consola y abre las 27 pantallas, comprobando el código HTTP, que no
haya errores de JavaScript y que ninguna esté mostrando el panel de error del
store (que responde 200 y parece una página buena). Sale con código 1 si algo
falla, así que sirve en CI o después de actualizar.

Necesita Playwright instalado en el host donde se corre:
`npx playwright install chromium`.

### Ensayar la instalación completa antes de tocar un servidor de un cliente

```bash
npm run ensayo:instalacion          # instala, comprueba y borra
npm run ensayo:instalacion -- --dejar   # deja todo arriba para mirarlo
```

Levanta un PostgreSQL nuevo, crea el usuario de monitoreo con
`sql/monitor-user.sql`, instala Búho en una copia limpia del proyecto con puertos
propios (3200 y 55433, para no chocar con nada) y verifica de punta a punta:
muestras escritas, chequeos corridos, consola accesible con la contraseña de
arranque, todas las pantallas respondiendo, y una segunda corrida que no
regenera los secretos ni pierde datos.

Es la prueba que conviene correr después de cualquier cambio en `install.sh`, en
el `docker-compose.yml`, en los scripts de `sql/` o en el arranque del colector:
son exactamente las partes que funcionan en una máquina ya configurada y fallan
en una limpia.

---

## Operación

```bash
docker compose ps                        # estado
docker compose logs -f collector         # qué está recolectando
docker compose logs -f web               # errores de la consola
docker compose restart collector         # recargar config.json
docker compose down                      # detener, conservando los datos
```

`config.json` se lee al arrancar el colector: después de editarlo hay que
reiniciarlo.

### Respaldo del store

Lo único que hay que respaldar es el store; todo lo demás se reconstruye desde
`config.json`. Y es justo lo que el cliente está pagando: la historia.

El respaldo viene automatizado como un servicio del compose. Corre solo, cada
día, conserva las últimas siete copias y deja el resultado en
**Instancia → eventos del colector**, para que un respaldo que falla se vea en
la consola en vez de descubrirse el día que hay que restaurar.

En `.env`:

```bash
BUHO_BACKUP_DIR=/var/backups/buho   # ruta del host, no un volumen de docker
BUHO_BACKUP_EVERY=86400             # segundos entre copias
BUHO_BACKUP_KEEP=7                  # cuántas conservar
```

La ruta es del host a propósito: un respaldo guardado dentro de un volumen de
docker se borra con el mismo `docker compose down -v` que borra el store.

Para restaurar en un store vacío:

```bash
docker compose up -d store
docker compose exec -T store pg_restore -U buho -d buho --no-owner < buho-FECHA.dump
docker compose up -d
```

El formato es el propio de `pg_dump` (`-Fc`), así que se puede restaurar en
paralelo (`-j 4`) o sólo una tabla.

### Actualizar

```bash
git pull && ./install.sh
```

El esquema se migra solo al arrancar el colector.

### Cuánto ocupa

Con retención por omisión (7 días en crudo, 30 en 5 minutos, 400 en una hora),
una instancia de PostgreSQL ronda 1–2 GB al año. La consola muestra el tamaño
real por tabla en el resumen de flota, y **Administración → Retención** permite
ajustarlo sin reiniciar nada.

---

## Cuando algo no funciona

**La consola dice "Consola sin autenticación".**
Falta `BUHO_AUTH_SECRET` o `BUHO_AUTH_PASSWORD` en el entorno del contenedor
web. Comprobar que `.env` existe y `docker compose up -d` se corrió después.

**No entran muestras de una instancia.**
`docker compose logs --tail 40 collector` dice exactamente qué falló. Los tres
casos habituales: credenciales, `pg_hba.conf` que no admite la IP de Búho, o un
firewall en el medio. Probar la conexión desde el contenedor:

```bash
docker compose exec collector npx tsx apps/cli/src/main.ts
```

**No hay CPU ni memoria del servidor.**
Falta `hostMetrics`, o el usuario SSH no puede leer el `data_directory`. Búho
sube por el árbol de directorios hasta uno legible para sacar el uso del
sistema de archivos, pero necesita entrar por SSH.

**No aparecen las consultas más caras.**
Falta `pg_stat_statements`: hay que ponerlo en `shared_preload_libraries`,
reiniciar el servidor y crear la extensión en cada base. La consola dice en qué
paso está cada instancia.

**El log no trae nada.**
La pantalla de Log de cada instancia muestra el origen que se está leyendo y las
limitaciones detectadas. Con `journal` el usuario SSH tiene que estar en el grupo
`systemd-journal`.

**Los respaldos salen como "no verificable".**
Búho reporta lo que el motor sabe de sus propios respaldos. Una herramienta
externa que no deja rastro en el motor no aparece, y eso no significa que no
exista. En PostgreSQL, "sin recuperación" con `archive_mode = off` sí es real: no
hay recuperación a un punto en el tiempo.

---

## Desinstalar

```bash
docker compose down -v    # -v borra también la historia del store
```
