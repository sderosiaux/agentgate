import { randomUUID } from 'node:crypto';

export type IdPrefix = 'pri' | 'agt' | 'mis' | 'cred' | 'apr' | 'aud' | 'req' | 'ses';

const ID_LENGTH = 20;

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, ID_LENGTH)}`;
}
