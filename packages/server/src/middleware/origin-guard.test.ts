import { describe, expect, it } from 'vitest';
import { isAllowedHost, isAllowedOrigin } from './origin-guard';

const config = {
  host: '127.0.0.1',
  port: 4317,
  allowedOrigins: ['http://trusted.test'],
  nodeEnv: 'development',
} as const;
describe('local origin guard', () => {
  it('allows local, configured, dev, and missing origins', () => {
    for (const origin of [
      undefined,
      'http://127.0.0.1:4317',
      'http://localhost:4317',
      'http://127.0.0.1:5173',
      'http://trusted.test',
    ])
      expect(isAllowedOrigin(origin, config)).toBe(true);
  });
  it('rejects foreign, null, and wrong-port origins', () => {
    for (const origin of [
      'null',
      'http://evil.example',
      'http://localhost:9999',
    ])
      expect(isAllowedOrigin(origin, config)).toBe(false);
  });
  it('rejects rebinding hosts', () => {
    expect(isAllowedHost('127.0.0.1:4317', config)).toBe(true);
    expect(isAllowedHost('localhost:4317', config)).toBe(true);
    expect(isAllowedHost('attacker.test', config)).toBe(false);
  });
});
