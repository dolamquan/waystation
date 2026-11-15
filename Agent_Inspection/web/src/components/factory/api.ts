import { request } from '../../api.ts';
import type { FactoryDefinition, FactoryItem, FactorySnapshot } from '../../../../shared/factory.ts';
export const factoryApi = {
  snapshot: () => request<FactorySnapshot>('GET', '/api/factory'),
  save: (definition: Partial<FactoryDefinition>, id?: string) => request<{ factory: FactoryDefinition }>('POST', `/api/factory/definitions${id ? `/${encodeURIComponent(id)}` : ''}`, definition),
  create: (input: { factoryId: string; title: string; request: string; criteria: string }) => request<{ item: FactoryItem }>('POST', '/api/factory/items', input),
  action: (id: string, action: string) => request<{ item: FactoryItem }>('POST', `/api/factory/items/${encodeURIComponent(id)}/action`, { action }),
  diff: (id: string) => request<{ diff: { stat: string; patch: string; truncated: boolean } }>('GET', `/api/factory/items/${encodeURIComponent(id)}/diff`),
};
