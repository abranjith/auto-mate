import { useQuery } from '@tanstack/react-query';
import { getHealth } from './api-client';

/** Refresh server health while the shell is open. @returns A cached query that refetches every ten seconds. */
export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => getHealth(), staleTime: 5000, refetchInterval: 10000, retry: 1 });
}
