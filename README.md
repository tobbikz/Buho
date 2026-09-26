# Búho

Monitor de bases de datos **on-prem**: un colector, un store y una consola. Sin Prometheus, sin Grafana, sin agente en el host del cliente.

**PostgreSQL primero** (13–18). Cubiertos también: MSSQL, MariaDB/MySQL y MongoDB (métricas + inventario en v0.4).

> Búho no solo grafica métricas: corre un catálogo de checks y dice **qué está mal y cómo se arregla**.

---

## Qué hay hoy (v1.1+)

| Pieza | Estado |
|-------|--------|
| `packages/core` | Capability probe, pools, colectores PG + foreign (Maria/MSSQL/Mongo), deltas, bloqueos, host, inventario, seguridad, descubrimiento |
| `packages/checks` | 22 checks PG + checks Maria/MSSQL + pack de sistema + custom SQL alerts |
| `packages/store` | Schema particionado, rollups, alertas (`alert_*`), retención, inventario |
| `apps/collector` | Scheduler por tiers + reconcile/flush de alertas |
| `apps/cli` (`buho-check`) | Informe de salud **gratis** (lead gen) — mismos checks, sin store |
| `apps/web` | Consola: flota, checks, alerts, estate, seguridad, análisis, admin |
| Licencia | Business Source License 1.1 — ver `LICENSE` |
| Go-live | Checklist primer cliente: **[GO_LIVE.md](GO_LIVE.md)** |

---

## Instalar

```bash
./install.sh
```

Comprueba requisitos, genera los secretos, levanta store, colector y consola, y
verifica que estén entrando muestras. La guía completa —usuario de monitoreo por
motor, métricas del host, lectura del log, proxy con TLS, respaldo del store y
qué hacer cuando algo no funciona— está en **[INSTALL.md](INSTALL.md)**.
Checklist del **primer cliente en producción**: **[GO_LIVE.md](GO_LIVE.md)**.
Landing / pitch estático: **[landing/index.html](landing/index.html)**.

---

## Uso rápido

### Informe de una instancia (no escribe nada)

```bash
npm install
npm run check -- 'postgres://usuario:clave@127.0.0.1:5432/mibase'
```

Códigos de salida: `0` sin hallazgos · `1` avisos · `2` críticos · `3` error de conexión. Sirve directo en un cron o en CI.

### Monitoreo continuo

```bash
cp config.example.json config.json   # editar instancias
docker compose up -d                 # store + collector
docker compose logs -f collector
```

El store queda en `127.0.0.1:55432` (no 5432, para no chocar con un PostgreSQL local).

### Consola web

```bash
npm run web                          # dev en http://localhost:3100
docker compose up -d web             # o en contenedor, mismo puerto
```

En dev la UI toma la URL del store de `config.json`; en producción exige `BUHO_STORE_URL`. La consola **sólo lee el store**: nunca abre conexiones contra las instancias monitoreadas.

Autenticación por contraseña única:

```bash
BUHO_AUTH_PASSWORD="$(openssl rand -base64 24)"   # obligatoria en producción
BUHO_AUTH_COOKIE_SECURE=true                       # sólo si la consola sirve TLS ella misma
```

En producción sin `BUHO_AUTH_PASSWORD` la consola **no sirve ninguna página**: redirige todo a una pantalla que explica cómo configurarla. En desarrollo se permite entrar sin contraseña, con un aviso visible en la parte superior.

Pantallas de F1:

- **Resumen de flota** — score, críticos, avisos, conexiones, cache hit, commits/s y frescura del dato por instancia.
- **Detalle de instancia** — capabilities, indicadores con **CPU y memoria del host, throughput DML**, health score, conexiones, cache hit, commits/s, bloqueos, edad de XID, tuplas muertas y uptime; series con ventana de 15 m a 7 días (conexiones, transacciones/s, WAL/s, bloqueos, CPU y memoria del host, throughput DML, sesiones activas por clase de espera, cache hit, I/O/s, derrame a temporales), hallazgos agrupados por severidad y por check (paginados, remediación una vez por grupo), wait events, tablas más grandes, tuplas muertas, slots de replicación y eventos del colector (cada fila se abre y muestra componente, ocurrencias, primera y última vez, mensaje y detalle).
- **Parque** (`/estate`) — inventario de flota en siete dominios: **Backups**, **Disco**, **Jobs**, **Replicación**, **Configuración**, **Licencias** y **Versiones**. Es la sección multi-motor: cubre PostgreSQL, MariaDB y SQL Server.
- **Análisis** — cualquiera de las ~93 series del store en un gráfico de líneas: selector agrupado por familia con filtro de texto, **un gráfico por unidad** (mezclar sesiones y bytes en un eje aplasta la serie chica), desglose por etiqueta para una métrica sola y agregación entre etiquetas elegible. La selección viaja en la URL, así que el enlace *es* el gráfico.
- **Consultas** — top 25 por tiempo total, llamadas, media o filas en la ventana elegida, con % del tiempo, cache hit, temporales y WAL por consulta, sparkline de tendencia por fila y el texto completo desplegable. Cuando falta `pg_stat_statements`, la pantalla explica qué correr y si hace falta reiniciar.
- **Host** — CPU (uso, espera de I/O y CPU robada por el hipervisor), memoria, swap, carga por núcleo y disco del filesystem del data directory. Es opcional: si la instancia no lo declara, la pantalla explica cómo activarlo en lugar de mostrar charts vacíos.
- **Bloqueos** — árbol bloqueador → esperando con las dos queries y la transacción culpable, más el historial de episodios resueltos de las últimas 24 h.
- **Catálogo** (`/instances/[id]/orm`) — el grafo se arma por esquema (las tablas en un girasol alrededor de su anillo) y se queda quieto. Cambiar Structure / Traffic / Both no rearranca la simulación.

Refresco por polling cada 30 s, con botones de pausa y refresco manual: la tabla que estás leyendo no se mueve sola si no quieres. El topbar no muestra contador de frescura (re-renderizaba cada segundo para decir algo que el dato ya dice); la frescura por instancia está en la tabla de flota y en el encabezado del detalle.

### Usuario de monitoreo en la instancia a vigilar

```bash
psql -h HOST -U postgres -f sql/monitor-user.sql
```

Read-only vía `pg_monitor`: acceso a estadísticas y configuración, **nunca** a los datos de las tablas.

---

## Decisiones de diseño

**Un pool por instancia, con timeouts estrictos.** Si la base monitoreada se cuelga, Búho no se cuelga con ella. Cada ciclo va aislado: una instancia enferma no afecta a las demás.

**`application_name = buho_collector`** en toda conexión, para que el DBA vea de inmediato quién se conecta a su base.

**Capability probe obligatorio.** Las vistas de estadísticas cambian entre versiones: PG17 movió las estadísticas de checkpoint de `pg_stat_bgwriter` a `pg_stat_checkpointer`, y PG18 eliminó `wal_write`/`wal_sync` de `pg_stat_wal`. Un colector con SQL fijo se rompe al cambiar de versión.

**`stats_reset` se rastrea por fila, no por vista.** En `pg_stat_database` el reset es por base de datos. Sin ese guardia, un reinicio produce picos que nunca ocurrieron.

**Sin TimescaleDB.** Particionado declarativo nativo y rollups propios: una dependencia menos que justificar en on-prem, y purga por `DROP PARTITION` en vez de `DELETE`.

**Útil sin `pg_stat_statements`.** La mayoría de las instancias no lo tienen activo. El check distingue tres estados, y el caso "precargada pero sin `CREATE EXTENSION`" se resuelve sin reiniciar el servidor.

**Los checks callan cuando no aplican.** Sin standby ni slots, los checks de replicación no dicen nada en vez de alarmar.

**La UI no habla con las instancias monitoreadas.** Renderizar una pantalla nunca abre una conexión contra la base de un cliente: todo sale del store, que es lo único que la web conoce. Eso mantiene el costo de una visita a la consola en cero para la base vigilada.

**El colector es un proceso aparte de la web.** Un scheduler de larga vida no sobrevive los reloads ni el ciclo de vida de Next.js, y un reinicio de la consola no debe pausar la recolección.

**Los bloqueos se guardan como episodios, no como muestras.** La identidad de un episodio es `(instancia, pid que espera, inicio de su query)`: mientras el bloqueo sigue vivo se actualiza la misma fila. La UI muestra "un bloqueo de 4 minutos" en vez de veinticuatro muestras del mismo bloqueo.

**`pg_stat_activity` es del clúster, no de la base conectada.** La captura de bloqueos filtra por `datname = current_database()`; sin eso, dos entradas del config apuntando a dos bases del mismo servidor registran el mismo bloqueo dos veces. Lo mismo aplica a `pg_stat_statements`, que filtra por `dbid`.

**De `pg_stat_statements` se guardan deltas, no acumulados.** El contador crudo cuenta desde el último reset y no puede responder "qué fue caro en la última hora". El colector calcula la diferencia por `queryid` entre ciclos y descarta el intervalo si `stats_since` cambia o si `calls` retrocede, que es un reset y no una consulta que se ejecutó menos veces.

**Búho marca su propio SQL con `/* buho */`,** para que la pantalla de Consultas pueda separar el trabajo del monitor del trabajo de la aplicación sin adivinar por patrones de texto. La marca va **al final**: `pg_stat_statements` descarta los comentarios que preceden a la sentencia y conserva los que la siguen. Efecto secundario útil: el overhead del propio monitor queda medido y a la vista.

**CPU y memoria del host van en el Resumen, no escondidas en su pestaña.** Cuando la instancia declara `hostMetrics`, el Resumen abre con CPU, memoria y throughput DML como indicadores y agrega un chart de CPU/memoria antes de las aproximaciones: si hay dato del sistema operativo, es el que manda. El detalle completo (swap, carga por núcleo, disco) queda en la pestaña Host. Si no está configurado, el indicador lo dice y remite ahí.

**PostgreSQL no expone CPU ni RAM del host.** Búho grafica primero las aproximaciones que sí salen de la base (sesiones activas por clase de espera, *DB time* en sesiones equivalentes, cache hit, derrame a temporales) y además ofrece el dato real como **opción declarada por instancia**, leyendo `/proc` con `hostMetrics.source`:

| `source` | Cuándo | Qué se instala en el servidor vigilado |
|----------|--------|----------------------------------------|
| `none` (por defecto) | No se recogen recursos del host | nada |
| `local` | Búho corre en el mismo host que la base | nada |
| `ssh` | La base está en otro servidor | nada: un usuario de sólo lectura con acceso a `/proc` y `df` |

Sigue siendo *agentless*: no hay proceso residente en el servidor del cliente, sólo lectura de archivos. La conexión SSH usa `BatchMode=yes` para que una llave inválida falle y quede registrada, en vez de colgarse esperando una contraseña. `df` no se corre sobre el data directory (es 700 y propiedad de `postgres`): se sube al ancestro accesible, que está en el mismo filesystem.

**La CPU necesita dos lecturas.** `/proc/stat` da jiffies acumulados desde el arranque, así que el primer ciclo publica memoria, carga y disco pero **no** porcentaje de CPU: publicar el promedio histórico del host como si fuera el uso actual sería mentir.

**Un check no puede preguntarle a su propia sesión.** El pool de Búho fija `statement_timeout` e `idle_in_transaction_session_timeout` como parámetros del paquete de arranque, y eso contamina las dos vistas obvias: `current_setting()` devuelve el valor del monitor, y `reset_val` también, porque `RESET` vuelve al valor de arranque de la sesión y no al del archivo de configuración. El check de timeouts lee `pg_file_settings` (la configuración en disco) y cuenta aparte los overrides por rol o por base, que no evalúa.

**Las ventanas largas leen rollups, no muestras crudas.** Hasta 6 h se leen las muestras, hasta 3 días el rollup de 5 m y más allá el de 1 h. La columna de valor sigue la intención de la agregación: si el chart pide el peor caso, el rollup devuelve `min_value` y no el promedio, o el pico desaparece justo en la ventana donde importaba verlo. Cada panel dice de dónde salió el dato.

**Crear una partición sobre filas que ya están en la partición por defecto falla.** PostgreSQL no puede crear una partición de rango que solape filas guardadas en el `default`. La función de mantenimiento detecta el caso, desengancha el `default`, crea la partición, mueve las filas y lo vuelve a enganchar; el camino normal (partición creada por adelantado, `default` vacío) no toma ningún lock extra. Sin esto, un solo día escrito sin partición dejaba la tabla imposible de particionar para siempre.

**Sesión firmada, sin tabla de sesiones.** La cookie lleva su propia expiración con HMAC-SHA-256, así que reiniciar la consola no cierra sesiones y no hay estado que limpiar. El secreto se deriva de la contraseña: cambiarla revoca todo. La contra, asumida: no se puede revocar una sesión individual antes de que expire (12 h). La cookie es `HttpOnly` y `SameSite=Lax`, y `secure` es opcional porque la mayoría de las instalaciones on-prem terminan TLS en un proxy.

**`min` no es el peor caso de todos los porcentajes.** Con 99 % y 80 % de cache hit entre dos bases, el peor caso es el mínimo; con 5 % y 40 % de tuplas muertas, es el máximo. El catálogo de métricas marca los ratios donde *más es mejor* y el resto usa `max`, en vez de tratar a todos los porcentajes igual y esconder justo el problema que se busca.

**Las alertas son parte de Búho (desde v1.1).** Checks abren alertas con histéresis, silencios, reglas y entrega a Slack / Teams / Discord / Google Chat / Mattermost / Telegram / Rocket.Chat / PagerDuty / SMTP / webhook genérico. Admin → Alerts. Un producto **multi-fuente** de suite (DataSync + Quetzal + Búho) puede vivir aparte después; no quita el alerting nativo.

**Los porcentajes no se suman entre etiquetas.** Al agregar una métrica etiquetada por base de datos, las tasas se suman pero los ratios no: sumar el cache hit de cuatro bases da 397 %. La función de series recibe la operación (`sum`, `avg`, `min`, `max`) y el cache hit usa `min`, el peor caso.

---

## Alcance conocido de esta versión

- Las métricas de objetos (tuplas muertas, índices, tamaños de tabla) son de la **base conectada**; las de instancia (`pg_stat_database`, tamaños, replicación, WAL) cubren todo el servidor.
- El colector se ejecuta con `tsx` directamente sobre TypeScript. En F2 pasa a un bundle compilado.
- Las métricas de servidor (conexiones frente a `max_connections`, WAL, checkpoints, uptime) son del clúster completo. Si dos entradas del config apuntan al mismo servidor, esos números se repiten a propósito: el límite es compartido.
- Las muestras crudas se retienen 7 días; los rollups de 5 m 30 días y los de 1 h 400. Una ventana de más de 3 días muestra promedios por hora, no picos instantáneos (salvo en los charts que piden el peor caso).
- Hay dos roles y nada más, **admin** y **viewer**: la división es entre mirar y cambiar, no entre qué instancias ve cada quien. Un viewer ve todo lo monitoreado, textos de consultas y hallazgos de seguridad incluidos. La consola sigue escuchando en `127.0.0.1` y se asume detrás de un proxy o VPN.
- Un cambio de rol no surte efecto hasta que la sesión expira o el usuario vuelve a entrar, porque el rol viaja firmado en la cookie y no se consulta en cada petición. Para cortar acceso ya, se deshabilita la cuenta y se rota `BUHO_AUTH_SECRET`.
- El descubrimiento **no agrega instancias al monitoreo**: identifica motor y versión sin credenciales, pero monitorear exige credenciales y esas se declaran en `config.json`, no en un formulario web que las guardaría en la base.
- Las etiquetas se declaran en `config.json` y la consola no las edita: dos dueños del mismo dato terminan en que el colector borra lo que alguien acaba de escribir en la interfaz.
- Las métricas del host requieren Linux (`/proc`) y quedan desactivadas si no se declaran.
- La auditoría de seguridad **no prueba explotar nada**: sólo lee catálogos. No escanea puertos, no intenta iniciar sesión ni ejecuta pruebas de penetración. La única comprobación activa es la de contraseñas de diccionario en SQL Server, que usa `PWDCOMPARE` contra el hash guardado y por eso no genera intentos fallidos ni bloquea cuentas.
- La auditoría de seguridad cubre el servidor, no los datos: no clasifica columnas sensibles ni revisa permisos objeto por objeto. Eso es un producto distinto.
- El sugeridor de índices sólo opina de consultas cuyo plan alguien pidió con ANALYZE: no recorre `pg_stat_statements` por su cuenta. Menos ideas, todas verificables.
- La medición de bloat con `pgstattuple` exige la extensión instalada y que el rol la pueda ejecutar (`pg_stat_scan_tables`). Si falta, la celda lo dice en vez de ofrecer un botón que va a fallar.
- El sugeridor y el vacuum son de PostgreSQL. MariaDB y SQL Server tienen métricas, chequeos, consultas, bloqueos y log, pero no tienen un equivalente de vacuum ni planes en el mismo formato.
- Alerting nativo: canales chat/SMTP/webhook + pack de sistema + SQL custom (v1.1+). Un gateway multi-producto (Centinela) es opcional y vive aparte.
- No hay detección de crecimiento anómalo: exige comparar contra el historial del store, no una consulta a la instancia, y por eso no cabe en el modelo de checks actual.

---

## Estructura

```
packages/core     tipos, probe, pools, colectores, deltas, host, inventario, seguridad, descubrimiento, planes, config
packages/checks   catálogo de checks (SQL + severidad + remediación)
packages/store    schema, particiones, rollups, escritura
apps/collector    proceso de recolección 24/7
apps/cli          informe por consola
apps/web          consola Next.js 16 (App Router, server components)
scripts/          verificación de pantallas y sondas de paridad, bloat y sugeridor
sql/              usuario de monitoreo
```


## Parque multi-motor (PostgreSQL, MariaDB, SQL Server, MongoDB)

Una instancia declara su motor en el config; si no lo declara, es PostgreSQL:

```json
{ "alias": "mssql-prod", "engine": "mssql", "host": "10.0.0.30", "port": 1433,
  "database": "master", "user": "buho_monitor", "password": "..." }
```

**Los tres motores tienen el ciclo completo.** Métricas cada 5 s, chequeos, analítica de consultas, bloqueos y lectura del log: lo mismo para PostgreSQL, MariaDB y SQL Server. Lo que sigue siendo exclusivo de PostgreSQL son las dos cosas que no tienen equivalente en los otros —vacuum y bloat, y las métricas del host por SSH— más el sugeridor de índices, que se apoya en los planes de PostgreSQL.

Que el ciclo sea el mismo no significa que los números sean los mismos. Las vistas de estadísticas de los tres no se parecen, así que cada motor mide lo que puede medir y **lo que no puede se dice en vez de rellenarse con un cero**. Cuando dos motores miden lo mismo, la métrica se llama igual: `db_cache_hit_pct` es el ratio del buffer pool en MariaDB y el del buffer cache en SQL Server, y la misma pantalla sirve para los dos.

Lo que cada motor no puede dar sale como limitación explícita al sondear:

| Falta | Motor | Consecuencia |
|---|---|---|
| `performance_schema` apagado | MariaDB | Sin analítica de consultas. La pantalla lo dice y da el `my.cnf` |
| Sin privilegio `PROCESS` | MariaDB | Sólo ve sus propias sesiones: conexiones y bloqueos en cero |
| `log_bin` apagado | MariaDB | Sin métricas de binlog ni de replicación |
| Sin `VIEW SERVER STATE` | SQL Server | Sin sesiones, esperas ni I/O por archivo |
| Caché de planes vacía | SQL Server | Consultas vacías hasta que haya tráfico; Query Store lo hace persistente |

### Los siete dominios no se reparten igual entre motores

| Dominio | PostgreSQL | MariaDB | SQL Server |
|---|---|---|---|
| Versiones | `server_version_num` + fin de soporte | `version()` | versión, edición y nivel de parche |
| Configuración | `pg_settings.reset_val` | `information_schema.system_variables` | `sys.configurations` |
| Disco | tamaño de bases y tablespaces | `information_schema.tables` | archivos, topes y espacio real del volumen |
| Replicación | réplicas, slots, receptor de WAL | `SHOW REPLICA STATUS`, binlog, GTID | AlwaysOn y mirroring |
| **Backups** | sólo archivado de WAL (no hay catálogo) | sólo binlog (no hay catálogo) | catálogo real de `msdb..backupset` |
| **Jobs** | ninguno, salvo `pg_cron` | eventos del scheduler | SQL Agent con historial |
| **Licencias** | no aplica | no aplica | edición, núcleos y topes reales |

**Los vacíos se explican, no se esconden.** PostgreSQL y MariaDB no llevan catálogo de respaldos: nada dentro del servidor sabe si anoche corrió un `pg_dump`. En vez de mostrar un tab vacío que parece un bug, Búho reporta lo que sí es verificable desde dentro — el archivado de WAL o el binlog, que es lo que habilita la recuperación a un punto en el tiempo — y dice explícitamente qué no puede saber sin integrar pgBackRest, Barman o mariabackup. Un tab vacío sin explicación le quita credibilidad a todo lo demás que muestra la herramienta.

**Ausencia no es salud.** Con el archivado apagado, PostgreSQL igual emite su fila de respaldo, en rojo. En una vista de flota, una instancia que no aparece en la tabla se lee como una instancia sana, y ese es exactamente el error que no puede cometer esta pantalla.

### Decisiones de diseño del parque

**Instantáneas, no series.** El inventario reemplaza sus filas en cada lectura en vez de acumular historia: "¿qué servidor no tiene backup?" se responde sobre el último valor conocido, y guardar una fila por hora de algo que cambia una vez al mes sólo infla el store. Cada dominio hace upsert de lo que vino y borra lo que no; si se eliminó una base, la fila desaparece. El corte usa `captured_at < now()`, que es exacto porque `now()` es constante dentro de la transacción, en vez de un margen de tolerancia adivinado.

**Fin de soporte desde una tabla local, sin llamar a internet.** Un despliegue on-prem puede no tener salida, y una herramienta de monitoreo que consulta un servicio externo es lo que hace que seguridad la rechace. El costo es actualizar la tabla a mano cuando salen versiones nuevas; equivocarse por unos meses en una fecha de EOL es mucho menos grave que pedirle salida a internet al servidor de base de datos.

**La configuración se compara, no se lista.** Nadie audita 28 parámetros por 14 servidores. Lo que se busca es la divergencia — dos servidores que deberían ser gemelos y no lo son — y el default silencioso, el parámetro que nadie decidió nunca. La comparación es por motor: comparar `work_mem` con `innodb_buffer_pool_size` no significa nada.

**En SQL Server la licencia es un hallazgo, no un dato.** Dos casos valen dinero real: una edición Developer o Evaluation atendiendo producción, que es un incumplimiento de licencia, y núcleos que la edición no puede usar (Standard topa en 24), que es hardware pagado que el motor ignora en silencio.

**Un servidor es (host, puerto), no una fila del config.** En Búho una instancia es host:puerto/base, y tener dos entradas contra el mismo clúster es normal y útil para métricas y checks por base. Pero versiones, parámetros, bases, tablespaces, volúmenes y replicación son objetos del **clúster**: cada entrada los enumera todos. Sin colapsar por servidor, el parque reportaba el doble de disco (3.0 GB en vez de 1.8 GB) y comparaba un servidor consigo mismo como si fueran dos. Las consultas del parque llevan `distinct on (host, port, ...)` por eso.

**Cada motor recibe la pantalla que le corresponde.** La ruta de instancia renderizaba la plantilla de PostgreSQL para cualquier motor: un SQL Server mostraba "edad de XID", "WAL generado por segundo" y un aviso de `pg_stat_statements`, todo vacío. Ahora MariaDB y SQL Server tienen su propia vista de inventario, sus pestañas de PostgreSQL desaparecen y las URL directas a `/queries`, `/analysis`, `/host` y `/locks` redirigen. Mostrar campos que no aplican no es un hueco cosmético: quien lo ve concluye que la herramienta está rota y deja de creerle también a los datos correctos.

**El pool prestado no se cierra.** El inventario de PostgreSQL reutiliza el pool que ya tiene el colector, y su `close()` es inerte a propósito: sin eso, un `finally { client.close() }` de buena fe mataría el pool del colector y dejaría la instancia sin métricas.
---

## Seguridad (los tres motores)

Una capa aparte del parque: el parque responde *qué tengo*, seguridad responde *qué tan expuesto estoy*. No es
inventario sino un juicio, con severidad, evidencia y remediación por hallazgo. Se audita **cada 6 horas**,
porque la postura cambia cuando alguien edita una configuración o crea una cuenta, no de forma continua.

Seis categorías, con la comprobación equivalente en cada motor cuando existe:

| Categoría | PostgreSQL | MariaDB | SQL Server |
|---|---|---|---|
| Autenticación | `trust` y `md5` en `pg_hba.conf`, `password_encryption`, hashes reales en `pg_authid`, roles con login sin contraseña | plugin por cuenta (`mysql_old_password`, `mysql_native_password`), cuentas sin contraseña, anónimas, validación de contraseñas | contraseñas de diccionario vía `PWDCOMPARE`, `sa` habilitada, `CHECK_POLICY`, `CHECK_EXPIRATION`, modo mixto |
| Privilegios | superusuarios, `BYPASSRLS`, si Búho mismo es superusuario | `SUPER` alcanzable desde `'%'`, privilegios globales | miembros de `sysadmin`, `BUILTIN\Administrators`, bases `TRUSTWORTHY` |
| Cifrado | `ssl`, versión mínima de TLS | `require_secure_transport`, `have_ssl`, `REQUIRE SSL` por cuenta | TDE por base, conexiones en claro **ahora mismo**, certificados por vencer |
| Superficie | extensiones sensibles (`dblink`, `plpythonu`, …) | `local_infile`, `secure_file_priv` | `xp_cmdshell`, CLR, OLE Automation, consultas distribuidas ad hoc |
| Auditoría | `log_connections`, `pgaudit` | `server_audit`, `general_log` | especificaciones de SQL Server Audit |
| Acceso público | `CREATE` de `PUBLIC` por esquema, reglas abiertas a `0.0.0.0/0` | usuario anónimo, base `test` | — |

### Decisiones de diseño de la seguridad

**"No verificable" es un estado de primera clase, y es el motivo de todo el módulo.** Casi toda comprobación
interesante de seguridad está detrás de un permiso que un usuario de monitoreo normalmente no tiene:
`pg_authid` y `pg_hba_file_rules` piden superusuario, `mysql.user` pide `SELECT` sobre el esquema `mysql`,
`sys.sql_logins` pide `CONTROL SERVER`. Una comprobación que falla por permisos y se pinta como aprobada es
**peor que no tenerla**: el DBA cierra la pantalla convencido de que su servidor está bien cuando en realidad
Búho nunca pudo mirar. Cada bloque privilegiado atrapa el error y reporta el permiso exacto que falta, y la
pestaña Cobertura existe para que ese punto ciego sea visible en vez de silencioso.

**La postura se calcula sólo sobre lo verificado.** Contar lo desconocido como aprobado produce la mentira
cómoda —un puntaje alto con la mitad de las comprobaciones sin correr—. Contarlo como fallado es igual de
inútil: el número bajaría al faltar un permiso y subiría al concederlo, sin que la seguridad real cambiara.
Una sola crítica topa el puntaje en 55: un `trust` en `pg_hba.conf` no se compensa con veinte aciertos.

**Búho se audita a sí mismo.** Si el colector se conecta como superusuario, aparece un hallazgo con su nombre.
El riesgo lo introdujo esta herramienta y ocultarlo sería lo mismo que se le reclama a cualquier otra.

**Sólo lectura, nunca escritura.** La auditoría no cambia configuraciones ni cuentas; la remediación se
imprime como el comando exacto a ejecutar y la decisión queda en manos del DBA. La única comprobación activa
es `PWDCOMPARE`, que compara contra el hash guardado sin intentar iniciar sesión: no genera intentos fallidos
ni bloquea cuentas.

**Acá no se colapsa por (host, puerto), a diferencia del parque.** Dos entradas del config contra el mismo
clúster producen hallazgos repetidos, y aun así se muestran los dos: si una de las entradas usa un usuario con
menos permisos, sus resultados **no** son los mismos, y colapsarlas descartaría justo la lectura que sí vio el
problema. Duplicar un hallazgo molesta; esconderlo cuesta.

**Distinguir el valor seguro del peligroso vale más que la comprobación.** En MariaDB
`secure_file_priv = NULL` **deshabilita** la lectura y escritura de archivos: es el valor seguro, y el
peligroso es la cadena vacía. Marcar `NULL` como problema —el error intuitivo— habría producido una alarma
falsa en toda instalación por omisión, y una pantalla de seguridad con falsos positivos se deja de leer.

### Hallazgos reales de la primera corrida

Sobre las cuatro instancias de prueba, sin ajustar nada:

- **PostgreSQL 18.4**: seis reglas `trust` en `pg_hba.conf` (se entra sin contraseña, también como
  superusuario), `ssl = off`, el rol `postgres` sin contraseña, conexiones sin registrar y el propio usuario de
  Búho con superusuario. Postura 26/100.
- **MariaDB 11.4**: `root@'%'` y otra cuenta con `SUPER` alcanzables desde cualquier origen, las siete cuentas
  en `mysql_native_password`, TLS disponible pero no obligatorio, sin plugin de auditoría. Postura 20/100.
- **SQL Server 2025**: `BUILTIN\Administrators` como `sysadmin`, `sa` habilitada y sin caducidad, una conexión
  activa sin cifrar, ninguna base con TDE, sin auditoría configurada. Sin contraseñas de diccionario. Postura
  35/100.

Dos lecciones de implementación quedaron en el camino y valen para cualquier consulta futura:

- **MariaDB devuelve los nombres de columna con la capitalización de la definición** (`User`, `Super_priv`).
  Leerlos en minúscula da `undefined` en silencio, lo que hacía que toda cuenta pareciera anónima y sin
  privilegios: una alarma falsa de usuario anónimo y, peor, la detección de `root@'%'` con `SUPER` sin
  disparar. Todas las columnas van con alias explícito en minúscula.
- **`mysql.user` es una vista sobre `mysql.global_priv` desde MariaDB 10.4** y no expone el bloqueo de la
  cuenta ni la fecha de la contraseña; esos dos datos viven en el JSON de `global_priv` y se piden aparte para
  que la consulta principal siga sirviendo en versiones donde esa tabla no existe.
- **`tedious` pasa la dirección IP como nombre de servidor al negociar TLS** y Node 24 la rechaza, porque la
  RFC 6066 no permite una IP en SNI. El fallo era intermitente —sólo aparece en el camino de negociación de
  cifrado— y un ciclo de seguridad que falla al azar es peor que uno que falla siempre.

---

## Grupos, descubrimiento, cuentas y retención

Cuatro cosas que no son monitoreo pero sin las que el monitoreo no se usa: saber
qué instancia es de quién, qué hay en la red que nadie vigila, quién puede
cambiar la configuración y cuánto se guarda.

### Etiquetas y agrupación

No hay un campo `grupo`. Hay **etiquetas clave/valor** y "grupo" es la dimensión
que se está mirando:

```json
{
  "alias": "ventas-prod",
  "tags": { "grupo": "core-cr", "equipo": "datos", "cliente": "acme", "sitio": "san-jose" }
}
```

Un campo `grupo` fuerza una sola jerarquía, y la realidad tiene varias a la vez:
la misma instancia es del equipo de datos, del cliente ACME y del sitio de San
José. Con etiquetas, el selector **Agrupar por** de la flota cambia de dimensión
sin tocar el modelo, y aparecen además tres que Búho ya conoce sin que nadie las
declare: ambiente, motor y servidor. Al hacer clic en el encabezado de un grupo
se filtra por él, y tanto el filtro como la agrupación viajan en la URL para
poder pegarla en un chat.

La barra lateral agrupa por la etiqueta más usada del parque —`grupo` si existe—
para que la navegación y la tabla no cuenten historias distintas del mismo
parque. Los grupos con críticos van primero: cuando algo está roto, esa es la
razón por la que alguien abrió la pantalla.

### Descubrimiento de red

`Administración → Descubrimiento` recorre un rango y dice qué motor hay en cada
puerto **hablando el saludo de cada protocolo**, sin credenciales:

| Motor | Cómo se identifica | Versión |
|-------|--------------------|---------|
| MariaDB / MySQL | Manda su paquete de saludo al conectar | Sí, en texto (`11.4.12-MariaDB`) |
| SQL Server | Responde al PRELOGIN de TDS con un token de versión binario | Sí (`16.0.4265`) |
| PostgreSQL | Su respuesta al SSLRequest es un byte, `S` o `N` | No sin autenticar; queda en blanco a propósito |

Es distinto de un escáner de puertos: `nmap` diría "algo escucha en el 3306" y no
distingue un MariaDB real de cualquier otra cosa puesta ahí. Y es distinto de
adivinar por el número de puerto, que es lo que falla justamente en las
instalaciones donde importa.

Decisiones que lo hacen usable dentro de una red ajena:

- **Las direcciones públicas hay que habilitarlas a mano.** Una herramienta de
  monitoreo que escanea internet desde el servidor del cliente es un problema
  legal, no una función.
- **Tope de 1024 direcciones por escaneo.** Un `/16` escrito por error lanzaría
  65 536 sondas; el error explica cómo partirlo.
- **Todo escaneo queda en la bitácora** con el usuario, los rangos y el
  resultado, incluidos los rechazados. Un escáner de puertos sin registro de
  quién lo disparó es lo que un equipo de seguridad no puede aceptar.
- **La espera del saludo es de 250 ms, no del timeout completo.** PostgreSQL y
  SQL Server no saludan nunca, así que esperar el timeout entero costaba ese
  tiempo por cada uno antes de empezar su sonda: el escaneo de localhost bajó de
  768 ms a 320 ms.
- **La versión conocida no se pierde** si un escaneo posterior no la puede leer.
- Lo encontrado **se acumula**: lo que se vio una vez sigue listado con su
  `last_seen_at`, porque "esto apareció el martes y ya no está" es justo la clase
  de cosa que interesa de un parque. Se puede anotar e ignorar por fila.

### Cuentas y roles

Dos roles: **admin** puede cambiar cosas, **viewer** sólo mira. La tabla completa
está en la propia pantalla de usuarios.

- **La sesión no vive en base de datos.** La cookie lleva usuario, rol y
  expiración firmados con HMAC-SHA-256, así verificar cada petición no cuesta una
  consulta, reiniciar la web no cierra sesiones y el middleware —que corre en el
  runtime edge, sin acceso al store— puede decidir solo.
- **`requireAdmin` se repite dentro de cada acción**, no sólo en el middleware.
  Una server action se puede invocar sin pasar por la página que la dibuja:
  ocultar el botón no es autorización.
- **Contraseñas con scrypt** (N=16384, r=8, p=1) y sal por cuenta, de
  `node:crypto`. No se usó bcrypt ni argon2 porque son módulos nativos: en un
  despliegue on-prem, cada dependencia que hay que compilar es una instalación
  que falla en la máquina del cliente.
- **Modo de arranque:** mientras no exista ninguna cuenta, `BUHO_AUTH_PASSWORD`
  entra como administrador para poder crear la primera. En cuanto hay una cuenta
  deja de servir; si siguiera valiendo sería una puerta trasera permanente que
  ignora los roles.
- **El último administrador no se puede degradar, deshabilitar ni borrar.** Sin
  esa guarda, la consola queda de sólo lectura para siempre y hay que arreglarlo
  con SQL a mano.
- **La demora de medio segundo del login es igual exista o no la cuenta.** Si
  sólo se demorara con usuario válido, el tiempo de respuesta revelaría qué
  nombres existen.
- Un viewer que llega a `/admin` por un enlace guardado ve una explicación en la
  flota, no una redirección muda.

### Retención

`Administración → Retención` edita los cinco plazos y el colector los relee en su
ciclo de mantenimiento, cada 15 minutos: no hay que reiniciar nada. `config.json`
queda como valor inicial; si el store tiene una fila, manda.

- **Se muestra el tamaño real de cada tabla en la misma pantalla.** Decidir
  cuántos días guardar sin ver lo que cuesta es adivinar. Cada partición se
  atribuye a su tabla raíz: consultar sólo las tablas padre dejaba fuera
  justamente a las más grandes, porque `metric_samples` y `statement_stats` no
  almacenan nada en el padre y aparecían con cero bytes.
- **Un agregado no puede durar menos que el detalle que lo alimenta.** Se valida
  en el servidor: con rollups de 5 m más cortos que las muestras crudas, la
  ventana de 30 días perdería los últimos días, justo donde hay más datos.
- Las muestras crudas y las estadísticas por consulta se borran con `DROP TABLE`
  de la partición diaria, que no deja filas muertas ni exige vacuum. Los
  agregados y los episodios de bloqueo se borran con `DELETE`: su espacio queda
  reutilizable pero el archivo no se encoge.
- **Bajar un valor borra datos de forma irreversible** en el siguiente ciclo. La
  vía para conservar historia larga es subir el agregado de 1 hora, que ocupa una
  fracción del crudo.

### Verificar los flujos

Sesión, rol y envío de formularios no se comprueban con un `curl`:

```bash
PW_CHROME=/ruta/al/chrome \
BUHO_ADMIN=usuario:contraseña BUHO_VIEWER=usuario:contraseña \
npm run verify:console
```

Recorre login con cuenta y con credenciales inválidas, el bloqueo de `/admin`
para un viewer, un escaneo real, la guardia de red pública, la validación de
contraseñas y la bitácora. Un `requireAdmin` olvidado en una acción nueva no
rompe ninguna pantalla, y por eso conviene volver a correrlo.


## Planes de ejecución

Cada consulta del listado tiene un enlace a su plan. La pantalla trae el árbol
dibujado, la salida de texto de PostgreSQL, y los hallazgos anclados al nodo
donde está el problema — que es lo que cuesta encontrar en un plan de cuarenta
líneas donde hay un culpable y treinta y nueve consecuencias suyas.

### El EXPLAIN lo corre el colector, no la consola

La consola sólo lee el store y **nunca** se conecta a las instancias
monitoreadas. Un plan rompe esa frontera de frente, porque es una pregunta que
hay que hacerle a la base viva. En vez de hacer una excepción hay una cola:

1. La consola escribe el encargo en `buho.plan_requests`.
2. El colector lo toma con `for update skip locked` —ya tiene las credenciales y
   el pool abierto—, ejecuta y deja el resultado.
3. La pantalla se refresca sola hasta que aparece.

Cuesta un segundo de espera. Gana que las credenciales de las bases del cliente
existan en un solo proceso, que cada plan quede con quién lo pidió, y que la
tabla sea además el historial de planes: con eso se contesta "esta consulta se
puso lenta el martes, ¿le cambió el plan?".

Se atiende un encargo por vuelta. Un `EXPLAIN ANALYZE` ejecuta la consulta de
verdad, y dejar que se acumulen en paralelo convertiría un botón de la interfaz
en una forma de cargar la base del cliente.

### Qué se ofrece según la sentencia

`pg_stat_statements` registra todo, así que en el listado de las más costosas
aparecen sentencias que no se pueden explicar. En el lake son **134 de 240**: más
de la mitad. La pantalla ofrece sólo los modos que pueden funcionar, porque un
botón que falla al apretarlo es peor que ningún botón.

| Sentencia | Modos ofrecidos |
|-----------|-----------------|
| Lectura (`SELECT`, `WITH` sin escritura, `TABLE`, `VALUES`) | plan estimado y `ANALYZE` |
| Escritura (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE TABLE AS`) | sólo plan estimado |
| Utilitaria (`ALTER`, `CREATE INDEX`, `VACUUM`, `SET`, `TRUNCATE`, `BEGIN`…) | ninguno |
| Texto recortado a 4000 caracteres | ninguno |
| Normalizada con `$1` | sólo plan genérico, y sólo en PG 16+ |

Las utilitarias no es que Búho no las intente: **la gramática de `EXPLAIN` no las
acepta**. `EXPLAIN ALTER TABLE` es un error de sintaxis y `REFRESH MATERIALIZED
VIEW` contesta "utility statements have no plan structure". Verificado contra PG
18.4. La pantalla lo dice y apunta a dónde sí está el hallazgo en esos casos: no
en el plan sino en el número de llamadas —DDL idempotente en cada ciclo, un `SET`
por conexión, un `VACUUM` manual de más—.

Las escrituras se planifican pero no se ejecutan. Revertir la transacción
alcanzaría para las filas, pero no para lo que un `INSERT` deja detrás: valores
de secuencia consumidos, disparadores con efectos externos, WAL y bloqueos sobre
una base de producción.

| Modo | Ejecuta la consulta | Requiere |
|------|---------------------|----------|
| Plan estimado | No | consulta con valores concretos |
| Plan genérico | No | PostgreSQL 16+ (`EXPLAIN (GENERIC_PLAN)`) |
| Ejecutado con `ANALYZE` | **Sí** | rol admin, y consulta de sólo lectura |

El modo genérico es lo que permite explicar el texto que trae
`pg_stat_statements`, normalizado con `$1`, sin reconstruir valores a mano. Sin
valores concretos el planificador no usa estadísticas de selectividad, así que
las estimaciones son las genéricas; la pantalla lo dice. La consola acepta ese
modo en PostgreSQL 16 o posterior; el aviso de “sólo PostgreSQL” aparece cuando
el motor es MariaDB.

`ANALYZE` tiene tres guardas y no una: sólo lectura pura —un
`WITH x AS (INSERT … RETURNING …)` empieza con `WITH` y se rechaza—, todo dentro
de una transacción que se revierte siempre, y la autorización comprobada en el
servidor y no en el atributo `disabled` del botón.

### Lo que señala

Nueve patrones, cada uno con su arreglo concreto: lectura completa que descarta
casi todo lo que lee, desvío entre filas estimadas y reales, ordenamiento
derramado a disco, tabla hash partida en lotes, Nested Loop con demasiadas
vueltas, índice que encuentra las filas pero no puede filtrarlas, bitmap que
perdió precisión, estimaciones por omisión del planificador y CTE materializada.

Las que dependen de números reales sólo se evalúan con `ANALYZE`: sin ejecución
no hay filas reales que comparar, y la pantalla lo dice en vez de callarse.

### Límites

- Un texto de consulta recortado a 4000 caracteres no se puede explicar: al
  planificador le falta el final de la sentencia. La consulta aparece marcada y
  sin botón, en vez de fallar con un error de sintaxis.
- Antes de PostgreSQL 16 no existe `GENERIC_PLAN`, así que las consultas
  normalizadas hay que explicarlas a mano reemplazando los parámetros.
- El colector se conecta con su propio `search_path`: una consulta sobre tablas
  de staging sin esquema explícito falla, y el error lo dice.

---

## Vacuum y bloat

Por instancia: qué tablas están peor, cuándo pasó el último autovacuum, qué está
corriendo ahora y cuánto espacio se recuperaría.

El bloat es una **estimación**, no una medida: se calcula con el ancho promedio
de tupla que reporta `pg_stats` contra el tamaño real del heap. Por eso la
pantalla muestra el porcentaje sobre el heap y no sobre el total —con índices
incluidos el número no significa nada— y marca las tablas cuyas estadísticas
están viejas, donde la estimación no vale. Medirlo de verdad exige
`pgstattuple`, que lee la tabla entera; no se corre sin que alguien lo pida.

### Bloat medido, cuando alguien lo pide

Cada fila de la tabla tiene un botón **medir**, con dos modos:

- **aproximado** (`pgstattuple_approx`) salta las páginas que el mapa de
  visibilidad marca como limpias: cuesta una fracción y yerra por décimas.
- **exacto** (`pgstattuple`) lee cada página y cada tupla. Es la verdad, y es un
  escaneo secuencial completo de la tabla contra la base del cliente.

Va por cola, de a una y con timeout de media hora, por la misma razón que el
EXPLAIN: sólo el colector tiene credenciales de las instancias, y dos mediciones
en paralelo serían el monitor haciéndole daño al servidor que vigila. Sólo admin
puede encolarla; un viewer ve el resultado de lo que otro midió.

Cuando la medición existe, la pantalla la pone al lado de la estimación y avisa
si se equivocaba por más de 5 puntos. Ese es el dato que decide si en ese
servidor hay que volver a medir o si la estimación gratis alcanza.

### Wraparound por tabla

`age(datfrozenxid)` avisa de que la base se acerca al límite pero no dice qué
congelar, y la respuesta casi nunca es "todo": lo normal es que una o dos tablas
arrastren a las demás. La columna **congelamiento** muestra, por tabla, el peor
de los dos relojes —transacciones y multixact— como porcentaje del
`freeze_max_age` que le aplica, con la opción por tabla si la tiene.

Los multixact se miran aparte porque avanzan por su cuenta: los generan las
claves foráneas y los `SELECT FOR SHARE`, no las escrituras. Una tabla puede
estar tranquila de XID y apretada de mxid.

Una tabla particionada no guarda filas y su `relfrozenxid` es cero: medir su edad
devuelve el rango entero de XID, que en pantalla parece una emergencia inventada.
Se reporta cero y el wraparound se mira en cada partición.

---

## Sugeridor de índices

Parte de los planes que ya se ejecutaron con ANALYZE, y sólo de esos. Un
sugeridor que mira `pg_stat_user_tables` ve muchos escaneos secuenciales y dice
"falta un índice" sin saber sobre qué columna, ni si la consulta lee media tabla
—donde el secuencial es correcto—, ni si el índice ya existe y el planificador lo
descartó por estadísticas viejas. Del plan, en cambio, sale la condición exacta,
cuántas filas descartó, cuántas veces se repitió y cuánto costó.

Tres patrones:

| Patrón | Qué se vio | Qué propone |
|---|---|---|
| Secuencial filtrado | Leyó N filas y descartó más del 90 % después de leerlas | Índice sobre las columnas de la condición |
| Índice que no filtra | El índice encontró las filas y el filtro descartó miles al traerlas | **Ampliar** el índice que ya se usa, no crear otro |
| Orden en disco | El `Sort` usó más de 4 MB de disco | Medir `work_mem` antes; índice sólo si el orden se repite |

La extracción de columnas es deliberadamente conservadora: sólo identificadores
simples a la izquierda de un comparador, las de igualdad al frente y las de rango
al final. Funciones, casts y condiciones con `OR` se descartan en vez de
adivinarse, porque un DDL que no compila destruye la confianza en la pantalla
entera.

Cada sugerencia trae su contraindicación al lado y la evidencia debajo, con enlace
a la consulta que la motivó. Al pie aparecen los hallazgos de los chequeos de
índices (unused y redundant), agrupados por esquema y paginados. Si el snapshot
de inventario todavía no llegó, los KPI de Unused y Redundant salen de esos
chequeos en vez de quedarse en cero. El total de índices sigue esperando el
snapshot: los chequeos no enumeran los que están sanos.

`pg_stat_progress_vacuum` da el avance del vacuum en curso por fases, que es lo
que contesta la pregunta real durante un incidente: si conviene esperar o matarlo.

---

## Replicación por instancia

El parque muestra el estado de toda la flota; la pantalla de instancia agrega lo
que faltaba: **el lag en el tiempo**. Un pico de treinta segundos hace una hora
no se ve en ninguna vista de estado actual.

Se lee distinto según el rol, y eso importa:

- En el **primario**, `pg_stat_replication` da el retraso de cada standby en
  bytes y en tiempo, y `pg_replication_slots` avisa del slot inactivo que
  retiene WAL hasta llenar el disco.
- En el **standby**, `pg_last_xact_replay_timestamp()` da el retraso de reproducción
  real. Es el único número que responde "si el primario muere ahora, cuánto se
  pierde".

La conexión de un standby hacia su primario se marca como `upstream`, no como
`standby`: verla listada como su propio standby fue confuso en la primera versión.

Un **suscriptor lógico** no está en recovery y no tiene slots: los slots viven en
el publicador. Búho lee `pg_stat_subscription`. Si el apply worker no tiene pid,
la suscripción sale como `down` (el mismo caso que “apply worker pid is empty”).

---

## Chequeos de toda la flota

Los chequeos de la flota se agrupan por tipo de problema y se parten en secciones de
severidad (crítico, aviso, info). Dentro de un chequeo, las filas van por grupo de
instancia y luego por alias, de a 12 por página; cada sección muestra 8 chequeos
por página. La remediación se escribe una sola vez, al pie del grupo.

---

## Líneas base

Contestan la pregunta que un umbral fijo no puede: 400 conexiones un martes a
las 3 de la tarde puede ser rutina, y las mismas 400 un domingo a las 4 de la
mañana un proceso que se soltó. La referencia es el propio pasado del servidor a
la misma hora.

Se calculan en el store desde el rollup de una hora (`buho.build_baselines`), en
dos alcances: por **hora del día**, que sirve con pocos días de historia, y por
**hora de la semana**, que distingue el martes del domingo pero necesita unas
cinco semanas. La consola usa la más fina que tenga datos suficientes.

Con pocas observaciones por celda una banda es ruido disfrazado de estadística.
Hay un mínimo de cinco y, cuando no se alcanza, la pantalla dice que todavía no
hay línea base en vez de dibujar una.

Dónde aparecen: como banda del percentil 10 al 90 en los gráficos de Análisis
(botón «Línea base») y como panel **Fuera de lo normal** en el resumen de la
instancia, que lista sólo las métricas que se salieron de su banda, ordenadas por
cuánto se pasaron respecto del ancho habitual.

> Colector, consola y store comparten zona horaria (`BUHO_TZ`, o la del sistema).
> Con el store en UTC y la consola en UTC-6 la banda sale corrida seis horas: fue
> el primer error que apareció al graficarlas.

---

## Log de PostgreSQL

De ahí salen las dos cosas que las vistas de estadísticas no tienen: el deadlock
completo —con las dos consultas y quién ganó— y los errores de la aplicación.

Lee de `journald` o de archivos, local o por SSH, en `jsonlog`, `csvlog` o
`stderr`. Las entradas multilínea se rearman (un deadlock son varias líneas), se
clasifican y se agrupan por huella, así que 188 errores iguales son una fila y no
188. Guarda un cursor por instancia para no releer lo mismo.

La pantalla dice siempre **de dónde** está leyendo y qué limitaciones detectó:
"cero errores" y "no hay log configurado" son conclusiones opuestas y el informe
no puede confundirlas.

---

## Informe semanal

El entregable de la consultoría: lo que el cliente recibe y por lo que paga.

Contesta "cómo se portó la semana", no "qué está pasando ahora", así que todo es
una comparación contra la semana anterior o un extremo del periodo. Trae el
veredicto en una línea, los totales, las acciones recomendadas priorizadas, el
estado de respaldos y, por instancia, indicadores con su promedio, su pico y su
cambio, crecimiento, incidentes, mantenimiento pendiente y las consultas que más
tiempo consumieron.

Se descarga en Markdown desde la pantalla o desde una ruta, para dejarlo en cron:

```bash
curl -b sesion.txt http://127.0.0.1:3100/report/export?semana=1 -o informe.md
```

Markdown y no PDF a propósito: se pega en un correo, se convierte a lo que sea y
se versiona junto al resto de la documentación del cliente. La pantalla y el
archivo salen de la misma consulta, así que no pueden discrepar.

Cuando el monitoreo no cubrió toda la semana, el informe lo dice en la instancia
afectada en vez de promediar sobre los huecos y callarse.

---


## Sesiones y esperas en los tres motores (v0.3)

La pantalla Sesiones ya no es sólo de PostgreSQL.

- **PostgreSQL:** `pg_stat_activity` (como antes).
- **MariaDB:** `information_schema.PROCESSLIST`. El `State` es texto libre y se
  clasifica a familias (`Lock`, `IO`, `Client`, `Timeout`, `CPU`, `Other`).
- **SQL Server:** `sys.dm_exec_requests` + `sys.dm_exec_sessions`, con
  `wait_type` y `blocking_session_id`.

Misma pantalla, mismo gráfico de perfil de espera, misma reconstrucción de
«qué estaba corriendo a las 3:04». Es muestreo cada 10 s: mide bien lo que dura.

## Informe semanal como entregable (v0.3)

El informe ahora incluye:

1. **Plan de trabajo de la semana** — tres prioridades, no un dump de métricas.
2. **Tiempo de sesión en Lock / IO** a nivel de parque.
3. **Perfil de espera por instancia** (tags con porcentaje).

Sigue exportándose a Markdown (`/report/export`) para pegarlo en el correo del
lunes. Eso es lo que el cliente de consultoría DBAOps paga.

## Empaquetado sin compilar (v0.3)

```bash
./install.sh --pull
```

Baja `collector` y `web` desde GHCR (`ghcr.io/tobbikz/buho-monitor/...`) y
levanta el store. El cliente no necesita Node ni `docker build`. Las imágenes se
publican al etiquetar un release (`v0.3.0`) con el workflow de GitHub Actions.

En un checkout que ya está corriendo, aplicar código nuevo sin reiniciar el store:

```bash
git pull
./install.sh --actualizar
```

## Comparar dos momentos, capacidad, topología e incidentes (v0.4)

Cinco piezas pensadas para el DBA que vende diagnóstico, no dashboards:

1. **Antes / ahora** en Análisis (`?vs=24h`, `6h`, `7d`): la misma ventana
   desplazada, línea punteada = el pasado alineado al eje de ahora. Sirve para
   “antes del deploy vs. después” sin dos pestañas.
2. **Qué pasó** — párrafo en español en Resumen y Sesiones, armado con esperas,
   bloqueos y la consulta más larga del momento peor. Plantilla auditable, no LLM.
3. **Capacidad** (`/instances/[id]/capacity`) — proyección lineal de disco, XID,
   CPU y RAM del host: “con este crecimiento, en X semanas se acaba”.
4. **Topología** (`/instances/[id]/topology`) — congela el grafo app↔tabla del
   Flujo semana a semana y muestra qué aristas nacieron, murieron o crecieron ≥2×.
5. **MongoDB** — motor nuevo: `serverStatus` / `dbStats`, inventario del parque,
   resumen e Análisis. Sin profiler ni bloqueos todavía (se dice en pantalla).


## English UI and Add database (v0.4.1)

- Console copy is English (Búho brand kept).
- **Add database** on the fleet page (Admin → Databases) writes `buho.monitor_targets`. The collector picks new targets every ~30s without a restart. `config.json` still works and wins on alias clash.

After pull: `BUHO_STORE_URL=... npm run migrate`


## Atribución por aplicación (v0.2)

La primera columna del diagrama de flujo puede ser el **rol** o la
**aplicación**, y las dos no valen lo mismo.

El rol es exacto: `pg_stat_statements` lo guarda. La aplicación no está ahí —el
`application_name` no se acumula con las estadísticas—, así que sale de mirar
`pg_stat_activity` cada cinco segundos, apuntar qué aplicación estaba
ejecutando qué `query_id`, y repartir después el peso medido en esa proporción.
Si `portal-web` se vio 30 veces con una consulta y `etl-nocturno` 10, el peso de
esa consulta se parte 75/25.

Es un **muestreo**, y la pantalla lo dice y lo cuantifica: las consultas que
nunca se vieron activas se agrupan como «no observado», con su porcentaje. Una
consulta que dura menos que el intervalo puede no aparecer jamás; una que dura
mucho aparece en varias fotos seguidas. A cambio no cuesta nada extra —esa vista
ya se consultaba cada ciclo— y no exige tocar ninguna aplicación.

Requiere PostgreSQL 14 o más y `compute_query_id` activo. Con `auto` hace falta
además que `pg_stat_statements` esté precargado, porque «auto» significa «sólo si
alguien lo pide» y quien lo pide es esa extensión. Si falta, el colector lo
registra con el motivo en vez de dejar la pantalla vacía: el propio store de
Búho es un caso real de esto, y se ve en el log como tal.

Las observaciones se acumulan en memoria y se escriben una fila por minuto
(`buho.query_actors`), particionada y purgada con la misma política que el resto
de las muestras crudas.

## Actividad en vivo

El panel del diagrama tiene dos vistas y contestan preguntas distintas.

**En vivo** (la que se abre por omisión) es un lienzo oscuro donde el tráfico de
los últimos cinco minutos viaja como partículas entre los nodos. **Acumulado** es
el diagrama de cintas de siempre, con el total de la ventana elegida. La
diferencia importa: una tabla que recibió un millón de filas esta mañana domina
el acumulado y no debe mover una sola partícula si lleva cinco minutos quieta.

Lo que se ve es honesto en un sentido concreto: la posición de cada partícula es
decorativa —no hay una fila viajando por un cable—, pero **la densidad no lo
es**. Cada arista emite en proporción a lo que movió por segundo, así que una
cinta que lanza el doble movió el doble. Si todo está quieto, no hay tráfico, y
el rótulo lo dice con palabras en vez de dejar un lienzo negro ambiguo.

Arriba a la izquierda van la tasa por segundo, las sesiones activas y las
bloqueadas, y la edad del dato. Se refresca cada cinco segundos encadenando
peticiones (no en intervalo fijo), para que una consulta lenta no acumule
llamadas contra el store. Está dibujado en canvas porque son cientos de
partículas a sesenta cuadros por segundo, y con un nodo del DOM por partícula el
navegador se arrodilla.

Está en las dos pantallas: por instancia y para todo el parque.

## Flujo del parque

`/flow` responde la pregunta que la vista por instancia no podía: **de todos los
servidores, qué tabla recibe más escritura**. Las columnas pasan a ser
instancia → esquema → tabla, porque a nivel de parque lo primero que se busca es
en qué máquina está el volumen.

El esquema va calificado por instancia: dos servidores pueden tener cada uno su
`public`, y unirlos fundiría en una sola cinta el tráfico de máquinas distintas.
Se calcula por instancia y se suma, no con una consulta global, porque el esquema
por omisión depende del motor: `public` en PostgreSQL, `dbo` en SQL Server, el
nombre de la base en MariaDB.

Debajo hay una tabla que sí falta en la mayoría de los monitores: **las
instancias que no aportaron nada**, con cuántas consultas se les vieron. Una
instancia ausente del diagrama porque no llega tráfico y otra ausente porque le
falta `pg_stat_statements` se ven igual en el dibujo, y no son lo mismo.

## Ensayo de instalación

`npm run ensayo:instalacion` instala Búho desde cero como lo haría alguien que
nunca lo vio, y comprueba que funcione.

Hace una copia limpia del proyecto —sin `.env`, sin `config.json`, sin
`node_modules`—, levanta un PostgreSQL nuevo para monitorear, crea el usuario de
monitoreo **con el script documentado** (`sql/monitor-user.sql`, no a mano),
corre `install.sh` en puertos distintos a los de desarrollo y verifica que el
colector escriba muestras, que los chequeos corran, que la consola deje entrar
con la contraseña de arranque y que todas las pantallas respondan. Al final lo
corre otra vez para confirmar que actualizar no regenera los secretos ni pierde
datos, y borra todo.

Ese ensayo destapó tres fallos que sólo aparecen en una máquina limpia:

• **`sql/monitor-user.sql` no creaba el usuario.** El `CREATE ROLE` iba dentro de
  un bloque `DO`, y psql no interpola sus variables dentro de literales entre
  comillas de dólar: `:'buho_password'` quedaba escrito tal cual y el rol nunca
  se creaba. Todo el script documentado para dar mínimo privilegio fallaba en el
  primer paso. Ahora se crea con `\gexec`, donde la sustitución sí ocurre.
• **El propio ensayo se daba por bueno sin recolectar nada.** Buscaba la palabra
  «muestras» en la salida del instalador, que también aparece en el aviso «sin
  muestras todavía». Una prueba que pasa cuando el producto no funciona es peor
  que no tenerla.
• **Los nombres con acentos salían partidos en la consola.** La cookie de sesión
  se leía con `atob`, que devuelve un byte por carácter, así que un usuario
  «José» entraba y la consola lo saludaba como «JosÃ©». La firma se sigue
  verificando sobre los bytes, que es lo que se firma; el payload ahora se
  interpreta como UTF-8.

## Flujo del tráfico y mapa de uso

Dos preguntas que ninguna serie de tiempo contesta: **quién le pega a qué** y
**cuándo**.

El diagrama de flujo cruza tres columnas —rol → esquema → tabla— y el grosor de
cada cinta es el peso elegido. Se puede pesar por filas ("dónde cae el
volumen"), por tiempo ("dónde se gasta el servidor") o por llamadas ("qué se
llama más"); cambiar de una a otra suele reordenar el diagrama entero, y ver ese
cambio es parte del diagnóstico. La dirección se elige: en escritura la tabla es
el destino del DML, en lectura son las tablas del `from` y los `join`.

Funciona en los tres motores, porque la atribución sale del texto de la
consulta, que se recoge igual en todos.

### La atribución es aproximada, y se dice

Ninguna de las dos fuentes sirve sola: `pg_stat_statements` sabe el rol, las
llamadas, las filas y el tiempo pero no la tabla; el texto de la consulta sabe
la tabla pero no cuánto se ejecutó. El cruce es análisis léxico del texto, no un
parser, así que la pantalla muestra **qué porcentaje del peso pudo atribuir** al
lado del diagrama.

Tres decisiones para que el número no engañe:

- Cuando una consulta toca varias tablas, su peso **se reparte** entre ellas.
  Cargarlo entero a cada una multiplicaría el tráfico.
- Los esquemas del sistema quedan fuera (`pg_catalog`, `information_schema`,
  `performance_schema`, `mysql`): ese tráfico es del monitoreo y de las
  herramientas.
- Los nombres de CTE **no** se cuentan como tablas. `from mi_cte` es idéntico a
  `from mi_tabla`, y sin distinguirlos las consultas de monitoreo —que son casi
  todas CTEs— llenaban el diagrama de tablas que no existen.

El contraste honesto va debajo, y sólo en PostgreSQL: los contadores de
`pg_stat_user_tables` por tabla, que no dependen de haber entendido ninguna
consulta. Si no cuadran con el diagrama, ellos tienen razón; la atribución se
pierde con triggers, cascadas de claves foráneas y consultas que se cayeron de
`pg_stat_statements`. Ahí va también la proporción **HOT**: por debajo del 50 %,
cada `update` está reescribiendo índices.

MariaDB y SQL Server no exponen contadores de filas por tabla, así que en esos
motores el diagrama es la única fuente y la pantalla lo aclara. En SQL Server,
además, el DML no aporta filas a `dm_exec_query_stats`, así que las escrituras
hay que pesarlas por tiempo o por llamadas.

### El mapa de uso

Una rejilla de 7 días por 24 horas sobre `metric_rollup_1h`, que guarda 400 días:
ver un año no cuesta más que ver una semana. Contesta "cuándo se puede tocar este
servidor", que es la pregunta que una curva de 24 horas no puede contestar —un
lunes a las 3 de la tarde y un domingo a las 3 de la mañana son el mismo punto
del día y dos mundos distintos.

Se elige entre escrituras, transacciones, conexiones, lecturas de disco y
sesiones bloqueadas, y entre el promedio ("cómo es una hora típica") o el máximo
("qué tan mal se puso alguna vez a esa hora"). Debajo, en palabras, la hora más
cargada y la más tranquila: ahí va la ventana de mantenimiento.

Los huecos se dibujan **como huecos** y no como cero. Una celda sin datos y una
celda con carga cero son cosas distintas: la primera dice "no estaba mirando".
El color es relativo a la propia rejilla, así que no compara entre instancias, y
la hora es la del operador, no la del store.
