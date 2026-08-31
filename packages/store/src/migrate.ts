import { Store } from './index';

const url = process.env['BUHO_STORE_URL'];

if (!url) {
  console.error('Falta BUHO_STORE_URL (ej. postgres://buho:buho@127.0.0.1:55432/buho)');
  process.exit(2);
}

const store = new Store(url);

try {
  await store.migrate();
  console.log('Schema del store aplicado.');
} catch (error) {
  console.error('Falló la migración:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await store.close();
}
