export interface OrmTable {
  schema: string;
  name: string;
  relation: string;
  liveTuples: number;
  deadTuples: number;
  sizeBytes: number;
  writeHeat: number;
  readHeat: number;
  heat: number;
  attributed: boolean;
  apps: string[];
}

export interface OrmSchema {
  name: string;
  tables: OrmTable[];
  heat: number;
  tableCount: number;
  sizeBytes: number;
}

export type OrmNodeKind = 'schema' | 'table';

export interface OrmNode {
  id: string;
  kind: OrmNodeKind;
  label: string;
  schema?: string;
  sizeBytes: number;
  liveTuples: number;
  writeHeat: number;
  readHeat: number;
  heat: number;
  table?: OrmTable;
}

export type OrmLinkKind = 'membership' | 'fk' | 'traffic';

export interface OrmLink {
  source: string;
  target: string;
  kind: OrmLinkKind;
  /** Attributed traffic on this relationship (FK edge overlay). */
  traffic: number;
  writeTraffic: number;
  readTraffic: number;
}

export type OrmLayer = 'estructura' | 'trafico' | 'ambos';

export interface OrmModel {
  schemas: OrmSchema[];
  nodes: OrmNode[];
  links: OrmLink[];
  totalTables: number;
  foreignKeys: number;
  attributedTables: number;
  maxSize: number;
  maxHeat: number;
  maxTraffic: number;
}

export function formatBytesShort(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function schemaNodeId(name: string): string {
  return `schema:${name}`;
}

export function tableNodeId(relation: string): string {
  return `table:${relation}`;
}
