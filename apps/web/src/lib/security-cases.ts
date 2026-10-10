import { Store } from '@buho/store';
import { storeUrl } from './db';

export type SecurityCase = {
  caseId: number;
  title: string;
  status: 'open' | 'acked' | 'closed' | string;
  severity: string;
  assignee: string | null;
  findingKeys: unknown;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function listSecurityCases(limit = 100): Promise<SecurityCase[]> {
  const store = new Store(storeUrl());
  try {
    return await store.listSecurityCases(limit);
  } finally {
    await store.close().catch(() => undefined);
  }
}

export async function upsertSecurityCase(input: {
  caseId?: number;
  title: string;
  status?: string;
  severity?: string;
  assignee?: string | null;
  findingKeys?: unknown;
  note?: string | null;
}): Promise<number> {
  const store = new Store(storeUrl());
  try {
    return await store.upsertSecurityCase(input);
  } finally {
    await store.close().catch(() => undefined);
  }
}
