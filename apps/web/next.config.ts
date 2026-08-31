import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Las reglas para agentes viven en el vault de Obsidian, no en el repo.
  agentRules: false,
  // Imagen autocontenida para el despliegue on-prem: sin node_modules completo.
  output: 'standalone',
  // El store se consulta desde componentes de servidor: pg nunca debe entrar
  // al bundle del cliente.
  serverExternalPackages: ['pg'],
  // Sin esto, en desarrollo **nada** hidrata.
  //
  // Next bloquea las peticiones a sus recursos de dev (/_next/static, el
  // WebSocket de HMR) cuyo origen no esté en una lista blanca que por omisión
  // contiene `localhost` y el hostname del servidor, pero **no** `127.0.0.1`.
  // Como la consola se abre por IP en todas partes —README, compose, pruebas—,
  // un chunk devolvía 403, la hidratación se cortaba en silencio y todos los
  // componentes de cliente quedaban muertos: los botones no respondían y las
  // tablas no se expandían, sin un solo error en consola que lo dijera.
  //
  // Sólo aplica a desarrollo; en producción estos recursos no existen.
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
