import { LRUCache } from "lru-cache";

export class FreebieTracker {
  private cache: LRUCache<string, number>;
  private maxFree: number;

  constructor(maxFree: number) {
    this.maxFree = maxFree;
    this.cache = new LRUCache<string, number>({
      max: 10_000, // Track up to 10K unique IPs
      ttl: 1000 * 60 * 60, // Reset after 1 hour
    });
  }

  hasFreebies(clientIp: string): boolean {
    if (this.maxFree <= 0) return false;
    const used = this.cache.get(clientIp) || 0;
    return used < this.maxFree;
  }

  use(clientIp: string): void {
    const used = this.cache.get(clientIp) || 0;
    this.cache.set(clientIp, used + 1);
  }

  remaining(clientIp: string): number {
    if (this.maxFree <= 0) return 0;
    const used = this.cache.get(clientIp) || 0;
    return Math.max(0, this.maxFree - used);
  }
}
